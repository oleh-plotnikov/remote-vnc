import { load } from './bundle.mjs';

export default async function ({ ok, eq }) {
  const { describeBridgeClose } = await load('closeDiagnostics.ts');
  const base = {
    label: 'lab',
    target: 'h:5900',
    sawConnected: true,
    connectedMs: 43000,
    forceRaw: false,
    willReconnect: false,
    reconnectSeconds: 10,
    rawHintShown: false,
  };

  // A session that connected and was then dropped cleanly by the server: the
  // blank-screen signature — info line with the duration, plus the force-raw
  // hint, exactly once.
  let d = describeBridgeClose(base);
  eq(d.level, 'info', 'clean close after connected is info');
  ok(d.message.includes('after 43s'), 'connected duration appears in the message');
  ok(!!d.hint && d.hint.includes('Force raw encoding'), 'hints at force raw encoding');
  eq(d.rawHintShown, true, 'hint marked as shown');
  d = describeBridgeClose({ ...base, rawHintShown: true });
  ok(!d.hint, 'hint is not repeated within a session');
  d = describeBridgeClose({ ...base, forceRaw: true });
  ok(!d.hint, 'no hint when force raw is already on');

  // A clean close with the handshake never completed points at the server,
  // loudly — it is how "accepted the TCP connection, then nothing" looks.
  d = describeBridgeClose({ ...base, sawConnected: false, connectedMs: undefined });
  eq(d.level, 'warn', 'pre-handshake clean close is a warning');
  ok(d.message.includes('before the RFB handshake completed'), 'names the missing handshake');
  ok(!d.hint, 'no force-raw hint before the handshake completed');

  // An abnormal close keeps the historical shape: error level, reason text,
  // and no phase suffix when the handshake never completed (the reason —
  // e.g. ECONNREFUSED — already tells that story).
  d = describeBridgeClose({ ...base, sawConnected: false, connectedMs: undefined, reason: 'connect ECONNREFUSED 1.2.3.4:5900' });
  eq(d.level, 'error', 'reasoned close is an error');
  eq(d.message, 'bridge closed (lab, h:5900): connect ECONNREFUSED 1.2.3.4:5900', 'pre-handshake reasoned message matches the historical shape');
  d = describeBridgeClose({ ...base, reason: 'boom' });
  ok(d.message.includes('after 43s') && d.message.includes('boom'), 'post-handshake reasoned close carries duration and reason');

  // Reconnecting drops: informational when the session worked or the reason
  // explains the drop, a warning when the handshake never completed (a silent
  // retry loop against a dead target should not look routine).
  d = describeBridgeClose({ ...base, willReconnect: true });
  eq(d.level, 'info', 'reconnecting drop after connected is info');
  ok(d.message.includes('reconnecting in 10s'), 'mentions the reconnect delay');
  d = describeBridgeClose({ ...base, willReconnect: true, reason: 'x' });
  eq(d.level, 'info', 'reasoned reconnecting drop is info');
  d = describeBridgeClose({ ...base, willReconnect: true, sawConnected: false, connectedMs: undefined });
  eq(d.level, 'warn', 'pre-handshake reconnecting drop is a warning');

  // Sub-second sessions still read as real durations.
  d = describeBridgeClose({ ...base, connectedMs: 120 });
  ok(d.message.includes('after 1s'), 'sub-second duration floors to 1s');
}
