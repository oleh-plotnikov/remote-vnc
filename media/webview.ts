import RFB from '@novnc/novnc';
import { cropLayout, visibleSize } from '../src/cropLayout';

interface RfbOptions {
  viewOnly: boolean;
  scaleViewport: boolean;
  resizeSession: boolean;
  qualityLevel: number;
  compressionLevel: number;
  showDotCursor: boolean;
}

type ExtensionMessage =
  | {
      type: 'connect';
      url: string;
      password?: string;
      options: RfbOptions;
      forceRaw?: boolean;
      parkCursor?: boolean;
      crop?: { width: number; height: number };
    }
  | { type: 'disconnect' }
  | { type: 'reconnecting' }
  | { type: 'screenshot' };

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

// Cursor parking (per-connection "park server cursor"): touch-screen devices
// often paint a pointer arrow into the framebuffer itself (there is no
// client-side cursor to hide — the arrow is pixels in the image). The only
// remedy is to move it: once the local pointer has been idle for a moment,
// send a synthetic pointer move to the bottom-right corner so the arrow tucks
// away to a one-pixel sliver.
let parkCursor = false;
let parkTimer: ReturnType<typeof setInterval> | undefined;
let parked = false;
let lastLocalPointer = 0;
const PARK_IDLE_MS = 3000;

function markLocalPointer(): void {
  lastLocalPointer = Date.now();
  parked = false;
}
// Capture phase so noVNC's own handlers cannot swallow the events first.
for (const ev of ['pointermove', 'pointerdown', 'pointerup', 'wheel'] as const) {
  screen.addEventListener(ev, markLocalPointer, { capture: true, passive: true });
}

function stopCursorPark(): void {
  if (parkTimer !== undefined) {
    clearInterval(parkTimer);
    parkTimer = undefined;
  }
}

// The park destination and result are logged (once per connection) so a
// still-visible arrow can be told apart from parking never running at all:
// no "cursor parking armed" line means the setting never reached the webview,
// "parked" with the arrow still in place means the server ignores synthetic
// pointer moves.
let parkLogged = false;

function startCursorPark(): void {
  stopCursorPark();
  parked = false;
  post({ type: 'log', level: 'info', message: 'cursor parking armed' });
  // Parking must not race the user's own pointer: only act after PARK_IDLE_MS
  // of local silence, and only once per idle period. Uses the same noVNC
  // internals as the compat refresh (no public API sends a raw pointer event).
  parkTimer = setInterval(() => {
    const r = rfb as unknown as { _sock?: unknown; _fbWidth?: number; _fbHeight?: number } | undefined;
    if (!r || !r._sock || !r._fbWidth || !r._fbHeight) {
      return;
    }
    if (parked || Date.now() - lastLocalPointer < PARK_IDLE_MS) {
      return;
    }
    try {
      (RFB as unknown as {
        messages: { pointerEvent(s: unknown, x: number, y: number, mask: number): void };
      }).messages.pointerEvent(r._sock, r._fbWidth - 1, r._fbHeight - 1, 0);
      parked = true;
      if (!parkLogged) {
        parkLogged = true;
        post({
          type: 'log',
          level: 'info',
          message: `cursor parked at (${r._fbWidth - 1}, ${r._fbHeight - 1})`,
        });
      }
    } catch {
      /* internals shifted across a noVNC upgrade — stop parking rather than spam */
      post({ type: 'log', level: 'error', message: 'cursor parking unavailable (noVNC internals changed)' });
      stopCursorPark();
    }
  }, 1000);
}

// ---- visibleArea crop: hide a stride-padded framebuffer's dead band -------
// The server said the framebuffer is (say) 512x272 while the panel is
// 480x272. noVNC is given a container sized so its OWN scale-to-fit lands on
// the crop's scale, and an overflow-hidden box around it windows just the
// visible area. No transforms near the canvas — pointer math stays noVNC's.
let crop: { width: number; height: number } | undefined;
let clipbox: HTMLDivElement | undefined;
let cropInner: HTMLDivElement | undefined;
let cropObserver: ResizeObserver | undefined;
let cropLogged = false;

function teardownCrop(): void {
  cropObserver?.disconnect();
  cropObserver = undefined;
  clipbox = undefined;
  cropInner = undefined;
}

