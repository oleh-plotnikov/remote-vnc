# Page Mirroring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A saved Web Page can render as a live mirror of a real Chrome tab, so its pixels belong to the webview and screenshot/recording work exactly as they do for VNC.

**Architecture:** The extension host launches one headless Chrome with an ephemeral DevTools port, opens one CDP target per mirrored page, and streams `Page.screencastFrame` JPEGs to the webview, which draws them to a canvas. Input travels back through `Input.dispatch*`. The host owns the CDP socket; the webview only ever sees frame data and sends input intents.

**Tech Stack:** TypeScript, VS Code extension API, `ws` (already bundled), Chrome DevTools Protocol, esbuild.

**Spec:** `docs/specs/2026-08-13-page-mirror-and-control-design.md`

## Global Constraints

- Node-side modules that tests must load may not import `vscode` or `ws` at module top; keep protocol and discovery logic in pure modules (`test/bundle.mjs` builds against a `vscode` stub only).
- `esbuild.js` banners are load-bearing: any new bundle needs its own banner naming the third-party code inside it, and `test/bundleAttribution.test.mjs` will fail otherwise.
- Mirror is opt-in per page. `mirror` absent or not exactly `true` means the current iframe behaviour, unchanged.
- No `--remote-debugging-port=9222`. Always `0`, and read the real port from Chrome's stderr.
- Every `Page.screencastFrame` must be answered with `Page.screencastFrameAck`.
- Existing tests must keep passing: `npm test` (274 assertions), `npm run typecheck`.

---

### Task 1: Chrome discovery

**Files:**
- Create: `src/chromeLocator.ts`
- Test: `test/chromeLocator.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `chromeCandidates(platform: NodeJS.Platform): string[]`, `pickChrome(candidates: string[], exists: (p: string) => boolean): string | undefined`.

- [ ] **Step 1: Write the failing test**

```js
import { load } from './bundle.mjs';

export default async function ({ ok, eq }) {
  const { chromeCandidates, pickChrome } = await load('chromeLocator.ts');

  const mac = chromeCandidates('darwin');
  ok(mac[0].includes('Google Chrome.app'), 'macOS probes Chrome.app first');
  ok(mac.some((p) => p.includes('Chromium')), 'macOS also probes Chromium');

  const win = chromeCandidates('win32');
  ok(win.some((p) => p.includes('Program Files')), 'windows probes Program Files');

  const linux = chromeCandidates('linux');
  ok(linux.includes('google-chrome'), 'linux probes a bare PATH name');

  // pickChrome returns the FIRST candidate that exists
  const present = new Set(['/b', '/c']);
  eq(pickChrome(['/a', '/b', '/c'], (p) => present.has(p)), '/b', 'first existing wins');
  eq(pickChrome(['/a'], () => false), undefined, 'none found → undefined');
  eq(pickChrome([], () => true), undefined, 'empty list → undefined');
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module 'chromeLocator.ts'`.

- [ ] **Step 3: Write minimal implementation**

```ts
/**
 * Where Chrome lives, per platform. Chromium and Edge are accepted too: the
 * DevTools protocol is the same, and a user who has only Chromium should not
 * be told to install Chrome.
 *
 * Bare names (no slash) are PATH lookups, resolved by the caller's `exists`.
 */
export function chromeCandidates(platform: NodeJS.Platform): string[] {
  if (platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ];
  }
  if (platform === 'win32') {
    return [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    ];
  }
  return ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'];
}

