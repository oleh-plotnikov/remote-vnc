# Display Scaling Mode & Session Recording Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** A saved connection can render 1:1 instead of scale-to-fit, and a
record/stop button captures the session as WebM or GIF.

**Architecture:** Feature 1 rides the existing `scaleViewport` plumbing — a
per-connection override resolved in `doConnect`, plus CSS scrollbars in the
webview. Feature 2 records entirely inside the webview (MediaRecorder for
WebM, gifenc for GIF), delivers finished bytes to the host over
`postMessage`, and the host saves or opens them exactly the way screenshots
are handled.

**Tech Stack:** TypeScript, VS Code extension API, noVNC, esbuild,
MediaRecorder, gifenc (new devDependency, bundled into `media/webview.js`).

**Spec:** `docs/specs/2026-08-05-scaling-and-recording-design.md`

## Global Constraints

- Commit messages: conventional-commit style (`feat:`/`fix:`/`docs:`/`test:`/
  `chore:`), every line (subject and body) wrapped at 80 characters or less.
- No `Co-Authored-By` or tool-name trailers in commits; the repo stays free
  of assistant/vendor identifiers everywhere (code, comments, commits).
- All code, comments, UI copy, and docs are in English.
- `npm run typecheck`, `npm test`, and `npm run build` must pass at every
  commit.
- `src/recording.ts` and `src/cropLayout.ts` must not import `vscode` — the
  webview bundle imports them.
- Steps marked **[manual]** need a live VNC target and the Extension
  Development Host (F5); an agent executor pauses there and asks the user to
  verify instead of skipping silently.

---

### Task 1: Per-connection `scaleViewport` — schema, type, connect plumbing

**Files:**
- Modify: `package.json` (connections item schema, ~line 196)
- Modify: `src/connections.ts:5-14` (SavedConnection)
- Modify: `src/extension.ts` (`connectEntry` ~line 207, `ConnectInput`
  ~line 752, `doConnect` ~line 777)
- Test: `test/connections.test.mjs`

**Interfaces:**
- Consumes: existing `applyConnectionEdit`, `getRfbOptions`,
  `manager.connect(request, options)`.
- Produces: `SavedConnection.scaleViewport?: boolean`;
  `ConnectInput.scaleViewport?: boolean`; `doConnect` resolves it into
  `RfbOptions.scaleViewport`. Task 3's prompts write this field; Task 2's
  webview behaviour keys off the resolved option.

- [ ] **Step 1: Write the failing test**

Append to the end of the exported function in `test/connections.test.mjs`
(after the `futureField` block):

```js
  // scaleViewport follows the same merge rules as every other optional field.
  const scaled = applyConnectionEdit(
    { name: 'n', host: 'h', scaleViewport: false },
    { host: 'h2' }
  );
  eq(scaled.scaleViewport, false, 'scaleViewport survives an unrelated edit');
  const cleared = applyConnectionEdit(
    { name: 'n', host: 'h', scaleViewport: false },
    { scaleViewport: undefined }
  );
  eq('scaleViewport' in cleared, false, 'explicit undefined clears scaleViewport');
```

- [ ] **Step 2: Run tests to verify the new assertions fail**

Run: `npm test`
Expected: FAIL — TypeScript compile error in `bundle.mjs` load or assertion
failure, because `SavedConnection` has no `scaleViewport` member yet.
(If it passes because `applyConnectionEdit` is generic, that is fine — the
test then pins the behaviour; continue.)

- [ ] **Step 3: Add the field to `SavedConnection`**

In `src/connections.ts`, after `parkServerCursor?: boolean;`:

```ts
  /** Scale to fit the panel (true) or render 1:1 (false); absent = follow
   *  the global `remoteVnc.scaleViewport` default. */
  scaleViewport?: boolean;
```

- [ ] **Step 4: Add the property to the connections schema in `package.json`**

After the `parkServerCursor` property of the connections item schema:

```json
"scaleViewport": {
  "type": "boolean",
  "description": "Scale the framebuffer to fit the panel (true) or show it at its original 1:1 size with scrollbars (false). When omitted, the global \"remoteVnc.scaleViewport\" default applies."
},
```

- [ ] **Step 5: Pass the field through the connect path**

In `src/extension.ts`:

1. `connectEntry` (~line 207) — add one line to the `doConnect` argument:

```ts
    parkServerCursor: entry.parkServerCursor,
    scaleViewport: entry.scaleViewport,
    visibleArea: parseVisibleArea(entry.visibleArea),
```

2. `ConnectInput` (~line 752):

```ts
/** A connect request before the global defaults have been applied. */
type ConnectInput = Omit<ConnectionRequest, 'autoReconnect' | 'parkServerCursor'> & {
  autoReconnect?: boolean;
  parkServerCursor?: boolean;
  /** Per-connection display override; resolved into RfbOptions.scaleViewport. */
  scaleViewport?: boolean;
};
```

3. `doConnect` (~line 777) — resolve the override into the options instead
of forwarding it on the request:

```ts
  const { scaleViewport, ...req } = request;
  const options = getRfbOptions();
  await manager.connect(
    {
      ...req,
      autoReconnect: effectiveAutoReconnect(req.autoReconnect, getAutoReconnectDefault()),
      parkServerCursor:
        req.parkServerCursor ??
        vscode.workspace.getConfiguration('remoteVnc').get<boolean>('parkServerCursor', false),
    },
    { ...options, scaleViewport: scaleViewport ?? options.scaleViewport }
  );
```

(The existing comment above `manager.connect` stays.)

- [ ] **Step 6: Run checks**

Run: `npm run typecheck && npm test`
Expected: both PASS (including the two new assertions).

- [ ] **Step 7: Commit**

```bash
git add package.json src/connections.ts src/extension.ts test/connections.test.mjs
git commit -m "feat: per-connection scaleViewport override"
```

---

### Task 2: Webview 1:1 mode with scrollbars

**Files:**
- Modify: `media/webview.ts` (`connect()`, ~line 276)
- Modify: `media/style.css` (`.screen` block)

**Interfaces:**
- Consumes: `msg.options.scaleViewport` (already delivered to the webview);
  `cropLayout(..., scaleToFit)` already handles `false`.
- Produces: `#screen[data-mode="native" | "fit"]` styling contract.

- [ ] **Step 1: Tag the screen with the display mode**

