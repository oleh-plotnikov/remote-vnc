# Sidebar Views Implementation Plan

> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dedicated Activity Bar container to Remote VNC with two tree views — Saved Connections (click-to-connect, Edit/Delete/Forget) and Active Sessions (Reveal/Disconnect).

**Architecture:** A pure data/storage module (`connections.ts`) and a pure session registry (`sessionRegistry.ts`) hold the testable logic; thin `TreeDataProvider`s (`connectionsView.ts`, `sessionsView.ts`) render them. `VncSessionManager` gains a session registry and an `onDidChangeSessions` event. `extension.ts` wires providers, tree views, and new commands. All VNC-specific behavior (trust gate, host-scoped secrets, global-precedence) is preserved.

**Tech Stack:** TypeScript, VS Code Extension API (`TreeDataProvider`, `viewsContainers`), esbuild bundles, Node `node:test`-free assertion scripts run via `node` against esbuild-bundled modules with a `vscode` stub.

---

## File structure

| File | Responsibility | Action |
| --- | --- | --- |
| `src/connections.ts` | Connection storage model: types, `collectConnections` (scope-tagged, trust-gated, global-precedence), `isValidPort`, `secretKeyFor`, `DEFAULT_PORT` | Create |
| `src/sessionRegistry.ts` | Pure `SessionRegistry` (id→label, change callback) — no vscode import | Create |
| `src/connectionsView.ts` | `ConnectionsTreeProvider` + `ConnectionTreeItem` | Create |
| `src/sessionsView.ts` | `SessionsTreeProvider` + `SessionTreeItem` | Create |
| `src/vncPanel.ts` | Integrate `SessionRegistry`; expose `onDidChangeSessions`, `getSessions`, `reveal`, `disconnect`; per-session `id`/`label`/`matches`; reveal-existing-instead-of-duplicate | Modify |
| `src/extension.ts` | Use `connections.ts`; register providers + tree views; `editConnection`/`deleteConnection`; `connectEntry` refactor; tree command wrappers | Modify |
| `resources/remote-vnc.svg` | Monochrome Activity Bar icon | Create |
| `package.json` | `viewsContainers`, `views`, `viewsWelcome`, `menus`, new command declarations | Modify |
| `test/bundle.mjs` | Test helper: esbuild-bundle a `src` module with a `vscode` stub, return it | Create |
| `test/connections.test.mjs` | Unit tests for `connections.ts` | Create |
| `test/sessionRegistry.test.mjs` | Unit tests for `sessionRegistry.ts` | Create |
| `test/run.mjs` | Runs all `*.test.mjs`, exits non-zero on failure | Create |

---

## Task 1: Test harness

**Files:**
- Create: `test/bundle.mjs`, `test/run.mjs`
- Modify: `package.json` (add `test` script)

- [ ] **Step 1: Create the bundle helper**

Create `test/bundle.mjs`:

```js
// Bundle a TypeScript module from src/ to CJS with a minimal `vscode` stub,
// so pure logic can be unit-tested in plain Node.
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const vscodeStub = `
  export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };
  export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };
  export class TreeItem { constructor(label, state) { this.label = label; this.collapsibleState = state; } }
  export class ThemeIcon { constructor(id, color) { this.id = id; this.color = color; } }
  export class ThemeColor { constructor(id) { this.id = id; } }
  export class EventEmitter { constructor(){ this._l=[]; this.event=(cb)=>{ this._l.push(cb); return { dispose(){} }; }; } fire(v){ for (const cb of this._l) cb(v); } dispose(){} }
  export const workspace = {};
  export const window = {};
  export const commands = {};
  export default {};
`;

const stubPlugin = {
  name: 'stub-vscode',
  setup(b) {
    b.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: vscodeStub, loader: 'js' }));
  },
};

/** Bundle `src/<entry>` and return the loaded CommonJS module. */
export async function load(entry) {
  const out = join(mkdtempSync(join(tmpdir(), 'rv-test-')), 'm.cjs');
  await build({
    entryPoints: [join(ROOT, 'src', entry)],
    bundle: true, format: 'cjs', platform: 'node', outfile: out, logLevel: 'silent',
  });
  return require(out);
}
```

- [ ] **Step 2: Create the runner**

Create `test/run.mjs`:

```js
// Discover and run every test/*.test.mjs. Each test file default-exports an
// async function receiving an { ok, eq } assertion API and returns nothing;
// it throws on failure.
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log(`  ✗ ${msg}`); } };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

const files = readdirSync(here).filter((f) => f.endsWith('.test.mjs')).sort();
for (const f of files) {
  console.log(f);
  const mod = await import(pathToFileURL(join(here, f)).href);
  await mod.default({ ok, eq });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 3: Add the test script**

In `package.json`, add to `"scripts"` (after `"typecheck"`):

```json
    "test": "node test/run.mjs",
