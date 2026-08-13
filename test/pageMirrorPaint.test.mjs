// The mirrored page's paint chain (media/pageMirror.ts), driven through the
// real bundle with a stub DOM.
//
// This is the fourth instance of one bug: a mirror that silently stops
// painting. Here the mechanism is `painting`, the single promise every frame's
// paint is chained onto. A link left REJECTED makes `.then` skip every later
// frame's callback for the life of the webview — so `paint` is never entered
// again, its `finally` ack never runs, and Chrome stops sending after
// MAX_UNACKED. One malformed payload (`atob`), one truncated frame
// (`createImageBitmap`) or one `drawImage` failure was enough.
//
// Nothing in src/ can catch this: the chain lives in the webview bundle, which
// test/bundle.mjs's `load` does not reach. `loadMedia` bundles media/ for a
// browser context instead, and the stubs below are the DOM that bundle runs
// against.
import { loadMedia } from './bundle.mjs';

/** A one-pixel JPEG's worth of base64 — valid base64, so `atob` succeeds and
 *  the failure under test can be placed where the test wants it. */
const GOOD = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
/** `atob` rejects characters outside the base64 alphabet, so this throws
 *  synchronously inside jpegBlob — the decode failure that needs no stub. */
const MALFORMED = 'not base64 !!!';

