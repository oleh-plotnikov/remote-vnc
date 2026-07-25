// Unit tests for toWebviewWsUrl: the loopback->webview URL rewrite that makes
// the bridge reachable when the extension host runs on a remote (dev container,
// Remote-SSH, …). asExternalUri behaviour is injected via globalThis.
import { load } from './bundle.mjs';

const LOOPBACK = 'ws://127.0.0.1:5555/?token=abcdef0123456789';

export default async function ({ eq }) {
  const { toWebviewWsUrl } = await load('vncPanel.ts');

  // Local window: asExternalUri is a no-op, so the URL is returned unchanged.
  globalThis.__asExternalUri = async (u) => u;
  eq(await toWebviewWsUrl(LOOPBACK), LOOPBACK, 'local window leaves the loopback URL unchanged');

  // Remote with a forwarded local port: scheme stays ws, host/port rewritten,
  // and the single-use token survives the round-trip.
  globalThis.__asExternalUri = async (u) => u.with({ authority: '127.0.0.1:60000' });
  eq(
    await toWebviewWsUrl(LOOPBACK),
    'ws://127.0.0.1:60000/?token=abcdef0123456789',
    'forwarded local port keeps ws:// and preserves the token',
  );

  // Remote over a TLS tunnel (e.g. Codespaces): https resolves to wss.
  globalThis.__asExternalUri = async (u) =>
    u.with({ scheme: 'https', authority: 'app-60000.tunnel.vscode.dev' });
  eq(
    await toWebviewWsUrl(LOOPBACK),
    'wss://app-60000.tunnel.vscode.dev/?token=abcdef0123456789',
    'TLS tunnel maps https to wss',
  );

  // The token must survive verbatim, never percent-encoded. vscode.Uri.toString
  // encodes the query ('=' -> '%3D'), which the bridge rejects, so the original
  // query is carried across by hand instead of round-tripped through the Uri.
  globalThis.__asExternalUri = async (u) => u.with({ authority: 'localhost:7001' });
  const resolved = await toWebviewWsUrl(LOOPBACK);
  eq(resolved, 'ws://localhost:7001/?token=abcdef0123456789', 'token is preserved exactly (no %3D)');
  eq(resolved.includes('%3D'), false, 'resolved URL never percent-encodes the token separator');

  // If forwarding throws, fall back to the raw loopback URL (correct locally,
  // no worse than before remotely).
  globalThis.__asExternalUri = async () => {
    throw new Error('forwarding unavailable');
  };
  eq(await toWebviewWsUrl(LOOPBACK), LOOPBACK, 'forwarding failure falls back to the raw URL');

  delete globalThis.__asExternalUri;
}
