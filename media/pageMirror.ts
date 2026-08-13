/**
 * The mirrored page's webview half: paint the CDP screencast onto a canvas and
 * post input back. What media/webview.ts is to a VNC session, this is to a
 * Chrome tab — a picture of a screen somewhere else, plus the events needed to
 * drive it.
 *
 * The two things it imports from `src/` are captureChordAction and
 * RecordingFormat, both pure: no imports of their own, no Node globals, and
 * captureChordAction takes a structural `ChordEvent` rather than a DOM
 * `KeyboardEvent`. That purity is
 * the bar for anything else from `src/` arriving here — the CDP modules reach
 * for `Buffer`, which does not exist in this context, and a bundle that pulls
 * one in fails at runtime rather than at build time. Frames arrive already
 * decoded from the host, and the messages this file posts are re-validated
 * there (src/mirrorInput.ts, or consumed directly for the two recording
 * messages — see src/pagePanel.ts's handleMirrorMessage) — nothing said here
 * is trusted on arrival.
 */
import { captureChordAction } from '../src/captureChord';
import { RecordingFormat } from '../src/recording';
import { startRecording, Recorder } from './recorder';

interface VsCodeApi {
  postMessage(message: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

/** The messages the host sends: one JPEG screencast frame, base64, or a
 *  recording start/stop — the same two media/webview.ts answers for a VNC
 *  session, sent here because the canvas already receiving the mirror's
 *  frames is the recordable surface (media/recorder.ts). */
type HostMessage =
  | { type: 'frame'; data: string }
  | { type: 'record-start'; format: RecordingFormat; fps: number }
  | { type: 'record-stop' }
  | { type: 'degraded'; degraded: boolean };

const vscode = acquireVsCodeApi();
const canvas = document.getElementById('screen') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const status = document.getElementById('status');

/**
 * Frames are painted one at a time, in arrival order. Decoding is async, so
 * without this chain two frames in flight would race and the older one could
 * land last — and each link ends in exactly one ack, which is what keeps the
 * host's unacknowledged-frame queue in step with Chrome's.
 *
 * This promise must therefore NEVER settle rejected: a rejected link makes
 * `.then` skip every later frame's callback for the life of the webview, so
 * `paint` is never entered again, no ack is ever posted again, and Chrome
 * stops sending after MAX_UNACKED — a mirror that silently freezes. `paint`
 * is what guarantees that, by catching everything itself.
 */
let painting: Promise<void> = Promise.resolve();

/**
 * Whether at least one frame has actually been drawn onto `canvas`.
 *
 * NOT `canvas.width === 0`: the canvas starts at 1×1 (see the `<canvas
 * width="1" height="1">` in src/pagePanel.ts's renderMirrorHtml), so that
 * check could never fire — a recording started before the first frame
 * arrived silently recorded the 1×1 placeholder for the entire take and
 * still reported success, reachable simply by requesting a recording during
 * the Chrome launch window (now up to `remoteVnc.mirrorLaunchTimeout`,
 * default 45s) before anything has painted.
 */
let hasPainted = false;

/** At most one recording at a time, the same invariant media/webview.ts keeps
 *  for a VNC session's canvas. */
let recorder: Recorder | undefined;

window.addEventListener('message', (event) => {
  const msg = event.data as HostMessage | undefined;
  if (msg?.type === 'frame' && typeof msg.data === 'string') {
    painting = painting.then(() => paint(msg.data));
  } else if (msg?.type === 'record-start') {
    startPageRecording(msg.format, msg.fps);
  } else if (msg?.type === 'record-stop') {
    stopPageRecording();
  } else if (msg?.type === 'degraded') {
    showDegraded(msg.degraded === true);
  }
});

/**
 * The "this mirror is struggling" banner, built here rather than declared in
 * the host's HTML (src/pagePanel.ts's renderMirrorHtml) so one file owns both
 * the element and the wording — an id shared across that boundary would go
 * stale silently, and a banner that never appears is indistinguishable from
 * the frozen mirror it exists to explain.
 *
 * Why show anything at all: when Chrome's renderer stops acknowledging input,
 * frames keep arriving (capture and encode are browser-process work,
 * independent of the renderer's input queue), so the tab looks alive while
 * ignoring the user. That combination reads as broken software rather than as
 * a busy page, and the difference is the whole reason the host bothers to
 * measure the queue — see markMirrorDegraded in src/pagePanel.ts.
 *
 * Created lazily: a mirror that never degrades never adds a node.
 */
let degradedBanner: HTMLElement | undefined;
function showDegraded(on: boolean): void {
  if (!degradedBanner) {
    if (!on) {
      return; // nothing has ever been shown, so there is nothing to hide
    }
    const el = document.createElement('div');
    el.textContent =
      'This page is not keeping up — pointer movement is being dropped so typing and clicks ' +
      'keep landing. If it stays stuck, open the page again from the Web Pages view, or run ' +
      '"Remote VNC: Restart Mirrored Page".';
    // Inline, because the panel's CSP allows inline styles but no stylesheet
    // of ours would reach this element without the id contract avoided above.
    // pointer-events:none so the banner cannot swallow a click meant for the
    // page it is complaining about.
    el.style.cssText =
      'position:absolute;top:0;left:0;right:0;z-index:1;padding:6px 10px;text-align:center;' +
      'font:12px var(--vscode-font-family, sans-serif);pointer-events:none;' +
      'color:var(--vscode-inputValidation-warningForeground, #fff);' +
      'background:var(--vscode-inputValidation-warningBackground, #5a4300);' +
      'border-bottom:1px solid var(--vscode-inputValidation-warningBorder, #b89500);';
    document.body.appendChild(el);
    degradedBanner = el;
  }
  degradedBanner.hidden = !on;
}

/**
 * Start recording the mirror's own canvas — the same canvas `paint` draws
 * every frame into, so whatever the tab is currently showing is what gets
 * recorded. No crop concept here (unlike media/webview.ts): a mirrored page
 * has no visibleArea setting, so the whole canvas is the recordable area.
 */
function startPageRecording(format: RecordingFormat, fps: number): void {
  if (recorder) {
    return; // already recording — the registry's own guard should prevent this
  }
  if (!hasPainted) {
    vscode.postMessage({
      type: 'record-status',
      recording: false,
      error: 'No frame has been painted yet.',
    });
    return;
  }
  const started = startRecording({
    canvas,
    width: canvas.width,
    height: canvas.height,
    format,
    fps,
    onStop: (result) => {
      recorder = undefined;
      vscode.postMessage({
        type: 'recording',
        format,
        data: result.data,
        durationMs: result.durationMs,
        reason: result.reason,
      });
    },
    onError: (message) => {
      recorder = undefined;
      vscode.postMessage({ type: 'record-status', recording: false, error: message });
    },
  });
  if (started) {
    recorder = started;
    vscode.postMessage({ type: 'record-status', recording: true });
  }
}

function stopPageRecording(): void {
  if (recorder) {
    // onStop delivers the bytes and clears `recorder`; stop() is idempotent.
    recorder.stop('stopped');
  } else {
    // A fresh webview (rebuilt by restartMirrorWebview) knows nothing of an
    // old recording — answering "not recording" heals the host's state,
    // exactly as media/webview.ts's record-stop handler does.
    vscode.postMessage({ type: 'record-status', recording: false });
  }
}

async function paint(data: string): Promise<void> {
  try {
    const bitmap = await createImageBitmap(jpegBlob(data));
    if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
    }
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    hasPainted = true;
    // The first frame is the only proof the whole chain works; the launch
    // notice has said what it can and is now in the way.
    status?.remove();
  } catch (err) {
    // Swallowed rather than rethrown, and this is the whole point: `atob` on a
    // malformed payload, `createImageBitmap` on a truncated frame and
    // `drawImage` can all throw, and letting one out would leave `painting`
    // rejected forever (see its comment above). One frame lost to a bad
    // payload is a flicker; a rejected chain is a dead mirror.
    console.warn('mirror: dropped a frame —', err);
  } finally {
    // Acknowledge after painting, and even after a decode failure: the ack is
    // Chrome's flow control. Acking early turns a slow paint into an unbounded
    // frame queue; never acking stops the stream dead, with a frozen page and
    // no error anywhere as the only symptom.
    vscode.postMessage({ type: 'ack' });
  }
}

/**
 * Base64 → Blob by hand rather than `fetch('data:image/jpeg;base64,…')`:
 * a fetch of a data: URL is governed by `connect-src`, and this panel's CSP
 * grants none. Widening it to carry image bytes would be a real loosening for
 * something four lines of decoding already do.
 */
function jpegBlob(base64: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: 'image/jpeg' });
}

