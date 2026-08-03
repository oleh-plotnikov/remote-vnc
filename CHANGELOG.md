# Changelog

All notable changes to **Remote VNC** are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
