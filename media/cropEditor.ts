/**
 * The crop editor's webview half: decode the PNG the host hands over, draw it
 * scaled into the tab, and turn pointer and keyboard work into one rectangle.
 *
 * Every geometric decision here is imported from '../src/screenshotCrop'
 * rather than written locally, and that is the point rather than a tidiness
 * preference. Nothing under media/ is unit-testable — test/bundle.mjs builds
 * from src/ only — and the host re-runs the very same `clampCropRect` on the
 * rectangle this file posts before it accepts the pixels. A local variant,
 * however close, would eventually round one edge differently and get an honest
 * crop refused with no way for the user to tell why.
 *
 * The rule the rest of the file obeys is stated where the selection is
 * declared. Read it before touching any coordinate below.
 */
import {
  CropRect,
  clampCropRect,
  fitScale,
  rectFromDrag,
  toImagePoint,
} from '../src/screenshotCrop';

type CropExtensionMessage =
  | {
      type: 'image';
      // An ArrayBuffer, not a Uint8Array: see `toArrayBuffer` on the host side.
      // A TypedArray does not survive the webview transport as one.
      bytes: ArrayBuffer;
      width: number;
      height: number;
      name: string;
      staged: boolean;
      cropped: boolean;
    }
  | { type: 'unavailable'; reason: string };

