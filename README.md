# Remote VNC

[![Marketplace](https://vsmarketplacebadges.dev/version/OlehPlotnikov.remote-vnc.svg?label=marketplace)](https://marketplace.visualstudio.com/items?itemName=OlehPlotnikov.remote-vnc)
[![Open VSX](https://img.shields.io/open-vsx/v/OlehPlotnikov/remote-vnc?label=open%20vsx)](https://open-vsx.org/extension/OlehPlotnikov/remote-vnc)
[![Installs](https://vsmarketplacebadges.dev/installs-short/OlehPlotnikov.remote-vnc.svg)](https://marketplace.visualstudio.com/items?itemName=OlehPlotnikov.remote-vnc)
[![CI](https://github.com/oleh-plotnikov/remote-vnc/actions/workflows/ci.yml/badge.svg)](https://github.com/oleh-plotnikov/remote-vnc/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

View and control a remote screen over **VNC** directly inside Visual Studio Code.

Remote VNC embeds the battle-tested [noVNC](https://github.com/novnc/noVNC) client
in a VS Code editor panel and bridges it to any standard VNC/RFB server — no
external `websockify` proxy required. Connect to a headless server, a container,
a dev board, or a desktop without leaving your editor.

## Install

Search for **Remote VNC** in the Extensions view, or:

```bash
code --install-extension OlehPlotnikov.remote-vnc
```

For VSCodium, Cursor, Windsurf and other editors that do not use Microsoft's
Marketplace, the same extension is on
[Open VSX](https://open-vsx.org/extension/OlehPlotnikov/remote-vnc). A `.vsix` is
attached to every [release](https://github.com/oleh-plotnikov/remote-vnc/releases)
if you would rather install it by hand.

## Features

- 🖥️ **Full VNC viewer** in an editor tab — keyboard, mouse and live framebuffer.
- 🔌 **No proxy needed** — the extension runs a private, loopback-only
  `TCP ↔ WebSocket` bridge with a single-use token, so the browser-based client
  can reach a raw RFB server.
- 💾 **Saved connections** stored in settings, with passwords kept in VS Code's
  encrypted **Secret Storage**. The pencil on a connection row opens a menu of
  every property — address, auto-reconnect, raw encoding, cursor parking,
  visible area — and each change is saved as you make it.
- 🎚️ **Tunable** quality / compression, view-only mode, viewport scaling and
  optional server-side resize.
- 🧩 **Multiple sessions** — open several remote screens side by side.
- **Session recording** — a record/stop button on the viewer tab, session
  rows, and connection rows captures the session as WebM video or animated
  GIF (`remoteVnc.recordingFormat`), saved like screenshots or opened as a
  tab without saving (`remoteVnc.recordingAction`).
- **Original-size display** — a connection can opt out of scale-to-fit and
  render 1:1 with scrollbars (`scaleViewport` per connection).
- **Screenshot cropping** — a capture opens in a crop editor rather than the
  built-in image preview, which can zoom but cannot select a region: drag a
  rectangle over the screenshot, nudge its edges with the arrow keys, and
  press Crop to trim the file down to the dialog, the fault message or the
  one widget that matters (`remoteVnc.screenshotCropEditor`).

## Usage

Open the Command Palette (`Ctrl/Cmd+Shift+P`) and run one of:

| Command | What it does |
| --- | --- |
| **Remote VNC: Connect to Server…** | Connect to an ad-hoc `host[:port]`. |
| **Remote VNC: Connect to Saved Server…** | Pick from your saved connections. |
| **Remote VNC: Add Saved Connection…** | Save a named connection for reuse. |
| **Remote VNC: Disconnect Active Session** | Close the focused session. |
| **Remote VNC: Take Screenshot** | Save the current framebuffer as a PNG. Also a 📷 button on connection and session rows and on the viewer tab. |
| **Remote VNC: Crop Image…** | Open the PNG in the active tab in the crop editor. Also a button on the editor title bar of any PNG shown in the built-in image preview, and a **Reopen Editor With…** entry. |

### Address formats

- `192.168.1.10` → port `5900`
- `server:5901` → explicit TCP port
- `server:1` → VNC **display** 1 → port `5901` (values below 100 are display numbers)
- `[::1]:5901` → bracketed IPv6 literal

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `remoteVnc.connections` | `[]` | Saved connections (`name`, `host`, `port`, optional `autoReconnect`, `forceRawEncoding`, `parkServerCursor`, `scaleViewport`, `visibleArea`). |
| `remoteVnc.autoReconnect` | `true` | Reconnect every 10 s after an unexpected drop. A connection's own `autoReconnect` overrides this. Stops on auth failure or manual disconnect. |
| `remoteVnc.viewOnly` | `false` | Ignore local input. |
| `remoteVnc.scaleViewport` | `true` | Scale the framebuffer to fit the panel. |
| `remoteVnc.resizeSession` | `false` | Ask the server to resize to the panel. |
| `remoteVnc.qualityLevel` | `6` | Tight JPEG quality (0–9). |
| `remoteVnc.compressionLevel` | `2` | Tight compression (0–9). |
| `remoteVnc.showDotCursor` | `false` | Always show a dot cursor. |
| `remoteVnc.parkServerCursor` | `false` | Park the server-drawn pointer in the bottom-right corner when idle — for touch-screen devices that paint an arrow into the framebuffer. Per-connection `parkServerCursor` overrides this. |
| `remoteVnc.screenshotDirectory` | `""` | Folder for one-click screenshot and recording saves (`~` allowed; on the remote under WSL/SSH/containers). Empty = ask every time. |
| `remoteVnc.screenshotAction` | `"open"` | When a screenshot is taken: `open` as an editor tab (no file kept) or `save` to disk. |
| `remoteVnc.screenshotCropEditor` | `true` | Open a screenshot in the crop editor instead of the built-in image preview. Applies when `screenshotAction` is `open`. |
| `remoteVnc.recordingFormat` | `"webm"` | Recording format: `webm` (efficient video) or `gif` (256-color animation). |
| `remoteVnc.recordingFrameRate` | `10` | Frames per second for recordings (1–30). |
| `remoteVnc.recordingAction` | `"open"` | When a recording stops: `open` as an editor tab (no file kept) or `save` to disk. |
| `remoteVnc.bridgePort` | `0` | Fixed bridge port for a **local Dev Container** (see below); `0` = ephemeral. |

Recordings stop and save themselves when the connection drops or when you
run **Disconnect**; closing the viewer tab itself discards an in-progress
recording. One recording is capped at 10 minutes.

Crop overwrites the file open in the tab: a cropped capture is still the
staged copy, so it disappears after seven days unless you **Save** it, and
**Revert** undoes a crop only for as long as the tab stays open. An image
preview of the same file open in another editor group keeps showing the
pre-crop image until it is closed and reopened.

## How it works

```
┌──────────────┐   postMessage   ┌─────────────────────┐   WebSocket    ┌──────────────┐   TCP/RFB   ┌────────────┐
│  Webview      │ ◀────────────▶ │  Extension host      │ ◀───────────▶ │  Loopback     │ ◀────────▶ │ VNC server │
│  (noVNC RFB)  │                 │  (commands, bridge)  │  127.0.0.1     │  WS↔TCP bridge │            │            │
└──────────────┘                 └─────────────────────┘                └──────────────┘             └────────────┘
```

Browsers — and therefore VS Code webviews — cannot open raw TCP sockets, while
VNC servers speak the RFB protocol over plain TCP. The extension host opens an
ephemeral WebSocket server bound to `127.0.0.1`, guarded by a random per-session
token, and pipes bytes verbatim to a fresh TCP connection to the VNC server.

> **Security note:** VNC traffic itself is not encrypted by classic RFB. For
> connections across untrusted networks, tunnel through SSH
> (`ssh -L 5901:localhost:5900 host`) and point Remote VNC at the local end of
> the tunnel.

## Running on a remote (Dev Container, Remote-SSH, WSL, Codespaces)

When VS Code is attached to a remote, the **extension host and the bridge run on
the remote**, but the **webview renders on your local machine**. The bridge's
`127.0.0.1` therefore means *the remote*, which the webview cannot reach directly.
The extension resolves the bridge URL through
[`asExternalUri`](https://code.visualstudio.com/api/references/vscode-api#env.asExternalUri),
which forwards the port out to your machine.

For **Remote-SSH, WSL and Codespaces** this is automatic. For a **local Dev
Container**, `asExternalUri` does **not** auto-forward an ephemeral port — so set
a fixed bridge port and forward it once:

```jsonc
// .devcontainer/devcontainer.json
{
  "forwardPorts": [5959],
  "customizations": {
    "vscode": { "settings": { "remoteVnc.bridgePort": 5959 } }
  }
}
```

Then `Dev Containers: Rebuild and Reopen in Container` (or just forward port
`5959` from the **Ports** panel without rebuilding). A fixed bridge port allows
**one** session at a time. Connection diagnostics are written to the
**Remote VNC** output channel (`View → Output → Remote VNC`).

## Development

```bash
npm install
npm run build      # bundle extension host + webview once
npm run watch      # rebuild on change
```

Press `F5` in VS Code to launch an Extension Development Host.

To produce a `.vsix`:

```bash
npm run build
npx @vscode/vsce package --no-dependencies
```

## License

[MIT](./LICENSE).

The bundles also contain [noVNC](https://github.com/novnc/noVNC) (MPL-2.0,
carrying pako and a DES cipher under their own notices),
[gifenc](https://github.com/mattdesl/gifenc) (MIT) and
[ws](https://github.com/websockets/ws) (MIT), which stay under their own terms.
Attribution and source-availability details are in
[THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md), which also ships inside
the installed extension.
