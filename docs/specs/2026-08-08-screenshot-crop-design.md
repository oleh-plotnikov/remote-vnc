# Remote VNC — Screenshot Crop Editor Design

**Date:** 2026-08-08
**Status:** Approved (brainstorming) — pending implementation plan

## Goal

A screenshot taken with **Remote VNC: Take Screenshot** opens as an editor
tab. Today that tab is VS Code's built-in image preview, which can zoom but
cannot select a region — so trimming a capture down to the dialog, the fault
message or the one widget that matters means leaving the editor entirely.

This adds a crop tool **in that tab**: drag a rectangle over the screenshot,
press Crop, and the file becomes the cropped image.

## The mechanism

A `CustomReadonlyEditorProvider` registered for `viewType`
`remoteVnc.crop`, contributed for `*.png` with `priority: "option"`. The
staged capture is opened with `vscode.openWith`, so the tab that appears is
a real file tab — real name, real icon, real breadcrumb — whose body is the
crop UI.

`priority` is a correctness field, not a preference. VS Code ranks editor
candidates `default=4, builtin=3, text=2, option=1`, and the built-in image
preview registers `*.png` at `builtin`. `"default"` would outrank it and
silently claim every PNG in every workspace; at `"option"` the only trace on
unrelated images is one extra row in **Reopen Editor With…**, while
`vscode.openWith` bypasses ranking entirely for our own flow.

"Readonly" here is VS Code's word for "this provider has no dirty state and
no editor-mediated save". The provider still writes the file itself — that is
ordinary and is what the crop action does.

The alternative, a plain `WebviewPanel`, was rejected: it is not the file's
tab, and restoring it across a window reload needs
`registerWebviewPanelSerializer` plus an explicit `onWebviewPanel:`
activation event. The custom-editor extension point generates
`onCustomEditor:remoteVnc.crop` on its own, so `"activationEvents": []`
stays empty.

## Feature 1: the crop editor tab

### What the user sees

A fixed header, the image centred, a fixed footer.

- **Header left** — the source size, `1920 × 1080`.
- **Header centre** — a live selection readout in the editor font so digits
  do not jitter: `640 × 360 at 120, 80`, in integer image pixels. This
  readout, never the drawn rectangle, is what the user verifies against; it
  is what keeps a selection honest below 100 % scale, where one image pixel
  is smaller than one CSS pixel.
- **Header right** — for a staged capture, a persistent badge:
  `Staged copy — removed after 7 days`.
- **Footer** — `Crop` (primary) · `Revert` · `Save` · `Open as Image`.

The image is scaled to fit the tab by `fitScale`, **upscaling allowed**, with
`image-rendering: pixelated` at scale ≥ 1. The motivating hardware for this
extension is a 480 × 272 embedded panel; showing that at 1:1 in a full tab
makes pixel-aiming harder, not more honest. An image larger than the tab
scrolls: `overflow: auto` on the stage and `margin: auto` on the child, the
arrangement `media/style.css:29-43` already documents — plain flex centring
leaves the top and left overflow edges unreachable.

Press and drag anywhere to select; drag any of eight handles to resize; drag
inside to move. Arrow keys nudge one image pixel, `Shift` + arrows ten.
`Escape` clears. `Enter` crops. Outside the selection is dimmed by four
absolutely-positioned rectangles — exact at any size, unlike a `9999px`
box-shadow.

### The invariant that governs the UI

Selection state is four integers in **image-pixel** space. The DOM rectangle
is always derived as `round(imagePx × scale)`, never the reverse, and
`devicePixelRatio` is never read anywhere in the feature. That single rule
retires the whole class of HiDPI, tab-resize and scaled-display drift bugs
instead of handling them one at a time.

### Failure state

Drawn in the tab, never as a blank canvas and never as a bare toast:
`This capture is no longer available.` when the file is gone (a capture the
7-day sweep already removed, replayed by a window reload), or
`This file is not a PNG the crop editor can read.` when the bytes behind a
`.png` name are something else. The filename and an `Open as Image` button
stay; header and footer controls hide.

