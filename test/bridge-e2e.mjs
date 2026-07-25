// End-to-end check of the TCP<->WebSocket bridge against a REAL VNC server.
// Not part of the auto-run suite (it needs a live server); run manually:
//
//   VNC_PORT=5900 node test/bridge-e2e.mjs
//
// It opens the real bridge, connects a WebSocket the way noVNC does, and asserts
// the server's RFB ProtocolVersion banner is proxied straight through.
import { load } from './bundle.mjs';
import { WebSocket } from 'ws';

const port = Number(process.env.VNC_PORT || 5900);
const { createBridge } = await load('vncBridge.ts');

const bridge = await createBridge({ host: '127.0.0.1', port });
console.log('bridge url:', bridge.url);

try {
  const banner = await new Promise((resolve, reject) => {
    const ws = new WebSocket(bridge.url, ['binary']);
    const timer = setTimeout(() => reject(new Error('timed out waiting for RFB banner')), 5000);
    ws.on('message', (data) => {
      clearTimeout(timer);
      const buf = Array.isArray(data) ? Buffer.concat(data) : data;
      ws.close();
      resolve(buf.toString('latin1', 0, Math.min(12, buf.length)));
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

  if (/^RFB 003\.00\d/.test(banner)) {
    console.log('OK — bridge proxied the RFB handshake:', JSON.stringify(banner));
    process.exitCode = 0;
  } else {
    console.error('FAIL — unexpected first bytes:', JSON.stringify(banner));
    process.exitCode = 1;
  }
} catch (err) {
  console.error('FAIL —', err.message);
  process.exitCode = 1;
} finally {
  bridge.dispose();
}