function layoutCrop(scaleToFit: boolean): void {
  if (!crop || !clipbox || !cropInner) {
    return;
  }
  const canvas = cropInner.querySelector('canvas');
  if (!canvas || !canvas.width || !canvas.height) {
    return;
  }
  const l = cropLayout(
    canvas.width,
    canvas.height,
    crop.width,
    crop.height,
    screen.clientWidth,
    screen.clientHeight,
    scaleToFit
  );
  if (!l) {
    return;
  }
  clipbox.style.width = `${l.clipWidth}px`;
  clipbox.style.height = `${l.clipHeight}px`;
  cropInner.style.width = `${l.innerWidth}px`;
  cropInner.style.height = `${l.innerHeight}px`;
  if (!cropLogged) {
    cropLogged = true;
    post({
      type: 'log',
      level: 'info',
      message: `showing ${Math.min(crop.width, canvas.width)}x${Math.min(crop.height, canvas.height)} of the ${canvas.width}x${canvas.height} framebuffer (visibleArea)`,
    });
  }
}

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
  stopCursorPark();
  teardownCrop();
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
  parkCursor = msg.parkCursor ?? false;
  parkLogged = false;
  crop = msg.crop;
  cropLogged = false;
  // A fresh connection starts idle, so the first park happens right away —
  // the arrow a touch-screen server paints at its resting position should be
  // gone before the operator ever sees it.
  lastLocalPointer = 0;

  // Diagnostic: the host the webview actually dials. In a remote window this
  // must be a forwarded authority, not 127.0.0.1 (the webview runs locally).
  const dialedHost = safeHost(msg.url);
  post({ type: 'log', level: 'info', message: `webview connecting to ${dialedHost}` });

  // With a crop, noVNC renders into an inner container whose size layoutCrop
  // controls, wrapped in an overflow-hidden clip box that the flex-centred
  // #screen positions like it would the canvas itself.
  let target: HTMLElement = screen;
  if (crop) {
    clipbox = document.createElement('div');
    clipbox.className = 'clipbox';
    cropInner = document.createElement('div');
    cropInner.className = 'clipinner';
    clipbox.appendChild(cropInner);
    screen.appendChild(clipbox);
    target = cropInner;
  }

  try {
    rfb = new RFB(target, msg.url, {
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
    // Report the framebuffer size the server actually advertised (the canvas
    // is created at exactly that size; CSS scaling does not touch the
    // attributes). A black band beside an embedded device's screen usually
    // means this is wider than the visible panel — the number settles it.
    const canvas = screen.querySelector('canvas');
    post({
      type: 'status',
      state: 'connected',
      width: canvas?.width,
      height: canvas?.height,
    });
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
    if (parkCursor) {
      startCursorPark();
    }
    if (crop) {
      // The framebuffer size is known now — size the clip box, and follow the
      // panel from here on (noVNC re-autoscales when its container resizes).
      layoutCrop(msg.options.scaleViewport);
      cropObserver = new ResizeObserver(() => layoutCrop(msg.options.scaleViewport));
      cropObserver.observe(screen);
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
  } else if (msg.type === 'screenshot') {
    // The framebuffer only exists here, in noVNC's canvas — capture it as a
    // PNG data URL and let the host do the saving (webviews cannot touch the
    // filesystem).
    const canvas = screen.querySelector('canvas');
    if (!rfb || !canvas) {
      post({ type: 'screenshot', error: 'No active connection to capture.' });
    } else {
      try {
        post({ type: 'screenshot', dataUrl: capture(canvas) });
      } catch (err) {
        post({ type: 'screenshot', error: describe(err) });
      }
    }
  }
});

/**
 * PNG data URL of what the viewer is showing. With a `visibleArea` crop the
 * canvas still holds the padded framebuffer — the dead band is hidden by a
 * clip box, not removed — so capturing the canvas directly would save the
 * band the user cannot see. Copy the visible rectangle out first; without a
 * crop the canvas is already the answer and no copy happens.
 */
function capture(canvas: HTMLCanvasElement): string {
  const size = visibleSize(canvas.width, canvas.height, crop);
  if (size.width === canvas.width && size.height === canvas.height) {
    return canvas.toDataURL('image/png');
  }
  const out = document.createElement('canvas');
  out.width = size.width;
  out.height = size.height;
  const ctx = out.getContext('2d');
  if (!ctx) {
    // No 2D context means no copy is possible; the padded capture beats none.
    return canvas.toDataURL('image/png');
  }
  ctx.drawImage(canvas, 0, 0, size.width, size.height, 0, 0, size.width, size.height);
  return out.toDataURL('image/png');
}

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