## Feature 2: the write policy

**Crop overwrites the file in place.** The file that opened in the tab
becomes the cropped file. This is a deliberate choice over writing a new
sibling: it keeps "the screenshot" a single object, and it means the
capture toast's Save As… hands over the cropped bytes with no plumbing —
`openCapture` reads the file at click time (`src/vncPanel.ts:719`).

In-place overwriting carries four known hazards. Three are closed here; the
fourth is documented.

### (a) Two captures in the same second

`captureFilename` is second-resolution (`src/screenshot.ts:16-26`), so a
second screenshot of the same connection inside one second reuses the staged
name and overwrites the file an open crop tab is still showing. That tab
holds the *older* bitmap; its next Crop would write stale pixels over the
newer capture.

Closed at the source: `openCapture` now picks a free name. `stagedName`
takes the desired name and the directory listing and returns the first free
`name`, `name-2`, `name-3`, … The tab title carries the suffix, which is
honest.

Closed again at the write, because a name collision is not the only way a
file can move under an open tab: before every overwrite the provider
re-reads the file and compares it byte-for-byte with what it last wrote or
read. A mismatch refuses the write —
`Remote VNC: this file changed outside the crop editor; reopen it to crop
the current image.` — and nothing is lost.

### (b) The 7-day sweep

The cropped file lives in `globalStorageUri/recordings`, which
`sweepOldRecordings` (`src/extension.ts:158-181`) empties after seven days.
`sweepOldRecordings` is unchanged; the crop tab states the fact in its header
badge, and `Save` sits in the footer as the way out. Rewriting the file does
bump its `mtime`, so a cropped capture gets its seven days measured from the
crop rather than from the capture — worth knowing, not worth relying on.

### (c) A parallel image-preview tab goes stale

The built-in image preview computes its cache-buster once at load and does
not watch the file, so a preview of the same capture open in another group
keeps showing the pre-crop image until it is closed and reopened. Accepted
and documented; nothing in the extension can refresh another editor's
webview.

### (d) Undo

`Revert` restores the bytes read when the tab opened, for as long as the tab
is open — the provider holds them anyway. Closing the tab discards that
history, which the button's tooltip says.

### Files outside extension storage

`Reopen Editor With…` makes the crop editor reachable on any PNG in the
workspace. Overwriting one of those silently is not acceptable, so the first
Crop in such a tab goes through a modal confirmation naming the file. Consent
is remembered for that tab, not beyond it. `isStagedPath` is the one
predicate that decides staged-versus-not, and it is used for exactly this
and for the save-dialog default directory, so a classification bug fails
symmetrically instead of leaving a hole.

### Save

`Save` copies the current image out of staging, with the same destination
policy the extension already has for captures: silently into
`remoteVnc.screenshotDirectory` when it is set, otherwise a save dialog.
That behaviour lives in `saveCapture` today (`src/vncPanel.ts:636-684`) and
now has two call sites, so its body moves to `src/captureSave.ts` and
`VncSession.saveCapture` becomes a thin caller. One behaviour, one
implementation, no drift. Silent overwrite inside the configured directory is
the established contract of that setting and is not changed here.

### Trusting the webview

The webview draws the sub-rect from the decoded bitmap at 1:1 into an
offscreen canvas and posts a PNG data URL. The rect travels with it as a
**cross-check, never an instruction** — the pixels are already cut, so the
host has nothing to cut. The host validates in this order, and only then
touches the disk:

1. Re-entrancy — a `saving` flag on the panel entry; a second Crop while a
   write is in flight is ignored and logged. This replaces disabling the
   button, so the button has no route to getting stuck.
2. Length bound, before `Buffer.from` runs, not after.
3. `pngBytesFromDataUrl` — unchanged and already tested
   (`src/screenshot.ts:40`).