/** The first candidate that exists, or undefined when none do. */
export function pickChrome(
  candidates: string[],
  exists: (path: string) => boolean
): string | undefined {
  return candidates.find(exists);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS, assertion count up by 7.

- [ ] **Step 5: Commit**

```bash
git add src/chromeLocator.ts test/chromeLocator.test.mjs
git commit -m "feat: locate a Chrome-family binary per platform"
```

---

### Task 2: `mirror` in the saved-page schema

**Files:**
- Modify: `src/pages.ts:4-15` (interface), `src/pages.ts:60-70` (collect loop)
- Test: `test/pages.test.mjs` (append)

**Interfaces:**
- Consumes: nothing.
- Produces: `SavedPage.mirror?: boolean`, carried through `collectPages` into `PageEntry`.

- [ ] **Step 1: Write the failing test**

Append inside the existing default export in `test/pages.test.mjs`:

```js
  // mirror flag: only an exact `true` enables it
  const mirrorInspect = {
    globalValue: [
      { name: 'm', url: 'http://h/', mirror: true },
      { name: 'n', url: 'http://h/', mirror: 'yes' },
      { name: 'o', url: 'http://h/' },
    ],
  };
  const got = collectPages(mirrorInspect, true);
  eq(got.find((p) => p.name === 'm').mirror, true, 'mirror:true survives');
  eq(got.find((p) => p.name === 'n').mirror, undefined, 'non-boolean mirror is dropped');
  eq(got.find((p) => p.name === 'o').mirror, undefined, 'absent mirror stays absent');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `mirror:true survives` (value is `undefined`).

- [ ] **Step 3: Write minimal implementation**

In `src/pages.ts`, add to `SavedPage`:

```ts
  /**
   * Render this page as a live mirror of a real Chrome tab instead of an
   * iframe. Costs a Chrome process and makes the tab a picture rather than a
   * document (no text selection, no in-page find) — in exchange the pixels are
   * ours, so screenshot and recording work. Opt-in per page for that reason.
   */
  mirror?: boolean;
```

In the `collectPages` loop, replace the `byName.set(...)` call with:

```ts
        byName.set(p.name, {
          name: p.name,
          url: p.url,
          ...size,
          ...(p.mirror === true ? { mirror: true as const } : {}),
          scope,
        });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test && npm run typecheck`
Expected: PASS both.

- [ ] **Step 5: Commit**

```bash
git add src/pages.ts test/pages.test.mjs
git commit -m "feat: add an opt-in mirror flag to saved pages"
```

---

### Task 3: CDP protocol helpers

**Files:**
- Create: `src/cdp.ts`
- Test: `test/cdp.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `devToolsUrlFromStderr(line: string): string | undefined`, `parseCdpMessage(raw: unknown): CdpMessage | undefined`, `type CdpMessage`.

These are the pure half. The socket lives in Task 4.

- [ ] **Step 1: Write the failing test**

```js
import { load } from './bundle.mjs';

export default async function ({ ok, eq }) {
  const { devToolsUrlFromStderr, parseCdpMessage } = await load('cdp.ts');

  eq(
    devToolsUrlFromStderr('DevTools listening on ws://127.0.0.1:53219/devtools/browser/abc-123'),
    'ws://127.0.0.1:53219/devtools/browser/abc-123',
    'extracts the browser endpoint'
  );
  eq(devToolsUrlFromStderr('[1234:5678] some other chrome noise'), undefined, 'ignores noise');
  eq(devToolsUrlFromStderr(''), undefined, 'ignores empty');

  // responses correlate by id
  const res = parseCdpMessage('{"id":7,"result":{"data":"AAA"}}');
  eq(res.id, 7, 'response id parsed');
  eq(res.result.data, 'AAA', 'response result parsed');

  // events carry a method and no id
  const ev = parseCdpMessage('{"method":"Page.screencastFrame","params":{"sessionId":3}}');
  eq(ev.method, 'Page.screencastFrame', 'event method parsed');
  eq(ev.id, undefined, 'event has no id');

  // anything unparseable is rejected rather than forwarded
  eq(parseCdpMessage('not json'), undefined, 'garbage rejected');
  eq(parseCdpMessage('[1,2,3]'), undefined, 'non-object rejected');
  eq(parseCdpMessage('null'), undefined, 'null rejected');
  eq(parseCdpMessage(undefined), undefined, 'undefined rejected');
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module 'cdp.ts'`.

- [ ] **Step 3: Write minimal implementation**

```ts
/**
 * The wire vocabulary of the Chrome DevTools Protocol, kept free of `ws` and
 * `vscode` so the tests can load it. The socket itself lives in cdpClient.ts.
 */
export interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
  sessionId?: string;
}

/**
 * Chrome announces its endpoint on stderr, once, as
 * `DevTools listening on ws://127.0.0.1:<port>/devtools/browser/<uuid>`.
 * We launch with `--remote-debugging-port=0`, so this line is the ONLY way to
 * learn the port — 9222 is a guess that collides with the user's own sessions.
 */
export function devToolsUrlFromStderr(line: string): string | undefined {
  const m = /DevTools listening on (ws:\/\/\S+)/.exec(line);
  return m ? m[1] : undefined;
}

/**
 * Parse one frame off the socket. Returns undefined for anything that is not a
 * JSON object — a malformed frame must be dropped, never forwarded to the
 * webview, where it would be interpreted as image data.
 */
export function parseCdpMessage(raw: unknown): CdpMessage | undefined {
  const text = typeof raw === 'string' ? raw : raw instanceof Uint8Array ? Buffer.from(raw).toString('utf8') : undefined;
  if (!text) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined;
  }
  return parsed as CdpMessage;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS, assertion count up by 10.

- [ ] **Step 5: Commit**

```bash
git add src/cdp.ts test/cdp.test.mjs
git commit -m "feat: add CDP wire helpers"
```

---

### Task 4: CDP client over `ws`

**Files:**
- Create: `src/cdpClient.ts`
- Test: `test/cdpClient.test.mjs`

**Interfaces:**
- Consumes: `parseCdpMessage`, `CdpMessage` from `src/cdp.ts`.
- Produces: `class CdpConnection` with `send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<Record<string, unknown>>`, `on(method: string, handler: (params: Record<string, unknown>, sessionId?: string) => void): void`, `dispose(): void`, and a constructor taking a minimal socket: `{ send(data: string): void; close(): void; onMessage(cb: (raw: unknown) => void): void; onClose(cb: () => void): void }`.

Taking the socket as an interface — rather than constructing a `WebSocket`
inside — is what makes this testable without a browser or a network.

- [ ] **Step 1: Write the failing test**

```js
import { load } from './bundle.mjs';

function fakeSocket() {
  const sent = [];
  let onMsg = () => {};
  let onClose = () => {};
  return {
    sent,
    send: (d) => sent.push(JSON.parse(d)),
    close: () => onClose(),
    onMessage: (cb) => { onMsg = cb; },
    onClose: (cb) => { onClose = cb; },
    deliver: (obj) => onMsg(JSON.stringify(obj)),
  };
}

export default async function ({ ok, eq }) {
  const { CdpConnection } = await load('cdpClient.ts');

  const sock = fakeSocket();
  const cdp = new CdpConnection(sock);

  // requests get incrementing ids and resolve on the matching response
  const p = cdp.send('Page.enable', { a: 1 }, 'S1');
  eq(sock.sent[0].method, 'Page.enable', 'method sent');
  eq(sock.sent[0].params.a, 1, 'params sent');
  eq(sock.sent[0].sessionId, 'S1', 'sessionId sent');
  const id = sock.sent[0].id;
  ok(typeof id === 'number', 'id is a number');

  sock.deliver({ id, result: { ok: true } });
  eq((await p).ok, true, 'resolves with result');

  // an error response rejects
  const p2 = cdp.send('Bad.method');
  sock.deliver({ id: sock.sent[1].id, error: { code: -32601, message: 'nope' } });
  let rejected = false;
  try { await p2; } catch (e) { rejected = String(e).includes('nope'); }
  ok(rejected, 'error response rejects with its message');

  // events reach the registered handler
  let seen;
  cdp.on('Page.screencastFrame', (params, sessionId) => { seen = { params, sessionId }; });
  sock.deliver({ method: 'Page.screencastFrame', params: { data: 'X' }, sessionId: 'S1' });
  eq(seen.params.data, 'X', 'event params delivered');
  eq(seen.sessionId, 'S1', 'event sessionId delivered');

  // a malformed frame is dropped, not thrown
  sock.deliver('not json');
  ok(true, 'malformed frame did not throw');

  // close rejects everything still in flight
  const p3 = cdp.send('Page.enable');
  sock.close();
  let closedRejected = false;
  try { await p3; } catch { closedRejected = true; }
  ok(closedRejected, 'in-flight requests reject on close');
}
```

Note: `sock.deliver('not json')` passes a raw string through `onMessage`; the
fake's `deliver` JSON-stringifies objects, so pass the literal by calling
`sock.onMessage` indirectly — replace that line with:

```js
  sock.deliver({ garbage: true }); // object without id or method: ignored
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module 'cdpClient.ts'`.

- [ ] **Step 3: Write minimal implementation**

```ts
import { parseCdpMessage, type CdpMessage } from './cdp';

/** The slice of a WebSocket this client needs. Keeps `ws` out of the unit tests. */
export interface CdpSocket {
  send(data: string): void;
  close(): void;
  onMessage(cb: (raw: unknown) => void): void;
  onClose(cb: () => void): void;
}

type EventHandler = (params: Record<string, unknown>, sessionId?: string) => void;

/**
 * Request/response correlation over one CDP socket, plus event fan-out.
 *
 * The host owns this object; the webview never does. CDP is not a display
 * protocol — `Page.navigate` accepts file:// and `Runtime.evaluate` runs
 * arbitrary code — so the endpoint stays on this side of the boundary.
 */
export class CdpConnection {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }
  >();
  private readonly handlers = new Map<string, EventHandler[]>();
  private closed = false;

  constructor(private readonly socket: CdpSocket) {
    socket.onMessage((raw) => this.receive(raw));
    socket.onClose(() => this.failAll(new Error('CDP connection closed')));
  }

  send(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string
  ): Promise<Record<string, unknown>> {
    if (this.closed) {
      return Promise.reject(new Error('CDP connection closed'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  on(method: string, handler: EventHandler): void {
    const list = this.handlers.get(method) ?? [];
    list.push(handler);
    this.handlers.set(method, list);
  }

  dispose(): void {
    this.failAll(new Error('CDP connection disposed'));
    this.socket.close();
  }

  private receive(raw: unknown): void {
    const msg: CdpMessage | undefined = parseCdpMessage(raw);
    if (!msg) {
      return;
    }
    if (typeof msg.id === 'number') {
      const entry = this.pending.get(msg.id);
      if (!entry) {
        return;
      }
      this.pending.delete(msg.id);
      if (msg.error) {
        entry.reject(new Error(`${msg.method ?? 'CDP'}: ${msg.error.message}`));
      } else {
        entry.resolve(msg.result ?? {});
      }
      return;
    }
    if (msg.method) {
      for (const h of this.handlers.get(msg.method) ?? []) {
        h(msg.params ?? {}, msg.sessionId);
      }
    }
  }

  private failAll(err: Error): void {
    this.closed = true;
    for (const { reject } of this.pending.values()) {
      reject(err);
    }
    this.pending.clear();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test && npm run typecheck`
Expected: PASS both.

- [ ] **Step 5: Commit**

```bash
git add src/cdp.ts src/cdpClient.ts test/cdpClient.test.mjs
git commit -m "feat: add a CDP connection with request correlation"
```

---

### Task 5: Launch Chrome and open a target

**Files:**
- Create: `src/chromeProcess.ts`
- Modify: `esbuild.js` (no new bundle yet; `ws` is already in the host bundle)
- Test: manual (spawning a browser is out of scope for the unit suite)

**Interfaces:**
- Consumes: `chromeCandidates`, `pickChrome` (Task 1); `devToolsUrlFromStderr` (Task 3); `CdpConnection`, `CdpSocket` (Task 4).
- Produces: `launchChrome(opts: { binary: string; userDataDir: string }): Promise<{ cdp: CdpConnection; kill(): void }>`, `openTarget(cdp: CdpConnection, url: string): Promise<string>` returning a `sessionId`.

- [ ] **Step 1: Write the implementation**

```ts
import { spawn, type ChildProcess } from 'child_process';
import WebSocket from 'ws';

import { devToolsUrlFromStderr } from './cdp';
import { CdpConnection, type CdpSocket } from './cdpClient';
import { logger } from './log';

/** Chrome prints its endpoint once; give up rather than hang forever. */
const LAUNCH_TIMEOUT_MS = 15_000;

export interface ChromeHandle {
  cdp: CdpConnection;
  kill(): void;
}

export async function launchChrome(opts: {
  binary: string;
  userDataDir: string;
}): Promise<ChromeHandle> {
  const child = spawn(
    opts.binary,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${opts.userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate,MediaRouter',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  );

  const wsUrl = await endpointFrom(child);
  const socket = await connect(wsUrl);
  return {
    cdp: new CdpConnection(socket),
    kill: () => child.kill(),
  };
}

/** Read stderr until the endpoint line appears, or fail with what we saw. */
function endpointFrom(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffered = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Chrome did not announce a DevTools endpoint in ${LAUNCH_TIMEOUT_MS}ms`));
    }, LAUNCH_TIMEOUT_MS);

    child.stderr?.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8');
      for (const line of buffered.split('\n')) {
        const url = devToolsUrlFromStderr(line);
        if (url) {
          clearTimeout(timer);
          resolve(url);
          return;
        }
      }
      // Keep only the tail: the banner is small, but a crashing Chrome is chatty.
      buffered = buffered.slice(-4096);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Chrome exited with code ${code} before announcing an endpoint`));
    });
  });
}

function connect(url: string): Promise<CdpSocket> {
  return new Promise((resolve, reject) => {
    // maxPayload lifted: a full-page captureScreenshot easily exceeds the 100MB
    // default on a large viewport, and ws closes the socket rather than truncating.
    const ws = new WebSocket(url, { maxPayload: 256 * 1024 * 1024 });
    ws.once('open', () =>
      resolve({
        send: (d) => ws.send(d),
        close: () => ws.close(),
        onMessage: (cb) => ws.on('message', (data) => cb(data.toString())),
        onClose: (cb) => ws.on('close', cb),
      })
    );
    ws.once('error', (err) => reject(err));
  });
}

/**
 * Create a tab for `url` and attach to it. `flatten: true` gives one socket for
 * every session, addressed by sessionId — without it each target needs its own
 * connection.
 */
export async function openTarget(cdp: CdpConnection, url: string): Promise<string> {
  const { targetId } = (await cdp.send('Target.createTarget', { url })) as { targetId: string };
  const { sessionId } = (await cdp.send('Target.attachToTarget', {
    targetId,
    flatten: true,
  })) as { sessionId: string };
  logger().info(`mirror: attached to ${url} (session ${sessionId})`);
  return sessionId;
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `npm run typecheck`
Expected: clean. If `ws` types are missing, add `@types/ws` to devDependencies.

- [ ] **Step 3: Verify the banner still matches**

Run: `npm test`
Expected: PASS, including `bundleAttribution.test.mjs` — `ws` is already declared in the host banner, so no banner edit is needed. If it fails, the message names the bundle to fix.

- [ ] **Step 4: Commit**

```bash
git add src/chromeProcess.ts
git commit -m "feat: launch headless Chrome and attach to a target"
```

---

### Task 6: The mirrored panel

**Files:**
- Create: `media/pageMirror.ts`
- Modify: `src/pagePanel.ts` (branch in `openPagePanel` and `renderPageHtml`), `esbuild.js` (fourth bundle + banner)
- Test: manual

**Interfaces:**
- Consumes: `launchChrome`, `openTarget` (Task 5); `SavedPage.mirror` (Task 2); `chromeCandidates`, `pickChrome` (Task 1).
- Produces: nothing consumed by later tasks in this plan. The control-channel plan consumes `mirroredTargets(): Array<{ id: string; name: string }>` from `pagePanel.ts`.

- [ ] **Step 1: Write the webview half**

`media/pageMirror.ts` — runs in the panel, never touches VS Code APIs:

```ts
/**
 * Draws CDP screencast frames onto a canvas and forwards input back. The
 * mirror's counterpart to media/webview.ts, which does the same job for noVNC.
 */
