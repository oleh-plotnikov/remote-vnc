/**
 * Pure formatting of the log lines emitted when a session's bridge closes.
 *
 * The Output channel used to go silent between the webview's "connecting"
 * line and a terse "bridge closed cleanly" much later, which made the two
 * field failure modes that matter indistinguishable:
 *
 *  - the RFB handshake never completed (wrong service on the port, or a
 *    single-viewer server already taken by another client), and
 *  - the handshake completed but the view stayed blank until the server
 *    dropped the idle viewer — the fixed-function-server quirk that
 *    "force raw encoding" exists for.
 *
 * Kept behind a pure function, mirroring ReconnectPolicy, so tests can pin
 * the levels and wording down without an extension host.
 */

export interface CloseContext {
  /** The connection's user-given label. */
  label: string;
  /** host:port of the VNC server. */
  target: string;
  /** Abnormal-closure reason from the bridge, if any. */
  reason?: string;
  /** The RFB handshake completed on this bridge (webview reported connected). */
  sawConnected: boolean;
  /** Milliseconds the session was connected, when sawConnected. */
  connectedMs?: number;
  /** The connection runs in "force raw encoding" compatibility mode. */
  forceRaw: boolean;
  /** The session will schedule a reconnect for this closure. */
  willReconnect: boolean;
  /** Delay before that reconnect, for the message. */
  reconnectSeconds: number;
  /** The force-raw hint was already logged once for this session. */
  rawHintShown: boolean;
}

export interface CloseDiagnostics {
  level: 'info' | 'warn' | 'error';
  message: string;
  /** Optional follow-up line with an actionable suggestion (log as info). */
  hint?: string;
  /** New value for CloseContext.rawHintShown. */
  rawHintShown: boolean;
}

export function describeBridgeClose(ctx: CloseContext): CloseDiagnostics {
  const where = `${ctx.label}, ${ctx.target}`;
  // With an error reason and no completed handshake the reason already tells
  // the story (e.g. ECONNREFUSED), so no phase is added — which also keeps
  // those messages byte-identical to what earlier releases logged.
  const phase = ctx.sawConnected
    ? ` after ${formatSeconds(ctx.connectedMs ?? 0)}`
    : ctx.reason
      ? ''
      : ' before the RFB handshake completed';
  const again = ctx.willReconnect ? ` — reconnecting in ${ctx.reconnectSeconds}s` : '';
  const reasonPart = ctx.reason ? `: ${ctx.reason}` : '';

  let level: 'info' | 'warn' | 'error';
  let message: string;
  if (ctx.willReconnect) {
    // A drop that never reached a usable session deserves attention even
    // while the session keeps retrying — it is how a reconnect loop against
    // an unreachable bridge or a non-VNC service looks.
    level = ctx.sawConnected || ctx.reason ? 'info' : 'warn';
    message = `bridge dropped (${where})${phase}${reasonPart}${again}`;
  } else if (ctx.reason) {
    level = 'error';
    message = `bridge closed (${where})${phase}${reasonPart}`;
  } else if (!ctx.sawConnected) {
    // Both sides closed without an error, yet nothing ever worked: the server
    // accepted the TCP connection and then went nowhere. Say so instead of
    // calling it merely "clean".
    level = 'warn';
    message =
      `bridge closed cleanly (${where}) before the RFB handshake completed — the server accepted ` +
      `the connection but the session never became usable. If this repeats, check that the target ` +
      `really is a VNC server and that no other viewer holds it (many embedded servers allow only one).`;
  } else {
    level = 'info';
    message = `bridge closed cleanly (${where})${phase}.`;
  }

  // A session that connected and was then dropped cleanly by the server is
  // the blank-screen signature of fixed-function embedded servers: they send
  // no framebuffer to a client advertising pseudo-encodings, then time the
  // idle viewer out. Logged once per session — right or wrong, once is enough.
  const hint =
    ctx.sawConnected && !ctx.reason && !ctx.forceRaw && !ctx.rawHintShown
      ? `if the view stayed blank until the connection dropped, enable "Force raw encoding" on this ` +
        `connection (Edit Connection… in the Saved Connections view, or "forceRawEncoding": true in ` +
        `remoteVnc.connections) — fixed-function embedded servers send no image without it.`
      : undefined;

  return { level, message, hint, rawHintShown: ctx.rawHintShown || hint !== undefined };
}

/** Whole seconds, floored to at least 1 so sub-second sessions still read as real. */
function formatSeconds(ms: number): string {
  return `${Math.max(1, Math.round(ms / 1000))}s`;
}
