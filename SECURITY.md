# Security Policy

## Reporting a vulnerability

Please do **not** open a public issue for a security problem.

Report it privately through GitHub's
[security advisory form](https://github.com/oleh-plotnikov/remote-vnc/security/advisories/new).
That keeps the report between us until a fix is available.

Expect an acknowledgement within a few days. Once a fix ships, you will be
credited in the advisory unless you would rather not be.

## Supported versions

Only the latest published version receives fixes. There are no maintenance
branches for older releases.

## What is worth reporting

The extension's sensitive surface is small but real:

- **The bridge.** The extension host listens on `127.0.0.1` and forwards bytes
  verbatim to a VNC server. It is guarded by a single-use 192-bit token compared
  in constant time, and serves only the first client. Anything that lets another
  local process reach a session, replay a token, or keep a bridge alive past its
  session is in scope.
- **Stored passwords.** VNC passwords live in VS Code's encrypted Secret Storage,
  keyed by `host:port` so a stored password cannot follow a renamed host. Any
  path that leaks one, or hands it to the wrong host, is in scope.
- **The webview.** It runs under a strict content security policy with a
  per-load nonce. Anything that lets remote framebuffer content, a server name,
  or a saved page URL execute script in the panel is in scope.
- **Workspace trust.** In an untrusted workspace, connections from workspace
  settings are ignored and only user-level ones are offered. A way to make an
  untrusted workspace initiate a connection is in scope.

## Known and accepted

**Classic RFB does not encrypt traffic.** This is a property of the protocol, not
a flaw in this extension, and is documented in the README. Across an untrusted
network, tunnel through SSH (`ssh -L 5901:localhost:5900 host`) and point the
extension at the local end of the tunnel. Reports amounting to "VNC traffic is
plaintext" will be closed with a pointer here.

## Third-party code

The bundles contain [noVNC](https://github.com/novnc/noVNC) and
[ws](https://github.com/websockets/ws); see
[THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md). Vulnerabilities in those
projects are best reported to them directly — please also open an advisory here
so the bundled version can be bumped.