In `media/webview.ts` `connect()`, right after `cropLogged = false;`:

```ts
  // 1:1 mode swaps the flex centring for a scrollable box (see style.css);
  // the attribute is the webview's single switch for that styling.
  screen.dataset.mode = msg.options.scaleViewport ? 'fit' : 'native';
```

- [ ] **Step 2: Scrollbars in native mode**

In `media/style.css`, after the `.screen canvas` rule:

```css
/* Original-size (1:1) mode: the panel scrolls instead of zooming. Centring
   must come from `margin: auto` — with plain flex centring the top/left
   overflow edges of an oversized framebuffer cannot be scrolled to.
   `!important` because noVNC writes an inline overflow style on its
   container (which is #screen itself when no crop is active). */
.screen[data-mode='native'] {
  overflow: auto !important;
  justify-content: flex-start;
  align-items: flex-start;
}

.screen[data-mode='native'] > * {
  margin: auto;
}
```

- [ ] **Step 3: Build and typecheck**

Run: `npm run typecheck && npm run build`
Expected: both PASS; `media/webview.js` rebuilt.

- [ ] **Step 4 [manual]: Verify both modes against a live server**

In the Extension Development Host, with a saved connection:

1. Connection without `scaleViewport` → behaves exactly as before (fits).
2. Set `"scaleViewport": false` on the connection in settings.json,
   reconnect → image renders 1:1; if larger than the panel, scrollbars
   appear and all four edges are reachable; if smaller, it sits centred.
3. Pointer clicks land where the cursor points, including after scrolling.
4. With a `visibleArea` crop + `scaleViewport: false`: the cropped area
   shows 1:1 and the dead band stays hidden.

- [ ] **Step 5: Commit**

```bash
git add media/webview.ts media/style.css
git commit -m "feat: original-size display mode with scrollbars"
```

---

### Task 3: Display-size step in Add/Edit connection + README row

**Files:**
- Modify: `src/extension.ts` (`addConnection` ~line 219, `ConnectionField`
  ~line 338, `editConnection` items ~line 371, `promptConnectionField`
  ~line 451, prompts section ~line 897)
- Modify: `README.md` (connection properties / settings documentation)

**Interfaces:**
- Consumes: `SavedConnection.scaleViewport` (Task 1), `applyConnectionEdit`,
  `describeFlag` pattern.
- Produces: `promptScaleViewport(current, fallback, title?)`,
  `describeScale(value, fallback)`, `getScaleViewportDefault()` — all
  internal to `extension.ts`.

- [ ] **Step 1: Helpers**

In `src/extension.ts`, next to `getParkServerCursorDefault` (~line 795):

```ts
/** The global `remoteVnc.scaleViewport` default for connections without their own value. */
function getScaleViewportDefault(): boolean {
  return vscode.workspace.getConfiguration('remoteVnc').get<boolean>('scaleViewport', true);
}
```

Next to `describeFlag` (~line 348):

```ts
/** Describe the display-size choice: explicit, or the global default it inherits. */
function describeScale(value: boolean | undefined, fallback: boolean): string {
  const name = (v: boolean) => (v ? 'Scale to fit' : 'Original size (1:1)');
  return value === undefined ? `Default (${name(fallback)})` : name(value);
}
```

- [ ] **Step 2: The shared prompt**

After `promptParkServerCursor` (~line 897):

```ts
/**
 * Ask how the framebuffer should be displayed. Returns the patch to apply —
 * `{ scaleViewport: undefined }` means "follow the global setting" — or
 * undefined when cancelled. See `promptAutoReconnect` for why the inherited
 * state has to be reachable.
 */
async function promptScaleViewport(
  current: boolean | undefined,
  fallback: boolean,
  title = 'Display size'
): Promise<{ scaleViewport: boolean | undefined } | undefined> {
  const pick = await vscode.window.showQuickPick(
    [
      {
        label: 'Scale to fit',
        description: 'Zoom the framebuffer to fill the panel',
        value: true as boolean | undefined,
      },
      {
        label: 'Original size (1:1)',
        description: 'Native pixels; scrollbars when it does not fit',
        value: false as boolean | undefined,
      },
      {
        label: describeScale(undefined, fallback),
        description: 'Follow the remoteVnc.scaleViewport setting',
        value: undefined,
      },
    ],
    { title, placeHolder: `Currently: ${describeScale(current, fallback)}`, ignoreFocusOut: true }
  );
  return pick ? { scaleViewport: pick.value } : undefined;
}
```

- [ ] **Step 3: Add Connection chain**

In `addConnection` (~line 219):

1. Step count: `const total = hasFolder ? 8 : 7;`
2. After the `park` prompt and before the `area` prompt:

```ts
  const scale = await promptScaleViewport(
    undefined,
    getScaleViewportDefault(),
    title('Display size')
  );
  if (!scale) {
    return;
  }
```

3. In the `applyConnectionEdit` literal, after `...park,`:

```ts
      ...scale,
```

- [ ] **Step 4: Edit Connection menu**

1. `ConnectionField` union — add `'scaleViewport'` before `'visibleArea'`.
2. In `editConnection`'s `items`, after the `parkServerCursor` item:

```ts
      {
        id: 'scaleViewport',
        label: '$(screen-normal) Display size',
        description: describeScale(current.scaleViewport, getScaleViewportDefault()),
      },
```

3. In `promptConnectionField`, before the `visibleArea` case:

```ts
    case 'scaleViewport':
      return promptScaleViewport(current.scaleViewport, getScaleViewportDefault());
```

- [ ] **Step 5: README**

In the settings/connection documentation of `README.md` (the same place
`parkServerCursor` and `visibleArea` are described), add one row/bullet:

```md
- `scaleViewport` (per connection): scale to fit the panel (default), or
  `false` for the original 1:1 size — the panel scrolls when the screen is
  larger than the tab.
```

- [ ] **Step 6: Run checks**

Run: `npm run typecheck && npm test && npm run build`
Expected: all PASS.

- [ ] **Step 7 [manual]: Verify the flows**

1. **Add Saved Connection…** asks Display size as its own numbered step
   (8 steps with a folder open, 7 without); Esc cancels the whole flow.
2. **Edit Connection…** shows "Display size — Default (Scale to fit)" for an
   untouched connection; picking "Original size (1:1)" writes
   `"scaleViewport": false` to settings.json; picking the Default option
   removes the key.

