# Changelog

All notable changes to **Remote VNC** are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.4.0] - 2026-08-13

### Security

- **The mirrored browser no longer opens a debugging port.** It was launched
  with `--remote-debugging-port=0`, which starts an HTTP/WebSocket server on
  loopback that has no credential of any kind — CDP has no authentication to
  switch on. The ephemeral port was obscurity rather than a defence, and Chrome
  republishes it in `DevToolsActivePort` inside the profile directory anyway, so
  any local process (including one under a *different* uid on a shared build
  machine) could attach and then read `file://` through `Page.navigate`, run
  script through `Runtime.evaluate`, or take the persistent profile's cookies.
  The connection is now `--remote-debugging-pipe`: an inherited fd pair that no
  unrelated process can open. Readiness moved with it — there is no endpoint
  line to wait for on stderr, so the launch now waits on a `Browser.getVersion`
  the browser can only answer once it is up, and `remoteVnc.mirrorLaunchTimeout`
  still bounds that wait.

- **A page URL can no longer inject markup into its own tab.** The resolved
  frame origin was interpolated into the panel's `Content-Security-Policy` meta
  tag without escaping, while the `src` beside it was escaped. A saved URL whose
  authority contained a quote could therefore close the attribute and supply a
  second, weaker policy — and a browser honours the first policy it parses, so
  the `script-src 'nonce-…'` that would have contained the injection was the
  thing being truncated.

- **A folder path can no longer become shell code.** `${workspaceFolder}` was
  substituted verbatim into a command that runs through `sh -c`. Directory names
  may legally contain `$( )`, backticks and semicolons, so a cloned repository
  or an unpacked archive could put shell syntax where a path was expected and
  have a user-level `preUseCommand` — which Workspace Trust does not gate, by
  design — carry it into a shell. Such a path is now refused with an error that
  says so, rather than quoted: `$( )` and backticks expand inside double quotes
  too, and single quotes are not portable to `cmd.exe`.

- **The port-forwarding tunnel token no longer reaches the log.** Opening or
  reloading a page wrote the resolved URL to the **Remote VNC** output channel,
  and in a remote window that URL carries the tunnel's auth token in its query —
  in a channel the bug-report template asks reporters to paste into a public
  issue. The query is now redacted wholesale; the origin and path, which are the
  diagnostic, are kept.

- **A malformed control-server token no longer throws out of the request
  handler.** The token check compared `String#length` (UTF-16 units) and then
  handed the two buffers to `timingSafeEqual` (bytes). Node decodes header
  values as latin1, so 48 raw high bytes passed the length gate as a 48-character
  string whose UTF-8 buffer was 96 bytes, and `timingSafeEqual` threw
  `RangeError` — before routing, with nothing to catch it. Byte lengths are now
  compared, as the VNC bridge's equivalent check already did.

- **An untrusted workspace can no longer choose where captures are written.**
  `screenshotAction: 'save'` removes the save dialog and `screenshotDirectory`
  names the destination; both were ordinary window-scoped settings, so a
  `.vscode/settings.json` in a cloned repository could have every screenshot of
  a live VNC session written silently into a directory of its choosing. Both are
  now read through the same trust rule the saved connections and pages already
  use: a workspace value applies only in a trusted workspace, a user-level value
  always applies, and a dropped value is logged rather than silently ignored.

- **The bridge rejects an unauthenticated client before the handshake.** The
  token was checked on the established connection, so the bridge answered `101`
  and only then closed with `1008`. WebSockets are not subject to the
  same-origin policy, so any page in any browser on the machine could tell a
  live bridge from a dead port that way — and with a fixed `remoteVnc.bridgePort`
  without even scanning for one. No framebuffer bytes were ever exposed; what
  leaked was the existence of a session.

- **A mirrored tab says when the page has taken it elsewhere.** A mirror is a
  real browser tab with no URL bar, and the page can navigate itself — a
  redirect, a meta refresh, a link followed inside the mirror — while every
  forwarded keystroke goes wherever it landed. The tab showed the saved entry's
  name from open until close, and nothing else. It now appends the current
  origin to the title once that origin differs from the one the entry was opened
  at. The navigation is not blocked: a dev server redirect or an OAuth round
  trip is ordinary, so this makes the move visible rather than impossible. Only
  the origin is shown — a path and query we did not choose often carry tokens —
  and route changes within the same origin leave the title alone, so the one
  change worth noticing is not buried in noise.