interface VsCodeApi {
  postMessage(message: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

/** A position in image pixels. Never a CSS pixel — see the invariant below. */
interface Point {
  x: number;
  y: number;
}

/**
 * A drag in progress. `span` covers both a fresh selection and a handle
 * resize, because they are the same operation: a rectangle spanned between an
 * anchor that stays put and a corner that follows the pointer. A handle merely
 * starts from a different anchor and may hold one axis still — which is also
 * what makes dragging a handle past its anchor flip the rectangle instead of
 * producing a negative size.
 */
type Drag =
  | { mode: 'move'; pointerId: number; start: CropRect; grab: Point }
  | {
      mode: 'span';
      pointerId: number;
      fixed: Point;
      other: Point;
      grab: Point;
      freeX: boolean;
      freeY: boolean;
    };

const STAGED_BADGE = 'Staged copy — removed after 7 days';
const HINT_SELECT = 'Drag to select';
const HINT_KEYS = 'Arrows nudge · Shift for 10 · Enter crops · Escape clears';
const HINT_STAGED = 'Cropped — Save keeps a copy outside staging';

const NUDGE: Record<string, Point | undefined> = {
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
};

const vscode = acquireVsCodeApi();

const bar = document.getElementById('bar') as HTMLElement;
const srcsize = document.getElementById('srcsize') as HTMLSpanElement;
const readout = document.getElementById('readout') as HTMLSpanElement;
const badge = document.getElementById('badge') as HTMLSpanElement;
const stage = document.getElementById('stage') as HTMLDivElement;
const frame = document.getElementById('frame') as HTMLDivElement;
const view = document.getElementById('view') as HTMLCanvasElement;
const sel = document.getElementById('sel') as HTMLDivElement;
const deadBox = document.getElementById('dead') as HTMLDivElement;
const cropBtn = document.getElementById('crop') as HTMLButtonElement;
const revertBtn = document.getElementById('revert') as HTMLButtonElement;
const saveBtn = document.getElementById('save') as HTMLButtonElement;
const reopenBtn = document.getElementById('reopen') as HTMLButtonElement;
const hint = document.getElementById('hint') as HTMLSpanElement;
const scrims = {
  top: document.getElementById('scrim-top') as HTMLDivElement,
  bottom: document.getElementById('scrim-bottom') as HTMLDivElement,
  left: document.getElementById('scrim-left') as HTMLDivElement,
  right: document.getElementById('scrim-right') as HTMLDivElement,
};

// THE INVARIANT: the selection is four integers in IMAGE-pixel space, and the
// rectangle on screen is always derived from it as round(imagePx * scale) —
// never the reverse. `devicePixelRatio` is not read here, and nothing reads a
// selection edge back out of the DOM. That single rule retires HiDPI,
// tab-resize and scaled-display drift as a class: a resize only re-derives, so
// no error can accumulate, and the readout the user verifies against is the
// state itself rather than a measurement of the picture.
let selection: CropRect | undefined;

let bitmap: ImageBitmap | undefined;
let imgW = 0;
let imgH = 0;
let scale = 1;
let fileName = '';
let staged = false;
let cropped = false;
let drag: Drag | undefined;

// Decodes are asynchronous and the host re-posts the image after every crop,
// so two can be in flight at once; only the newest may claim the tab.
let decoding = 0;

function post(message: unknown): void {
  vscode.postMessage(message);
}

// A ResizeObserver fires on every tab resize and a drag on every pointer move,
// so a failure inside either would repeat a line hundreds of times in the
// Output channel. Every diagnostic in this file goes through here instead.
const said = new Set<string>();

function logOnce(level: 'info' | 'error', message: string): void {
  if (said.has(message)) {
    return;
  }
  said.add(message);
  post({ type: 'log', level, message });
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Place one overlay in the frame's scaled coordinates. */
function place(el: HTMLElement, x: number, y: number, w: number, h: number): void {
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  el.style.width = `${Math.max(0, w)}px`;
  el.style.height = `${Math.max(0, h)}px`;
}

/**
 * Draw the image at the scale that fits the stage, and re-derive the overlays.
 *
 * The canvas is sized to the scaled image rather than to the source and then
 * squashed by CSS: a canvas whose attributes disagree with its box resamples
 * twice, and the second pass is the browser's, outside any `imageSmoothing`
 * decision made here. Smoothing is honest only when shrinking; at 1:1 and
 * above the pixels are the subject, so `.crisp` hands the job to
 * `image-rendering: pixelated`.
 */
function render(): void {
  if (!bitmap) {
    return;
  }
  scale = fitScale(imgW, imgH, stage.clientWidth, stage.clientHeight);
  const w = Math.round(imgW * scale);
  const h = Math.round(imgH * scale);
  frame.style.width = `${w}px`;
  frame.style.height = `${h}px`;
  view.width = w;
  view.height = h;
  view.classList.toggle('crisp', scale >= 1);
  const ctx = view.getContext('2d');
  if (!ctx) {
    logOnce('error', 'crop editor has no 2D context to draw the preview');
    return;
  }
  ctx.imageSmoothingEnabled = scale < 1;
  ctx.drawImage(bitmap, 0, 0, w, h);
  paint();
}

/** Re-derive everything that follows from the selection: overlays, readout,
 *  stage state and the controls that only mean something with one. */
function paint(): void {
  cropBtn.disabled = !selection;
  hint.textContent = selection ? HINT_KEYS : cropped && staged ? HINT_STAGED : HINT_SELECT;
  if (!selection) {
    // Nothing is selected, so nothing is excluded — the stage stays 'empty'
    // even mid-drag, which is also what keeps the scrims from flashing at
    // their last positions while a new drag is still under one pixel.
    stage.dataset.state = 'empty';
    sel.hidden = true;
    readout.textContent = '';
    return;
  }
  const r = selection;
  stage.dataset.state = drag ? 'selecting' : 'ready';
  readout.textContent = `${r.width} × ${r.height} at ${r.x}, ${r.y}`;
  const fw = Math.round(imgW * scale);
  const fh = Math.round(imgH * scale);
  const x = Math.round(r.x * scale);
  const y = Math.round(r.y * scale);
  const w = Math.round(r.width * scale);
  const h = Math.round(r.height * scale);
  sel.hidden = false;
  place(sel, x, y, w, h);
  // Four bands rather than one huge shadow: exact at any size, and they stay
  // exact when the tab is resized because they are re-derived here too.
  place(scrims.top, 0, 0, fw, y);
  place(scrims.bottom, 0, y + h, fw, fh - y - h);
  place(scrims.left, 0, y, x, h);
  place(scrims.right, x + w, y, fw - x - w, h);
}

/**
 * Turn a handle into the span it stands for: the opposite corner or edge
 * becomes the anchor, the pointer becomes the other corner. An edge handle
 * frees one axis only and carries the other extent along unchanged.
 *
 * `grab` is where inside the handle the press landed, and it matters more than
 * it sounds. A handle is a 10px square straddling the corner and its hit area
 * is padded to ±8 CSS px, so without this the corner jumps to the pointer the
 * instant it is pressed — 8 CSS px, which on a 3840-wide capture fitted into a
 * narrow tab is over 40 image pixels of silent movement before the user has
 * dragged anything. The move drag has always subtracted its grab offset; this
 * is the same bookkeeping for the other half.
 */
function spanFromHandle(dir: string, r: CropRect, pointerId: number, p: Point): Drag {
  const right = r.x + r.width;
  const bottom = r.y + r.height;
  const other = { x: dir.includes('w') ? r.x : right, y: dir.includes('n') ? r.y : bottom };
  return {
    mode: 'span',
    pointerId,
    fixed: { x: dir.includes('w') ? right : r.x, y: dir.includes('n') ? bottom : r.y },
    other,
    grab: { x: p.x - other.x, y: p.y - other.y },
    freeX: dir.includes('e') || dir.includes('w'),
    freeY: dir.includes('n') || dir.includes('s'),
  };
}

/** Advance a drag to a pointer position, in image pixels. */
function applyDrag(d: Drag, p: Point): void {
  if (d.mode === 'move') {
    // A move clamps the ORIGIN, not the rectangle. `clampCropRect` alone would
    // trim the width at the border, and a selection that shrinks when it is
    // pushed against an edge is not what moving means.
    const maxX = imgW - d.start.width;
    const maxY = imgH - d.start.height;
    const moved = {
      x: Math.min(Math.max(p.x - d.grab.x, 0), maxX),
      y: Math.min(Math.max(p.y - d.grab.y, 0), maxY),
      width: d.start.width,
      height: d.start.height,
    };
    selection = clampCropRect(moved, imgW, imgH) ?? d.start;
    return;
  }
  // The grab offset comes off the freed axes only: a held axis keeps the extent
  // the selection already had, and there is nothing there for the press to have
  // been offset from. `rectFromDrag` runs both endpoints through its own bounds
  // check, so an offset point outside the image needs no clamping here and a
  // drag past the anchor still flips.
  selection = rectFromDrag(
    d.fixed,
    { x: d.freeX ? p.x - d.grab.x : d.other.x, y: d.freeY ? p.y - d.grab.y : d.other.y },
    imgW,
    imgH
  );
}

/** A pointer event as a point in image pixels, measured from the frame rather
 *  than from `offsetX` — a handle or the selection is the event target as
 *  often as the canvas is, and each has its own origin. */
function pointAt(e: PointerEvent): Point {
  const box = frame.getBoundingClientRect();
  return toImagePoint(e.clientX - box.left, e.clientY - box.top, scale, imgW, imgH);
}

frame.addEventListener('pointerdown', (e) => {
  if (!bitmap || e.button !== 0) {
    return;
  }
  const p = pointAt(e);
  const dir = (e.target as HTMLElement | null)?.closest('.h')?.getAttribute('data-dir');
  if (dir && selection) {
    drag = spanFromHandle(dir, selection, e.pointerId, p);
  } else if (selection && sel.contains(e.target as Node)) {
    drag = {
      mode: 'move',
      pointerId: e.pointerId,
      start: selection,
      grab: { x: p.x - selection.x, y: p.y - selection.y },
    };
  } else {
    // A fresh selection is anchored at the press itself, so there is no offset
    // to carry: `fixed` and `other` are the same point.
    drag = {
      mode: 'span',
      pointerId: e.pointerId,
      fixed: p,
      other: p,
      grab: { x: 0, y: 0 },
      freeX: true,
      freeY: true,
    };
  }
  frame.setPointerCapture(e.pointerId);
  // preventDefault stops the press from being taken as a text/image drag —
  // and, because it also suppresses the focus it would otherwise give the
  // stage, the focus call has to be explicit or the arrow keys go dead after
  // the first drag.
  e.preventDefault();
  stage.focus();
  applyDrag(drag, p);
  paint();
});

frame.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.pointerId) {
    return;
  }
  applyDrag(drag, pointAt(e));
  paint();
});