/**
 * Where a pointer event landed in page pixels. The canvas is drawn at whatever
 * size fits the tab, so client coordinates have to be scaled by the ratio
 * between its displayed box and its pixel dimensions — for a fixed-canvas page
 * (a 1280×800 mockup in a smaller tab) those differ by a lot.
 */
function pagePoint(e: MouseEvent): { x: number; y: number } {
  const box = canvas.getBoundingClientRect();
  return {
    x: Math.round(((e.clientX - box.left) / box.width) * canvas.width),
    y: Math.round(((e.clientY - box.top) / box.height) * canvas.height),
  };
}

/** CDP's modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8. */
function modifiersOf(e: MouseEvent | KeyboardEvent | WheelEvent): number {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}

function sendMouse(event: string, e: MouseEvent): void {
  vscode.postMessage({
    type: 'input',
    kind: 'mouse',
    event,
    ...pagePoint(e),
    button: e.button === 0 ? 'left' : e.button === 2 ? 'right' : 'middle',
    buttons: e.buttons,
    modifiers: modifiersOf(e),
  });
}

canvas.addEventListener('mousedown', (e) => sendMouse('mousePressed', e));
canvas.addEventListener('mouseup', (e) => sendMouse('mouseReleased', e));

// Pointer moves arrive far faster than a page needs them and each one costs a
// message hop plus a CDP round trip, so they are thinned to roughly display
// rate. Presses and releases are never dropped — those carry their own
// coordinates, so a drag still starts and ends exactly where the user let go.
let lastMove = 0;
canvas.addEventListener('mousemove', (e) => {
  const now = performance.now();
  if (now - lastMove < 16) {
    return;
  }
  lastMove = now;
  sendMouse('mouseMoved', e);
});

