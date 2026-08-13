import { chmodSync, unlinkSync, writeFileSync } from 'fs';
import * as crypto from 'crypto';
import * as http from 'http';
import * as vscode from 'vscode';

import { controlErrorStatus, endpointFileName, parseControlRoute, tokenOk } from './controlRoutes';
import { getPanel, listPanels } from './panelRegistry';
import { logger } from './log';

/**
 * A loopback capture API, off unless the user turns it on.
 *
 * Same shape as vncBridge's authorisation: 127.0.0.1, an ephemeral port, and a
 * single random token. The token is written to a 0600 file rather than printed,
 * so the filesystem is what authenticates the caller.
 */
export async function startControlServer(
  context: vscode.ExtensionContext
): Promise<() => void> {
  const token = crypto.randomBytes(24).toString('hex');

  const server = http.createServer((req, res) => {
    const send = (code: number, body: unknown): void => {
      const json = JSON.stringify(body);
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(json);
    };

    if (!tokenOk(req.headers['x-remote-vnc-token'], token)) {
      send(401, { error: 'unauthorized' });
      return;
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const route = parseControlRoute(req.method ?? 'GET', url.pathname);
    if (!route) {
      send(404, { error: 'not found' });
      return;
    }
    if (route.kind === 'list') {
      send(200, { targets: listPanels() });
      return;
    }
    const panel = getPanel(route.id);
    if (!panel) {
      send(404, { error: 'unknown target' });
      return;
    }
    const run =
      route.kind === 'screenshot'
        ? panel.screenshot()
        : route.kind === 'record'
          ? panel.record().then(() => 'recording')
          : route.kind === 'recordStop'
            ? panel.recordStop()
            : panel.reload().then(() => 'reloaded');
    run.then(
      (result) => send(200, { result }),
      (err: Error) => send(controlErrorStatus(err.message), { error: err.message })
    );
  });

  // Node throws synchronously on an 'error' event with no listener, so a
  // failed bind (EMFILE, a sandboxed bind denial, ...) would otherwise escape
  // the try/catch around `startControlServer` in extension.ts and crash the
  // extension host instead of rejecting like every other setup failure here.
  // `settled` mirrors vncBridge.ts's `resolved`: before listen() resolves the
  // error rejects setup; afterwards (a runtime error accepting a later
  // connection, say) it only gets logged, since there is no promise left to
  // reject and the server is otherwise still usable.
  let settled = false;
  await new Promise<void>((resolve, reject) => {
    server.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
        return;
      }
      logger().error(`control: ${err.message}`);
    });
    server.listen(0, '127.0.0.1', () => {
      settled = true;
      resolve();
    });
  });
  // `close()` alone only stops the listener accepting new sockets: a client
  // parked on a keep-alive connection keeps its request pipeline open and could
  // go on capturing the screen after the user switched the setting off and the
  // token file was deleted. The capture surface must not outlive the consent
  // that opened it, so live connections are severed too.
  const closeServer = (): void => {
    server.close();
    server.closeAllConnections();
  };

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const endpoint = { url: `http://127.0.0.1:${port}`, token };
  const file = vscode.Uri.joinPath(context.globalStorageUri, endpointFileName(process.pid));

  // Everything past listen() can still fail — read-only storage, EACCES on a
  // root-owned stale file — and a throw here rejects the promise that
  // extension.ts turns into a toast. Without this the socket would stay bound
  // for the window's life with no stop function to close it, and
  // syncControlServer's `enabled === Boolean(controlServerStop)` guard would
  // read that live server as "off" and never retry.
  try {
    await vscode.workspace.fs.createDirectory(context.globalStorageUri);
    // Created with mode 0600 up front — the token must never be briefly
    // world-readable at the platform's default umask. Node only applies the
    // `mode` option when open() actually creates the file (O_CREAT); if a
    // stale endpoint file survives a crashed previous run of this same pid,
    // its existing permissions carry over untouched, so chmodSync still runs
    // afterwards to guarantee 0600 either way.
    writeFileSync(file.fsPath, JSON.stringify(endpoint), { mode: 0o600 });
    chmodSync(file.fsPath, 0o600);
  } catch (err) {
    closeServer();
    throw err;
  }

  logger().info(`control: listening on ${endpoint.url}, endpoint at ${file.fsPath}`);

  return () => {
    closeServer();
    // Synchronous and best-effort, and only ever this window's own file:
    // deactivate() calls this directly (not awaited), so the delete must be
    // done by the time it returns rather than queued as a microtask that a
    // closing window may never get to run.
    try {
      unlinkSync(file.fsPath);
    } catch {
      // Already gone, or the filesystem is unavailable during shutdown.
    }
  };
}