- [ ] **Step 8: Commit**

```bash
git add src/extension.ts README.md
git commit -m "feat: display-size step in the connection editor"
```

---

### Task 4: Recording pure helpers (TDD)

**Files:**
- Modify: `src/screenshot.ts`
- Create: `src/recording.ts`
- Test: `test/screenshot.test.mjs`, create `test/recording.test.mjs`

**Interfaces:**
- Produces (used by Tasks 5–6):
  - `captureFilename(label: string, now: Date, ext: string): string` in
    `src/screenshot.ts`
  - in `src/recording.ts` (must stay `vscode`-free — the webview imports it):
    - `type RecordingFormat = 'webm' | 'gif'`
    - `type RecordingStopReason = 'stopped' | 'maxDuration' | 'disconnected'`
    - `const MAX_RECORDING_MS = 10 * 60 * 1000`
    - `recordingBytes(format: RecordingFormat, data: unknown): Uint8Array | undefined`
    - `clampFps(value: number): number` (round + clamp to 1–30; 10 on NaN)

- [ ] **Step 1: Write the failing tests**

In `test/screenshot.test.mjs`, add `captureFilename` to the `load()`
destructuring, and append inside the function:

```js
  // captureFilename generalises the screenshot name to any extension; the
  // png case must keep producing exactly the names screenshots always had.
  eq(captureFilename('hmi', at, 'webm'), 'hmi-20260803-181530.webm', 'webm extension');
  eq(captureFilename('hmi', at, 'gif'), 'hmi-20260803-181530.gif', 'gif extension');
  eq(captureFilename('hmi', at, 'png'), screenshotFilename('hmi', at), 'png case matches screenshots');
  eq(captureFilename('a b/c:d', at, 'gif'), 'a-b-c-d-20260803-181530.gif', 'sanitising applies');
```

Create `test/recording.test.mjs`:

```js
import { load } from './bundle.mjs';

export default async function ({ ok, eq }) {
  const { recordingBytes, clampFps, MAX_RECORDING_MS } = await load('recording.ts');

  const webm = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3]);
  const gif = Uint8Array.from('GIF89a'.split('').map((c) => c.charCodeAt(0)));

  // Magic-byte validation, mirroring pngBytesFromDataUrl's strictness.
  eq(Array.from(recordingBytes('webm', webm)), Array.from(webm), 'EBML magic accepted');
  eq(Array.from(recordingBytes('gif', gif)), Array.from(gif), 'GIF89a magic accepted');
  eq(recordingBytes('webm', gif), undefined, 'gif bytes rejected as webm');
  eq(recordingBytes('gif', webm), undefined, 'webm bytes rejected as gif');
  eq(recordingBytes('gif', new Uint8Array()), undefined, 'empty payload rejected');
  eq(recordingBytes('webm', 'AAAA'), undefined, 'non-binary payload rejected');
  eq(recordingBytes('webm', undefined), undefined, 'missing payload rejected');
  eq(
    Array.from(recordingBytes('webm', webm.buffer)),
    Array.from(webm),
    'a bare ArrayBuffer is normalised'
  );

  // Frame-rate clamping for the record-start message.
  eq(clampFps(10), 10, 'in-range untouched');
  eq(clampFps(0), 1, 'floor at 1');
  eq(clampFps(99), 30, 'ceiling at 30');
  eq(clampFps(12.7), 13, 'rounded');
  eq(clampFps(NaN), 10, 'NaN falls back to the default');

  ok(MAX_RECORDING_MS === 10 * 60 * 1000, 'cap is ten minutes');
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `captureFilename` is not exported and `recording.ts` does
not exist.

- [ ] **Step 3: Implement**

In `src/screenshot.ts`, generalise the name builder (replace the body of
`screenshotFilename` with a delegation):

```ts
/**
 * File name for a capture of the given connection, e.g.
 * `hmi-20260803-181530.png` — just the label and a timestamp, nothing else;
 * the label already says what was captured. It keeps unicode letters and
 * digits (labels are user-given and often non-ASCII) and collapses everything
 * else to a dash — path separators and other filesystem-hostile characters
 * must not survive into a file name.
 */
export function captureFilename(label: string, now: Date, ext: string): string {
  const safe = label
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 60);
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `${safe || 'session'}-${stamp}.${ext}`;
}

/** The screenshot case of `captureFilename`. */
export function screenshotFilename(label: string, now: Date): string {
  return captureFilename(label, now, 'png');
}
```

(The old doc comment moves onto `captureFilename`; `screenshotFilename`
keeps its name because `vncPanel.ts` imports it.)

Create `src/recording.ts`:

```ts
/**
 * Pure helpers for session recordings. The capture itself happens in the
 * webview (the framebuffer lives in noVNC's canvas — see media/recorder.ts);
 * everything here is the shared vocabulary and the validation around the
 * bytes it posts back, kept pure so tests can pin it down and so the
 * webview bundle can import it (no `vscode` allowed in this module).
 */

export type RecordingFormat = 'webm' | 'gif';

/** Why a recording ended — echoed back so the host can word its toast. */
export type RecordingStopReason = 'stopped' | 'maxDuration' | 'disconnected';

/** Hard cap on one recording: a forgotten recorder must not eat memory forever. */
export const MAX_RECORDING_MS = 10 * 60 * 1000;

const GIF_MAGIC = [0x47, 0x49, 0x46, 0x38]; // "GIF8" — covers GIF87a and GIF89a
const EBML_MAGIC = [0x1a, 0x45, 0xdf, 0xa3]; // WebM's Matroska container header

/**
 * Validate a recording payload by its magic bytes, or reject it. The mirror
 * of `pngBytesFromDataUrl`: a compromised or confused webview must not be
 * able to steer the file write into arbitrary content. postMessage may
 * deliver a bare ArrayBuffer; both shapes are accepted and normalised.
 */
export function recordingBytes(format: RecordingFormat, data: unknown): Uint8Array | undefined {
  const bytes =
    data instanceof Uint8Array ? data : data instanceof ArrayBuffer ? new Uint8Array(data) : undefined;
  if (!bytes || bytes.length === 0) {
    return undefined;
  }
  const magic = format === 'gif' ? GIF_MAGIC : EBML_MAGIC;
  return magic.every((b, i) => bytes[i] === b) ? bytes : undefined;
}