canvas.addEventListener(
  'wheel',
  (e) => {
    // Not passive: without preventDefault the webview document scrolls its own
    // (nonexistent) overflow and the mirrored page never sees the gesture.
    e.preventDefault();
    vscode.postMessage({
      type: 'input',
      kind: 'wheel',
      ...pagePoint(e),
      deltaX: e.deltaX,
      deltaY: e.deltaY,
      modifiers: modifiersOf(e),
    });
  },
  { passive: false }
);

// The tab has no context menu of its own worth showing, and suppressing it is
// what lets a right-click reach the mirrored page as a right-click.
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

/**
 * Keys go to the mirrored page and to nothing else.
 *
 * A forwarded key that is left to bubble reaches VS Code's keybindings too, so
 * typing into a form in the mirrored page would fire the workbench shortcut
 * sitting behind it — Cmd+S saving some file, Cmd+W closing the very tab being
 * typed into. Claiming the event is the same contract media/webview.ts has for
 * the VNC canvas, and for the same reason.
 *
 * The two capture chords are the exception, and they are checked FIRST: they
 * are ours, they must not reach the page as keystrokes, and they must not be
 * left to VS Code's dispatcher either, because this listener has already taken
 * the key. Capture phase, matching the VNC panel — nothing here competes for
 * the event today, but the chord must keep winning if anything ever does.
 */
function sendKey(event: string, e: KeyboardEvent): void {
  vscode.postMessage({
    type: 'input',
    kind: 'key',
    event,
    key: e.key,
    code: e.code,
    modifiers: modifiersOf(e),
  });
}

window.addEventListener(
  'keydown',
  (e) => {
    const action = captureChordAction(e);
    e.preventDefault();
    e.stopPropagation();
    if (action) {
      vscode.postMessage({ type: 'chord', action });
      return;
    }
    sendKey('keyDown', e);
  },
  true
);
window.addEventListener(
  'keyup',
  (e) => {
    e.preventDefault();
    e.stopPropagation();
    // The chord's own release is swallowed too: its keyDown never reached the
    // page, so forwarding a lone keyUp would hand the page half a keystroke.
    if (!captureChordAction(e)) {
      sendKey('keyUp', e);
    }
  },
  true
);

/**
 * Tell the host how big the tab is, so a responsive page is laid out at the
 * size it is actually being viewed at. The host cannot measure this — VS Code
 * never reports a panel's dimensions — so the measurement has to come from
 * here, and it is the reason `Emulation.setDeviceMetricsOverride` can follow
 * the panel at all. Debounced: a window drag emits resize continuously, and
 * each distinct size restarts the screencast.
 */
let resizeTimer: ReturnType<typeof setTimeout> | undefined;
function reportViewport(): void {
  vscode.postMessage({
    type: 'viewport',
    width: Math.round(window.innerWidth),
    height: Math.round(window.innerHeight),
  });
}
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(reportViewport, 200);
});

/**
 * The report is also this webview's only way of saying "I am here and
 * listening", and the host will not stream to one that has not said it — a
 * frame sent to a webview that is not listening is never acknowledged, and an
 * unacknowledged frame stops the stream for good.
 *
 * Load covers the normal case, because a hidden panel is torn down and rebuilt.
 * These two cover a webview that was kept alive instead: `resize` alone cannot
 * be relied on (a panel re-shown at the same size may not fire it), and a
 * document that is merely un-hidden never fires `load` again. Re-announcing
 * when nothing changed is free — the host compares sizes before acting.
 */
window.addEventListener('pageshow', reportViewport);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    reportViewport();
  }
});
reportViewport();