4. `pngSize` — **new, and the mirror that is currently missing.**
   `pngBytesFromDataUrl` validates only the envelope; without a magic-byte
   check, arbitrary bytes behind a correct prefix land in a file named
   `.png`. `recordingBytes` already sets this posture for GIF and WebM and
   its own comment calls itself "the mirror of `pngBytesFromDataUrl`"
   (`src/recording.ts:20-34`); `pngSize` supplies the PNG half — signature,
   IHDR length 13, chunk type, big-endian width and height.
5. `acceptCrop` — re-clamps the rect against the host's own IHDR reading of
   the source and requires the returned image's dimensions to **equal** it.
   A webview cannot return a full-resolution image while claiming a small
   selection.

`pngSize` must be a new function rather than folded into
`pngBytesFromDataUrl`: `test/screenshot.test.mjs:17-19` round-trips a
four-byte `[0x89,0x50,0x4e,0x47]` fixture — half a signature — so a check
inside the existing function would break a shipped assertion and change a
shipped contract.

Rejection shows one generic toast in the house wording —
`Remote VNC: the crop editor returned no usable PNG data.` — while
`logger().error` records which step failed. Generic toast, specific Output
channel, as everywhere else in this extension.

## Feature 3: routing and discoverability

`remoteVnc.screenshotCropEditor` (boolean, default `true`) decides whether a
screenshot opened by `screenshotAction: "open"` lands in the crop editor or
in the built-in preview. It qualifies `screenshotAction` rather than
replacing it: that setting already answers open-versus-save, this one answers
which editor.

Reached, in the order a user meets it:

1. The screenshot they just took opens straight into the tool.
2. A `$(screen-normal)` button on the editor title bar of any PNG open in the
   built-in preview, running **Remote VNC: Crop Image…**. The `when` clause
   is `activeCustomEditorId == 'imagePreview.previewEditor' && resourceExtname
   == '.png'` — **not** the `activeWebviewPanelId` idiom used by the three
   existing `editor/title` entries, because the image preview is a custom
   editor and never sets that key. Copying the existing idiom yields a menu
   entry that silently never fires.
3. **Remote VNC: Crop Image…** in the palette, acting on the active tab.
4. **Reopen Editor With… → Remote VNC Crop**, free from the contribution.

Recordings keep `vscode.open`. The capture toast's button is relabelled
`Save Full Image As…` on the screenshot path, so it cannot be confused with
the footer's `Save`; one `const` feeds both the label and the `if (choice
=== …)` comparison, so the two literals cannot drift.

## Protocol

Two hand-kept unions, following the repo's no-shared-protocol-module
convention: both declared at the bottom of `src/cropEditor.ts`, an
inbound-only mirror at the top of `media/cropEditor.ts`.

```ts
type CropExtensionMessage =
  | { type: 'image'; bytes: Uint8Array; width: number; height: number;
      name: string; staged: boolean; cropped: boolean }
  | { type: 'unavailable'; reason: string };

type CropWebviewMessage =
  | { type: 'ready' }
  | { type: 'crop'; rect?: CropRect; dataUrl?: string; error?: string }
  | { type: 'revert' }
  | { type: 'save' }
  | { type: 'reopen' }
  | { type: 'log'; level: 'info' | 'error'; message: string };
