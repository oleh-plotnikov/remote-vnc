# Auto-Reconnect Implementation Plan

> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-connection opt-in auto-reconnect — if a connection drops unexpectedly, retry forever every 10 s while showing an animated status icon, until it reconnects or the user disconnects.

**Architecture:** Reconnect is host-side in `VncSession`. The manager builds a `BridgeConnector` closure (createBridge + tunnel resolution) and hands it to the session; each attempt re-renders the webview with a fresh `clientUrl` (fresh CSP). The reconnect *decision* lives in a pure `ReconnectPolicy`. Per-session status (`connected`/`reconnecting`) drives an animated tree icon and a webview spinner.

**Tech Stack:** TypeScript, VS Code Extension API (`TreeDataProvider`, `ThemeIcon('sync~spin')`, webview messaging), esbuild bundles, Node assertion scripts via `test/bundle.mjs` (`vscode` stub).

---

## File structure

| File | Responsibility | Action |
| --- | --- | --- |
| `src/reconnectPolicy.ts` | Pure reconnect decision (reconnect vs stop, delay) | Create |
| `test/reconnectPolicy.test.mjs` | Unit tests for the policy | Create |
| `src/sessionRegistry.ts` | Add `status` to `SessionInfo` + `setStatus` | Modify |
| `test/sessionRegistry.test.mjs` | Update for `status` | Modify |
| `src/connections.ts` | Carry `autoReconnect` through `SavedConnection`/`collectConnections` | Modify |
| `test/connections.test.mjs` | Assert `autoReconnect` passthrough | Modify |
| `package.json` | `autoReconnect` in connections schema | Modify |
| `src/sessionsView.ts` | Animated icon by status | Modify |
| `test/sessionsView.test.mjs` | Icon id per status | Create |
| `media/webview.ts` + `media/style.css` | `reconnecting` message + CSS spinner | Modify |
| `src/vncPanel.ts` | Connector, `ConnectionRequest.autoReconnect`, `reconnecting` message, reconnect engine, manager wiring | Modify |
| `src/extension.ts` | `autoReconnect` in `connectEntry`/`doConnect` + add/edit quick pick | Modify |

---

## Task 1: ReconnectPolicy (pure decision)

**Files:**
- Create: `src/reconnectPolicy.ts`
- Test: `test/reconnectPolicy.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `test/reconnectPolicy.test.mjs`:

```js
import { load } from './bundle.mjs';

