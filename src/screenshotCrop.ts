/**
 * Pure geometry, naming and path predicates for the screenshot crop editor —
 * the tab that trims a capture already written to disk down to the region
 * that mattered.
 *
 * READ THIS BEFORE EDITING: this is NOT `src/cropLayout.ts`, and the two are
 * not two halves of one idea. That module is the live viewer's `visibleArea`
 * crop: it hides the dead band an embedded panel shows when its framebuffer
 * width is padded to the display controller's line stride, it never touches a
 * file, and its numbers are CSS sizes for a clip box drawn around noVNC's
 * canvas. This module cuts pixels out of a PNG, in whole image pixels, and
 * every number here is an image coordinate. The two share a word and nothing
 * else; conflating them is the likeliest way this feature gets quietly broken
 * later.
 *
 * Both the extension host and the webview import this, so it must stay
 * dependency-free: no `vscode`, and no Node globals either — `Buffer` does not
 * exist in the webview bundle. Same constraint as `src/recording.ts`, for the
 * same reason.
 */

/** A region of an image, in whole pixels, origin top-left. */
export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Upper bound on a crop data URL, checked before `Buffer.from` decodes it
 * rather than after. A cap applied to the decoded bytes is not a cap: the
 * allocation it was meant to prevent has already happened by then.
 *
 * The arithmetic, taking a 4K framebuffer as the largest source anyone
 * plausibly captures: 3840 × 2160 × 4 = 33,177,600 raw RGBA bytes, and a
 * *lossless* PNG of incompressible noise runs slightly above raw — a filter
 * byte per row plus deflate's block framing — so call it 34 MB. Base64 adds a
 * third: roughly 45 MB of characters. 64 MiB clears that worst case with room
 * to spare while still refusing a payload that could only be an attempt to
 * exhaust the host's memory.
 */
export const MAX_CROP_DATAURL_CHARS = 64 * 1024 * 1024;

/** A finite number and nothing else — `NaN`, `Infinity` and `'12'` all fail. */
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Clamp to [0, max], inclusive at both ends. NaN deliberately survives rather
 * than collapsing to an edge, so the guards downstream still see it and refuse.
 */
const within = (v: number, max: number): number => Math.min(Math.max(v, 0), max);

/**
 * Narrow an untrusted rectangle onto the image, or reject it.
 *
 * The parameter is `unknown` because every caller is a boundary: a
 * `postMessage` field on the host side, a pointer-derived rectangle on the
 * webview side. Whole pixels only — the origin floors and the extent rounds,
 * so a selection drawn below 100 % scale keeps the pixel the user aimed at
 * instead of shrinking away from it.
 *
 * The property that matters most is idempotence: clamping an already-clamped
 * integer rect returns it unchanged. `acceptCrop` re-clamps a rect the webview
 * has already clamped, so if a second pass could move an edge by one pixel,
 * every honest crop would be refused.
 */
export function clampCropRect(rect: unknown, imgW: number, imgH: number): CropRect | undefined {
  if (!isNum(imgW) || !isNum(imgH) || imgW <= 0 || imgH <= 0) {
    return undefined;
  }
  if (typeof rect !== 'object' || rect === null) {
    return undefined;
  }
  const { x, y, width, height } = rect as Record<string, unknown>;
  if (!isNum(x) || !isNum(y) || !isNum(width) || !isNum(height)) {
    return undefined;
  }
  const maxX = Math.floor(imgW);
  const maxY = Math.floor(imgH);
  const left = within(Math.floor(x), maxX);
  const top = within(Math.floor(y), maxY);
  const w = within(Math.round(width), maxX - left);
  const h = within(Math.round(height), maxY - top);
  if (w < 1 || h < 1) {
    return undefined;
  }
  return { x: left, y: top, width: w, height: h };
}

/**
 * The trust decision for a crop, in one testable function.
 *
 * The webview cuts the pixels and posts an image; the rectangle rides along as
 * a cross-check, never as an instruction — there is nothing left for the host
 * to cut. So the host re-clamps that claim against its own reading of the
 * source header and demands the returned image measure exactly it. Without the
 * equality a webview could hand back the full-resolution framebuffer while
 * claiming a small selection, and the host would write it over the file.
 */
export function acceptCrop(
  rect: unknown,
  imgW: number,
  imgH: number,
  outW: number,
  outH: number
): CropRect | undefined {
  const clamped = clampCropRect(rect, imgW, imgH);
  if (!clamped) {
    return undefined;
  }
  return outW === clamped.width && outH === clamped.height ? clamped : undefined;
}

/**
 * The rectangle spanned by a drag between two points in image space.
 *
 * The points are clamped to the image *before* the rectangle is formed, not
 * after: a drag that begins off the picture and ends inside it must select
 * from the edge, whereas clamping a rectangle built from the outside point
 * would keep its width and slide it inwards. Direction is normalised, so
 * dragging up-and-left yields the same rectangle as the same drag
 * down-and-right. Anything under one whole pixel is a click rather than a
 * selection and returns undefined — as does a non-finite coordinate from a
 * pointer event, by way of `clampCropRect`.
 *
 * Both corners are rounded to whole pixels here, before the rectangle exists.
 * Handing `clampCropRect` a fractional span instead would let it floor the
 * origin and round the extent independently, and the two disagree: with the
 * east edge anchored at 200, a pointer at x=100.4 gives width 100 and a pointer
 * at x=100.6 gives width 99, so the *anchored* edge slides back and forth by a
 * pixel every time the pointer crosses a half. Rounding is identity on the
 * anchor, so only the edge being dragged moves. `Math.floor`/`Math.ceil` would
 * anchor just as well and must not be used: they turn any sub-pixel press into
 * a 1x1 selection, which is the click this function is supposed to reject.
 */
