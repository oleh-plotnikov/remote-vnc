# Control Channel and Hotkeys Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A script or an agent can list open panels and pull screenshots and recordings from them, and a human can do the same from the keyboard.

**Architecture:** An opt-in loopback HTTP server, bound to `127.0.0.1` on an ephemeral port with a single 24-byte token written to a `0600` file, exposes capture over five routes. A dispatcher command resolves "the panel in front of me" so one key binding can serve panels that today need three different commands.

**Tech Stack:** TypeScript, VS Code extension API, Node `http`, no new dependencies.

**Spec:** `docs/specs/2026-08-13-page-mirror-and-control-design.md`

## Global Constraints

- `remoteVnc.controlServer.enabled` defaults to **false**. Nothing listens until a user opts in.
- Bind `127.0.0.1` only, port `0`. Never a fixed port, never `0.0.0.0`.
- Token comparison is constant-time, the same way `vncBridge.tokensMatch` does it.
- **No input routes.** Screenshot, record, reload, list. Clicking and typing are out of scope and must not be added here.
- Captures through the server bypass the crop editor and return a path; `remoteVnc.screenshotCropEditor` continues to govern the interactive path only.
- Pure logic (routing, token check, target ids) lives in modules free of `vscode` and `http`, so `test/bundle.mjs` can load them.
- Existing tests must keep passing: `npm test`, `npm run typecheck`.

---

### Task 1: Route parsing and authorisation

**Files:**
- Create: `src/controlRoutes.ts`
- Test: `test/controlRoutes.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `parseControlRoute(method: string, path: string): ControlRoute | undefined`, `type ControlRoute = { kind: 'list' } | { kind: 'screenshot' | 'record' | 'recordStop' | 'reload'; id: string }`, `tokenOk(supplied: unknown, expected: string): boolean`.

- [ ] **Step 1: Write the failing test**

```js
import { load } from './bundle.mjs';