/** Let the paint chain (and the microtasks its awaits queue) run out. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

export default async function ({ ok, eq }) {
  const posted = [];
  const drawn = [];
  const listeners = new Map(); // "target:type" -> handler

  const listenerHost = (name) => ({
    addEventListener: (type, cb) => listeners.set(`${name}:${type}`, cb),
  });

  const canvas = {
    // 1x1, matching the real <canvas width="1" height="1"> src/pagePanel.ts's
    // renderMirrorHtml starts with — NOT 0x0. That distinction is the whole
    // point of the recording-guard test below: canvas.width === 0 can never
    // be true in production, only in a stub that gets this wrong.
    width: 1,
    height: 1,
    ...listenerHost('canvas'),
    getContext: () => ({ drawImage: (bitmap) => drawn.push(bitmap) }),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1, height: 1 }),
  };
  let statusRemoved = 0;
  const status = { remove: () => statusRemoved++ };
  // The degraded banner builds its own node rather than reaching for an id in
  // the host's HTML, so these two are what it needs from the document.
  const appended = [];

  const saved = {
    window: globalThis.window,
    document: globalThis.document,
    acquireVsCodeApi: globalThis.acquireVsCodeApi,
    createImageBitmap: globalThis.createImageBitmap,
    warn: console.warn,
  };
  const warnings = [];

  globalThis.acquireVsCodeApi = () => ({ postMessage: (m) => posted.push(m) });
  globalThis.window = { innerWidth: 800, innerHeight: 600, ...listenerHost('window') };
  globalThis.document = {
    ...listenerHost('document'),
    getElementById: (id) => (id === 'screen' ? canvas : status),
    createElement: (tag) => ({ tag, style: {}, hidden: false }),
    body: { appendChild: (el) => appended.push(el) },
  };
  // Failure is injected here, per frame — the module calls this global by name.
  let bitmapFor = null;
  globalThis.createImageBitmap = async () => {
    if (bitmapFor === null) {
      throw new Error('truncated frame');
    }
    return bitmapFor;
  };
  // Captured rather than printed: the fix logs every dropped frame, and a test
  // run should not be noisy about a failure it caused on purpose.
  console.warn = (...args) => warnings.push(args.join(' '));

  // A `painting` left rejected also surfaces as an unhandled rejection, which
  // Node treats as fatal by default — against the un-fixed module that kills
  // the whole run before a single assertion below can report what broke.
  // Registering a listener both suppresses that and makes the rejection an
  // assertable fact of its own; in the webview it is the console error that
  // accompanies a frozen mirror.
  const unhandled = [];
  const onUnhandled = (err) => unhandled.push(err);
  process.on('unhandledRejection', onUnhandled);

  try {
    await loadMedia('pageMirror.ts');

    const onMessage = listeners.get('window:message');
    ok(onMessage, 'the bundle registers a window message listener on load');

    // --- a recording cannot start before a frame has painted ----------------
    // Must run before ANY frame message below. The old guard checked
    // `canvas.width === 0`, which can never be true against the real webview
    // (the canvas starts at 1×1, matching this stub — see its own comment
    // above) — so a recording requested during the Chrome launch window
    // (now up to remoteVnc.mirrorLaunchTimeout, 45s by default) recorded
    // that 1×1 placeholder for the entire take and still reported success.
    onMessage({ data: { type: 'record-start', format: 'webm', fps: 10 } });
    const beforeAnyPaint = posted.filter((m) => m.type === 'record-status');
    eq(beforeAnyPaint.length, 1, 'a record-start before any frame paints is answered, not silently accepted');
    eq(beforeAnyPaint[0]?.recording, false, 'and reported as not recording');
    eq(
      beforeAnyPaint[0]?.error,
      'No frame has been painted yet.',
      'with the actual reason, not left to look like a real (if immediate) start'
    );

    // Baseline: a good frame paints and acks, so the counts below mean
    // something. Without this the whole file could pass against a module that
    // never paints at all.
    bitmapFor = { width: 320, height: 240, close: () => {} };
    onMessage({ data: { type: 'frame', data: GOOD } });
    await settle();
    eq(drawn.length, 1, 'a good frame is painted');
    eq(canvas.width, 320, 'the canvas takes the frame width');
    eq(posted.filter((m) => m.type === 'ack').length, 1, 'and is acknowledged exactly once');
    eq(statusRemoved, 1, 'the launch notice is removed once the first frame lands');

    // Once a frame HAS painted, the same guard no longer blocks a request —
    // whatever happens next (no real MediaRecorder in this Node harness) is
    // a different, expected failure, which is exactly the point: the "no
    // frame painted" guard is no longer what is stopping it.
    const beforeSecondAttempt = posted.length;
    onMessage({ data: { type: 'record-start', format: 'webm', fps: 10 } });
    const afterPaint = posted.slice(beforeSecondAttempt);
    eq(afterPaint.length, 1, 'a record-start after a frame has painted gets exactly one reply');
    eq(
      afterPaint[0]?.error,
      'this webview cannot encode WebM (MediaRecorder unavailable)',
      'rejected for an unrelated reason now, not "No frame has been painted yet."'
    );

    // --- the bug: a decode failure must not poison the chain ---------------
    // Failure 1 is asynchronous (createImageBitmap rejects on a truncated
    // frame); failure 2 is synchronous (atob throws on a payload outside the
    // base64 alphabet). Both used to leave `painting` rejected forever.
    bitmapFor = null;
    onMessage({ data: { type: 'frame', data: GOOD } });
    await settle();
    eq(drawn.length, 1, 'a frame that fails to decode paints nothing');
    eq(
      posted.filter((m) => m.type === 'ack').length,
      2,
      'but is still acknowledged — the ack is Chrome flow control, not a success signal'
    );

    // Decoding restored first, so THIS frame's only failure is the base64 one —
    // jpegBlob throwing synchronously, before any await.
    bitmapFor = { width: 320, height: 240, close: () => {} };
    onMessage({ data: { type: 'frame', data: MALFORMED } });
    await settle();
    eq(drawn.length, 1, 'a payload that fails base64 decoding paints nothing');
    eq(
      posted.filter((m) => m.type === 'ack').length,
      3,
      'a payload that fails base64 decoding is acknowledged too, not silently swallowed'
    );

    // The assertion this file exists for: before the fix, the two failures
    // above left `painting` rejected, so this callback never ran — no paint,
    // no ack, and a mirror frozen for the life of the webview.
    bitmapFor = { width: 640, height: 480, close: () => {} };
    onMessage({ data: { type: 'frame', data: GOOD } });
    await settle();
    eq(drawn.length, 2, 'a later good frame still paints — the chain survived two rejections');
    eq(canvas.width, 640, 'and resizes the canvas to the new frame');
    eq(
      posted.filter((m) => m.type === 'ack').length,
      4,
      'and acks, which is what keeps Chrome sending past MAX_UNACKED'
    );

    eq(warnings.length, 2, 'each dropped frame is reported once, so this is not silent');

    // --- the degraded banner -------------------------------------------------
    // When Chrome's renderer stops acknowledging input, frames keep arriving —
    // capture and encode are browser-process work, independent of the
    // renderer's input queue — so the tab looks perfectly alive while
    // ignoring the user. That combination is what got a struggling mirror
    // reported as a broken one, and this banner is the difference.
    onMessage({ data: { type: 'degraded', degraded: false } });
    eq(appended.length, 0, 'a mirror that never degrades adds nothing to the DOM');

    onMessage({ data: { type: 'degraded', degraded: true } });
    eq(appended.length, 1, 'the banner appears when the host says the queue is over the cap');
    eq(appended[0]?.hidden, false, 'and is actually visible');
    ok(
      /not keeping up/i.test(appended[0]?.textContent ?? ''),
      `it says the page is struggling, not that it failed (got: ${appended[0]?.textContent})`
    );
    ok(
      /Restart Mirrored Page/.test(appended[0]?.textContent ?? ''),
      'and names the way out, which is the half a user cannot guess'
    );

    onMessage({ data: { type: 'degraded', degraded: true } });
    eq(appended.length, 1, 'staying degraded does not stack a second banner');

    onMessage({ data: { type: 'degraded', degraded: false } });
    eq(appended[0]?.hidden, true, 'and recovery hides it again — the state is a valve, not a latch');

    // --- ordering is still one frame at a time ------------------------------
    // The chain's original job: two frames posted in the same tick must land in
    // arrival order, however their decodes interleave. A `catch` that replaced
    // the chain with a fresh promise would pass everything above and break this.
    const order = [];
    let releaseFirst;
    const gate = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    let call = 0;
    globalThis.createImageBitmap = async () => {
      const n = ++call;
      if (n === 1) {
        await gate; // the first frame decodes slowly
      }
      order.push(n);
      return { width: 10 + n, height: 10, close: () => {} };
    };
    onMessage({ data: { type: 'frame', data: GOOD } });
    onMessage({ data: { type: 'frame', data: GOOD } });
    await settle();
    eq(order, [], 'the second frame waits while the first is still decoding');
    releaseFirst();
    await settle();
    eq(order, [1, 2], 'frames land in arrival order, not decode order');

    await settle();
    eq(
      unhandled.length,
      0,
      'the paint chain never settles rejected — one that does skips every later frame for good'
    );
  } finally {
    process.off('unhandledRejection', onUnhandled);
    console.warn = saved.warn;
    globalThis.window = saved.window;
    globalThis.document = saved.document;
    globalThis.acquireVsCodeApi = saved.acquireVsCodeApi;
    globalThis.createImageBitmap = saved.createImageBitmap;
  }
}