function endDrag(e: PointerEvent): void {
  if (!drag || e.pointerId !== drag.pointerId) {
    return;
  }
  drag = undefined;
  if (frame.hasPointerCapture(e.pointerId)) {
    frame.releasePointerCapture(e.pointerId);
  }
  paint();
}

frame.addEventListener('pointerup', endDrag);
frame.addEventListener('pointercancel', endDrag);

stage.addEventListener('keydown', (e) => {
  const step = NUDGE[e.key];
  if (step) {
    // Unclaimed arrows scroll the stage instead, which is both useless (the
    // image is fitted) and confusing while a selection is on screen.
    e.preventDefault();
    if (bitmap && selection) {
      const by = e.shiftKey ? 10 : 1;
      // A nudge is a move of the selection by a whole image pixel, so it goes
      // through the move path and inherits its edge clamping unchanged.
      const move: Drag = {
        mode: 'move',
        pointerId: -1,
        start: selection,
        grab: { x: 0, y: 0 },
      };
      applyDrag(move, { x: selection.x + step.x * by, y: selection.y + step.y * by });
      paint();
    }
    return;
  }
  if (e.key === 'Escape') {
    // Abandon the drag as well, not just the rectangle: a live drag would put
    // the selection straight back on the next pointer move.
    if (drag && frame.hasPointerCapture(drag.pointerId)) {
      frame.releasePointerCapture(drag.pointerId);
    }
    drag = undefined;
    selection = undefined;
    paint();
  } else if (e.key === 'Enter') {
    cut();
  }
});

