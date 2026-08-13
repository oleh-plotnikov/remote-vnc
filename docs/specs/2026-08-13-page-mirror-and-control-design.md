# Page mirroring, capture parity, and a control channel

Web Pages can be screenshotted and recorded like VNC sessions, hotkeys drive
both, and an opt-in loopback API lets a script or an agent pull captures.

## Why this is not a small change

Screenshot and recording already exist for VNC. The obvious plan — reuse those
commands for page tabs — cannot work. A VNC panel owns its pixels: noVNC paints
the framebuffer into a canvas the webview created, so `toDataURL` and
`captureStream` are available. A page tab renders a **cross-origin iframe**
(`pagePanel.ts`, `renderPageHtml`): the webview's origin is `vscode-webview://…`
and the framed page is `http://localhost:…`. The same-origin policy makes those
pixels unreadable, and no CSP directive, `allow` attribute or sandbox flag
changes that.

So capture parity requires the pixels to belong to us. That is what mirroring
does.

Decided with the user, 2026-08-13: capture must reflect **the live state of the
tab** — a page they have logged into or clicked through — not a fresh render of
the URL. That rules out "screenshot the URL in a headless browser on demand",
which was otherwise the cheapest option.

## Mirror mode

A saved page gains `mirror?: boolean`, default `false`. Everything already
configured keeps rendering as an iframe. The feature is detachable: without
Chrome the extension behaves exactly as it does today.

When `mirror` is true the extension drives a real browser and streams its
frames into the tab, the same shape as a VNC session — a remote screen you look
at and control.

### Locating Chrome

