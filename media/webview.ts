import RFB from '@novnc/novnc';

interface RfbOptions {
  viewOnly: boolean;
  scaleViewport: boolean;
  resizeSession: boolean;
  qualityLevel: number;
  compressionLevel: number;
  showDotCursor: boolean;
}

type ExtensionMessage =
  | { type: 'connect'; url: string; password?: string; options: RfbOptions; forceRaw?: boolean }
  | { type: 'disconnect' }
  | { type: 'reconnecting' };

interface VsCodeApi {
  postMessage(message: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
const screen = document.getElementById('screen') as HTMLDivElement;
const statusBar = document.getElementById('status') as HTMLDivElement;

let rfb: RFB | undefined;

// Set on an auth/security failure; cleared by the next connect. The failure
// status is terminal and actionable, so a racing host-side 'reconnecting'
// notice must not overwrite it (the host cancels that reconnect as soon as
// our securityfailure message reaches it).
let authFailed = false;

// Compatibility mode (per-connection "force raw"): advertise only Raw+CopyRect
// (no pseudo-encodings) AND poll for full framebuffer updates. Needed for static
// embedded servers (e.g. fixed-function appliances) that (a) answer the first
// request with a pseudo-only update for ANY advertised pseudo-encoding — after
// which noVNC switches to incremental requests it never answers, leaving a blank
// screen — and (b) ignore incremental requests, so the view would otherwise
// freeze on the first frame (and the server-rendered cursor would stay stuck).
let rawOnly = false;
let compatRefreshTimer: ReturnType<typeof setInterval> | undefined;

// Patch noVNC's encoding advertisement once. clientEncodings is a static used
// during the RFB handshake; filtering it (keeping codes <= 1: Raw=0, CopyRect=1,
// plus all negative pseudo-encodings) forces the server to use Raw.
{
  const RFBClass = RFB as unknown as {
    messages?: { clientEncodings?: (sock: unknown, encs: number[]) => void };
  };
  const orig = RFBClass.messages?.clientEncodings;
  if (orig) {
    RFBClass.messages!.clientEncodings = function (sock: unknown, encs: number[]) {
      // Compatibility mode: advertise ONLY Raw + CopyRect — no pseudo-encodings
      // at all. This server (a static embedded appliance) answers the first request
      // with a pseudo-rect-only update for ANY advertised pseudo-encoding
      // (ExtendedDesktopSize, Cursor, …); noVNC then switches to incremental
      // requests, which the static server never answers, leaving a blank screen.
      // Dropping every pseudo makes the first update carry the real framebuffer.
      return orig.call(this, sock, rawOnly ? encs.filter((e) => e === 0 || e === 1) : encs);
    };
  }
}

function stopCompatRefresh(): void {
  if (compatRefreshTimer !== undefined) {
    clearInterval(compatRefreshTimer);
    compatRefreshTimer = undefined;
  }
}

// Poll the server for a full (non-incremental) framebuffer update. A static
// embedded server ignores incremental requests, so without this the view freezes
// after the first frame. Uses noVNC internals (no public refresh API exists).
function startCompatRefresh(): void {
  stopCompatRefresh();
  compatRefreshTimer = setInterval(() => {
    const r = rfb as unknown as { _sock?: unknown; _fbWidth?: number; _fbHeight?: number } | undefined;
    if (!r || !r._sock || !r._fbWidth || !r._fbHeight) {
      return;
    }
    try {
      (RFB as unknown as {
        messages: { fbUpdateRequest(s: unknown, inc: boolean, x: number, y: number, w: number, h: number): void };
      }).messages.fbUpdateRequest(r._sock, false, 0, 0, r._fbWidth, r._fbHeight);
    } catch {
      /* internals shifted across a noVNC upgrade — stop polling rather than spam */
      stopCompatRefresh();
    }
  }, 1000);
}

function setStatus(text: string, kind: 'info' | 'ok' | 'error' | 'reconnecting'): void {
  statusBar.textContent = text;
  statusBar.dataset.kind = kind;
  statusBar.style.display = kind === 'ok' ? 'none' : 'block';
}

function post(message: unknown): void {
  vscode.postMessage(message);
}

function disconnect(): void {
  stopCompatRefresh();
  if (rfb) {
    try {
      rfb.disconnect();
    } catch {
      /* ignore */
    }
    rfb = undefined;
  }
  // A failed/unclean teardown can leave noVNC's old canvas behind; a new RFB
  // then renders NEXT TO it and the view shows a black band of the stale
  // canvas with the live framebuffer shifted/cropped. Always start clean.
  screen.replaceChildren();
}

function connect(msg: Extract<ExtensionMessage, { type: 'connect' }>): void {
  disconnect();
  setStatus('Connecting…', 'info');
  authFailed = false;
  rawOnly = msg.forceRaw ?? false;

  // Diagnostic: the host the webview actually dials. In a remote window this
  // must be a forwarded authority, not 127.0.0.1 (the webview runs locally).
  const dialedHost = safeHost(msg.url);
  post({ type: 'log', level: 'info', message: `webview connecting to ${dialedHost}` });

  try {
    rfb = new RFB(screen, msg.url, {
      credentials: msg.password ? { password: msg.password } : undefined,
      wsProtocols: ['binary'],
    });
  } catch (err) {
    setStatus(`Failed to start client: ${describe(err)}`, 'error');
    post({ type: 'log', level: 'error', message: describe(err) });
    return;
  }

  rfb.viewOnly = msg.options.viewOnly;
  rfb.scaleViewport = msg.options.scaleViewport;
  rfb.resizeSession = msg.options.resizeSession;
  rfb.qualityLevel = msg.options.qualityLevel;
  rfb.compressionLevel = msg.options.compressionLevel;
  rfb.showDotCursor = msg.options.showDotCursor;
  rfb.background = 'transparent';
  rfb.focusOnClick = true;

  rfb.addEventListener('connect', () => {
    setStatus('Connected', 'ok');
    post({ type: 'status', state: 'connected' });
    // Recompute the scale once the real framebuffer size is known — the
    // container may have been measured pre-layout (or while the tab was
    // hidden), which bakes in a wrong offset/scale until a window resize.
    requestAnimationFrame(() => {
      if (rfb) {
        rfb.scaleViewport = msg.options.scaleViewport;
      }
    });
    // In compatibility mode the server ignores incremental requests; poll for
    // full updates so the view stays live (and the server cursor tracks).
    if (rawOnly) {
      startCompatRefresh();
    }
  });

  rfb.addEventListener('disconnect', (e: CustomEvent<{ clean: boolean }>) => {
    const clean = e.detail?.clean ?? true;
    if (!clean) {
      setStatus('Connection lost', 'error');
      // An unclean drop right after "Connecting…" usually means the WebSocket
      // never reached the bridge — most often a remote-forwarding gap.
      post({
        type: 'log',
        level: 'error',
        message: `connection lost (unclean) for ${safeHost(msg.url)} — if this is a remote window, the forwarded bridge port may be unreachable`,
      });
    } else if (statusBar.dataset.kind !== 'error') {
      // A clean teardown that we triggered in response to an error (e.g. the
      // "password required" prompt) must not overwrite that actionable message.
      setStatus('Disconnected', 'info');
    }
    post({ type: 'status', state: 'disconnected', clean });
    rfb = undefined;
  });

  rfb.addEventListener('credentialsrequired', () => {
    authFailed = true;
    setStatus('Server requires a password — run the connect command again and provide one.', 'error');
    post({ type: 'securityfailure', reason: 'A password is required.' });
    // Tear down so the WebSocket and the live TCP connection are released
    // instead of hanging in the connecting state awaiting credentials.
    disconnect();
  });

  rfb.addEventListener('securityfailure', (e: CustomEvent<{ status: number; reason?: string }>) => {
    authFailed = true;
    const reason = e.detail?.reason ?? `status ${e.detail?.status}`;
    setStatus(`Security failure: ${reason}`, 'error');
    post({ type: 'securityfailure', reason });
  });

  rfb.addEventListener('desktopname', (e: CustomEvent<{ name: string }>) => {
    if (e.detail?.name) {
      post({ type: 'desktopname', name: e.detail.name });
    }
  });
}

window.addEventListener('message', (event: MessageEvent<ExtensionMessage>) => {
  const msg = event.data;
  if (!msg || typeof msg.type !== 'string') {
    return;
  }
  if (msg.type === 'connect') {
    connect(msg);
  } else if (msg.type === 'disconnect') {
    disconnect();
    if (statusBar.dataset.kind !== 'error') {
      setStatus('Disconnected', 'info');
    }
  } else if (msg.type === 'reconnecting') {
    disconnect();
    if (!authFailed) {
      setStatus('Reconnecting…', 'reconnecting');
    }
  }
});

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The `scheme://host:port` of a ws URL, with the token stripped, for logging. */
function safeHost(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '<unparsable url>';
  }
}

// Signal the extension host that our message listener is attached, so it can
// safely deliver the (single) connect message without it being dropped.
post({ type: 'ready' });