export default async function ({ ok, eq }) {
  const { parseControlRoute, tokenOk } = await load('controlRoutes.ts');

  eq(parseControlRoute('GET', '/targets'), { kind: 'list' }, 'list route');
  eq(parseControlRoute('POST', '/targets/abc/screenshot'), { kind: 'screenshot', id: 'abc' }, 'screenshot route');
  eq(parseControlRoute('POST', '/targets/abc/record'), { kind: 'record', id: 'abc' }, 'record route');
  eq(parseControlRoute('POST', '/targets/abc/record/stop'), { kind: 'recordStop', id: 'abc' }, 'record stop route');
  eq(parseControlRoute('POST', '/targets/abc/reload'), { kind: 'reload', id: 'abc' }, 'reload route');

  // method matters
  eq(parseControlRoute('GET', '/targets/abc/screenshot'), undefined, 'GET on a POST route is rejected');
  eq(parseControlRoute('POST', '/targets'), undefined, 'POST on the list route is rejected');

  // nothing else is routable
  eq(parseControlRoute('POST', '/targets/abc/click'), undefined, 'input routes do not exist');
  eq(parseControlRoute('GET', '/'), undefined, 'root is not routable');
  eq(parseControlRoute('GET', '/../etc/passwd'), undefined, 'traversal is not routable');

  // ids are opaque but bounded
  eq(parseControlRoute('POST', '/targets//screenshot'), undefined, 'empty id rejected');

  // token check
  ok(tokenOk('a'.repeat(48), 'a'.repeat(48)), 'equal tokens pass');
  ok(!tokenOk('a'.repeat(48), 'b'.repeat(48)), 'different tokens fail');
  ok(!tokenOk('short', 'a'.repeat(48)), 'length mismatch fails');
  ok(!tokenOk(undefined, 'a'.repeat(48)), 'missing token fails');
  ok(!tokenOk(null, 'a'.repeat(48)), 'null token fails');
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module 'controlRoutes.ts'`.

- [ ] **Step 3: Write minimal implementation**

```ts
import * as crypto from 'crypto';

export type ControlRoute =
  | { kind: 'list' }
  | { kind: 'screenshot' | 'record' | 'recordStop' | 'reload'; id: string };

/**
 * The complete routing table, as a function. Anything not matched here is a
 * 404 — including input routes, which deliberately do not exist: a leaked
 * token must buy a view, not actions taken in the user's name.
 */
export function parseControlRoute(method: string, path: string): ControlRoute | undefined {
  if (method === 'GET' && path === '/targets') {
    return { kind: 'list' };
  }
  if (method !== 'POST') {
    return undefined;
  }
  const m = /^\/targets\/([A-Za-z0-9_-]{1,64})\/(screenshot|record|record\/stop|reload)$/.exec(path);
  if (!m) {
    return undefined;
  }
  const [, id, action] = m;
  if (action === 'record/stop') {
    return { kind: 'recordStop', id };
  }
  return { kind: action as 'screenshot' | 'record' | 'reload', id };
}

/**
 * Constant-time token comparison — the same reasoning as vncBridge's
 * tokensMatch: a length-or-content early return leaks the token one byte at a
 * time to a local process that can retry freely.
 */
export function tokenOk(supplied: unknown, expected: string): boolean {
  if (typeof supplied !== 'string' || supplied.length !== expected.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test && npm run typecheck`
Expected: PASS both, assertion count up by 16.

- [ ] **Step 5: Commit**

```bash
git add src/controlRoutes.ts test/controlRoutes.test.mjs
git commit -m "feat: add control-channel routing and token check"
```

---

### Task 2: The panel registry

**Files:**
- Create: `src/panelRegistry.ts`
- Modify: `src/pagePanel.ts`, `src/vncPanel.ts` (register and unregister)
- Test: `test/panelRegistry.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `registerPanel(entry: PanelEntry): void`, `unregisterPanel(id: string): void`, `listPanels(): PanelSummary[]`, `getPanel(id: string): PanelEntry | undefined`, `type PanelEntry = { id: string; name: string; kind: 'page' | 'session'; mirrored: boolean; screenshot(): Promise<string>; record(): Promise<void>; recordStop(): Promise<string>; reload(): Promise<void> }`, `type PanelSummary = { id: string; name: string; kind: 'page' | 'session'; mirrored: boolean }`.

One registry serves both the control server and the hotkey dispatcher — without
it each would grow its own way of finding "the panel".

- [ ] **Step 1: Write the failing test**

```js
import { load } from './bundle.mjs';

export default async function ({ ok, eq }) {
  const { registerPanel, unregisterPanel, listPanels, getPanel } = await load('panelRegistry.ts');

  const stub = (id, name, kind, mirrored) => ({
    id, name, kind, mirrored,
    screenshot: async () => `/tmp/${id}.png`,
    record: async () => {},
    recordStop: async () => `/tmp/${id}.webm`,
    reload: async () => {},
  });

  eq(listPanels(), [], 'starts empty');

  registerPanel(stub('p1', 'design', 'page', true));
  registerPanel(stub('s1', 'kiosk', 'session', false));

  eq(listPanels().map((p) => p.id).sort(), ['p1', 's1'], 'both listed');
  eq(listPanels()[0].screenshot, undefined, 'summaries carry no callables');
  eq(getPanel('p1').name, 'design', 'lookup by id');
  eq(getPanel('nope'), undefined, 'unknown id → undefined');

  // re-registering the same id replaces rather than duplicates
  registerPanel(stub('p1', 'renamed', 'page', true));
  eq(listPanels().filter((p) => p.id === 'p1').length, 1, 'no duplicate on re-register');
  eq(getPanel('p1').name, 'renamed', 're-register replaces');

  unregisterPanel('p1');
  eq(listPanels().map((p) => p.id), ['s1'], 'unregister removes');
  unregisterPanel('gone');
  ok(true, 'unregistering an unknown id does not throw');
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module 'panelRegistry.ts'`.

- [ ] **Step 3: Write minimal implementation**

```ts
/** What a panel can do on request, whoever is asking. */
export interface PanelEntry {
  id: string;
  name: string;
  kind: 'page' | 'session';
  mirrored: boolean;
  screenshot(): Promise<string>;
  record(): Promise<void>;
  recordStop(): Promise<string>;
  reload(): Promise<void>;
}

/** The wire shape: identity only, never the callables. */
export type PanelSummary = Pick<PanelEntry, 'id' | 'name' | 'kind' | 'mirrored'>;

const panels = new Map<string, PanelEntry>();

export function registerPanel(entry: PanelEntry): void {
  panels.set(entry.id, entry);
}

export function unregisterPanel(id: string): void {
  panels.delete(id);
}

export function getPanel(id: string): PanelEntry | undefined {
  return panels.get(id);
}

export function listPanels(): PanelSummary[] {
  return [...panels.values()].map(({ id, name, kind, mirrored }) => ({ id, name, kind, mirrored }));
}
```

- [ ] **Step 4: Wire the producers**

In `pagePanel.ts`, call `registerPanel` when a panel is created and
`unregisterPanel` in its `onDidDispose`. Use a stable id: a short hash of the
URL, so a reopened page keeps its id across sessions. An iframe (non-mirrored)
page registers with `mirrored: false` and a `screenshot` that rejects with
`Error('page is not mirrored')` — the route exists, the capability does not, and
the caller gets a clear reason rather than a blank PNG.

Do the same in `vncPanel.ts` for sessions, delegating to the commands that
already implement capture there.

- [ ] **Step 5: Run tests and commit**

Run: `npm test && npm run typecheck`

```bash
git add src/panelRegistry.ts src/pagePanel.ts src/vncPanel.ts test/panelRegistry.test.mjs
git commit -m "feat: track open panels in one registry"
```

---

### Task 3: The loopback control server

**Files:**
- Create: `src/controlServer.ts`
- Modify: `src/extension.ts` (start on activate when enabled, stop on deactivate), `package.json` (setting)
- Test: manual

**Interfaces:**
- Consumes: `parseControlRoute`, `tokenOk` (Task 1); `listPanels`, `getPanel` (Task 2).
- Produces: `startControlServer(context: vscode.ExtensionContext): Promise<() => void>` returning a stop function.

- [ ] **Step 1: Implement**

```ts
import * as crypto from 'crypto';
import * as http from 'http';
import * as vscode from 'vscode';

import { parseControlRoute, tokenOk } from './controlRoutes';
import { getPanel, listPanels } from './panelRegistry';
import { logger } from './log';

/**
 * A loopback capture API, off unless the user turns it on.
 *
 * Same shape as vncBridge's authorisation: 127.0.0.1, an ephemeral port, and a
 * single random token. The token is written to a 0600 file rather than printed,
 * so the filesystem is what authenticates the caller.
 */
export async function startControlServer(
  context: vscode.ExtensionContext
): Promise<() => void> {
  const token = crypto.randomBytes(24).toString('hex');

  const server = http.createServer((req, res) => {
    const send = (code: number, body: unknown): void => {
      const json = JSON.stringify(body);
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(json);
    };

    if (!tokenOk(req.headers['x-remote-vnc-token'], token)) {
      send(401, { error: 'unauthorized' });
      return;
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const route = parseControlRoute(req.method ?? 'GET', url.pathname);
    if (!route) {
      send(404, { error: 'not found' });
      return;
    }
    if (route.kind === 'list') {
      send(200, { targets: listPanels() });
      return;
    }
    const panel = getPanel(route.id);
    if (!panel) {
      send(404, { error: 'unknown target' });
      return;
    }
    const run =
      route.kind === 'screenshot'
        ? panel.screenshot()
        : route.kind === 'record'
          ? panel.record().then(() => 'recording')
          : route.kind === 'recordStop'
            ? panel.recordStop()
            : panel.reload().then(() => 'reloaded');
    run.then(
      (result) => send(200, { result }),
      (err: Error) => send(500, { error: err.message })
    );
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const endpoint = { url: `http://127.0.0.1:${port}`, token };

  const file = vscode.Uri.joinPath(context.globalStorageUri, 'control.json');
  await vscode.workspace.fs.createDirectory(context.globalStorageUri);
  await vscode.workspace.fs.writeFile(file, Buffer.from(JSON.stringify(endpoint), 'utf8'));
  // workspace.fs has no mode argument; tighten it directly.
  const { chmodSync } = await import('fs');
  chmodSync(file.fsPath, 0o600);

  logger().info(`control: listening on ${endpoint.url}, endpoint at ${file.fsPath}`);

  return () => {
    server.close();
    void vscode.workspace.fs.delete(file).then(undefined, () => undefined);
  };
}
```

- [ ] **Step 2: Register the setting**

In `package.json`, add `remoteVnc.controlServer.enabled`, `type: boolean`,
`default: false`, with a description that says plainly what it opens: a
loopback API that can capture the content of open panels, authorised by a token
file readable only by this user.

In `extension.ts`, start it on activate when enabled, stop on deactivate, and
react to the setting changing without requiring a reload.

- [ ] **Step 3: Verify by hand**

```bash
EP=~/Library/Application\ Support/Code/User/globalStorage/olehplotnikov.remote-vnc/control.json
URL=$(node -p "require('$EP').url"); TOK=$(node -p "require('$EP').token")

curl -s -H "x-remote-vnc-token: $TOK" $URL/targets              # lists open panels
curl -s $URL/targets                                            # 401
curl -s -H "x-remote-vnc-token: $TOK" $URL/nope                 # 404
curl -s -X POST -H "x-remote-vnc-token: $TOK" $URL/targets/<id>/screenshot
```

Expected: the list shows every open panel; the unauthorised call is `401`; the
screenshot call returns a path and the file exists and shows the panel.

Also confirm `stat -f %Lp "$EP"` prints `600`.

- [ ] **Step 4: Commit**

```bash
git add src/controlServer.ts src/extension.ts package.json
git commit -m "feat: add an opt-in loopback control server"
```

---

### Task 4: Hotkeys with a dispatcher

**Files:**
- Modify: `src/extension.ts` (dispatcher commands, context key), `package.json` (commands, keybindings)
- Test: manual

**Interfaces:**
- Consumes: `listPanels`, `getPanel` (Task 2).
- Produces: `remoteVnc.screenshotFocused`, `remoteVnc.recordFocusedToggle`.

- [ ] **Step 1: Track which panel has focus**

Every panel already has `onDidChangeViewState`. On `active === true`, record its
id as the focused panel and set the context key:

```ts
void vscode.commands.executeCommand('setContext', 'remoteVnc.panelFocused', true);
```

On `active === false` for the currently-focused panel, clear both. Without the
context key the chords would fire while the user is typing in a source file.

- [ ] **Step 2: Implement the dispatchers**

`remoteVnc.screenshotFocused` looks up the focused panel and calls its
`screenshot()`; if none is focused, show an information message saying so
rather than failing silently.

`remoteVnc.recordFocusedToggle` calls `record()` or `recordStop()` depending on
the panel's current recording state — one toggle, because a start/stop pair is
awkward on a keyboard and the extension already knows the state.

- [ ] **Step 3: Register the bindings**

```json
"keybindings": [
  {
    "command": "remoteVnc.screenshotFocused",
    "key": "ctrl+alt+s",
    "mac": "cmd+alt+s",
    "when": "remoteVnc.panelFocused"
  },
  {
    "command": "remoteVnc.recordFocusedToggle",
    "key": "ctrl+alt+r",
    "mac": "cmd+alt+r",
    "when": "remoteVnc.panelFocused"
  }
]
```

- [ ] **Step 4: Verify by hand**

1. Focus a mirrored page tab, press the screenshot chord: a capture is saved.
2. Press the record chord, wait two seconds, press it again: a recording is saved.
3. Focus a source file and press both chords: nothing happens, and whatever the
   chord means in the editor still works.
4. Repeat step 1 on a VNC session tab: same result, same command.

- [ ] **Step 5: Commit**

```bash
git add src/extension.ts package.json
git commit -m "feat: add screenshot and record hotkeys"
```

---

## Self-Review

**Spec coverage.** Opt-in default-false setting → Task 3 step 2. Loopback, ephemeral port, 24-byte token, `0600` file → Task 3 step 1. The five routes → Task 1. No input routes → Task 1's implementation comment and its test. Crop-editor bypass → Task 2's `PanelEntry.screenshot` returns a path directly; the interactive command keeps its own path. File-queue alternative → rejected in the spec, nothing to implement. Hotkeys, dispatcher, `panelFocused` context, single record toggle → Task 4.

**Placeholders.** None. Every code step carries its code; every manual step lists the commands to run and what to expect.

**Type consistency.** `PanelEntry` and `PanelSummary` are defined once in Task 2 and consumed unchanged in Tasks 3 and 4. `ControlRoute` is defined in Task 1 and exhaustively handled in Task 3's dispatch chain. `screenshot()` and `recordStop()` return `Promise<string>` (a path) in every use; `record()` and `reload()` return `Promise<void>` and are adapted to a string result at the route layer.

**Dependency on the other plan.** Task 2 registers page panels whether or not
they are mirrored, so this plan is independently useful: it captures VNC
sessions on its own. Mirrored-page capture only works once
`2026-08-13-page-mirror.md` lands, and a non-mirrored page rejects with a
readable reason until then.