- **The release workflow pins its publishing tools.** `npx --yes @vscode/vsce`
  and `npx --yes ovsx` resolved whatever the registry served at run time, in
  steps holding a publishing credential and in the step that builds the `.vsix`
  itself.

### Added

- **`preUseCommand` / `postUseCommand` on a saved page or connection.** An
  entry can now bring its own target up before the tab loads and take it
  down again when the last tab using it closes. Written for pages served
  by a local app: the URL answers nothing until that app runs, so the
  alternative was keeping a supervisor loop alive all day for a tab used
  for minutes. The tab opens immediately showing the command running, and
  the URL is loaded only once it exits 0; a non-zero exit or a timeout
  leaves the tab saying what failed with the last lines of output, and
  the full log in the **Remote VNC** output channel. `preUseTimeout`
  (seconds, default 60) bounds the wait, and a timeout kills the
  command's whole process group, so a build it started does not outlive
  it. `${workspaceFolder}` and `${workspaceFolder:NAME}` are substituted.

  These execute arbitrary shell commands, so they are gated on Workspace
  Trust: a command on an entry saved in workspace or folder settings is
  ignored — and logged as ignored — unless the workspace is trusted.
  Entries in your user settings are unaffected. Everything else about the
  entry works either way; only the commands are dropped.

- **`username` on a saved connection.** A server whose security type asks
  for an account name can now be given one. This is what a Mac needs:
  macOS offers Apple ARD/DH (security type 30) ahead of VNC Auth (2), and
  noVNC takes the first type it supports from the server's list — so
  every connection to a Mac negotiated ARD and then failed, because only
  a password was ever sent. Set it from **Username** in the connection's
  edit menu, or as `username` in `remoteVnc.connections`. It is optional
  and absent by default, so classic password-only servers are unchanged,
  and the secret-storage key is untouched, so no saved password is lost.

### Fixed

- **Renaming a connection no longer strands its password.** The Secret Storage
  key is derived from the connection's name *and* `host:port`, so editing any of
  the three left the stored password under a key nothing could reach again: the
  connection asked under the new key, **Forget Password** computed the new key
  too, and deleting the entry deleted the new key — while the real password
  stayed in the OS keyring with no way to remove it. The secret now moves with
  the entry, written under the new key before the old one is deleted.

- **"A password is required" when the server wanted a username.** noVNC
  names the credentials it still needs; that list was discarded and every
  case was reported as a missing password. Retyping the password could
  never help, and nothing said so. The message now names what is actually
  missing, and when the server asks for an account name that the
  connection does not carry, it says where to set it.

## [1.3.0] - 2026-08-08

### Added

- **Screenshot cropping.** A capture taken with **Remote VNC: Take
  Screenshot** now opens in a crop editor instead of the built-in image
  preview: drag a rectangle over the screenshot, resize it by its
  handles or nudge it a pixel at a time with the arrow keys, and press
  Crop — the file becomes the selected region. The built-in preview can
  zoom but cannot select a region, so trimming a capture down to the
  dialog, the fault message or the one widget that matters meant leaving
  the editor for another tool. `remoteVnc.screenshotCropEditor` (default
  `true`) decides which editor a screenshot opens in; any other PNG
  reaches the crop editor through **Remote VNC: Crop Image…**, a button
  on the title bar of an image preview, or **Reopen Editor With…**.
  Crop overwrites the file in the tab, **Revert** puts back the bytes
  the tab opened with, and **Save** copies the result out of staging
  the same way a capture is saved.
- **Copy to the clipboard** from the crop editor. The button copies the
  selection when there is one and the whole image when there is not —
  its label says which — and never touches the file, so pasting a region
  into a chat or an issue needs no crop and no saved file. The copy is
  made in the tab rather than by the extension host, which is what makes
  it land in *your* clipboard when VS Code is attached to a remote.