/** Clamp a configured frame rate to something a recorder can honour. */
export function clampFps(value: number): number {
  if (!Number.isFinite(value)) {
    return 10;
  }
  return Math.min(30, Math.max(1, Math.round(value)));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run typecheck && npm test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/screenshot.ts src/recording.ts test/screenshot.test.mjs test/recording.test.mjs
git commit -m "feat: recording filename and payload helpers"
```

---

### Task 5: Webview recorder (gifenc, capture engine, protocol)

**Files:**
- Modify: `package.json` + `package-lock.json` (`npm i -D gifenc`)
- Create: `media/gifenc.d.ts`
- Create: `media/recorder.ts`
- Modify: `media/webview.ts` (message types, wiring, badge, disconnect)
- Modify: `media/style.css` (badge)
- Modify: `src/vncPanel.ts` (`renderHtml` body, message type unions only)

**Interfaces:**
- Consumes: `RecordingFormat`, `RecordingStopReason`, `MAX_RECORDING_MS`
  from `../src/recording`; `visibleSize` from `../src/cropLayout`.
- Produces:
  - `media/recorder.ts`: `startRecording(opts: RecorderOptions): Recorder |
    undefined` where `Recorder = { stop(reason?: RecordingStopReason): void }`
    and `RecorderOptions = { canvas, width, height, format, fps,
    onStop(result: { data: Uint8Array; durationMs: number; reason:
    RecordingStopReason }): void, onError(message: string): void }`.
  - Protocol (both `media/webview.ts` and `src/vncPanel.ts` unions):
    - host → webview: `{ type: 'record-start'; format: RecordingFormat;
      fps: number }`, `{ type: 'record-stop' }`
    - webview → host: `{ type: 'record-status'; recording: boolean;
      error?: string }`, `{ type: 'recording'; format: RecordingFormat;
      data: Uint8Array | ArrayBuffer; durationMs: number;
      reason: RecordingStopReason }`
  - `#rec` badge element in the panel HTML.

- [ ] **Step 1: Install gifenc and declare its module**

Run: `npm install --save-dev gifenc`

gifenc ships no TypeScript declarations — create `media/gifenc.d.ts`
(the `novnc.d.ts` precedent):

```ts
declare module 'gifenc' {
  export function quantize(
    rgba: Uint8Array | Uint8ClampedArray,
    maxColors: number
  ): number[][];
  export function applyPalette(
    rgba: Uint8Array | Uint8ClampedArray,
    palette: number[][]
  ): Uint8Array;
  export function GIFEncoder(): {
    writeFrame(
      index: Uint8Array,
      width: number,
      height: number,
      opts?: { palette?: number[][]; delay?: number }
    ): void;
    finish(): void;
    bytes(): Uint8Array;
  };
}
```

- [ ] **Step 2: Create `media/recorder.ts`**

```ts
/**
 * Session recording inside the webview — the framebuffer exists only in
 * noVNC's canvas, so both encoders run here and the host receives finished
 * bytes. WebM rides the browser's MediaRecorder (native VP8/VP9); GIF is
 * encoded incrementally by gifenc, so memory holds the growing compressed
 * file, never a raw frame history.
 */
import { GIFEncoder, quantize, applyPalette } from 'gifenc';
import { MAX_RECORDING_MS, RecordingFormat, RecordingStopReason } from '../src/recording';

export interface RecorderResult {
  data: Uint8Array;
  durationMs: number;
  reason: RecordingStopReason;
}

export interface RecorderOptions {
  /** noVNC's canvas — still the padded framebuffer when a crop is active. */
  canvas: HTMLCanvasElement;
  /** The area worth recording: visibleSize() of the crop, in canvas pixels. */
  width: number;
  height: number;
  format: RecordingFormat;
  fps: number;
  /** Delivered exactly once, after stop() or the duration cap. */
  onStop(result: RecorderResult): void;
  /** Delivered instead of onStop when recording cannot start or dies. */
  onError(message: string): void;
}

export interface Recorder {
  stop(reason?: RecordingStopReason): void;
}

export function startRecording(opts: RecorderOptions): Recorder | undefined {
  try {
    return opts.format === 'gif' ? startGif(opts) : startWebm(opts);
  } catch (err) {
    opts.onError(err instanceof Error ? err.message : String(err));
    return undefined;
  }
}

function startWebm(opts: RecorderOptions): Recorder | undefined {
  const { canvas, width, height, fps } = opts;
  const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find(
    (m) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)
  );
  if (!mime) {
    opts.onError('this webview cannot encode WebM (MediaRecorder unavailable)');
    return undefined;
  }

  // With a crop the canvas holds more than the user sees — record a work
  // canvas that receives only the visible rectangle, at the capture rate.
  let source = canvas;
  let copyTimer: number | undefined;
  if (width !== canvas.width || height !== canvas.height) {
    const work = document.createElement('canvas');
    work.width = width;
    work.height = height;
    const ctx = work.getContext('2d');
    if (!ctx) {
      opts.onError('no 2D context for the crop copy');
      return undefined;
    }
    const copy = () => ctx.drawImage(canvas, 0, 0, width, height, 0, 0, width, height);
    copy(); // the stream must not open on an empty frame
    copyTimer = window.setInterval(copy, Math.round(1000 / fps));
    source = work;
  }

  const recorder = new MediaRecorder(source.captureStream(fps), {
    mimeType: mime,
    videoBitsPerSecond: 4_000_000,
  });
  const chunks: Blob[] = [];
  const startedAt = Date.now();
  let reason: RecordingStopReason = 'stopped';
  let done = false;

  const cleanup = () => {
    if (copyTimer !== undefined) {
      clearInterval(copyTimer);
    }
    clearTimeout(capTimer);
  };
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) {
      chunks.push(e.data);
    }
  };
  recorder.onstop = () => {
    cleanup();
    void new Blob(chunks, { type: mime }).arrayBuffer().then((buf) => {
      opts.onStop({ data: new Uint8Array(buf), durationMs: Date.now() - startedAt, reason });
    });
  };
  recorder.onerror = () => {
    if (done) {
      return;
    }
    done = true;
    cleanup();
    opts.onError('MediaRecorder failed mid-recording');
  };

  const stop = (why: RecordingStopReason = 'stopped') => {
    if (done) {
      return;
    }
    done = true;
    reason = why;
    try {
      recorder.stop(); // onstop delivers the bytes
    } catch {
      cleanup();
    }
  };
  const capTimer = window.setTimeout(() => stop('maxDuration'), MAX_RECORDING_MS);
  recorder.start(1000); // 1 s chunks keep any single blob small
  return { stop };
}

function startGif(opts: RecorderOptions): Recorder | undefined {
  const { canvas, width, height, fps } = opts;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    opts.onError('no 2D context to read frames from');
    return undefined;
  }
  const gif = GIFEncoder();
  const delay = Math.round(1000 / fps);
  const startedAt = Date.now();
  let done = false;

  const grab = () => {
    // Quantised per frame and appended immediately: memory holds only the
    // growing compressed GIF, never raw frames.
    const image = ctx.getImageData(0, 0, width, height);
    const palette = quantize(image.data, 256);
    gif.writeFrame(applyPalette(image.data, palette), width, height, { palette, delay });
  };
  grab(); // a stop before the first tick must still yield a playable file

  const stop = (why: RecordingStopReason = 'stopped') => {
    if (done) {
      return;
    }
    done = true;
    clearInterval(frameTimer);
    clearTimeout(capTimer);
    gif.finish();
    opts.onStop({ data: gif.bytes(), durationMs: Date.now() - startedAt, reason: why });
  };
  const frameTimer = window.setInterval(() => {
    if (done) {
      return;
    }
    try {
      grab();
    } catch (err) {
      done = true;
      clearInterval(frameTimer);
      clearTimeout(capTimer);
      opts.onError(err instanceof Error ? err.message : String(err));
    }
  }, delay);
  const capTimer = window.setTimeout(() => stop('maxDuration'), MAX_RECORDING_MS);
  return { stop };
}
```

- [ ] **Step 3: Extend the message unions**

The same two variants are added in BOTH `media/webview.ts`
(`ExtensionMessage`) and `src/vncPanel.ts` (`ExtensionMessage`,
~line 560):

```ts
  | { type: 'record-start'; format: RecordingFormat; fps: number }
  | { type: 'record-stop' };
```

And to `WebviewMessage` in `src/vncPanel.ts` (~line 574):

```ts
  | { type: 'record-status'; recording: boolean; error?: string }
  | {
      type: 'recording';
      format: RecordingFormat;
      data: Uint8Array | ArrayBuffer;
      durationMs: number;
      reason: RecordingStopReason;
    };
```

Imports: `media/webview.ts` adds
`import { RecordingFormat, RecordingStopReason } from '../src/recording';`
and `import { startRecording, Recorder } from './recorder';`
`src/vncPanel.ts` adds
`import { RecordingFormat, RecordingStopReason } from './recording';`
(the rest of the vncPanel import lands in Task 6).

- [ ] **Step 4: Wire the webview**

In `media/webview.ts`:

1. Top-level, next to the other elements:

```ts
const recBadge = document.getElementById('rec') as HTMLDivElement;

let recorder: Recorder | undefined;
```

2. Helper functions (near `disconnect()`):

```ts
function stopRecorder(reason: RecordingStopReason): void {
  // onStop/onError clear `recorder` and the badge; stop() is idempotent, so
  // every teardown path may call this unconditionally.
  recorder?.stop(reason);
}

function startSessionRecording(format: RecordingFormat, fps: number): void {
  if (recorder) {
    return; // already recording — the button pair cannot normally reach this
  }
  const canvas = screen.querySelector('canvas');
  if (!rfb || !canvas) {
    post({ type: 'record-status', recording: false, error: 'No active connection to record.' });
    return;
  }
  const size = visibleSize(canvas.width, canvas.height, crop);
  const started = startRecording({
    canvas,
    width: size.width,
    height: size.height,
    format,
    fps,
    onStop: (result) => {
      recorder = undefined;
      recBadge.hidden = true;
      post({
        type: 'recording',
        format,
        data: result.data,
        durationMs: result.durationMs,
        reason: result.reason,
      });
    },
    onError: (message) => {
      recorder = undefined;
      recBadge.hidden = true;
      post({ type: 'record-status', recording: false, error: message });
    },
  });
  if (started) {
    recorder = started;
    recBadge.hidden = false;
    post({ type: 'record-status', recording: true });
  }
}
```

3. First line of `disconnect()` (before `stopCompatRefresh()`):

```ts
  // A dropping/reconnecting session must not lose the recording: flush it to
  // the host while the webview is still alive (re-render is ~10 s away).
  stopRecorder('disconnected');
```

4. In the `message` listener, after the `screenshot` branch:

```ts
  } else if (msg.type === 'record-start') {
    startSessionRecording(msg.format, msg.fps);
  } else if (msg.type === 'record-stop') {
    if (recorder) {
      stopRecorder('stopped');
    } else {
      // A fresh webview after a reconnect knows nothing of an old recording;
      // answering "not recording" heals the host's stale context key.
      post({ type: 'record-status', recording: false });
    }
  }
```

- [ ] **Step 5: Badge markup and style**

In `src/vncPanel.ts` `renderHtml` body, after the status div:

```html
  <div id="rec" class="rec" hidden>● REC</div>
```

In `media/style.css`, after the `.status` rules:

```css
/* Recording badge: visible whenever the webview is capturing, so the state
   is obvious even when the editor-title buttons are out of sight. */
.rec {
  position: absolute;
  top: 8px;
  right: 12px;
  z-index: 10;
  padding: 4px 10px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.5px;
  pointer-events: none;
  user-select: none;
  color: #fff;
  background: rgba(190, 17, 0, 0.85);
}

.rec[hidden] {
  display: none;
}
```

- [ ] **Step 6: Build and typecheck**

Run: `npm run typecheck && npm test && npm run build`
Expected: all PASS. (`src/vncPanel.ts` has unused-import warnings only if
lint runs; the host wiring lands in Task 6 — typecheck must stay clean, so
the vncPanel import in Step 3 is exactly the two types used by the unions.)

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json media/gifenc.d.ts media/recorder.ts \
  media/webview.ts media/style.css src/vncPanel.ts
git commit -m "feat: webview recording engine for webm and gif"
```

---

### Task 6: Host side — commands, context key, save/open, sweep, notices

**Files:**
- Modify: `package.json` (commands, menus, settings)
- Modify: `src/vncPanel.ts` (VncSession recording state, manager methods)
- Modify: `src/extension.ts` (command registration, activate, sweep)
- Modify: `esbuild.js` (gifenc attribution in the webview banner)
- Modify: `THIRD-PARTY-NOTICES.md`

**Interfaces:**
- Consumes: Task 4 helpers (`captureFilename`, `recordingBytes`,
  `clampFps`), Task 5 protocol.
- Produces:
  - `VncSession`: `get isRecording(): boolean`, `startRecording(): void`,
    `stopRecording(): void`, `disposeGracefully(): Promise<void>`.
  - `VncSessionManager`: `recordActive(): void`,
    `stopRecordingActive(): void`.
  - Context key `remoteVnc.recordingActive`; commands
    `remoteVnc.recordStart`, `remoteVnc.recordStop`; settings
    `remoteVnc.recordingFormat`, `remoteVnc.recordingFrameRate`,
    `remoteVnc.recordingAction`.

- [ ] **Step 1: package.json — commands, menus, settings**

Commands (after `remoteVnc.screenshotConnection`):

```json
{
  "command": "remoteVnc.recordStart",
  "title": "Start Recording",
  "category": "Remote VNC",
  "icon": "$(record)"
},
{
  "command": "remoteVnc.recordStop",
  "title": "Stop Recording",
  "category": "Remote VNC",
  "icon": "$(stop-circle)"
},
```

`editor/title` menu (after the screenshot entry):

```json
{
  "command": "remoteVnc.recordStart",
  "when": "activeWebviewPanelId == remoteVnc.screen && !remoteVnc.recordingActive",
  "group": "navigation"
},
{
  "command": "remoteVnc.recordStop",
  "when": "activeWebviewPanelId == remoteVnc.screen && remoteVnc.recordingActive",
  "group": "navigation"
},
```

(No `commandPalette` gating — like `remoteVnc.screenshot`, both palette
entries act on the last-focused session and toast when there is nothing to
do.)

Settings (after `remoteVnc.screenshotDirectory`):

```json
"remoteVnc.recordingFormat": {
  "type": "string",
  "enum": ["webm", "gif"],
  "default": "webm",
  "markdownDescription": "Format **Remote VNC: Start Recording** captures. `webm` — efficient video, fine for long recordings. `gif` — universally embeddable animation, 256 colours, large files; best for short clips."
},
"remoteVnc.recordingFrameRate": {
  "type": "number",
  "default": 10,
  "minimum": 1,
  "maximum": 30,
  "description": "Frames per second for recordings (both formats). Embedded panels update slowly — 10 is usually plenty and keeps GIF files small."
},
"remoteVnc.recordingAction": {
  "type": "string",
  "enum": ["save", "open"],
  "default": "save",
  "markdownDescription": "What happens when a recording stops. `save` — write the file like screenshots: silently into `remoteVnc.screenshotDirectory` when set, otherwise via a save dialog. `open` — stage the file in extension storage and open it as an editor tab without saving; a toast offers **Save As…**."
},
```

- [ ] **Step 2: VncSession recording state**

In `src/vncPanel.ts`:

1. Extend the import from `./recording`:

```ts
import { RecordingFormat, RecordingStopReason, recordingBytes, clampFps } from './recording';
```

and the screenshot import:

```ts
import { screenshotFilename, captureFilename, pngBytesFromDataUrl, expandHome } from './screenshot';
```

2. `VncSessionInit` gains:

```ts
  onRecordingChange: () => void;
```

3. `VncSession` fields (near `authFailed`):

```ts
  private recording: 'idle' | 'starting' | 'recording' = 'idle';
  /** Resolvers waiting for the in-flight recording to flush (graceful close). */
  private recordingWaiters: Array<() => void> = [];
  private readonly onRecordingChange: () => void;
  private readonly globalStorageUri: vscode.Uri;
```

Constructor assignments (with the others):

```ts
    this.onRecordingChange = init.onRecordingChange;
    this.globalStorageUri = init.context.globalStorageUri;
```

4. Public surface (near `takeScreenshot`):

```ts
  get isRecording(): boolean {
    return this.recording !== 'idle';
  }

  /** Ask the webview to start recording; settings pick format and rate. */
  startRecording(): void {
    if (this.recording !== 'idle') {
      void vscode.window.showInformationMessage(`Remote VNC (${this.label}): already recording.`);
      return;
    }
    const config = vscode.workspace.getConfiguration('remoteVnc');
    const format: RecordingFormat =
      config.get<string>('recordingFormat', 'webm') === 'gif' ? 'gif' : 'webm';
    const fps = clampFps(config.get<number>('recordingFrameRate', 10));
    this.recording = 'starting';
    this.onRecordingChange();
    void this.post({ type: 'record-start', format, fps });
  }

  stopRecording(): void {
    if (this.recording === 'idle') {
      void vscode.window.showInformationMessage(`Remote VNC (${this.label}): no recording in progress.`);
      return;
    }
    void this.post({ type: 'record-stop' });
  }

  /**
   * Disconnect on the user's behalf: an in-flight recording is stopped and
   * given a moment to deliver its bytes before the webview is destroyed.
   * (Closing the tab skips this — the webview dies instantly; documented.)
   */
  async disposeGracefully(): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (this.recording !== 'idle') {
      void this.post({ type: 'record-stop' });
      await Promise.race([
        new Promise<void>((resolve) => this.recordingWaiters.push(resolve)),
        new Promise<void>((resolve) => setTimeout(resolve, 3000)),
      ]);
    }
    this.dispose();
  }