// Every button hands focus straight back to the stage. The arrow keys, Enter
// and Escape are bound there, and the hint keeps advertising them — but a
// clicked button holds focus, so without this the keyboard silently stops
// working after the first press of Save or Open as Image (Crop and Revert only
// seem to escape it because becoming disabled blurs them). It also stops Enter
// from re-firing the focused button.
cropBtn.addEventListener('click', () => {
  cut();
  stage.focus();
});
revertBtn.addEventListener('click', () => {
  post({ type: 'revert' });
  stage.focus();
});
saveBtn.addEventListener('click', () => {
  post({ type: 'save' });
  stage.focus();
});
reopenBtn.addEventListener('click', () => {
  post({ type: 'reopen' });
  stage.focus();
});

/**
 * Cut the selection out of the decoded bitmap and hand the host the pixels.
 *
 * The cut is taken from the bitmap at 1:1, never from the on-screen canvas:
 * that one holds the fitted preview, so cutting from it would resample the
 * user's selection through the fit scale and return soft pixels at the wrong
 * size. The rectangle travels along only as a cross-check, which is why it is
 * clamped by the same function the host re-runs.
 */
function cut(): void {
  if (!bitmap || !selection) {
    return;
  }
  const rect = clampCropRect(selection, imgW, imgH);
  if (!rect) {
    post({ type: 'crop', error: 'the selection is not a usable rectangle' });
    return;
  }
  const { x, y, width, height } = rect;
  try {
    const out = document.createElement('canvas');
    out.width = width;
    out.height = height;
    const ctx = out.getContext('2d');
    if (!ctx) {
      post({ type: 'crop', error: 'no 2D context for the cut' });
      return;
    }
    ctx.drawImage(bitmap, x, y, width, height, 0, 0, width, height);
    post({ type: 'crop', rect, dataUrl: out.toDataURL('image/png') });
  } catch (err) {
    post({ type: 'crop', error: describe(err) });
  }
}

/**
 * Swap the picture for prose without losing the tab. The stage's `dead` state
 * hides the frame, so the message lands where the image was; the name is only
 * known once an image has arrived, and a capture that was already gone when
 * the tab opened has none, so an empty second line is skipped rather than
 * printed.
 */
function goDead(reason: string): void {
  bitmap?.close();
  bitmap = undefined;
  selection = undefined;
  drag = undefined;
  stage.dataset.state = 'dead';
  sel.hidden = true;
  bar.hidden = true;
  hint.textContent = '';
  for (const button of [cropBtn, revertBtn, saveBtn]) {
    button.hidden = true;
  }
  deadBox.replaceChildren(
    ...[reason, fileName]
      .filter((text) => text.length > 0)
      .map((text) => {
        const line = document.createElement('div');
        line.textContent = text;
        return line;
      })
  );
  deadBox.hidden = false;
}

/**
 * The image payload as something `Blob` will accept, or undefined with the
 * reason already in the Output channel.
 *
 * The shape that arrives is worth checking rather than assuming. Only an
 * `ArrayBuffer` is documented to be recreated across the webview transport; a
 * `Uint8Array` sent as a message field arrives as a plain index object, and
 * `new Blob([…])` would quietly turn that into the fifteen characters
 * "[object Object]" — a blob that fails to decode and reports nothing except
 * that the file is not an image. Naming what actually came through is the
 * difference between a one-line fix and an afternoon. A view is accepted too:
 * it is equally usable, and refusing it would be pedantry.
 */
