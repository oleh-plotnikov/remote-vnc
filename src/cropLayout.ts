/**
 * Pure geometry for the `visibleArea` crop.
 *
 * Some embedded VNC servers advertise a framebuffer wider than the device's
 * visible panel — the width is padded to the display controller's line stride
 * (a 480x272 panel advertised as 512x272 is typical), and the padding renders
 * as a dead black band beside the picture. The viewer cannot fix the server,
 * but it can stop showing the padding.
 *
 * The mechanism avoids touching noVNC's coordinate math entirely: noVNC's
 * container is made `innerWidth`×`innerHeight` so that noVNC's own
 * scale-to-fit lands on exactly `scale`, and a clipping box of
 * `clipWidth`×`clipHeight` around it hides everything beyond the visible
 * area. No CSS transforms anywhere near the canvas, so pointer positions map
 * exactly as noVNC expects.
 */

export interface CropLayout {
  scale: number;
  clipWidth: number;
  clipHeight: number;
  innerWidth: number;
  innerHeight: number;
}

/**
 * Compute the clip-box and container sizes for a crop.
 *
 * `fbW`×`fbH` is the advertised framebuffer, `cropW`×`cropH` the visible area
 * (clamped to the framebuffer — a stale setting must not outgrow reality),
 * `boxW`×`boxH` the space the panel offers. With `scaleToFit` false
 * (scaleViewport off) everything renders 1:1 and the clip box simply windows
 * the visible area. Returns undefined when any dimension is not positive.
 */
export function cropLayout(
  fbW: number,
  fbH: number,
  cropW: number,
  cropH: number,
  boxW: number,
  boxH: number,
  scaleToFit: boolean
): CropLayout | undefined {
  if ([fbW, fbH, cropW, cropH, boxW, boxH].some((n) => !Number.isFinite(n) || n <= 0)) {
    return undefined;
  }
  const w = Math.min(cropW, fbW);
  const h = Math.min(cropH, fbH);
  const scale = scaleToFit ? Math.min(boxW / w, boxH / h) : 1;
  return {
    scale,
    clipWidth: w * scale,
    clipHeight: h * scale,
    innerWidth: fbW * scale,
    innerHeight: fbH * scale,
  };
}

/**
 * The pixel size that actually represents the device: the crop when one is
 * set, clamped to the framebuffer, and the framebuffer itself otherwise.
 *
 * The viewer hides the dead band with a clip box drawn around a full-size
 * canvas — the canvas keeps every advertised pixel. Anything that reads the
 * canvas rather than looking at it (a screenshot) therefore has to crop
 * explicitly, or it captures the band the viewer is hiding.
 */
export function visibleSize(
  fbWidth: number,
  fbHeight: number,
  crop: { width: number; height: number } | undefined
): { width: number; height: number } {
  return {
    width: crop ? Math.min(crop.width, fbWidth) : fbWidth,
    height: crop ? Math.min(crop.height, fbHeight) : fbHeight,
  };
}

/**
 * Parse a `visibleArea` setting ("480x272", `x` or `×`) into dimensions.
 * Bounds are generous — panels smaller than 16px or larger than 16384px are
 * not real devices, they are typos.
 */
export function parseVisibleArea(text: string | undefined): { width: number; height: number } | undefined {
  if (!text) {
    return undefined;
  }
  const m = /^\s*(\d{1,5})\s*[x×]\s*(\d{1,5})\s*$/.exec(text);
  if (!m) {
    return undefined;
  }
  const width = Number(m[1]);
  const height = Number(m[2]);
  const ok = (n: number) => n >= 16 && n <= 16384;
  return ok(width) && ok(height) ? { width, height } : undefined;
}
