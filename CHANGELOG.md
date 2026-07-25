# Changelog

All notable changes to **Remote VNC** are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