function imageBuffer(bytes: unknown): ArrayBuffer | undefined {
  if (bytes instanceof ArrayBuffer) {
    return bytes;
  }
  if (ArrayBuffer.isView(bytes)) {
    const view = bytes as Uint8Array;
    const copy = new Uint8Array(view.byteLength);
    copy.set(view);
    return copy.buffer;
  }
  const shape =
    bytes === null || bytes === undefined
      ? String(bytes)
      : `${(bytes as object).constructor?.name ?? typeof bytes} with ` +
        `${typeof bytes === 'object' ? Object.keys(bytes as object).length : 0} keys`;
  logOnce('error', `crop editor received ${shape} where the image bytes should be`);
  return undefined;
}

async function showImage(msg: Extract<CropExtensionMessage, { type: 'image' }>): Promise<void> {
  fileName = msg.name;
  staged = msg.staged;
  cropped = msg.cropped;
  // Every 'image' is a fresh source, the one re-posted after a crop included:
  // the pixels the old rectangle described are gone, so keeping it would point
  // at a region of an image that no longer exists.
  selection = undefined;
  drag = undefined;
  const token = ++decoding;
  const buffer = imageBuffer(msg.bytes);
  if (!buffer) {
    goDead('The image did not arrive intact. See the "Remote VNC" output for details.');
    return;
  }
  let next: ImageBitmap;
  try {
    const png = new Blob([buffer], { type: 'image/png' });
    next = await createImageBitmap(png);
  } catch (err) {
    logOnce('error', `crop editor could not decode the image: ${describe(err)}`);
    goDead('This file is not an image the crop editor can read.');
    return;
  }
  if (token !== decoding) {
    next.close(); // a newer image overtook this decode; that one owns the tab
    return;
  }
  bitmap?.close();
  bitmap = next;
  imgW = next.width;
  imgH = next.height;
  // The host reads the size out of the IHDR and `acceptCrop` compares the
  // returned image against it, so a decoder that disagrees would reject every
  // crop from this tab with nothing on screen to explain it.
  if (msg.width !== imgW || msg.height !== imgH) {
    logOnce(
      'error',
      `crop editor decoded ${imgW}x${imgH} but the host read ${msg.width}x${msg.height}`
    );
  }
  bar.hidden = false;
  deadBox.hidden = true;
  for (const button of [cropBtn, revertBtn, saveBtn]) {
    button.hidden = false;
  }
  srcsize.textContent = `${imgW} × ${imgH}`;
  badge.textContent = STAGED_BADGE;
  badge.hidden = !staged;
  // Revert restores the bytes the tab opened with, so it only means something
  // once this tab has actually written the file.
  revertBtn.disabled = !cropped;
  render();
  // The arrow keys belong to the stage, so it wants focus — but only when
  // nothing else has it, or the re-post that follows a crop would pull focus
  // off the button the user just pressed.
  if (document.activeElement === null || document.activeElement === document.body) {
    stage.focus();
  }
}

function showUnavailable(msg: Extract<CropExtensionMessage, { type: 'unavailable' }>): void {
  goDead(msg.reason);
}

window.addEventListener('message', (event: MessageEvent<CropExtensionMessage>) => {
  const msg = event.data;
  if (!msg || typeof msg.type !== 'string') {
    return;
  }
  if (msg.type === 'image') {
    void showImage(msg);
  } else if (msg.type === 'unavailable') {
    showUnavailable(msg);
  }
});

// The eight handles are the script's, not the markup's: they carry no content
// and exist only while a selection does, so renderCropHtml would be shipping
// eight empty divs to describe a purely interactive affordance.
for (const dir of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
  const handle = document.createElement('div');
  handle.className = 'h';
  handle.dataset.dir = dir;
  sel.appendChild(handle);
}

// The fitted scale is a function of the tab's size, so a resize re-derives it
// — and with it the selection's rectangle, which is never measured back out of
// the DOM.
new ResizeObserver(() => render()).observe(stage);

hint.textContent = HINT_SELECT;

// Tell the host the listener is attached. Idempotent on purpose: the host
// holds the bytes and re-posts them on every 'ready', so a webview that VS
// Code reloaded (a hidden tab, a window restore) heals itself with no extra
// state on either side.
post({ type: 'ready' });
