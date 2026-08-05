# Remote VNC — Display Scaling Mode & Session Recording Design

**Date:** 2026-08-05
**Status:** Approved (brainstorming) — pending implementation plan

## Goal

Two additions to the viewer:

1. **Display scaling mode** — a saved connection can opt out of scale-to-fit
   and render the framebuffer at its original 1:1 size, fixed, no zoom.
2. **Session recording** — a record/stop button on the panel captures the
   session as a WebM video or an animated GIF, chosen in settings.

## Feature 1: per-connection display scaling

### The property

A new optional boolean on a saved connection, named exactly like the global
setting it overrides:

- `scaleViewport` absent → the global `remoteVnc.scaleViewport` default
  applies (`true` = scale to fit, today's behaviour).
- `scaleViewport: false` → original size, 1:1, no zoom.

Inheritance follows the `autoReconnect`/`parkServerCursor` pattern: the value
is resolved at connect time in `doConnect`, and the connection editor shows
the *effective* value marked as inherited (`Default (On)`), so the user is
not baited into writing an explicit value that silences a global they may
later change.

### Data flow

The mechanism already exists end to end: the webview receives
`options.scaleViewport`, hands it to noVNC, and `cropLayout` already takes a
`scaleToFit` parameter. The only host-side change is one line in `doConnect`
overriding `options.scaleViewport` with the connection's value when present.
The host↔webview protocol does not change.

### Scrollbars at 1:1

Today `#screen` is a flex-centred box under an `overflow: hidden` body: a
framebuffer larger than the panel gets clipped and its edges are
unreachable. In 1:1 mode the webview sets `data-mode="native"` on `#screen`,
and CSS switches it to `overflow: auto` with the child centred by
`margin: auto` instead of `justify-content`/`align-items` — the classic
arrangement where smaller content sits centred and larger content scrolls to
all four edges (pure flex centring makes the top/left overflow edge
unreachable). No transforms near the canvas: noVNC maps pointer coordinates
through `getBoundingClientRect`, which scrolling does not disturb.

With a `visibleArea` crop the clip box is what scrolls; the crop geometry
already computes `scale = 1` for `scaleToFit: false`.

### Edit points

- `package.json`: the `scaleViewport` property in the connections schema.
- The connection editor's property menu and the Add Connection chain gain a
  step (On / Off / Default), following the existing shared-step pattern.
- README.

Screenshots and recordings are unaffected: both read native framebuffer
pixels regardless of how the viewer is zoomed.

## Feature 2: session recording

### UX

Editor-title buttons beside the screenshot button, swapped by a
`remoteVnc.recordingActive` context key that the session manager updates on
active-panel changes and recording-state changes:

- `remoteVnc.recordStart` — `$(record)`, "Start Recording", shown when the
  active panel is a VNC session and no recording is running there.
- `remoteVnc.recordStop` — `$(stop-circle)`, "Stop Recording", shown while
  recording.

Both commands are also in the palette. Sessions record independently; the
button pair reflects the active panel's state. While recording, the webview
shows a small "● REC" badge in a corner of the screen.

### Settings

- `remoteVnc.recordingFormat`: `"webm"` (default) | `"gif"` — the format the
  record button starts.
- `remoteVnc.recordingFrameRate`: number, default `10`, range 1–30, used by
  both formats. Embedded panels update slowly; 10 fps keeps GIFs a sane
  size.
- `remoteVnc.recordingAction`: `"save"` (default) | `"open"` — what happens
  on stop. `save` mirrors screenshots exactly: with
  `remoteVnc.screenshotDirectory` set the file is written there silently,
  otherwise a save dialog asks. `open` writes the file to the extension's
  global storage and opens it as an editor tab without saving anywhere
  permanent, with a "Save As…" toast for keeping it after all.

File names follow the screenshot convention:
`<label>-20260805-143000.webm` / `.gif`.

### Capture — WebM

`canvas.captureStream(fps)` into `MediaRecorder` (VP9, falling back
VP8 → default WebM via `isTypeSupported`; ~4 Mbps video bitrate). Chunks
accumulate in the webview; stop yields one `Uint8Array` posted to the host.
With a `visibleArea` crop the stream is taken from an offscreen canvas of
the visible size, into which frames are copied on an fps timer — the same
cropping the screenshot `capture()` already does, applied continuously.

### Capture — GIF

The `gifenc` encoder (MIT, ~8 KB, bundled into `webview.js` by esbuild like
noVNC is). An fps timer reads the (cropped) frame, quantises it to a
256-colour palette per frame, and appends it to the encoder's buffer
immediately — memory holds only the growing compressed GIF, never raw
frames.

### Duration cap

Recording auto-stops at 10 minutes with an explanatory toast — a guard
against a forgotten recording eating memory, not a feature limit.

### Lifecycle

- **Connection drop mid-recording — the recording survives.** The webview
  learns of the disconnect first (RFB event), stops the recorder, and posts
  the data long before reconnect re-renders the webview (attempts are 10 s
  apart). The partial recording is saved; the toast says the session
  dropped.
- **Disconnect command mid-recording — graceful.** The manager first sends
  `record-stop`, waits for the data (≈3 s timeout), then tears the panel
  down.
- **Closing the tab mid-recording loses the recording.** The webview is
  destroyed instantly; there is nothing to intercept. Documented in README.

### Protocol additions

- host → webview: `{ type: 'record-start', format, fps }`,
  `{ type: 'record-stop' }`.
- webview → host: `{ type: 'record-status', recording, error? }` (drives the
  context key and surfaces start failures),
  `{ type: 'recording', format, data: Uint8Array, durationMs }` on
  completion. VS Code transfers `Uint8Array` through `postMessage` natively —
  no base64 inflation, which would be material for video.

### Host side

Pure helpers in the mould of the existing screenshot ones:

- `captureFilename(label, now, ext)` — lives in `screenshot.ts` beside
  `screenshotFilename`, which becomes its `png` case: same unicode-keeping
  sanitisation, same timestamp format.
- `recordingBytes(format, data)` — in a new `src/recording.ts`; validates
  the payload by magic bytes before it touches disk (`GIF89a`; EBML
  `1A 45 DF A3` for WebM) — the mirror of `pngBytesFromDataUrl`, which
  keeps a confused webview from steering arbitrary content into a file
  write.

`save` action: the screenshot path verbatim — directory configured → silent
write (directory created, `~` expanded), unusable directory → logged
fallback to the dialog; dialog filtered by format. Then a log line and a
toast with "Open".

`open` action: the file goes to `globalStorageUri/recordings/` and opens via
`vscode.open` — GIF plays in the built-in Media Preview, WebM in the
built-in video player (both render in Chromium, so VP8/VP9 decode is
there). The toast offers "Save As…". On activation the recordings folder is
swept of files older than 7 days so the storage does not grow unnoticed.

## Error handling

Every failure is a toast prefixed `Remote VNC (label):` plus an Output-channel
line, as with screenshots: starting with no active session; no usable
`MediaRecorder` mime type after the fallback chain; GIF encoding failure;
empty or magic-byte-invalid payload; file-write failure. A recording failure
never touches the VNC session itself — recording is auxiliary, the
connection is primary.

## Testing

Pure functions in `test/` (node, no VS Code API):

- `captureFilename`: extension handling, sanitisation, and that the `png`
  case reproduces today's screenshot names exactly.
- `recordingBytes`: accepts valid magic bytes for both formats; rejects
  garbage, wrong-format payloads, and empty arrays.
- `cropLayout` gains `scaleToFit: false` cases (scale pinned to 1) if not
  already covered.

Browser-side capture (MediaRecorder, the gifenc loop) is not testable under
node and is verified manually; the implementation plan carries the checklist
(both formats × crop/no-crop × save/open × connection drop).

## Docs & dependencies

- README: both features, the tab-close caveat, the settings.
- CHANGELOG under 1.2.0.
- `gifenc` in devDependencies and THIRD-PARTY-NOTICES.

## Out of scope

- A per-session toggle button for the scaling mode (the property is set in
  the connection editor; changing it means reconnecting).
- Drag-to-pan (`clipViewport`/`dragViewport`) — scrollbars cover the
  oversized-framebuffer case.
- Streaming recording chunks to the host during capture (would survive a
  tab close, at the cost of a much larger protocol; revisit if lost
  recordings turn out to matter in practice).
- MP4 output — Chromium's MediaRecorder speaks WebM; converting is a job
  for external tools.
- Audio. VNC has none.

## Addendum (2026-08-05, after first hands-on testing)

Two follow-ups from using the build, both approved before the 1.2.0
release (so no compatibility burden):

### Record buttons in the tree views

The record control appears everywhere the camera does:

- **Active Sessions rows** get an inline record button after the camera.
  The row knows its own state: `SessionRegistry` gains a `recording`
  flag (`setRecording(id, bool)`, change-fired like `setStatus`), the
  tree item's `contextValue` becomes `remoteVnc.session.recording` while
  recording, and the menu shows Start (`$(record)`) or Stop
  (`$(stop-circle)`) accordingly. A recording row also swaps its icon to
  a red `record` codicon (the reconnecting spinner still wins).
  Existing session-row buttons switch their `when` to a
  `viewItem =~ /^remoteVnc\.session/` prefix match so they stay visible
  in both states.
- **Saved Connections rows** get one `$(record)` toggle button beside
  the camera, with the camera's target semantics: it finds the live
  session for the row's host:port and starts or stops its recording;
  with no live session it toasts "connect first", like the camera does.

### `remoteVnc.screenshotAction`

Screenshots gain the same post-capture choice recordings have, as a
separate setting (`save` | `open`, default `save`) — the user explicitly
preferred independent control over one shared setting. `save` is today's
behaviour; `open` stages the PNG in the same extension-storage folder
recordings use (the existing 7-day sweep covers it) and opens it as a
tab with a "Save As…" toast. Internally the save/open delivery flows are
unified into shared capture helpers parameterised by kind — this also
resolves the `saveScreenshot`/`saveRecording` duplication the final
review deferred.