```

5. `onMessage` — two new cases:

```ts
      case 'record-status':
        if (msg.error) {
          logger().error(`recording (${this.label}): ${msg.error}`);
          void vscode.window.showWarningMessage(
            `Remote VNC (${this.label}): could not record — ${msg.error}.`
          );
        }
        this.recording = msg.recording ? 'recording' : 'idle';
        if (this.recording === 'idle') {
          this.flushRecordingWaiters();
        }
        this.onRecordingChange();
        break;
      case 'recording':
        this.recording = 'idle';
        this.onRecordingChange();
        this.flushRecordingWaiters();
        void this.handleRecording(msg);
        break;
```

6. Private helpers (near `saveScreenshot`):

```ts
  private flushRecordingWaiters(): void {
    for (const resolve of this.recordingWaiters.splice(0)) {
      resolve();
    }
  }

  /** Validate, then save or open a finished recording, per settings. */
  private async handleRecording(msg: Extract<WebviewMessage, { type: 'recording' }>): Promise<void> {
    const bytes = recordingBytes(msg.format, msg.data);
    if (!bytes) {
      void vscode.window.showWarningMessage(
        `Remote VNC (${this.label}): the webview returned no usable ${msg.format} data.`
      );
      return;
    }
    const note =
      msg.reason === 'maxDuration'
        ? ' (stopped at the 10-minute limit)'
        : msg.reason === 'disconnected'
          ? ' (session dropped)'
          : '';
    logger().info(
      `recording finished (${this.label}) — ${msg.format}, ${Math.round(msg.durationMs / 1000)}s, reason ${msg.reason}`
    );
    const name = captureFilename(this.label, new Date(), msg.format);
    const action = vscode.workspace
      .getConfiguration('remoteVnc')
      .get<string>('recordingAction', 'save');
    if (action === 'open') {
      await this.openRecording(bytes, name, msg.format, note);
    } else {
      await this.saveRecording(bytes, name, msg.format, note);
    }
  }

  /** The screenshot save path, for a recording (directory → silent; else ask). */
  private async saveRecording(
    bytes: Uint8Array,
    name: string,
    format: RecordingFormat,
    note: string
  ): Promise<void> {
    const configured = vscode.workspace
      .getConfiguration('remoteVnc')
      .get<string>('screenshotDirectory', '')
      .trim();
    let uri: vscode.Uri | undefined;
    if (configured) {
      const dir = vscode.Uri.file(expandHome(configured, os.homedir()));
      try {
        await vscode.workspace.fs.createDirectory(dir);
        uri = vscode.Uri.joinPath(dir, name);
      } catch (err) {
        logger().warn(
          `recording: cannot use remoteVnc.screenshotDirectory "${configured}" — ${describeError(err)}; asking instead`
        );
      }
    }
    if (!uri) {
      uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(`${os.homedir()}/${name}`),
        filters: recordingFilters(format),
      });
      if (!uri) {
        return; // cancelled
      }
    }
    try {
      await vscode.workspace.fs.writeFile(uri, bytes);
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Remote VNC (${this.label}): could not save the recording — ${describeError(err)}.`
      );
      return;
    }
    logger().info(`recording saved (${this.label}) -> ${uri.fsPath}`);
    const choice = await vscode.window.showInformationMessage(
      `Remote VNC: recording saved${note} — ${name}`,
      'Open'
    );
    if (choice === 'Open') {
      void vscode.commands.executeCommand('vscode.open', uri);
    }
  }

  /** Stage in extension storage (no user folder touched) and open as a tab. */
  private async openRecording(
    bytes: Uint8Array,
    name: string,
    format: RecordingFormat,
    note: string
  ): Promise<void> {
    const dir = vscode.Uri.joinPath(this.globalStorageUri, 'recordings');
    let uri: vscode.Uri;
    try {
      await vscode.workspace.fs.createDirectory(dir);
      uri = vscode.Uri.joinPath(dir, name);
      await vscode.workspace.fs.writeFile(uri, bytes);
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Remote VNC (${this.label}): could not stage the recording — ${describeError(err)}.`
      );
      return;
    }
    await vscode.commands.executeCommand('vscode.open', uri);
    const choice = await vscode.window.showInformationMessage(
      `Remote VNC: recording opened, not saved${note}.`,
      'Save As…'
    );
    if (choice === 'Save As…') {
      const target = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(`${os.homedir()}/${name}`),
        filters: recordingFilters(format),
      });
      if (target) {
        try {
          await vscode.workspace.fs.copy(uri, target, { overwrite: true });
        } catch (err) {
          void vscode.window.showErrorMessage(
            `Remote VNC (${this.label}): could not save the recording — ${describeError(err)}.`
          );
        }
      }
    }
  }
