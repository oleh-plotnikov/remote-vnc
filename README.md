# Remote VNC

[![Marketplace](https://img.shields.io/visual-studio-marketplace/v/OlehPlotnikov.remote-vnc?label=marketplace)](https://marketplace.visualstudio.com/items?itemName=OlehPlotnikov.remote-vnc)
[![Open VSX](https://img.shields.io/open-vsx/v/OlehPlotnikov/remote-vnc?label=open%20vsx)](https://open-vsx.org/extension/OlehPlotnikov/remote-vnc)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/OlehPlotnikov.remote-vnc)](https://marketplace.visualstudio.com/items?itemName=OlehPlotnikov.remote-vnc)
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

## Usage

Open the Command Palette (`Ctrl/Cmd+Shift+P`) and run one of:

| Command | What it does |
| --- | --- |
| **Remote VNC: Connect to Server…** | Connect to an ad-hoc `host[:port]`. |
| **Remote VNC: Connect to Saved Server…** | Pick from your saved connections. |
| **Remote VNC: Add Saved Connection…** | Save a named connection for reuse. |
| **Remote VNC: Disconnect Active Session** | Close the focused session. |
| **Remote VNC: Take Screenshot** | Save the current framebuffer as a PNG. Also a 📷 button on connection and session rows and on the viewer tab. |

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
| `remoteVnc.screenshotDirectory` | `""` | Folder for one-click screenshot saves (`~` allowed; on the remote under WSL/SSH/containers). Empty = ask every time. |
| `remoteVnc.bridgePort` | `0` | Fixed bridge port for a **local Dev Container** (see below); `0` = ephemeral. |

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

The bundles also contain [noVNC](https://github.com/novnc/noVNC) (MPL-2.0) and
[ws](https://github.com/websockets/ws) (MIT), which stay under their own terms.
Attribution and source-availability details are in
[THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md).