### Changed

- The capture toast's button reads **Save Full Image As…** on the
  screenshot path, so it cannot be mistaken for the crop editor's own
  **Save**, which writes the cropped image.
- A staged capture now takes the first free filename. Capture names have
  second resolution, so two screenshots of one connection inside the same
  second shared a name and the second overwrote the file an open tab was
  still showing; the second capture is now `…-2`.

## [1.2.2] - 2026-08-05

### Fixed

- **README badges.** Shields.io retired its Visual Studio Marketplace
  badge routes and now serves grey "retired badge" placeholders; the
  version and installs badges moved to vsmarketplacebadges.dev.

## [1.2.1] - 2026-08-05

### Fixed

- **Third-party notices.** The DES cipher inside noVNC carries a third
  license block — Jef Poskanzer's 1996 BSD-style terms, which require the
  notice, conditions and disclaimer to accompany binary redistribution —
  and it was missing from `THIRD-PARTY-NOTICES.md` and the bundle banner.
  Both now reproduce it. A new test pins every notice text and banner
  copyright line to the installed packages, so a dependency upgrade can no
  longer ship stale attribution unnoticed, and the noVNC section now
  points at the file that actually holds the MPL 2.0 text
  (`docs/LICENSE.MPL-2.0`). README and SECURITY.md third-party summaries
  now include gifenc.

## [1.2.0] - 2026-08-05

### Added

- **Session recording.** A record/stop button on the viewer tab, on
  Active Sessions rows, and on Saved Connections rows (plus
  **Remote VNC: Start/Stop Recording** in the palette) captures the session
  as WebM video or animated GIF — `remoteVnc.recordingFormat` picks the
  format, `remoteVnc.recordingFrameRate` the capture rate. By default a
  finished recording opens as an editor tab without saving (a toast
  offers Save As…); with `remoteVnc.recordingAction: "save"` it is
  written like screenshots — silently into
  `remoteVnc.screenshotDirectory` when set, otherwise via a save dialog.
  A dropped connection or a Disconnect flushes
  the partial recording instead of losing it; one recording is capped at
  10 minutes.
- **`remoteVnc.screenshotAction`**: the same open-or-save choice as
  recordings, but for screenshots — `open` (default) stages the PNG in
  extension storage and opens it as a tab with a "Save As…" toast,
  `save` writes it to disk as before.
- **`scaleViewport`** (per connection): render the framebuffer at its
  original 1:1 size with scrollbars instead of scaling it to fit the
  panel. The connection editor gained a Display size step; when unset, the
  global `remoteVnc.scaleViewport` default applies, as before.

## [1.1.0] - 2026-08-04

### Added

- **Screenshots.** A camera button on saved-connection rows, active-session
  rows and the viewer tab (plus **Remote VNC: Take Screenshot** in the
  palette) saves the current framebuffer as a PNG. With
  `remoteVnc.screenshotDirectory` set, saving is one click with no dialog;
  otherwise a save dialog asks. Under a remote (WSL, SSH, containers) the
  file lands on the remote filesystem.
- **`parkServerCursor`** (global default plus per-connection override): after
  a few seconds of pointer idle, the server-drawn mouse pointer is parked in
  the bottom-right corner. Touch-screen devices paint the pointer arrow into
  the framebuffer itself, so it cannot be hidden client-side — parking moves
  it out of the picture instead.
- **`visibleArea`** (per connection, e.g. `"480x272"`): show only that area
  of the framebuffer. Some embedded servers advertise a width padded to the
  display controller's line stride (a 480x272 panel announced as 512x272)
  and render the padding as a dead black band beside the picture; the crop
  windows it away without touching noVNC's pointer math. Combined with
  cursor parking, the parked arrow lands inside the hidden band.
- **Connection property menu.** Editing a saved connection now lists every
  property with its current value instead of walking a fixed chain of
  dialogs, so a single field can be changed on its own. Adding a connection
  asks for `parkServerCursor` and `visibleArea` too — both previously had to
  be written into `settings.json` by hand. The two flags that also exist as
  global settings, `autoReconnect` and `parkServerCursor`, offer **Default**
  alongside Yes and No: a connection can be handed back to the global value
  rather than pinned to an explicit one, and a new connection follows the
  global setting unless it is told otherwise.