```

Module-level helper (near `describeError`):

```ts
/** Save-dialog filter for a recording format. */
function recordingFilters(format: RecordingFormat): Record<string, string[]> {
  return format === 'gif' ? { 'GIF image': ['gif'] } : { 'WebM video': ['webm'] };
}
```

7. `dispose()` — add `this.flushRecordingWaiters();` right after
`this.clearReconnectTimer();` so a tab-close during the graceful wait
cannot leave the promise hanging.

- [ ] **Step 3: Manager — commands and the context key**

In `VncSessionManager`:

1. Session construction (`connect`, ~line 139) gains:

```ts
      onStatus: (status) => this.registry.setStatus(id, status),
      onRecordingChange: () => this.updateRecordingContext(),
```

2. After `this.active = session;` in `connect`, and inside the existing
`onDidChangeViewState` and `onDidDispose` handlers (after the `active`
updates), add:

```ts
    this.updateRecordingContext();
```

3. New methods (near `screenshotActive`):

```ts
  /** Start recording the focused session (palette and the panel button). */
  recordActive(): void {
    if (!this.active) {
      void vscode.window.showInformationMessage('Remote VNC: no active session to record.');
      return;
    }
    this.active.startRecording();
  }

  /** Stop the focused session's recording. */
  stopRecordingActive(): void {
    if (!this.active || !this.active.isRecording) {
      void vscode.window.showInformationMessage('Remote VNC: no recording in progress.');
      return;
    }
    this.active.stopRecording();
  }

  /** Mirror the focused session's recording state into the when-clause key. */
  private updateRecordingContext(): void {
    void vscode.commands.executeCommand(
      'setContext',
      'remoteVnc.recordingActive',
      this.active?.isRecording ?? false
    );
  }