`remoteVnc.chromePath` names the binary. When empty, probe the platform
defaults (macOS `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
Linux `google-chrome` / `chromium` on PATH, Windows the two Program Files
locations). Chromium and Edge are accepted — the protocol is the same.

If nothing is found, show one error naming the setting and **fall back to the
iframe**. A page that silently opens a dead black tab is worse than a page that
opens without capture buttons.

### Browser lifecycle

One browser process per window, launched:

    --headless=new --remote-debugging-port=0 --user-data-dir=<globalStorage>/chrome

`--headless=new` because a headful window on screen defeats the purpose of an
editor tab. Port `0` and read the real port from Chrome's stderr line
`DevTools listening on ws://127.0.0.1:PORT/devtools/browser/…`; never guess
9222, which collides with the user's own debugging sessions.

A private `--user-data-dir` under `globalStorage` keeps the mirrored session's
cookies and localStorage between reopens — without it, "the state I clicked
into" dies every time the tab is closed — and guarantees we never touch the
user's real Chrome profile.

One CDP target (tab) per mirrored page. When the last mirrored page closes,
kill the browser after a short grace period so a quick close/reopen does not
pay the startup cost twice.

### Transport

`src/cdpClient.ts` — a thin CDP client over `ws`, which is already bundled into
the host bundle and already declared in the attribution banner.

**The host owns the socket; the webview never sees it.** Routing CDP through
the existing `vncBridge` would be tempting — one fewer hop, and the token model
is already written — but CDP is not a display protocol. `Page.navigate` accepts
`file:///`, `Runtime.evaluate` runs arbitrary code, `Browser.getVersion` leaks
paths. Handing that endpoint to webview JavaScript would turn a rendering bug
into local file disclosure. The host mediates and forwards only an allowlist of
message shapes.

### Frames and input

`Page.startScreencast({ format: 'jpeg', quality, maxWidth, maxHeight })`. Each
`Page.screencastFrame` carries base64 data and a session id; the host forwards
the data to the webview, which decodes it with `createImageBitmap` and draws to
a canvas. **Every frame must be acknowledged** with `Page.screencastFrameAck` —
Chrome stops sending after a small number of unacknowledged frames, and the
failure looks like a frozen page rather than an error.

Mouse, wheel and keyboard events from the webview are forwarded to
`Input.dispatchMouseEvent` / `Input.dispatchKeyEvent`. Viewport size follows the
saved page's `width`/`height` when set, otherwise the panel size, applied with
`Emulation.setDeviceMetricsOverride`.

### Capture

The two paths differ on purpose:

- **Screenshot** — `Page.captureScreenshot`, not a canvas readback. The
  screencast is lossy JPEG sized to the panel; `captureScreenshot` returns a
  full-resolution PNG. From there the existing pipeline is unchanged:
  `captureSave.ts`, the crop editor, the clipboard path.
- **Recording** — the existing `media/recorder.ts` MediaRecorder over the
  canvas. Frames already arrive there, so the webm/gif encoding, the
  `MAX_RECORDING_MS` cap and `recordingBytes` validation need no changes.

Full reuse on the save-and-edit side; different sources for stills and video,
because a still deserves better than the stream's quality.

## Control channel

VS Code cannot invoke an extension command from outside the process — there is
no `code --command`, no IPC socket. Any programmatic access therefore means the
extension opens a channel, and a channel that can capture screen content is a
capability worth constraining.

`remoteVnc.controlServer.enabled`, **default false**. A Marketplace user who
never touches it has nothing listening.

When enabled, the same idiom as `vncBridge`: bind `127.0.0.1` on an ephemeral
port, mint a 24-byte hex token, and write `{ url, token }` to a file created
with mode `0600` under `globalStorage`. Clients read the file; the filesystem is
the authentication.

| Method | Effect |
| --- | --- |
| `GET /targets` | open page tabs and VNC sessions, with ids |
| `POST /targets/:id/screenshot` | capture; responds with the saved path |
| `POST /targets/:id/record` | start; responds when recording begins |
| `POST /targets/:id/record/stop` | stop; responds with the saved path |
| `POST /targets/:id/reload` | reload a page target |

**No input endpoints.** The request was screenshots and recordings; clicking and
typing can be added later behind their own setting. Until then a leaked token
buys a view, not actions taken in the user's name.

Captures made through this channel **bypass the crop editor** and return a path
directly. `remoteVnc.screenshotCropEditor` still governs the interactive path,
where a human is present to drag a rectangle; for a script the editor would be
a dead end.

A file-queue alternative (watch a directory, drop a JSON request) was
considered. It is strictly safer — no listening socket at all — but adds
filesystem-watch latency and is an odd interface for the other consumers this
should serve, such as CI. Rejected on those grounds, not on security.

## Hotkeys

| Command | Key |
| --- | --- |
| Screenshot the focused panel | `Cmd+Alt+S` / `Ctrl+Alt+S` |
| Start or stop recording | `Cmd+Alt+R` / `Ctrl+Alt+R` |

Three screenshot commands exist today (`screenshot`, `screenshotSession`,
`screenshotConnection`), each bound to a different source. A key binding cannot
choose between them, so add one dispatcher command that inspects the active
panel and delegates. Recording gets a single toggle rather than the existing
start/stop pair: a pair is awkward on a keyboard and the extension already
tracks the state.

Both bindings are guarded by a `remoteVnc.panelFocused` context key, set from
`onDidChangeViewState`. Without the guard the chords would fire while the user
is typing in a source file.

## Files

| Path | Change |
| --- | --- |
| `src/pagePanel.ts` | branch on `mirror`; mirrored panels build a canvas host instead of an iframe |
| `src/cdpClient.ts` | new — CDP over `ws`, host-side |
| `src/chromeLocator.ts` | new — binary discovery per platform |
| `src/controlServer.ts` | new — loopback API, token file |
| `src/pages.ts` | `mirror` in the saved-page schema |
| `media/pageMirror.ts` | new — webview half: decode frames, draw, forward input |
| `src/extension.ts` | dispatcher commands, context key, control-server lifecycle |
| `package.json` | settings, commands, keybindings |
| `esbuild.js` | fourth bundle for `media/pageMirror.ts`, with its banner |

## Testing

The repository's tests are plain Node against a `vscode` stub, with no browser
and no network. That boundary holds here:

- `chromeLocator` — probing order and the not-found result, over a stubbed fs.
- `cdpClient` — request/response correlation by id, event dispatch, and that a
  malformed frame is rejected rather than forwarded.
- Control server — token comparison (constant-time, as `vncBridge` does),
  rejection of a wrong or missing token, unknown target id.
- Page schema — `mirror` defaults to false; an unknown value does not throw.

The screencast path itself is not unit-testable without Chrome and is verified
by hand: open a mirrored page, screenshot it, record two seconds, confirm both
files.

## Risks

**Chrome version drift.** CDP is stable in the domains used here
(`Page`, `Input`, `Emulation`), but `--headless=new` spelling has changed once
already. Detect failure at launch and fall back to the iframe with a clear
message rather than leaving a blank tab.

**Memory.** A screencast at panel resolution plus a MediaRecorder is not free,
and the browser is a second Chromium alongside VS Code's own. Keep one browser
process shared by all mirrored pages; stop the screencast when a panel is
hidden, the way `pagePanel` already avoids `retainContextWhenHidden`.

**Feature perception.** A mirrored tab is not a real iframe: text selection,
in-page find and native scrolling all behave differently. Mirror stays opt-in
per page for that reason, and the setting description must say so.