### Fixed

- **Editing a connection no longer deletes fields the dialogs never asked
  about.** Both wizards rebuilt the saved entry from the answers they
  collected, so one pass through **Edit Connection…** discarded a
  hand-written `visibleArea` or `parkServerCursor`.
- **Screenshots honour `visibleArea`.** The crop hides the dead band with a
  clip box around a full-size canvas, so a capture of that canvas still
  carried the band: the viewer showed 480x272 while the saved PNG was
  512x272 with a black stripe down the side.

### Changed

- The Output channel now records the whole life of a session, not just its
  end: a `connected` line (with the framebuffer size the server advertised —
  wider than the device's panel explains a dead band beside the picture)
  when the RFB handshake completes, the connected
  duration on every close, an explicit warning when a bridge closes without
  the handshake ever completing, and a one-time hint pointing at **Force raw
  encoding** when a server drops a connected-but-possibly-blank session —
  the signature of fixed-function embedded servers. Previously the log went
  silent between the webview's "connecting" line and a terse "bridge closed
  cleanly", which made those failures indistinguishable.
- The note logged when `asExternalUri` leaves the bridge's loopback URL
  unchanged now says that WSL, like local Dev Containers, usually forwards
  the port under the same address — that situation is normal there, not a
  hint that something is broken.

## [1.0.1] - 2026-07-25

No change to the extension itself — the shipped code is identical to 1.0.0.
This release exercises the publishing pipeline end to end and carries the
repository work done since: issue and pull request templates, a code of
conduct, a contributor-facing description of the release machinery, and a
release job that can now be started by hand instead of by moving a tag.

## [1.0.0] - 2026-07-25

First stable release, and the first published as open source.

### Added

- **VNC viewer in an editor tab** — keyboard, mouse and live framebuffer, backed
  by the noVNC client.
- **No external proxy.** The extension host runs its own loopback
  `WebSocket ↔ TCP` bridge, guarded by a single-use token, so the webview can
  reach a raw RFB server without `websockify`.
- **Saved connections** in settings, with passwords in encrypted Secret Storage
  keyed by `host:port`.
- **Activity Bar views** for saved connections, active sessions and web pages.
- **Auto-reconnect**, on by default, overridable per connection. Always stops on
  authentication failure or a manual disconnect.
- **Multiple concurrent sessions**, side by side.
- **Tunable** quality and compression, view-only mode, viewport scaling and
  optional server-side resize.
- **Remote support** — Dev Containers, Remote-SSH, WSL and Codespaces. Where the
  bridge runs on the remote but the webview renders locally, its URL is resolved
  through `asExternalUri`; a local Dev Container additionally needs a fixed
  `remoteVnc.bridgePort`, since ephemeral ports are not forwarded automatically.
- **Web Pages** — saved URLs opened as clean editor tabs, with an optional fixed
  canvas rendered scaled-to-fit for design mockups.
- **Compatibility mode** (`forceRawEncoding`) for fixed-function embedded servers
  whose static framebuffer never reaches an incremental-update client.

### Fixed

Relative to 0.4.0, the last release published before this one:

- Copyright and license notices for the bundled third-party code are no longer
  stripped from the shipped bundles. Minification dropped every attribution
  header, so `media/webview.js` carried the noVNC core library with its MPL-2.0
  notice removed. Both bundles now open with an attribution banner covering
  noVNC, the components it carries (pako under MIT, and a DES cipher whose terms
  require its notice be kept intact) and `ws`; `THIRD-PARTY-NOTICES.md` ships
  with the extension and records source availability.
- `remoteVnc.bridgePort` is now declared in the configuration contribution. The
  code has always read it and the README has always documented it, but it never
  appeared in the Settings UI and never autocompleted in `settings.json`.
- Packaging no longer ships TypeScript sources. `.vscodeignore` matched source
  by filename, so a sync-conflict copy slipped past it.
