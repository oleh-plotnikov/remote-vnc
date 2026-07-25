import { load } from './bundle.mjs';

export default async function ({ ok, eq }) {
  const { ReconnectPolicy } = await load('reconnectPolicy.ts');
  const p = new ReconnectPolicy(10000);

  eq(p.onBridgeClosed({ autoReconnect: true, disposed: false, authFailed: false }), { action: 'reconnect', delayMs: 10000 }, 'reconnects when enabled, live, not auth-failed');
  eq(p.onBridgeClosed({ autoReconnect: false, disposed: false, authFailed: false }), { action: 'stop' }, 'stops when autoReconnect off');
  eq(p.onBridgeClosed({ autoReconnect: true, disposed: true, authFailed: false }), { action: 'stop' }, 'stops when disposed');
  eq(p.onBridgeClosed({ autoReconnect: true, disposed: false, authFailed: true }), { action: 'stop' }, 'stops after auth failure');
}