```

- [ ] **Step 4: Add a temporary smoke test to prove the harness runs**

Create `test/_smoke.test.mjs`:

```js
export default async function ({ ok }) {
  ok(1 + 1 === 2, 'arithmetic works');
}
```

- [ ] **Step 5: Run it**

Run: `npm test`
Expected: `_smoke.test.mjs` printed, `1 passed, 0 failed`, exit 0.

- [ ] **Step 6: Remove the smoke test and commit**

```bash
rm test/_smoke.test.mjs
git add test/bundle.mjs test/run.mjs package.json
git commit -m "test: add headless test harness (esbuild + vscode stub)"
```

---

## Task 2: Connection data layer (`src/connections.ts`)

**Files:**
- Create: `src/connections.ts`
- Test: `test/connections.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `test/connections.test.mjs`:

```js
import { load } from './bundle.mjs';

export default async function ({ ok, eq }) {
  const { collectConnections, isValidPort, secretKeyFor } = await load('connections.ts');
  const G = 1, W = 2; // ConfigurationTarget.Global / Workspace (from the stub)

  // isValidPort
  ok(isValidPort(undefined), 'undefined port is valid');
  ok(isValidPort(5900), '5900 is valid');
  ok(!isValidPort(0), '0 is invalid');
  ok(!isValidPort(70000), '70000 is invalid');
  ok(!isValidPort(5901.5), 'non-integer is invalid');

  // secretKeyFor is host-scoped
  eq(secretKeyFor({ name: 'p', host: 'h', port: 5901 }), 'remoteVnc:p@h:5901', 'secret key includes host:port');
  eq(secretKeyFor({ name: 'p', host: 'h' }), 'remoteVnc:p@h:5900', 'secret key defaults port to 5900');

  // empty
  eq(collectConnections(undefined, true), [], 'no config → empty');

  // scope tagging + global only when untrusted
  const inspect = {
    globalValue: [{ name: 'g', host: 'gh' }],
    workspaceValue: [{ name: 'w', host: 'wh', port: 5901 }],
  };
  const trusted = collectConnections(inspect, true);
  eq(trusted.map((c) => [c.name, c.scope]).sort(), [['g', G], ['w', W]], 'trusted shows both with scope tags');
  const untrusted = collectConnections(inspect, false);
  eq(untrusted.map((c) => c.name), ['g'], 'untrusted hides workspace entries');

  // global wins a name collision
  const collide = {
    globalValue: [{ name: 'dup', host: 'global-host' }],
    workspaceValue: [{ name: 'dup', host: 'attacker-host' }],
  };
  const merged = collectConnections(collide, true);
  eq(merged.length, 1, 'collision deduped to one');
  eq([merged[0].host, merged[0].scope], ['global-host', G], 'global wins the collision');

  // invalid entries skipped
  const bad = { globalValue: [{ name: 'ok', host: 'h' }, { name: 'badport', host: 'h', port: 70000 }, { host: 'noname' }] };
  eq(collectConnections(bad, true).map((c) => c.name), ['ok'], 'invalid entries skipped');
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test`
Expected: FAIL — `Could not resolve "src/connections.ts"` (file does not exist yet).

- [ ] **Step 3: Create `src/connections.ts`**

```ts
import * as vscode from 'vscode';

export const DEFAULT_PORT = 5900;

export interface SavedConnection {
  name: string;
  host: string;
  port?: number;
}

/** A saved connection plus the configuration scope it is defined in. */
export interface ConnectionEntry extends SavedConnection {
  scope: vscode.ConfigurationTarget;
}

/** The subset of WorkspaceConfiguration.inspect() we read. */
export interface ConnectionsInspect {
  globalValue?: SavedConnection[];
  workspaceValue?: SavedConnection[];
  workspaceFolderValue?: SavedConnection[];
}

/** A saved port is valid when absent or an integer in the TCP range. */
export function isValidPort(port: number | undefined): boolean {
  return port === undefined || (Number.isInteger(port) && port >= 1 && port <= 65535);
}

/**
 * Resolve saved connections from a config inspection, tagging each with its
 * scope. Workspace scopes are layered UNDER global so a repo cannot shadow a
 * same-named user connection. In an untrusted workspace, workspace/folder
 * entries are dropped. Invalid entries (bad host/name type or out-of-range
 * port) are skipped.
 */
export function collectConnections(
  inspect: ConnectionsInspect | undefined,
  isTrusted: boolean
): ConnectionEntry[] {
  const layers: Array<{ list: SavedConnection[] | undefined; scope: vscode.ConfigurationTarget }> = [];
  if (isTrusted) {
    layers.push({ list: inspect?.workspaceFolderValue, scope: vscode.ConfigurationTarget.WorkspaceFolder });
    layers.push({ list: inspect?.workspaceValue, scope: vscode.ConfigurationTarget.Workspace });
  }
  layers.push({ list: inspect?.globalValue, scope: vscode.ConfigurationTarget.Global });

  const byName = new Map<string, ConnectionEntry>();
  for (const { list, scope } of layers) {
    for (const c of list ?? []) {
      if (c && typeof c.host === 'string' && typeof c.name === 'string' && isValidPort(c.port)) {
        byName.set(c.name, { name: c.name, host: c.host, port: c.port, scope });
      }
    }
  }
  return [...byName.values()];
}

/** Secret-storage key for a connection's password, bound to host:port. */
export function secretKeyFor(conn: { name: string; host: string; port?: number }): string {
  return `remoteVnc:${conn.name}@${conn.host}:${conn.port ?? DEFAULT_PORT}`;
}

/** The existing saved list for a single scope (used as the write base). */
export function baseFor(
  inspect: ConnectionsInspect | undefined,
  target: vscode.ConfigurationTarget
): SavedConnection[] {
  if (target === vscode.ConfigurationTarget.Workspace) {
    return inspect?.workspaceValue ?? [];
  }
  if (target === vscode.ConfigurationTarget.WorkspaceFolder) {
    return inspect?.workspaceFolderValue ?? [];
  }
  return inspect?.globalValue ?? [];
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm test`
Expected: `connections.test.mjs` … `N passed, 0 failed`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/connections.ts test/connections.test.mjs
git commit -m "feat: connection storage model with scope tagging"
```

---

## Task 3: Refactor `extension.ts` onto `connections.ts`

**Files:**
- Modify: `src/extension.ts`

This removes the duplicated `SavedConnection`/`DEFAULT_PORT`/`isValidPort`/`secretKeyFor`/`getSavedConnections` from `extension.ts` and adds shared `saveConnection`. No behavior change yet (commands still work as before).

- [ ] **Step 1: Replace the top imports and constants**

In `src/extension.ts`, replace:

```ts
import * as vscode from 'vscode';
import * as net from 'net';
import { VncSessionManager, RfbOptions, ConnectionRequest } from './vncPanel';