```

4. Graceful disconnects — recording flushes before teardown:

```ts
  /** Tear down a specific session. */
  disconnect(id: string): void {
    void this.sessions.get(id)?.disposeGracefully();
  }

  disconnectActive(): void {
    if (!this.active) {
      void vscode.window.showInformationMessage('Remote VNC: no active session.');
      return;
    }
    void this.active.disposeGracefully();
  }
```

(`dispose()` keeps calling the synchronous `session.dispose()` — deactivate
cannot await.)

- [ ] **Step 4: extension.ts — registration and the storage sweep**

1. In `activate`, with the other command registrations:

```ts
    vscode.commands.registerCommand('remoteVnc.recordStart', () => manager.recordActive()),
    vscode.commands.registerCommand('remoteVnc.recordStop', () => manager.stopRecordingActive()),
```

2. In `activate`, after `manager` is created:

```ts
  // The when-clause key must exist before the first panel gains focus.
  void vscode.commands.executeCommand('setContext', 'remoteVnc.recordingActive', false);
  void sweepOldRecordings(context);
```

3. Module-level, near `deactivate`:

```ts
/**
 * Recordings "opened, not saved" are staged in global storage; anything the
 * user wanted to keep has been Save-As'ed away, so week-old leftovers are
 * deleted to keep the storage from growing unnoticed.
 */