const vscode = acquireVsCodeApi();
const canvas = document.getElementById('screen') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;

window.addEventListener('message', async (event) => {
  const msg = event.data as { type: string; data?: string; width?: number; height?: number };
  if (msg.type === 'frame' && msg.data) {
    const blob = await (await fetch(`data:image/jpeg;base64,${msg.data}`)).blob();
    const bitmap = await createImageBitmap(blob);
    if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
    }
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    // Acknowledge only after painting: the ack is Chrome's flow control, and
    // acking early turns a slow paint into an unbounded frame queue.
    vscode.postMessage({ type: 'ack' });
  }
});

function sendMouse(type: string, e: MouseEvent): void {
  const r = canvas.getBoundingClientRect();
  vscode.postMessage({
    type: 'input',
    kind: 'mouse',
    event: type,
    x: Math.round(((e.clientX - r.left) / r.width) * canvas.width),
    y: Math.round(((e.clientY - r.top) / r.height) * canvas.height),
    button: e.button === 0 ? 'left' : e.button === 2 ? 'right' : 'middle',
    buttons: e.buttons,
  });
}

canvas.addEventListener('mousedown', (e) => sendMouse('mousePressed', e));
canvas.addEventListener('mouseup', (e) => sendMouse('mouseReleased', e));
canvas.addEventListener('mousemove', (e) => sendMouse('mouseMoved', e));
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  vscode.postMessage({
    type: 'input',
    kind: 'wheel',
    x: Math.round(((e.clientX - r.left) / r.width) * canvas.width),
    y: Math.round(((e.clientY - r.top) / r.height) * canvas.height),
    deltaX: e.deltaX,
    deltaY: e.deltaY,
  });
}, { passive: false });

