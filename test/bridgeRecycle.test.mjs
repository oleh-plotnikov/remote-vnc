// Bridge port recycling: a closed ephemeral bridge's port is reused by the
// next createBridge, so remote windows re-forward the SAME port instead of
// leaving one dead "User Forwarded" Ports-panel row per (re)connect.
// Real loopback listeners (port 0), no VNC server needed — the bridge binds
// before any client connects.
import { load } from './bundle.mjs';

const TARGET = { host: '127.0.0.1', port: 1 }; // never dialed: no ws client connects

const portOf = (bridge) => Number(new URL(bridge.url.replace('ws://', 'http://')).port);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function ({ ok }) {
  const { createBridge } = await load('vncBridge.ts');

  // Dispose frees the port into the recycle pool (asynchronously, once the
  // server actually closes) and the next ephemeral bridge picks it up.
  const first = await createBridge(TARGET);
  const firstPort = portOf(first);
  ok(firstPort > 0, 'ephemeral bridge binds a real port');
  first.dispose();
  let second;
  for (let i = 0; i < 20; i++) {
    await sleep(25);
    second = await createBridge(TARGET);
    if (portOf(second) === firstPort) {
      break;
    }
    second.dispose(); // recycle pool not refilled yet — retry
    second = undefined;
  }
  ok(second !== undefined && portOf(second) === firstPort, 'next bridge reuses the freed port');

  // Concurrent bridges get distinct ports (the pool only holds FREED ports).
  const third = await createBridge(TARGET);
  ok(portOf(third) !== firstPort, 'live bridges never share a port');

  second.dispose();
  third.dispose();
  await sleep(50); // let close callbacks run before the suite exits
}