interface SavedConnection {
  name: string;
  host: string;
  port?: number;
}

const DEFAULT_PORT = 5900;
const PLAINTEXT_WARNING_KEY = 'remoteVnc.plaintextWarningDismissed';
```

with:

```ts
import * as vscode from 'vscode';
import * as net from 'net';
import { VncSessionManager, RfbOptions, ConnectionRequest } from './vncPanel';
import {
  SavedConnection,
  ConnectionEntry,
  DEFAULT_PORT,
  collectConnections,
  secretKeyFor,
  baseFor,
} from './connections';

const PLAINTEXT_WARNING_KEY = 'remoteVnc.plaintextWarningDismissed';
```

- [ ] **Step 2: Replace `getSavedConnections`, `isValidPort`, and `secretKeyFor`**

Delete the existing `getSavedConnections`, `isValidPort`, and `secretKeyFor` functions (they now live in `connections.ts`) and replace them with a thin reader plus a shared writer:

```ts
/** Read saved connections (scope-tagged, trust-gated, global-precedence). */
function getSavedConnections(): ConnectionEntry[] {
  const config = vscode.workspace.getConfiguration('remoteVnc');
  return collectConnections(config.inspect<SavedConnection[]>('connections'), vscode.workspace.isTrusted);
}

/**
 * Upsert a connection into a single scope. `oldName` lets an edit that renames
 * the entry remove the previous record too. Reads the existing list from the
 * same scope as the write base so other scopes are untouched.
 */
async function saveConnection(
  target: vscode.ConfigurationTarget,
  conn: SavedConnection,
  oldName?: string
): Promise<void> {
  const config = vscode.workspace.getConfiguration('remoteVnc');
  const base = baseFor(config.inspect<SavedConnection[]>('connections'), target);
  const next = [...base.filter((c) => c.name !== conn.name && c.name !== (oldName ?? conn.name)), conn];
  await config.update('connections', next, target);
}
```

- [ ] **Step 3: Use `saveConnection` inside `addConnection`**

In `addConnection`, replace the manual list-building block:

```ts
  const config = vscode.workspace.getConfiguration('remoteVnc');
  const inspect = config.inspect<SavedConnection[]>('connections');
  const existing =
    (target === vscode.ConfigurationTarget.Workspace ? inspect?.workspaceValue : inspect?.globalValue) ?? [];
  const next = [
    ...existing.filter((c) => c.name !== name.trim()),
    { name: name.trim(), host: parsed.host, port: parsed.port },
  ];
  await config.update('connections', next, target);
```

with:

```ts
  await saveConnection(target, { name: name.trim(), host: parsed.host, port: parsed.port });
```

- [ ] **Step 4: Update `connectSaved` and `forgetPassword` secret key call sites**

These already call `secretKeyFor(pick.connection)` — now imported from `connections.ts`, so no change is needed beyond Step 1's import. Verify both functions still compile against `ConnectionEntry` (they use `.name`/`.host`/`.port`, all present).

- [ ] **Step 5: Verify typecheck and existing build**

Run: `npm run typecheck`
Expected: no output, exit 0.

Run: `npm run build`
Expected: `dist/extension.js` and `media/webview.js` written, no errors.

- [ ] **Step 6: Commit**

```bash
git add src/extension.ts
git commit -m "refactor: extension.ts uses shared connections module"
```

---

## Task 4: Session registry (`src/sessionRegistry.ts`)

**Files:**
- Create: `src/sessionRegistry.ts`
- Test: `test/sessionRegistry.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `test/sessionRegistry.test.mjs`:

```js
import { load } from './bundle.mjs';

export default async function ({ ok, eq }) {
  const { SessionRegistry } = await load('sessionRegistry.ts');
  const r = new SessionRegistry();
  let changes = 0;
  r.onChange(() => { changes += 1; });

  eq(r.list(), [], 'starts empty');

  r.add('a', 'Alpha');
  eq(r.list(), [{ id: 'a', label: 'Alpha' }], 'add registers id+label');
  eq(changes, 1, 'add fires change');

  r.add('b', 'Beta');
  eq(r.list().length, 2, 'second add tracked');
  eq(changes, 2, 'second add fires change');

  r.remove('a');
  eq(r.list(), [{ id: 'b', label: 'Beta' }], 'remove drops the entry');
  eq(changes, 3, 'remove fires change');

  r.remove('missing');
  eq(changes, 3, 'removing an unknown id does not fire change');
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test`
Expected: FAIL — `Could not resolve "src/sessionRegistry.ts"`.

- [ ] **Step 3: Create `src/sessionRegistry.ts`**

```ts
export interface SessionInfo {
  id: string;
  label: string;
}

/**
 * Tracks active session id→label and notifies a single listener on change.
 * Pure (no vscode dependency) so it can be unit-tested in isolation.
 */
export class SessionRegistry {
  private readonly items = new Map<string, string>();
  private listener: (() => void) | undefined;

  add(id: string, label: string): void {
    this.items.set(id, label);
    this.listener?.();
  }

  remove(id: string): void {
    if (this.items.delete(id)) {
      this.listener?.();
    }
  }

  list(): SessionInfo[] {
    return [...this.items].map(([id, label]) => ({ id, label }));
  }

  onChange(listener: () => void): void {
    this.listener = listener;
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm test`
Expected: `sessionRegistry.test.mjs` … all assertions pass, exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/sessionRegistry.ts test/sessionRegistry.test.mjs
git commit -m "feat: pure session registry"
```

---

## Task 5: Integrate the registry into `VncSessionManager`

**Files:**
- Modify: `src/vncPanel.ts`

- [ ] **Step 1: Add imports and `crypto` usage**

In `src/vncPanel.ts`, the top already imports `crypto`. Add after the existing imports:

```ts
import { SessionRegistry, SessionInfo } from './sessionRegistry';
```

- [ ] **Step 2: Replace the `VncSessionManager` class**

Replace the entire `VncSessionManager` class (currently lines ~24–84) with:

```ts
/** Owns the webview panels and their associated TCP↔WS bridges. */
export class VncSessionManager {
  private readonly sessions = new Map<string, VncSession>();
  private active: VncSession | undefined;
  private readonly registry = new SessionRegistry();
  private readonly _onDidChangeSessions = new vscode.EventEmitter<void>();
  readonly onDidChangeSessions = this._onDidChangeSessions.event;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.registry.onChange(() => this._onDidChangeSessions.fire());
  }

  async connect(request: ConnectionRequest, options: RfbOptions): Promise<void> {
    // Reveal an existing session to the same target instead of duplicating it.
    const existing = this.findByTarget(request.host, request.port);
    if (existing) {
      existing.reveal();
      this.active = existing;
      return;
    }

    let bridge: VncBridge;
    try {
      bridge = await createBridge({ host: request.host, port: request.port });
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Remote VNC: could not open a local bridge — ${describeError(err)}`
      );
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      `VNC · ${request.label}`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
      }
    );

    const id = crypto.randomUUID();
    const session = new VncSession(id, request, panel, bridge, options, this.context);
    this.sessions.set(id, session);
    this.registry.add(id, request.label);
    this.active = session;

    panel.onDidChangeViewState((e) => {
      if (e.webviewPanel.active) {
        this.active = session;
      }
    });
    panel.onDidDispose(() => {
      this.sessions.delete(id);
      this.registry.remove(id);
      if (this.active === session) {
        this.active = this.sessions.values().next().value;
      }
    });
  }

  /** Sessions currently open, for the Active Sessions tree view. */
  getSessions(): SessionInfo[] {
    return this.registry.list();
  }

  /** Bring a session's panel to the foreground. */
  reveal(id: string): void {
    this.sessions.get(id)?.reveal();
  }

  /** Tear down a specific session. */
  disconnect(id: string): void {
    this.sessions.get(id)?.dispose();
  }

  disconnectActive(): void {
    if (!this.active) {
      void vscode.window.showInformationMessage('Remote VNC: no active session.');
      return;
    }
    this.active.dispose();
  }

  dispose(): void {
    for (const session of [...this.sessions.values()]) {
      session.dispose();
    }
    this._onDidChangeSessions.dispose();
  }

  private findByTarget(host: string, port: number): VncSession | undefined {
    for (const s of this.sessions.values()) {
      if (s.matches(host, port)) {
        return s;
      }
    }
    return undefined;
  }
}
```

- [ ] **Step 3: Update the `VncSession` constructor and add `id`/`reveal`/`matches`**

Replace the `VncSession` class header and constructor signature (currently lines ~86–131) so it takes an `id` and `request` first and records the target. Replace:

```ts
/** A single VNC viewer panel. */
class VncSession {
  private readonly disposables: vscode.Disposable[] = [];
  private pendingConnect: ExtensionMessage | undefined;
  private disposed = false;
  /** Set once a specific bridge-side reason has been surfaced, so the webview's
   *  generic "closed unexpectedly" toast for the same failure is suppressed. */
  private bridgeReasonShown = false;

  constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly bridge: VncBridge,
    request: ConnectionRequest,
    options: RfbOptions,
    context: vscode.ExtensionContext
  ) {
```

with:

```ts
/** A single VNC viewer panel. */
class VncSession {
  private readonly disposables: vscode.Disposable[] = [];
  private pendingConnect: ExtensionMessage | undefined;
  private disposed = false;
  /** Set once a specific bridge-side reason has been surfaced, so the webview's
   *  generic "closed unexpectedly" toast for the same failure is suppressed. */
  private bridgeReasonShown = false;
  private readonly host: string;
  private readonly port: number;

  constructor(
    readonly id: string,
    request: ConnectionRequest,
    private readonly panel: vscode.WebviewPanel,
    private readonly bridge: VncBridge,
    options: RfbOptions,
    context: vscode.ExtensionContext
  ) {
    this.host = request.host;
    this.port = request.port;
```

(The rest of the constructor body — `panel.webview.html = …` onward — is unchanged.)

- [ ] **Step 4: Add `reveal` and `matches` methods**

In `VncSession`, immediately before the existing `dispose()` method, add:

```ts
  reveal(): void {
    this.panel.reveal();
  }

  matches(host: string, port: number): boolean {
    return this.host === host && this.port === port;
  }
```

- [ ] **Step 5: Verify typecheck and build**

Run: `npm run typecheck`
Expected: no output, exit 0.

Run: `npm run build`
Expected: bundles written, no errors.

- [ ] **Step 6: Commit**

```bash
git add src/vncPanel.ts
git commit -m "feat: session registry + reveal/disconnect/dedupe in VncSessionManager"
```

---

## Task 6: Connections tree provider (`src/connectionsView.ts`)

**Files:**
- Create: `src/connectionsView.ts`

- [ ] **Step 1: Create `src/connectionsView.ts`**

```ts
import * as vscode from 'vscode';
import { ConnectionEntry, DEFAULT_PORT, SavedConnection, collectConnections } from './connections';

/** A saved-connection row in the Saved Connections tree. */
export class ConnectionTreeItem extends vscode.TreeItem {
  constructor(public readonly entry: ConnectionEntry) {
    super(entry.name, vscode.TreeItemCollapsibleState.None);
    const address = `${entry.host}:${entry.port ?? DEFAULT_PORT}`;
    this.description = address;
    this.tooltip = `${entry.name} — ${address}`;
    this.iconPath = new vscode.ThemeIcon('vm');
    this.contextValue = 'remoteVnc.connection';
    this.command = {
      command: 'remoteVnc.connectConnection',
      title: 'Connect',
      arguments: [this],
    };
  }
}

/** Backs the "Saved Connections" view. */
export class ConnectionsTreeProvider
  implements vscode.TreeDataProvider<ConnectionTreeItem>, vscode.Disposable
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('remoteVnc.connections')) {
          this.refresh();
        }
      }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => this.refresh())
    );
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: ConnectionTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): ConnectionTreeItem[] {
    const config = vscode.workspace.getConfiguration('remoteVnc');
    const entries = collectConnections(
      config.inspect<SavedConnection[]>('connections'),
      vscode.workspace.isTrusted
    );
    return entries.map((entry) => new ConnectionTreeItem(entry));
  }

  dispose(): void {
    for (const d of this.disposables.splice(0)) {
      d.dispose();
    }
    this._onDidChangeTreeData.dispose();
  }
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: no output, exit 0. (The provider is not yet registered; that happens in Task 10.)

- [ ] **Step 3: Commit**

```bash
git add src/connectionsView.ts
git commit -m "feat: Saved Connections tree provider"
```

---

## Task 7: Sessions tree provider (`src/sessionsView.ts`)

**Files:**
- Create: `src/sessionsView.ts`

- [ ] **Step 1: Create `src/sessionsView.ts`**

```ts
import * as vscode from 'vscode';
import { VncSessionManager } from './vncPanel';
import { SessionInfo } from './sessionRegistry';

/** An active-session row in the Active Sessions tree. */
export class SessionTreeItem extends vscode.TreeItem {
  constructor(public readonly session: SessionInfo) {
    super(session.label, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.green'));
    this.contextValue = 'remoteVnc.session';
    this.command = {
      command: 'remoteVnc.revealSession',
      title: 'Reveal',
      arguments: [this],
    };
  }
}

/** Backs the "Active Sessions" view. */
export class SessionsTreeProvider
  implements vscode.TreeDataProvider<SessionTreeItem>, vscode.Disposable
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly sub: vscode.Disposable;

  constructor(private readonly manager: VncSessionManager) {
    this.sub = manager.onDidChangeSessions(() => this._onDidChangeTreeData.fire());
  }

  getTreeItem(element: SessionTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): SessionTreeItem[] {
    return this.manager.getSessions().map((s) => new SessionTreeItem(s));
  }

  dispose(): void {
    this.sub.dispose();
    this._onDidChangeTreeData.dispose();
  }
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: no output, exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/sessionsView.ts
git commit -m "feat: Active Sessions tree provider"
```

---

## Task 8: Activity Bar icon (`resources/remote-vnc.svg`)

**Files:**
- Create: `resources/remote-vnc.svg`

- [ ] **Step 1: Create the SVG**

Create `resources/remote-vnc.svg` (monochrome, `currentColor`, 24×24 — a monitor):

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
  <path fill="currentColor" d="M3 4h18a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-7v2h3v2H8v-2h3v-2H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm1 2v9h16V6H4z"/>
</svg>
```

- [ ] **Step 2: Verify it is well-formed**

Run: `node -e "const s=require('fs').readFileSync('resources/remote-vnc.svg','utf8'); if(!s.includes('currentColor')||!s.includes('viewBox')) throw new Error('bad svg'); console.log('svg ok')"`
Expected: `svg ok`

- [ ] **Step 3: Commit**

```bash
git add resources/remote-vnc.svg
git commit -m "feat: Activity Bar icon"
```

---

## Task 9: `package.json` contributions

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add the new command declarations**

In `package.json`, inside `contributes.commands`, add these objects to the array (after the existing `remoteVnc.disconnect` entry; keep valid JSON commas). Note the `icon` fields drive the inline hover buttons:

```json
      {
        "command": "remoteVnc.connectConnection",
        "title": "Connect",
        "category": "Remote VNC",
        "icon": "$(plug)"
      },
      {
        "command": "remoteVnc.editConnection",
        "title": "Edit Connection…",
        "category": "Remote VNC",
        "icon": "$(edit)"
      },
      {
        "command": "remoteVnc.deleteConnection",
        "title": "Delete Connection",
        "category": "Remote VNC",
        "icon": "$(trash)"
      },
      {
        "command": "remoteVnc.forgetConnectionPassword",
        "title": "Forget Password",
        "category": "Remote VNC",
        "icon": "$(key)"
      },
      {
        "command": "remoteVnc.revealSession",
        "title": "Reveal Session",
        "category": "Remote VNC",
        "icon": "$(eye)"
      },
      {
        "command": "remoteVnc.disconnectSession",
        "title": "Disconnect",
        "category": "Remote VNC",
        "icon": "$(debug-disconnect)"
      }
```

- [ ] **Step 2: Give `addConnection` an icon (for the view title `+`)**

In `package.json`, the existing `remoteVnc.addConnection` command object gains an icon. Change:

```json
      {
        "command": "remoteVnc.addConnection",
        "title": "Add Saved Connection…",
        "category": "Remote VNC"
      },
```

to:

```json
      {
        "command": "remoteVnc.addConnection",
        "title": "Add Saved Connection…",
        "category": "Remote VNC",
        "icon": "$(add)"
      },
```

- [ ] **Step 3: Add `viewsContainers`, `views`, `viewsWelcome`, and `menus`**

In `package.json`, inside `contributes` (after the `configuration` object), add these four keys:

```json
    "viewsContainers": {
      "activitybar": [
        {
          "id": "remote-vnc",
          "title": "Remote VNC",
          "icon": "resources/remote-vnc.svg"
        }
      ]
    },
    "views": {
      "remote-vnc": [
        { "id": "remoteVnc.connectionsView", "name": "Saved Connections" },
        { "id": "remoteVnc.sessionsView", "name": "Active Sessions" }
      ]
    },
    "viewsWelcome": [
      {
        "view": "remoteVnc.connectionsView",
        "contents": "No saved connections yet.\n[Add Connection](command:remoteVnc.addConnection)"
      }
    ],
    "menus": {
      "view/title": [
        {
          "command": "remoteVnc.addConnection",
          "when": "view == remoteVnc.connectionsView",
          "group": "navigation"
        }
      ],
      "view/item/context": [
        {
          "command": "remoteVnc.connectConnection",
          "when": "view == remoteVnc.connectionsView && viewItem == remoteVnc.connection",
          "group": "inline@1"
        },
        {
          "command": "remoteVnc.editConnection",
          "when": "view == remoteVnc.connectionsView && viewItem == remoteVnc.connection",
          "group": "inline@2"
        },
        {
          "command": "remoteVnc.forgetConnectionPassword",
          "when": "view == remoteVnc.connectionsView && viewItem == remoteVnc.connection",
          "group": "inline@3"
        },
        {
          "command": "remoteVnc.deleteConnection",
          "when": "view == remoteVnc.connectionsView && viewItem == remoteVnc.connection",
          "group": "inline@4"
        },
        {
          "command": "remoteVnc.revealSession",
          "when": "view == remoteVnc.sessionsView && viewItem == remoteVnc.session",
          "group": "inline@1"
        },
        {
          "command": "remoteVnc.disconnectSession",
          "when": "view == remoteVnc.sessionsView && viewItem == remoteVnc.session",
          "group": "inline@2"
        }
      ]
    },
```

- [ ] **Step 4: Validate the manifest JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log('package.json valid')"`
Expected: `package.json valid`

- [ ] **Step 5: Commit**

```bash
git add package.json
git commit -m "feat: contribute Activity Bar container, views, and menus"
```

---

## Task 10: Wire providers and commands in `extension.ts`

**Files:**
- Modify: `src/extension.ts`

- [ ] **Step 1: Import the providers and tree-item types**

In `src/extension.ts`, add after the `connections` import:

```ts
import { ConnectionsTreeProvider, ConnectionTreeItem } from './connectionsView';
import { SessionsTreeProvider, SessionTreeItem } from './sessionsView';
```

- [ ] **Step 2: Register providers, tree views, and commands in `activate`**

Replace the body of `activate` (the existing `manager = …` through the closing `}` of `activate`) with:

```ts
export function activate(context: vscode.ExtensionContext): void {
  manager = new VncSessionManager(context);
  context.subscriptions.push(manager);

  const connectionsProvider = new ConnectionsTreeProvider();
  const sessionsProvider = new SessionsTreeProvider(manager);
  context.subscriptions.push(
    connectionsProvider,
    sessionsProvider,
    vscode.window.createTreeView('remoteVnc.connectionsView', { treeDataProvider: connectionsProvider }),
    vscode.window.createTreeView('remoteVnc.sessionsView', { treeDataProvider: sessionsProvider })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('remoteVnc.connect', () => connectAdHoc(context)),
    vscode.commands.registerCommand('remoteVnc.connectSaved', () => connectSaved(context)),
    vscode.commands.registerCommand('remoteVnc.addConnection', () => addConnection()),
    vscode.commands.registerCommand('remoteVnc.forgetPassword', () => forgetPassword(context)),
    vscode.commands.registerCommand('remoteVnc.disconnect', () => manager.disconnectActive()),
    vscode.commands.registerCommand('remoteVnc.connectConnection', (item: ConnectionTreeItem) =>
      connectEntry(context, item.entry)
    ),
    vscode.commands.registerCommand('remoteVnc.editConnection', (item: ConnectionTreeItem) =>
      editConnection(item.entry)
    ),
    vscode.commands.registerCommand('remoteVnc.deleteConnection', (item: ConnectionTreeItem) =>
      deleteConnection(context, item.entry)
    ),
    vscode.commands.registerCommand('remoteVnc.forgetConnectionPassword', (item: ConnectionTreeItem) =>
      forgetConnectionPassword(context, item.entry)
    ),
    vscode.commands.registerCommand('remoteVnc.revealSession', (item: SessionTreeItem) =>
      manager.reveal(item.session.id)
    ),
    vscode.commands.registerCommand('remoteVnc.disconnectSession', (item: SessionTreeItem) =>
      manager.disconnect(item.session.id)
    )
  );
}
```

- [ ] **Step 3: Extract `connectEntry` and rewrite `connectSaved` to use it**

Replace the existing `connectSaved` function with the following two functions (`connectEntry` holds the secret-fetch/prompt/store + connect flow; `connectSaved` just picks an entry):

```ts
async function connectSaved(context: vscode.ExtensionContext): Promise<void> {
  const saved = getSavedConnections();
  if (saved.length === 0) {
    const choice = await vscode.window.showInformationMessage(
      'Remote VNC: no saved connections yet.',
      'Add Connection…'
    );
    if (choice) {
      await addConnection();
    }
    return;
  }

  const pick = await vscode.window.showQuickPick(
    saved.map((c) => ({
      label: c.name,
      description: `${c.host}:${c.port ?? DEFAULT_PORT}`,
      connection: c,
    })),
    { title: 'Connect to Saved Server', placeHolder: 'Select a connection' }
  );
  if (!pick) {
    return;
  }
  await connectEntry(context, pick.connection);
}

/** Resolve the password (stored, or prompted-and-stored) and open the session. */
async function connectEntry(context: vscode.ExtensionContext, entry: ConnectionEntry): Promise<void> {
  const secretKey = secretKeyFor(entry);
  let password: string | undefined;
  try {
    password = await context.secrets.get(secretKey);
  } catch {
    password = undefined; // keychain locked/unavailable — fall through to prompt
  }
  if (password === undefined) {
    const entered = await promptPassword(
      'Password (leave empty if the server has no authentication — it will be stored securely)'
    );
    if (entered === undefined) {
      return;
    }
    password = entered;
    // Store even an empty password so we can tell "no auth needed" from
    // "not entered yet" and avoid re-prompting on every connect.
    try {
      await context.secrets.store(secretKey, password);
    } catch (err) {
      void vscode.window.showWarningMessage(
        `Remote VNC: could not save the password — ${describeError(err)}. Using it for this session only.`
      );
    }
  }

  await doConnect(context, {
    host: entry.host,
    port: entry.port ?? DEFAULT_PORT,
    password: password || undefined,
    label: entry.name,
  });
}
```

- [ ] **Step 4: Add `editConnection`, `deleteConnection`, and `forgetConnectionPassword`**

Add these three functions (next to `addConnection`):

```ts
async function editConnection(entry: ConnectionEntry): Promise<void> {
  const name = await vscode.window.showInputBox({
    title: 'Edit Connection (1/2)',
    prompt: 'Display name for this connection',
    value: entry.name,
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : 'A name is required.'),
  });
  if (!name) {
    return;
  }

  const address = await vscode.window.showInputBox({
    title: 'Edit Connection (2/2)',
    prompt: 'Server address: host, host:port, or host:display',
    value: `${entry.host}:${entry.port ?? DEFAULT_PORT}`,
    ignoreFocusOut: true,
    validateInput: (v) => (parseAddress(v) ? undefined : 'Enter a valid host (and optional port).'),
  });
  if (!address) {
    return;
  }
  const parsed = parseAddress(address);
  if (!parsed) {
    return;
  }

  await saveConnection(entry.scope, { name: name.trim(), host: parsed.host, port: parsed.port }, entry.name);
}

async function deleteConnection(context: vscode.ExtensionContext, entry: ConnectionEntry): Promise<void> {
  const confirm = await vscode.window.showWarningMessage(
    `Delete saved connection "${entry.name}"?`,
    { modal: true },
    'Delete'
  );
  if (confirm !== 'Delete') {
    return;
  }

  const config = vscode.workspace.getConfiguration('remoteVnc');
  const base = baseFor(config.inspect<SavedConnection[]>('connections'), entry.scope);
  await config.update('connections', base.filter((c) => c.name !== entry.name), entry.scope);

  // Offer to also clear the stored password, if any.
  try {
    const stored = await context.secrets.get(secretKeyFor(entry));
    if (stored !== undefined) {
      const choice = await vscode.window.showInformationMessage(
        `Also forget the stored password for "${entry.name}"?`,
        'Forget Password'
      );
      if (choice === 'Forget Password') {
        await context.secrets.delete(secretKeyFor(entry));
      }
    }
  } catch {
    /* secret storage unavailable — nothing to clean up */
  }
}

async function forgetConnectionPassword(
  context: vscode.ExtensionContext,
  entry: ConnectionEntry
): Promise<void> {
  try {
    await context.secrets.delete(secretKeyFor(entry));
    void vscode.window.showInformationMessage(
      `Remote VNC: cleared the stored password for "${entry.name}".`
    );
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Remote VNC: could not clear the password — ${describeError(err)}.`
    );
  }
}
```

- [ ] **Step 5: Verify typecheck and build**

Run: `npm run typecheck`
Expected: no output, exit 0.

Run: `npm run build`
Expected: bundles written, no errors.

- [ ] **Step 6: Run the unit tests (regression)**

Run: `npm test`
Expected: `connections.test.mjs` and `sessionRegistry.test.mjs` all pass, exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/extension.ts
git commit -m "feat: register sidebar views and connection/session commands"
```