window.addEventListener('keydown', (e) => {
  vscode.postMessage({ type: 'input', kind: 'key', event: 'keyDown', key: e.key, code: e.code });
});
window.addEventListener('keyup', (e) => {
  vscode.postMessage({ type: 'input', kind: 'key', event: 'keyUp', key: e.key, code: e.code });
});
```

- [ ] **Step 2: Add the bundle and its banner**

In `esbuild.js`, copy the existing webview bundle entry, changing entry point to
`media/pageMirror.ts` and output to the matching `dist` name. Give it a banner
naming its third-party content — it has none, so state that explicitly, in the
same shape the other banners use. `test/bundleAttribution.test.mjs` compares the
banner against what is really inside.

- [ ] **Step 3: Branch the host half**

In `src/pagePanel.ts`, when the entry has `mirror === true`:

1. Resolve the binary: `remoteVnc.chromePath` if set, else `pickChrome(chromeCandidates(process.platform), fs.existsSync)`.
2. If nothing resolves, `showErrorMessage` naming `remoteVnc.chromePath` and **fall through to the existing iframe path**. A dead black tab is worse than a tab without capture.
3. Otherwise `launchChrome` (once per window, memoised), `openTarget(cdp, url)`, then on that session:
   - `Emulation.setDeviceMetricsOverride` with the page's `width`/`height` when set, else the panel size, `deviceScaleFactor: 1`, `mobile: false`
   - `Page.startScreencast` with `{ format: 'jpeg', quality: 80, maxWidth, maxHeight }`
4. `cdp.on('Page.screencastFrame', ...)` filtered by `sessionId` → `panel.webview.postMessage({ type: 'frame', data })`, remembering that frame's `sessionId` for the ack.
5. `panel.webview.onDidReceiveMessage`: `ack` → `Page.screencastFrameAck`; `input` → the matching `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent`. **Accept only these two message types** — the allowlist is the boundary that keeps the webview away from CDP.
6. `panel.onDidChangeViewState`: stop the screencast when hidden, restart when shown. The file already avoids `retainContextWhenHidden` for the same reason.
7. `panel.onDidDispose`: `Target.closeTarget`, and when no mirrored panels remain, kill Chrome after a 30s grace period.

The webview HTML for this branch is a full-bleed `<canvas id="screen">` with the
same CSP shape as today minus `frame-src` (there is no iframe) plus
`script-src 'nonce-…'` and `img-src data:`.

- [ ] **Step 4: Verify by hand**

1. `npm run build`, then `F5` for an Extension Development Host.
2. Add a page with `"mirror": true` pointing at any local dev server.
3. Open it: the tab shows the page and it repaints as the page animates.
4. Click something interactive; the page reacts.
5. Set `remoteVnc.chromePath` to a nonsense path and reopen: an error toast names the setting and the tab still opens as an iframe.

- [ ] **Step 5: Commit**

```bash
git add media/pageMirror.ts src/pagePanel.ts esbuild.js
git commit -m "feat: render mirrored pages from a CDP screencast"
```

---

### Task 7: Capture for mirrored pages

**Files:**
- Modify: `src/extension.ts` (register `remoteVnc.screenshotPage`, `remoteVnc.recordPage`), `package.json` (commands, menus)
- Test: manual

**Interfaces:**
- Consumes: the mirrored panel's CDP session (Task 6); existing `captureSave.ts` and `media/recorder.ts`.
- Produces: `remoteVnc.screenshotPage`, `remoteVnc.recordPage` — the control-channel plan calls both.

- [ ] **Step 1: Implement the screenshot command**

`Page.captureScreenshot` on the panel's session, `{ format: 'png', captureBeyondViewport: false }`, base64 → `Buffer` → the existing `captureSave` path, so the crop editor and clipboard behaviour are unchanged:

```ts
const { data } = (await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId)) as {
  data: string;
};
await saveCapture(Buffer.from(data, 'base64'), 'png');
```

Not a canvas readback: the screencast is JPEG scaled to the panel, while
`captureScreenshot` is a full-resolution PNG.

- [ ] **Step 2: Implement the recording command**

Reuse `media/recorder.ts` unchanged by posting the existing start/stop messages
to the mirrored panel — the canvas is already there and already receiving
frames, which is the whole point of Task 6. Validate returned bytes with
`recordingBytes` exactly as the VNC path does.

- [ ] **Step 3: Register in `package.json`**

Add both commands, and add them to the Web Pages tree item menu next to `Open`,
mirroring how `screenshotConnection` and `recordConnection` appear on a
connection row.

- [ ] **Step 4: Verify by hand**

1. Open a mirrored page, run **Take Screenshot**: a PNG is saved (or the crop
   editor opens, per `remoteVnc.screenshotCropEditor`), and it shows the page's
   current state — including anything you clicked into.
2. Run **Record**, wait two seconds, run it again: a WebM (or GIF, per
   `remoteVnc.recordingFormat`) lands beside the screenshot.
3. Confirm an iframe (non-mirrored) page shows no capture entries.

- [ ] **Step 5: Commit**

```bash
git add src/extension.ts package.json
git commit -m "feat: screenshot and record mirrored pages"
```

---

## Self-Review

**Spec coverage.** Mirror flag → Task 2. Chrome discovery and fallback → Tasks 1, 6 step 3. Lifecycle, `--headless=new`, ephemeral port, private profile → Tasks 5, 6. Transport and the host-owns-the-socket rule → Tasks 3, 4, 6 step 3.5. Frames and the ack requirement → Task 6 steps 1, 3. Input forwarding → Task 6. Capture split (CDP still, canvas video) → Task 7. Risks: launch failure fallback → Task 6 step 3.2; hidden-panel screencast stop → Task 6 step 3.6; shared browser process → Task 6 step 3.3.

**Not covered here, by design:** the control channel and the hotkeys, which are
their own plan (`2026-08-13-control-channel.md`). Task 7 names the two commands
that plan calls.

**Placeholders.** None: every code step carries the code, and the two manual
verification steps list the exact actions and expected outcomes.

**Type consistency.** `CdpConnection.send` returns `Promise<Record<string, unknown>>` in Task 4 and is destructured with an explicit cast at each call site in Tasks 5 and 7. `CdpSocket` is defined in Task 4 and implemented in Task 5's `connect`. `sessionId` is a `string` throughout. `pickChrome`/`chromeCandidates` signatures match between Tasks 1 and 6.

**One correction found during review:** Task 4's test originally delivered a raw
`'not json'` string through a fake whose `deliver` JSON-stringifies its argument,
which would have tested nothing. The step now notes the substitution.