export default async function ({ ok, eq }) {
  const { ReconnectPolicy } = await load('reconnectPolicy.ts');
  const p = new ReconnectPolicy(10000);

  eq(p.onBridgeClosed({ autoReconnect: true, disposed: false, authFailed: false }), { action: 'reconnect', delayMs: 10000 }, 'reconnects when enabled, live, not auth-failed');
  eq(p.onBridgeClosed({ autoReconnect: false, disposed: false, authFailed: false }), { action: 'stop' }, 'stops when autoReconnect off');
  eq(p.onBridgeClosed({ autoReconnect: true, disposed: true, authFailed: false }), { action: 'stop' }, 'stops when disposed');
  eq(p.onBridgeClosed({ autoReconnect: true, disposed: false, authFailed: true }), { action: 'stop' }, 'stops after auth failure');
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Could not resolve "src/reconnectPolicy.ts"`.

- [ ] **Step 3: Create `src/reconnectPolicy.ts`**

```ts
export interface ReconnectContext {
  autoReconnect: boolean;
  disposed: boolean;
  authFailed: boolean;
}

export type ReconnectDecision =
  | { action: 'reconnect'; delayMs: number }
  | { action: 'stop' };

/**
 * Pure reconnect decision. Reconnect only when the connection is meant to
 * recover (autoReconnect on), the session is still live, and the drop was not
 * an authentication/security failure (which a retry cannot fix). Fixed interval,
 * unbounded attempts — the caller stops by disposing.
 */
export class ReconnectPolicy {
  constructor(private readonly intervalMs: number) {}

  onBridgeClosed(ctx: ReconnectContext): ReconnectDecision {
    if (ctx.autoReconnect && !ctx.disposed && !ctx.authFailed) {
      return { action: 'reconnect', delayMs: this.intervalMs };
    }
    return { action: 'stop' };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: `reconnectPolicy.test.mjs` passes; overall `N passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add src/reconnectPolicy.ts test/reconnectPolicy.test.mjs
git commit -m "feat: pure reconnect policy"
```

---

## Task 2: Session status in the registry

**Files:**
- Modify: `src/sessionRegistry.ts`
- Modify: `test/sessionRegistry.test.mjs`

- [ ] **Step 1: Update the test to expect status**

Replace the entire contents of `test/sessionRegistry.test.mjs` with:

```js
import { load } from './bundle.mjs';

export default async function ({ ok, eq }) {
  const { SessionRegistry } = await load('sessionRegistry.ts');
  const r = new SessionRegistry();
  let changes = 0;
  r.onChange(() => { changes += 1; });

  eq(r.list(), [], 'starts empty');

  r.add('a', 'Alpha');
  eq(r.list(), [{ id: 'a', label: 'Alpha', status: 'connected' }], 'add registers id+label, status connected');
  eq(changes, 1, 'add fires change');

  r.setStatus('a', 'reconnecting');
  eq(r.list(), [{ id: 'a', label: 'Alpha', status: 'reconnecting' }], 'setStatus updates status');
  eq(changes, 2, 'setStatus fires change');

  r.setStatus('a', 'reconnecting');
  eq(changes, 2, 'setStatus to the same value does not fire');

  r.setStatus('missing', 'reconnecting');
  eq(changes, 2, 'setStatus on unknown id does not fire');

  r.remove('a');
  eq(r.list(), [], 'remove drops the entry');
  eq(changes, 3, 'remove fires change');

  r.remove('missing');
  eq(changes, 3, 'removing an unknown id does not fire');
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `sessionRegistry.test.mjs` assertions about `status` / `setStatus` fail.

- [ ] **Step 3: Replace `src/sessionRegistry.ts`**

```ts
export type SessionStatus = 'connected' | 'reconnecting';

export interface SessionInfo {
  id: string;
  label: string;
  status: SessionStatus;
}

/**
 * Tracks active sessions (id → label + status) and notifies a single listener
 * on change. Pure (no vscode dependency) so it can be unit-tested in isolation.
 */
export class SessionRegistry {
  private readonly items = new Map<string, { label: string; status: SessionStatus }>();
  private listener: (() => void) | undefined;

  add(id: string, label: string): void {
    this.items.set(id, { label, status: 'connected' });
    this.listener?.();
  }

  setStatus(id: string, status: SessionStatus): void {
    const item = this.items.get(id);
    if (item && item.status !== status) {
      item.status = status;
      this.listener?.();
    }
  }

  remove(id: string): void {
    if (this.items.delete(id)) {
      this.listener?.();
    }
  }

  list(): SessionInfo[] {
    return [...this.items].map(([id, { label, status }]) => ({ id, label, status }));
  }

  onChange(listener: () => void): void {
    this.listener = listener;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: `sessionRegistry.test.mjs` passes. (typecheck will fail until Task 4/6 consume `status` — that's expected; do not run typecheck yet.)

- [ ] **Step 5: Commit**

```bash
git add src/sessionRegistry.ts test/sessionRegistry.test.mjs
git commit -m "feat: per-session status in the registry"
```

---

## Task 3: Carry `autoReconnect` on saved connections

**Files:**
- Modify: `src/connections.ts`
- Modify: `test/connections.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Add the passthrough assertion to the test**

In `test/connections.test.mjs`, add these lines just before the closing `}` of the exported function:

```js
  // autoReconnect is carried through
  const withFlag = collectConnections({ globalValue: [{ name: 'ar', host: 'h', autoReconnect: true }] }, true);
  eq(withFlag[0].autoReconnect, true, 'autoReconnect carried through');
  const noFlag = collectConnections({ globalValue: [{ name: 'n', host: 'h' }] }, true);
  eq(noFlag[0].autoReconnect, undefined, 'absent autoReconnect stays undefined');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `autoReconnect carried through` (currently `collectConnections` drops the field, so it is `undefined`).

- [ ] **Step 3: Add `autoReconnect` to the model**

In `src/connections.ts`, change the `SavedConnection` interface:

```ts
export interface SavedConnection {
  name: string;
  host: string;
  port?: number;
}
```

to:

```ts
export interface SavedConnection {
  name: string;
  host: string;
  port?: number;
  autoReconnect?: boolean;
}
```

Then in `collectConnections`, change the `byName.set(...)` line:

```ts
        byName.set(c.name, { name: c.name, host: c.host, port: c.port, scope });
```

to:

```ts
        byName.set(c.name, { name: c.name, host: c.host, port: c.port, autoReconnect: c.autoReconnect, scope });
```

- [ ] **Step 4: Add `autoReconnect` to the settings schema**

In `package.json`, inside `contributes.configuration.properties."remoteVnc.connections".items.properties`, after the `port` property object, add:

```json
              ,
              "autoReconnect": {
                "type": "boolean",
                "default": false,
                "description": "Automatically reconnect (every 10s) if this connection drops unexpectedly."
              }
```

- [ ] **Step 5: Run test + validate manifest**

Run: `npm test`
Expected: `connections.test.mjs` passes.

Run: `node -e "JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log('package.json valid')"`
Expected: `package.json valid`

- [ ] **Step 6: Commit**

```bash
git add src/connections.ts test/connections.test.mjs package.json
git commit -m "feat: per-connection autoReconnect field"
```

---

## Task 4: Animated session icon by status

**Files:**
- Modify: `src/sessionsView.ts`
- Test: `test/sessionsView.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `test/sessionsView.test.mjs`:

```js
import { load } from './bundle.mjs';

export default async function ({ ok, eq }) {
  const { SessionTreeItem } = await load('sessionsView.ts');

  const connected = new SessionTreeItem({ id: 'a', label: 'Alpha', status: 'connected' });
  eq(connected.iconPath.id, 'circle-filled', 'connected → circle-filled icon');

  const reconnecting = new SessionTreeItem({ id: 'b', label: 'Beta', status: 'reconnecting' });
  eq(reconnecting.iconPath.id, 'sync~spin', 'reconnecting → animated sync~spin icon');
  eq(reconnecting.tooltip, 'Reconnecting…', 'reconnecting → tooltip');
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `reconnecting → animated sync~spin icon` (current code always uses `circle-filled`).

- [ ] **Step 3: Update `SessionTreeItem` in `src/sessionsView.ts`**

Replace the `SessionTreeItem` class constructor body:

```ts
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
```

with:

```ts
  constructor(public readonly session: SessionInfo) {
    super(session.label, vscode.TreeItemCollapsibleState.None);
    if (session.status === 'reconnecting') {
      // `~spin` animates the codicon while the host retries the connection.
      this.iconPath = new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.yellow'));
      this.tooltip = 'Reconnecting…';
    } else {
      this.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.green'));
    }
    this.contextValue = 'remoteVnc.session';
    this.command = {
      command: 'remoteVnc.revealSession',
      title: 'Reveal',
      arguments: [this],
    };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: `sessionsView.test.mjs` passes.

- [ ] **Step 5: Commit**

```bash
git add src/sessionsView.ts test/sessionsView.test.mjs
git commit -m "feat: animated session icon while reconnecting"
```

---

## Task 5: Webview reconnecting spinner

**Files:**
- Modify: `media/webview.ts`
- Modify: `media/style.css`

- [ ] **Step 1: Accept the `reconnecting` message in the webview**

In `media/webview.ts`, change the `ExtensionMessage` union:

```ts
type ExtensionMessage =
  | { type: 'connect'; url: string; password?: string; options: RfbOptions }
  | { type: 'disconnect' };
```

to:

```ts
type ExtensionMessage =
  | { type: 'connect'; url: string; password?: string; options: RfbOptions }
  | { type: 'disconnect' }
  | { type: 'reconnecting' };
```

Change the `setStatus` signature to accept the new kind:

```ts
function setStatus(text: string, kind: 'info' | 'ok' | 'error'): void {
```

to:

```ts
function setStatus(text: string, kind: 'info' | 'ok' | 'error' | 'reconnecting'): void {
```

In the `window.addEventListener('message', …)` handler, change:

```ts
  if (msg.type === 'connect') {
    connect(msg);
  } else if (msg.type === 'disconnect') {
    disconnect();
    if (statusBar.dataset.kind !== 'error') {
      setStatus('Disconnected', 'info');
    }
  }
```

to:

```ts
  if (msg.type === 'connect') {
    connect(msg);
  } else if (msg.type === 'disconnect') {
    disconnect();
    if (statusBar.dataset.kind !== 'error') {
      setStatus('Disconnected', 'info');
    }
  } else if (msg.type === 'reconnecting') {
    disconnect();
    setStatus('Reconnecting…', 'reconnecting');
  }
```

- [ ] **Step 2: Add the spinner styling**

In `media/style.css`, append:

```css
.status[data-kind='reconnecting']::before {
  content: '';
  display: inline-block;
  width: 10px;
  height: 10px;
  margin-right: 6px;
  vertical-align: -1px;
  border: 2px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: rv-spin 0.8s linear infinite;
}

@keyframes rv-spin {
  to {
    transform: rotate(360deg);
  }
}
```

- [ ] **Step 3: Verify the build**

Run: `npm run build`
Expected: `dist/extension.js` and `media/webview.js` written, no errors.

- [ ] **Step 4: Commit**

```bash
git add media/webview.ts media/style.css
git commit -m "feat: webview reconnecting spinner"
```

---

## Task 6: Reconnect engine in `VncSession` + manager wiring

**Files:**
- Modify: `src/vncPanel.ts`

This is the core task. It (a) adds a `BridgeConnector` and `ConnectionRequest.autoReconnect`, (b) adds the `reconnecting` extension→webview message, (c) refactors `VncSessionManager.connect` to build a connector and pass a status callback, and (d) rewrites `VncSession` with the reconnect engine.

- [ ] **Step 1: Update imports, `ConnectionRequest`, and add the connector type + constant**

In `src/vncPanel.ts`, change the import of the registry:

```ts
import { SessionRegistry, SessionInfo } from './sessionRegistry';
```

to:

```ts
import { SessionRegistry, SessionInfo, SessionStatus } from './sessionRegistry';
import { ReconnectPolicy } from './reconnectPolicy';
```

Change `ConnectionRequest`:

```ts
export interface ConnectionRequest {
  host: string;
  port: number;
  password?: string;
  label: string;
}
```

to:

```ts
export interface ConnectionRequest {
  host: string;
  port: number;
  password?: string;
  label: string;
  autoReconnect?: boolean;
}
```

Change the `VIEW_TYPE` constant block to also declare the connector type and the interval:

```ts
const VIEW_TYPE = 'remoteVnc.screen';
```

to:

```ts
const VIEW_TYPE = 'remoteVnc.screen';

/** Fixed delay between reconnect attempts. */
const RECONNECT_INTERVAL_MS = 10000;

/** Opens a fresh bridge and resolves the URL the webview should dial. */
export type BridgeConnector = () => Promise<{ bridge: VncBridge; clientUrl: string }>;

interface VncSessionInit {
  id: string;
  request: ConnectionRequest;
  panel: vscode.WebviewPanel;
  connector: BridgeConnector;
  bridge: VncBridge;
  clientUrl: string;
  options: RfbOptions;
  context: vscode.ExtensionContext;
  onStatus: (status: SessionStatus) => void;
}
```

- [ ] **Step 2: Replace `VncSessionManager.connect`**

Replace the whole `connect` method (the manager method currently spanning the initial-bridge + panel + session creation) with:

```ts
  async connect(request: ConnectionRequest, options: RfbOptions): Promise<void> {
    // Reveal an existing session to the same target instead of duplicating it.
    const existing = this.findByTarget(request.host, request.port);
    if (existing) {
      existing.reveal();
      this.active = existing;
      return;
    }

    logger().info(`connect: ${request.label} -> ${request.host}:${request.port}`);

    // A fixed bridge port is opt-in, for remotes where asExternalUri does not
    // auto-forward (local Dev Containers): the user forwards this one known port.
    const listenPort = getBridgePort();

    // The connector opens a fresh bridge and resolves a webview-reachable URL.
    // The session reuses it for every reconnect attempt.
    const connector: BridgeConnector = async () => {
      const bridge = await createBridge({ host: request.host, port: request.port }, { listenPort });
      const clientUrl = await toWebviewWsUrl(bridge.url, listenPort !== undefined);
      return { bridge, clientUrl };
    };

    let first: { bridge: VncBridge; clientUrl: string };
    try {
      first = await connector();
    } catch (err) {
      logger().error(`could not open local bridge for ${request.host}:${request.port} — ${describeError(err)}`);
      const hint =
        listenPort && isAddrInUse(err)
          ? ` Port ${listenPort} (remoteVnc.bridgePort) is already in use — only one session is possible with a fixed bridge port; disconnect the other session or change the port.`
          : '';
      void vscode.window.showErrorMessage(
        `Remote VNC: could not open a local bridge — ${describeError(err)}.${hint}`
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
    const session = new VncSession({
      id,
      request,
      panel,
      connector,
      bridge: first.bridge,
      clientUrl: first.clientUrl,
      options,
      context: this.context,
      onStatus: (status) => this.registry.setStatus(id, status),
    });
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
```

(`getSessions`, `reveal`, `disconnect`, `disconnectActive`, `dispose`, `findByTarget` are unchanged.)

- [ ] **Step 3: Replace the `VncSession` class**

Replace the entire `VncSession` class (from `/** A single VNC viewer panel. */ class VncSession {` through its closing `}`) with:

```ts
/** A single VNC viewer panel with optional auto-reconnect. */
class VncSession {
  private readonly id: string;
  private readonly disposables: vscode.Disposable[] = [];
  private pendingConnect: ExtensionMessage | undefined;
  private disposed = false;
  /** Set once a specific bridge-side reason has been surfaced, so the webview's
   *  generic "closed unexpectedly" toast for the same failure is suppressed. */
  private bridgeReasonShown = false;
  private readonly host: string;
  private readonly port: number;
  private readonly label: string;
  private readonly password?: string;
  private readonly autoReconnect: boolean;
  private readonly options: RfbOptions;
  private readonly extensionUri: vscode.Uri;
  private readonly panel: vscode.WebviewPanel;
  private readonly connector: BridgeConnector;
  private readonly onStatus: (status: SessionStatus) => void;
  private readonly policy = new ReconnectPolicy(RECONNECT_INTERVAL_MS);
  private bridge: VncBridge;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private authFailed = false;

  constructor(init: VncSessionInit) {
    this.id = init.id;
    this.host = init.request.host;
    this.port = init.request.port;
    this.label = init.request.label;
    this.password = init.request.password;
    this.autoReconnect = init.request.autoReconnect ?? false;
    this.options = init.options;
    this.extensionUri = init.context.extensionUri;
    this.panel = init.panel;
    this.connector = init.connector;
    this.onStatus = init.onStatus;
    this.bridge = init.bridge;

    this.panel.webview.html = renderHtml(this.panel.webview, this.extensionUri, init.clientUrl);

    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg))
    );
    this.wireBridge(this.bridge);
    this.panel.onDidDispose(() => this.dispose());

    // The connection is sent only after the webview signals it is ready —
    // messages posted before the script's listener is attached can be dropped.
    this.pendingConnect = {
      type: 'connect',
      url: init.clientUrl,
      password: this.password,
      options: this.options,
    };
  }

  private wireBridge(bridge: VncBridge): void {
    bridge.onClosed((reason) => this.onBridgeClosed(reason));
  }

  /**
   * The bridge closed on its own (server died / network dropped) — a
   * user-initiated teardown goes through dispose()→finalize(), which never
   * fires onClosed, so reaching here means the connection dropped unexpectedly.
   */
  private onBridgeClosed(reason?: string): void {
    if (this.disposed) {
      return;
    }
    const decision = this.policy.onBridgeClosed({
      autoReconnect: this.autoReconnect,
      disposed: this.disposed,
      authFailed: this.authFailed,
    });
    if (decision.action === 'reconnect') {
      if (reason) {
        logger().info(`bridge dropped (${this.label}, ${this.host}:${this.port}): ${reason} — reconnecting in ${RECONNECT_INTERVAL_MS / 1000}s`);
      } else {
        logger().info(`bridge dropped (${this.label}, ${this.host}:${this.port}) — reconnecting in ${RECONNECT_INTERVAL_MS / 1000}s`);
      }
      this.scheduleReconnect(decision.delayMs);
      return;
    }
    // Stop: surface the drop the same way a non-reconnecting session does.
    void this.post({ type: 'disconnect' });
    if (reason) {
      this.bridgeReasonShown = true;
      logger().error(`bridge closed (${this.label}, ${this.host}:${this.port}): ${reason}`);
      void vscode.window.showWarningMessage(`Remote VNC (${this.label}): ${reason}`);
    } else {
      logger().info(`bridge closed cleanly (${this.label}, ${this.host}:${this.port}).`);
    }
  }

  private scheduleReconnect(delayMs: number): void {
    this.onStatus('reconnecting');
    void this.post({ type: 'reconnecting' });
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => void this.attemptReconnect(), delayMs);
  }

  private async attemptReconnect(): Promise<void> {
    if (this.disposed) {
      return;
    }
    let established: { bridge: VncBridge; clientUrl: string };
    try {
      established = await this.connector();
    } catch (err) {
      logger().warn(`reconnect: could not open bridge (${this.label}) — ${describeError(err)}; retrying in ${RECONNECT_INTERVAL_MS / 1000}s`);
      this.scheduleReconnect(RECONNECT_INTERVAL_MS);
      return;
    }
    if (this.disposed) {
      established.bridge.dispose();
      return;
    }
    // Swap in the fresh bridge and re-render so the CSP matches its origin.
    try {
      this.bridge.dispose();
    } catch {
      /* ignore */
    }
    this.bridge = established.bridge;
    this.wireBridge(this.bridge);
    this.bridgeReasonShown = false;
    this.pendingConnect = {
      type: 'connect',
      url: established.clientUrl,
      password: this.password,
      options: this.options,
    };
    this.panel.webview.html = renderHtml(this.panel.webview, this.extensionUri, established.clientUrl);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private onMessage(msg: WebviewMessage): void {
    switch (msg.type) {
      case 'ready':
        if (this.pendingConnect) {
          void this.post(this.pendingConnect);
          this.pendingConnect = undefined;
        }
        break;
      case 'status':
        if (msg.state === 'connected') {
          this.onStatus('connected');
        } else if (msg.state === 'disconnected' && msg.clean === false && !this.bridgeReasonShown && !this.autoReconnect) {
          logger().error(`webview reported an unclean disconnect (target ${this.host}:${this.port}).`);
          logger().show(true);
          void vscode.window.showWarningMessage(
            'Remote VNC: connection closed unexpectedly. See the "Remote VNC" output for details.'
          );
        }
        break;
      case 'desktopname':
        if (msg.name) {
          this.panel.title = `VNC · ${msg.name}`;
        }
        break;
      case 'securityfailure':
        // Auth/security failure: a retry cannot fix it, so stop reconnecting.
        this.authFailed = true;
        this.clearReconnectTimer();
        this.onStatus('connected');
        logger().error(`security failure${msg.reason ? ` — ${msg.reason}` : ''} (target ${this.host}:${this.port}).`);
        void vscode.window.showErrorMessage(
          `Remote VNC: authentication/security failure${msg.reason ? ` — ${msg.reason}` : ''}.`
        );
        break;
      case 'log':
        if (msg.level === 'error') {
          logger().error(`webview: ${msg.message}`);
        } else {
          logger().info(`webview: ${msg.message}`);
        }
        break;
    }
  }

  private post(message: ExtensionMessage): Thenable<boolean> {
    return this.panel.webview.postMessage(message);
  }

  reveal(): void {
    this.panel.reveal();
  }

  matches(host: string, port: number): boolean {
    return this.host === host && this.port === port;
  }

  dispose(): void {
    // panel.dispose() re-fires onDidDispose synchronously, which calls us again.
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.clearReconnectTimer();
    this.bridge.dispose();
    for (const d of this.disposables.splice(0)) {
      d.dispose();
    }
    this.panel.dispose();
  }
}
```

- [ ] **Step 4: Add `reconnecting` to the extension→webview message union**

In `src/vncPanel.ts`, change:

```ts
type ExtensionMessage =
  | { type: 'connect'; url: string; password?: string; options: RfbOptions }
  | { type: 'disconnect' };
```

to:

```ts
type ExtensionMessage =
  | { type: 'connect'; url: string; password?: string; options: RfbOptions }
  | { type: 'disconnect' }
  | { type: 'reconnecting' };
```

- [ ] **Step 5: Verify typecheck, tests, build**

Run: `npm run typecheck`
Expected: no output, exit 0.

Run: `npm test`
Expected: all test files pass.

Run: `npm run build`
Expected: bundles written, no errors.

- [ ] **Step 6: Commit**

```bash
git add src/vncPanel.ts
git commit -m "feat: host-side auto-reconnect engine in VncSession"
```

---

## Task 7: Wire `autoReconnect` through commands

**Files:**
- Modify: `src/extension.ts`

- [ ] **Step 1: Pass `autoReconnect` from the entry into the connection request**

In `src/extension.ts`, in `connectEntry`, change the `doConnect` call:

```ts
  await doConnect(context, {
    host: entry.host,
    port: entry.port ?? DEFAULT_PORT,
    password: password || undefined,
    label: entry.name,
  });
```

to:

```ts
  await doConnect(context, {
    host: entry.host,
    port: entry.port ?? DEFAULT_PORT,
    password: password || undefined,
    label: entry.name,
    autoReconnect: entry.autoReconnect,
  });
```

- [ ] **Step 2: Add a reusable auto-reconnect quick pick helper**

In `src/extension.ts`, add this function next to `promptPassword`:

```ts
/** Ask whether a saved connection should auto-reconnect. Returns undefined on cancel. */
async function promptAutoReconnect(current = false): Promise<boolean | undefined> {
  const pick = await vscode.window.showQuickPick(
    [
      { label: 'No', description: 'Do not reconnect automatically', value: false },
      { label: 'Yes', description: 'Reconnect every 10s if the connection drops', value: true },
    ],
    {
      title: 'Auto-reconnect',
      placeHolder: current ? 'Currently: Yes' : 'Currently: No',
    }
  );
  return pick?.value;
}
```

- [ ] **Step 3: Capture `autoReconnect` in `addConnection`**

In `addConnection`, replace:

```ts
  await saveConnection(target, { name: name.trim(), host: parsed.host, port: parsed.port });
```

with:

```ts
  const autoReconnect = await promptAutoReconnect();
  if (autoReconnect === undefined) {
    return;
  }
  await saveConnection(target, { name: name.trim(), host: parsed.host, port: parsed.port, autoReconnect });
```

- [ ] **Step 4: Capture `autoReconnect` in `editConnection`**

In `editConnection`, replace:

```ts
  await saveConnection(entry.scope, { name: name.trim(), host: parsed.host, port: parsed.port }, entry.name);
```

with:

```ts
  const autoReconnect = await promptAutoReconnect(entry.autoReconnect ?? false);
  if (autoReconnect === undefined) {
    return;
  }
  await saveConnection(entry.scope, { name: name.trim(), host: parsed.host, port: parsed.port, autoReconnect }, entry.name);
```

- [ ] **Step 5: Verify typecheck, tests, build**

Run: `npm run typecheck`
Expected: no output, exit 0.

Run: `npm test`
Expected: all test files pass.

Run: `npm run build`
Expected: bundles written, no errors.

- [ ] **Step 6: Commit**

```bash
git add src/extension.ts
git commit -m "feat: capture and pass autoReconnect through connect/add/edit"
```

---

## Task 8: Package and manual test

**Files:** none (verification only)

- [ ] **Step 1: Package**

Run: `npm run package && npx --yes @vscode/vsce ls --no-dependencies`
Expected: succeeds; lists `dist/extension.js`, `media/webview.js`; does not list `test/`, `src/`, `docs/`.

- [ ] **Step 2: Install into the active profile and reload**

Run: `code --profile "Barto profile" --install-extension "$PWD/remote-vnc-0.1.0.vsix" --force`
Then in VS Code: "Developer: Reload Window".

- [ ] **Step 3: Manual checks**

- Add a saved connection; the wizard now asks "Auto-reconnect" (Yes/No).
- Connect to it (a local mock or a real device). Kill the server: the **Active Sessions** icon switches to a spinning `sync~spin`, and the panel shows "Reconnecting…".
- Restart the server: within ~10 s the session reconnects, the icon returns to a green dot, and the screen comes back.
- Click **Disconnect** while reconnecting: retries stop and the session closes.
- A connection with auto-reconnect **off** shows the usual "closed unexpectedly" behaviour and does not retry.

---

## Notes / decisions baked in

- **CSP per attempt:** each reconnect re-renders the webview HTML, so `connect-src` matches the new bridge origin (local ephemeral port or remote forwarded authority).
- **Trigger:** `bridge.onClosed` firing ≡ a non-user drop (dispose uses `finalize()`, which never notifies). `authFailed` (from `securityfailure`) stops the loop.
- **Status meaning:** the tree icon spins while actively retrying; green means "not retrying" (connected, or idle after an auth-failure stop — the panel shows the real error).
- **Ad-hoc connects** don't auto-reconnect (no saved flag); only saved connections carry `autoReconnect`.