---

## Task 11: Package and manual smoke test

**Files:** none (verification only)

- [ ] **Step 1: Package the .vsix and confirm contents**

Run: `npm run package && npx --yes @vscode/vsce ls --no-dependencies`
Expected: lists `resources/remote-vnc.svg`, `dist/extension.js`, `media/webview.js`; does **not** list `test/`, `src/`, or `docs/`.

> If `test/` or `docs/` appear, add `test/**` and `docs/**` to `.vscodeignore` and re-run.

- [ ] **Step 2: Launch the Extension Development Host**

Run: `code --new-window --extensionDevelopmentPath="$PWD" "$PWD"`
Expected: a new `[Extension Development Host]` window opens with a **Remote VNC** icon in the Activity Bar.

- [ ] **Step 3: Manual checks (visual)**

In the dev host, confirm:
- Activity Bar shows the Remote VNC icon; clicking it shows **Saved Connections** and **Active Sessions**.
- With no saved connections, the welcome view shows **Add Connection**.
- Add a connection (`127.0.0.1:5999` after `node scripts/mock-vnc-server.cjs 5999`, or a real device); it appears under Saved Connections with `host:port`.
- Hovering a connection shows **Connect / Edit / Forget / Delete**; clicking the row connects.
- A connected session appears under **Active Sessions**; its **Reveal** focuses the panel and **Disconnect** closes it.
- Editing a connection updates its row; deleting removes it (and offers to forget the password).

- [ ] **Step 4: Final commit (if any .vscodeignore change was needed)**

```bash
git add .vscodeignore
git commit -m "chore: exclude test/ and docs/ from the package"
```

(If no change was needed, skip.)

---

## Notes / decisions baked in

- **Activation:** contributed views auto-activate the extension when their container is first opened (VS Code ≥ 1.74), so `activationEvents` stays `[]`.
- **Stale session labels:** the Active Sessions row keeps the original connect label; a server-sent desktop name renames only the editor tab. Acceptable; out of scope to sync.
- **Scope-correct edits:** Edit/Delete write only to the scope the entry came from (`entry.scope`), preserving the global-precedence and trust-gate guarantees.