async function sweepOldRecordings(context: vscode.ExtensionContext): Promise<void> {
  const dir = vscode.Uri.joinPath(context.globalStorageUri, 'recordings');
  let entries: Array<[string, vscode.FileType]>;
  try {
    entries = await vscode.workspace.fs.readDirectory(dir);
  } catch {
    return; // nothing staged yet
  }
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const [name, type] of entries) {
    if (type !== vscode.FileType.File) {
      continue;
    }
    const uri = vscode.Uri.joinPath(dir, name);
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.mtime < cutoff) {
        await vscode.workspace.fs.delete(uri);
      }
    } catch {
      /* a file that cannot be statted or deleted is left alone */
    }
  }
}
```

- [ ] **Step 5: gifenc attribution**

In `esbuild.js`, extend `novncBanner` — after the DES cipher lines, before
the `Full notices` line, add:

```
 *
 * Also bundles gifenc ${depVersion('gifenc')} — (c) 2020 Matt DesLauriers — MIT
 * Source: https://github.com/mattdesl/gifenc
```

In `THIRD-PARTY-NOTICES.md`, add a section following the shape of the
existing ones:

```md
## gifenc

Compiled into `media/webview.js`.

- Project: <https://github.com/mattdesl/gifenc>
- Copyright (c) 2020 Matt DesLauriers
- License: **MIT**

Licensed under the MIT License: permission is hereby granted, free of
charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without
restriction, including without limitation the rights to use, copy, modify,
merge, publish, distribute, sublicense, and/or sell copies of the Software.
The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software. THE SOFTWARE IS
PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
```

(If the ws section in the file carries the full unabridged MIT text,
mirror that exact formatting instead of the condensed paragraph.)

- [ ] **Step 6: Run checks**

Run: `npm run typecheck && npm test && npm run build`
Expected: all PASS.

- [ ] **Step 7 [manual]: End-to-end recording checklist**

In the Extension Development Host against a live server:

1. Record button appears on the viewer tab; palette has Start/Stop
   Recording. Pressing record swaps the button to stop and shows ● REC.
2. `webm` format, `save` action, `screenshotDirectory` set → stop writes
   `<label>-<stamp>.webm` silently; toast's Open plays it in VS Code.
3. `gif` format → stop writes an animated GIF that plays in the editor.
4. `recordingAction: open` → stop opens a tab without touching the
   configured directory; Save As… copies it out.
5. With a `visibleArea` crop: the recording shows only the visible area.
6. Kill the VNC server mid-recording → partial file is delivered with the
   "(session dropped)" toast; reconnect continues normally.
7. Disconnect command mid-recording → recording lands before the panel
   closes.
8. Two sessions: record in one, switch tabs — the button pair follows each
   panel's own state.

- [ ] **Step 8: Commit**

```bash
git add package.json src/vncPanel.ts src/extension.ts esbuild.js THIRD-PARTY-NOTICES.md
git commit -m "feat: record and stop commands with save or open delivery"
```

---

### Task 7: Docs and release

**Files:**
- Modify: `README.md` (Features, Settings, recording caveat)
- Modify: `CHANGELOG.md`
- Modify: `package.json` (version — only with the user's go-ahead)

**Interfaces:**
- Consumes: everything shipped in Tasks 1–6.
- Produces: user-facing docs; the `1.2.0` release entry.

- [ ] **Step 1: README**

1. Features list — add:

```md
- **Session recording** — a record/stop button on the viewer tab captures
  the session as WebM video or animated GIF (`remoteVnc.recordingFormat`),
  saved like screenshots or opened as a tab without saving
  (`remoteVnc.recordingAction`).
- **Original-size display** — a connection can opt out of scale-to-fit and
  render 1:1 with scrollbars (`scaleViewport` per connection).
```

2. Settings section — rows for `remoteVnc.recordingFormat`,
`remoteVnc.recordingFrameRate`, `remoteVnc.recordingAction`, matching the
descriptions in `package.json` (abbreviated to one line each, in the
section's existing format).

3. After the recording documentation, the caveat:

```md
Recordings stop and save themselves when the connection drops or when you
run **Disconnect**; closing the viewer tab itself discards an in-progress
recording. One recording is capped at 10 minutes.
```

- [ ] **Step 2: CHANGELOG**

Add above the `[1.1.0]` entry:

```md
## [1.2.0] - 2026-08-05

### Added

- **Session recording.** A record/stop button on the viewer tab (plus
  **Remote VNC: Start/Stop Recording** in the palette) captures the session
  as WebM video or animated GIF — `remoteVnc.recordingFormat` picks the
  format, `remoteVnc.recordingFrameRate` the capture rate. Recordings
  save like screenshots (silently into `remoteVnc.screenshotDirectory`
  when set), or with `remoteVnc.recordingAction: "open"` they open as an
  editor tab without saving. A dropped connection or a Disconnect flushes
  the partial recording instead of losing it; one recording is capped at
  10 minutes.
- **`scaleViewport`** (per connection): render the framebuffer at its
  original 1:1 size with scrollbars instead of scaling it to fit the
  panel. The connection editor gained a Display size step; when unset, the
  global `remoteVnc.scaleViewport` default applies, as before.
```

- [ ] **Step 3: Ask the user, then release**

Confirm with the user that 1.2.0 should be cut now. If yes: bump
`"version": "1.2.0"` in `package.json`, run the full gate:

Run: `npm run typecheck && npm test && npm run package`
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add README.md CHANGELOG.md package.json
git commit -m "chore: release 1.2.0"
```

(If the user defers the release, commit the docs alone as
`docs: describe recording and the display-size property` and leave the
version untouched.)