```

Bytes cross as a real `Uint8Array`, never `asWebviewUri`: `globalStorageUri`
is not in the default `localResourceRoots`, and at `engines.vscode ^1.84.0`
(≥ 1.57) there is no base64 inflation. The editor therefore works for any
path on any filesystem provider — remote, WSL, container, virtual — there is
no HTTP cache in the path so no cache-buster is needed, and the webview is
never handed a filesystem URI.

`ready` is idempotent: a webview reload re-fires it and the host re-posts the
bytes it holds, so the tab heals with no extra host state. This is the
`pendingConnect` idiom of `src/vncPanel.ts:355-360`.

Unlike the non-destructive shape, an `image` re-post **is** required after a
successful crop or revert — the file changed, so the tab must show the new
pixels. `cropped` drives the footer's "not saved outside staging" hint.

## Edit points

| File | Change |
| --- | --- |
| `src/screenshotCrop.ts` | New. Pure geometry, naming and path predicates. No `vscode`, no `Buffer` — the webview bundle imports it. |
| `src/cropEditor.ts` | New. The provider, the panel entry map, the message switch, the guarded writes, `renderCropHtml`. |
| `src/captureSave.ts` | New. `saveCaptureBytes`, lifted verbatim from `VncSession.saveCapture`. |
| `media/cropEditor.ts` | New. Decode, render, pointer and keyboard interaction, offscreen 1:1 cut. |
| `media/cropEditor.css` | New. Separate from `media/style.css`, which is the VNC panel's and sets `overflow: hidden` on `html, body`. |
| `src/screenshot.ts` | `pngSize`. |
| `src/vncPanel.ts` | `openCapture` routes screenshots to the crop editor and picks a free staged name; the toast label; `saveCapture` delegates. |
| `src/extension.ts` | Register the provider and `remoteVnc.cropImage`. `sweepOldRecordings` unchanged. |
| `package.json` | `customEditors`, one command, one `editor/title` entry, one setting. |
| `esbuild.js` | A third bundle for `media/cropEditor.ts`. No banner — it pulls nothing from `node_modules`. |
| `.gitignore` | `media/cropEditor.js` and its map. `.vscodeignore` needs nothing: it excludes by extension. |
| `README.md`, `CHANGELOG.md` | A Features bullet, a Usage row, a Settings row, a `1.3.0` section. |

## Pure functions, and why each is pure

All in `src/screenshotCrop.ts` unless noted, all reachable by
`test/bundle.mjs` — which hardcodes `join(ROOT, 'src', entry)`, so anything
testable has to live under `src/`.

- `clampCropRect(rect: unknown, imgW, imgH): CropRect | undefined` — the
  boundary guard. Takes `unknown` because it narrows a message field.
  Imported by **both** host and webview so the two cannot disagree, and
  idempotent on an already-clamped rect. That idempotence is what makes
  `acceptCrop` safe against rounding drift, so a test pins it.
- `acceptCrop(rect, imgW, imgH, outW, outH): CropRect | undefined` — the
  whole trust decision, in one testable function.
- `rectFromDrag(a, b, imgW, imgH): CropRect | undefined` — normalises
  direction, so dragging up-and-left equals the same drag down-and-right.
- `toImagePoint(offsetX, offsetY, scale, imgW, imgH)` — CSS px → image px,
  clamped inclusively so a selection can reach the right and bottom edges.
- `fitScale(imgW, imgH, boxW, boxH)` — upscaling allowed on purpose; returns
  1 for any non-positive or non-finite input, so a tab reporting a 0 × 0 box
  mid-layout cannot produce `NaN`.
- `stagedName(name, existing: string[]): string` — the collision fix for (a).
- `isStagedPath(uri: string, stagingDir: string): boolean` — compares
  `Uri.toString()` values; requires the prefix to end in `/` and the
  remainder to be a single segment, so a sibling `recordings-evil` and a
  nested path are both not staged.
- `bytesEqual(a, b): boolean` — the stale-source check for (a).
- `pngSize(bytes)` in `src/screenshot.ts` — signature and IHDR.

## Deliberately not done

- `sweepOldRecordings` — untouched, including its doc comment.
- No new context key: the `when` clause needs only built-ins, so
  `remoteVnc.recordingActive` stays the extension's only `setContext` key.
- No `commandPalette` `when: false` gate — `remoteVnc.cropImage` takes no
  argument and resolves its target from the active tab, so it behaves
  sensibly from the palette, like `remoteVnc.screenshot`.
- `supportsMultipleEditorsPerDocument` left unset, so reopening a capture
  reveals the existing tab and no multi-webview sync question arises.
- No zoom ladder, no pan, no history beyond `Revert`, no file watcher. The
  editor's authority is the bytes it last wrote or read, which is correct for
  a scratch capture and is what lets an open tab outlive the sweep.
