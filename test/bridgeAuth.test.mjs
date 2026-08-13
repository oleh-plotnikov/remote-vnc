// When the bridge decides whether a client may speak to the VNC server.
//
// The token check ran in `wss.on('connection')` — after the handshake had
// already succeeded. Any page in any browser on this machine could open a
// WebSocket to the bridge (WebSockets are not subject to the same-origin
// policy), and the reply distinguished the two states it should not have: a
// live bridge answered 101 and then closed 1008, while everything else refused
// the connection outright. No framebuffer bytes leaked — the token still
// guarded those — but "Remote VNC is running, with a session open" is exactly
// what a fingerprinting script wants, and with a fixed `remoteVnc.bridgePort`
// it did not even need to scan for it.
//
// A real bridge against a real socket, because the property is about the
// handshake itself and a fake would be asserting on my own stand-in.
import net from 'node:net';
import { WebSocket } from 'ws';
import { load } from './bundle.mjs';

/** A stand-in VNC server: enough of one to prove bytes are proxied. */
function fakeVncServer() {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => socket.write('RFB 003.008\n'));
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/** Open a WebSocket and report how it was answered, without ever throwing. */
function attempt(url) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, ['binary']);
    const done = (outcome) => {
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* already gone */
      }
      resolve(outcome);
    };
    const timer = setTimeout(() => done({ kind: 'timeout' }), 4000);
    ws.on('upgrade', () => {
      // The 101 itself is the signal that matters, so it is what gets recorded —
      // a later 1008 close does not un-tell the caller what it just learned.
      ws.__upgraded = true;
    });
    ws.on('message', (data) => {
      const buf = Array.isArray(data) ? Buffer.concat(data) : data;
      done({ kind: 'banner', upgraded: true, text: buf.toString('latin1', 0, 12) });
    });
    ws.on('close', (code) => done({ kind: 'close', upgraded: ws.__upgraded === true, code }));
    ws.on('error', (err) => done({ kind: 'error', upgraded: ws.__upgraded === true, message: err.message }));
  });
}

export default async function ({ ok, eq }) {
  const { createBridge } = await load('vncBridge.ts');
  const { server, port } = await fakeVncServer();
  const bridge = await createBridge({ host: '127.0.0.1', port });

  try {
    // The legitimate client: the URL the webview is handed, token and all.
    const good = await attempt(bridge.url);
    eq(good.kind, 'banner', 'the tokened client is served');
    eq(good.text, 'RFB 003.008\n', 'and the server’s bytes are proxied through untouched');

    // Everything else must be refused BEFORE the protocol switch.
    const noToken = bridge.url.replace(/\?.*$/, '');
    const wrongToken = bridge.url.replace(/token=[^&]*/, `token=${'0'.repeat(48)}`);
    for (const [label, url] of [['no token', noToken], ['a wrong token', wrongToken]]) {
      const bad = await attempt(url);
      ok(!bad.upgraded, `${label}: the handshake never reaches 101, so a live bridge is not distinguishable from a closed port`);
      ok(bad.kind !== 'banner', `${label}: and no server bytes are proxied`);
    }
  } finally {
    bridge.dispose();
    server.close();
  }
}
