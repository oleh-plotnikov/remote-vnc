# Contributing

Thanks for taking a look. Issues and pull requests are both welcome.

## Getting set up

```bash
npm install
npm run build      # bundle the extension host and the webview once
npm run watch      # rebuild on change
```

Press `F5` in VS Code to launch an Extension Development Host with the extension
loaded. `npm run watch` plus a window reload (`Developer: Reload Window`) is the
fastest edit loop.

## Before opening a pull request

```bash
npm run typecheck
npm test
```

Both run in CI on every push and pull request, so a red one will be caught
anyway — but locally they take seconds.

Tests live in `test/` and run on plain Node with no framework. `test/run.mjs`
discovers every `*.test.mjs` and calls its default export with an `{ ok, eq }`
assertion API. To reach the extension host code, `test/bundle.mjs` builds a
module out of `src/` against a minimal `vscode` stub, so pure logic can be
exercised without an Extension Development Host.

A new test is a new `test/<name>.test.mjs` exporting one async function — please
add cases that way rather than introducing a test runner.

## Trying it against a real server

You do not need hardware. Any VNC server on `localhost` will do:

```bash
# macOS: System Settings → General → Sharing → Screen Sharing
# Linux:
x11vnc -localhost -nopw -display :0
```

Then run **Remote VNC: Connect to Server…** and enter `127.0.0.1`.

For the remote path (Dev Container, Remote-SSH), see the README section on
running under a remote — that code path behaves differently enough that it is
worth testing separately if you touch the bridge.

## Commit messages

Wrap every line at 80 characters or fewer, subject and body alike.

Write the subject in the imperative, prefixed with the kind of change
(`feat:`, `fix:`, `docs:`, `chore:`). Use the body to explain **why** — what the
code does is already in the diff, but the reason it had to change is not.

## Some notes on the code

- `src/` is the extension host, `media/webview.ts` is the panel. They talk over
  `postMessage` only; the webview never touches VS Code APIs.
- `src/vncBridge.ts` is the security-sensitive part. It listens on `127.0.0.1`,
  guards the socket with a single-use token compared in constant time, and serves
  only the first client. Changes here deserve extra scrutiny — see
  [SECURITY.md](./SECURITY.md).
- Both bundles ship with attribution banners generated in `esbuild.js`. If you
  add a dependency that ends up bundled, add it there and to
  [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md); minification strips the
  original headers, so nothing else preserves them.

## Licence

By contributing you agree that your contribution is licensed under the MIT
Licence, the same terms as the rest of the project.