export function rectFromDrag(
  a: { x: number; y: number },
  b: { x: number; y: number },
  imgW: number,
  imgH: number
): CropRect | undefined {
  const ax = Math.round(within(a.x, imgW));
  const bx = Math.round(within(b.x, imgW));
  const ay = Math.round(within(a.y, imgH));
  const by = Math.round(within(b.y, imgH));
  return clampCropRect(
    {
      x: Math.min(ax, bx),
      y: Math.min(ay, by),
      width: Math.abs(bx - ax),
      height: Math.abs(by - ay),
    },
    imgW,
    imgH
  );
}

/**
 * A pointer offset in CSS pixels as a point in image pixels.
 *
 * `devicePixelRatio` is deliberately not read here or anywhere else in this
 * feature. Selection state is image pixels and the drawn rectangle is always
 * derived from it, which retires HiDPI, tab-resize and scaled-display drift as
 * a class instead of one bug at a time.
 *
 * The clamp includes `imgW` and `imgH` because a point is a corner, not a
 * pixel: an exclusive clamp would put the image's last column and row out of
 * reach of any selection. A scale of zero — a stage measured mid-layout —
 * falls back to 1:1 rather than dividing its way to Infinity.
 */
export function toImagePoint(
  offsetX: number,
  offsetY: number,
  scale: number,
  imgW: number,
  imgH: number
): { x: number; y: number } {
  const s = isNum(scale) && scale > 0 ? scale : 1;
  const maxX = isNum(imgW) && imgW > 0 ? imgW : 0;
  const maxY = isNum(imgH) && imgH > 0 ? imgH : 0;
  return { x: within(offsetX / s, maxX), y: within(offsetY / s, maxY) };
}

/**
 * The scale that fits an image inside a box, upscaling included.
 *
 * The upscaling is the point, not an oversight: the motivating hardware for
 * this extension is a 480 × 272 embedded panel, and showing that 1:1 in a full
 * editor tab makes pixel-aiming harder rather than more honest. Any
 * non-positive or non-finite input yields 1, so a tab that reports a 0 × 0 box
 * mid-layout produces a plain image instead of NaN geometry that then leaks
 * into every coordinate the user sees.
 */
export function fitScale(imgW: number, imgH: number, boxW: number, boxH: number): number {
  if ([imgW, imgH, boxW, boxH].some((n) => !isNum(n) || n <= 0)) {
    return 1;
  }
  return Math.min(boxW / imgW, boxH / imgH);
}

/**
 * The first free name in a directory: `shot.png`, then `shot-2.png`,
 * `shot-3.png`, and so on.
 *
 * Capture names carry a second-resolution timestamp, so two screenshots of one
 * connection inside the same second would otherwise reuse a name and overwrite
 * the file an open crop tab is still showing — and that tab would then write
 * its older bitmap over the newer capture. The suffix goes before the
 * extension so the result is still a `.png` to every other tool, and the
 * comparison is case-sensitive because the directory listing handed in is the
 * authority here, not a guess about the filesystem underneath it.
 */
export function stagedName(name: string, existing: string[]): string {
  const taken = new Set(existing);
  if (!taken.has(name)) {
    return name;
  }
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  // Terminates: the listing is finite, so one of the first `taken.size + 1`
  // candidates is necessarily free.
  for (let n = 2; ; n++) {
    const candidate = `${stem}-${n}${ext}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
}

/**
 * Whether a document sits directly in the extension's staging directory.
 *
 * Both arguments are `Uri.toString()` values and the comparison is textual —
 * no filesystem access, so the answer is the same under a remote, a container
 * or a virtual filesystem provider. The prefix has to end at a separator and
 * the remainder has to be a single segment, which is what keeps out a sibling
 * `recordings-evil` and a nested `recordings/sub/shot.png`.
 *
 * This one predicate answers both "may this be overwritten without asking?"
 * and "where should the save dialog start?", so a misclassification shows up
 * in both places at once instead of leaving a silent hole in one of them.
 */
export function isStagedPath(uri: string, stagingDir: string): boolean {
  if (!uri || !stagingDir) {
    return false;
  }
  const base = stagingDir.endsWith('/') ? stagingDir : `${stagingDir}/`;
  if (!uri.startsWith(base)) {
    return false;
  }
  const rest = uri.slice(base.length);
  return rest.length > 0 && !rest.includes('/');
}

/**
 * Byte-for-byte comparison, length first.
 *
 * The crop editor's authority is the bytes it last read or wrote: before every
 * in-place overwrite it re-reads the file and compares, so a capture that
 * moved under an open tab is refused instead of being silently replaced. A
 * missing side is never equal to anything, another missing side included — an
 * absent baseline is precisely the case that has to refuse the write.
 */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  const len = a?.length ?? -1;
  if (len < 0 || len !== (b?.length ?? -1)) {
    return false;
  }
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}
