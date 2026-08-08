/**
 * Pure helpers for saving session screenshots. The capture itself happens in
 * the webview (the framebuffer lives in noVNC's canvas, so the extension host
 * never sees pixels — only the PNG data URL posted back); everything here is
 * the naming and decoding around it, kept pure so tests can pin it down.
 */

/**
 * File name for a capture of the given connection, e.g.
 * `hmi-20260803-181530.png` — just the label and a timestamp, nothing else;
 * the label already says what was captured. It keeps unicode letters and
 * digits (labels are user-given and often non-ASCII) and collapses everything
 * else to a dash — path separators and other filesystem-hostile characters
 * must not survive into a file name.
 */
export function captureFilename(label: string, now: Date, ext: string): string {
  const safe = label
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 60);
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `${safe || 'session'}-${stamp}.${ext}`;
}

/** The screenshot case of `captureFilename`. */
export function screenshotFilename(label: string, now: Date): string {
  return captureFilename(label, now, 'png');
}

/**
 * Decode a `data:image/png;base64,…` URL into PNG bytes, or undefined when the
 * payload is not the PNG data URL the webview produces. The prefix check keeps
 * a compromised or confused webview from steering the write into arbitrary
 * content types; the strict base64 charset check rejects payloads that
 * Buffer.from would otherwise silently truncate at the first invalid byte.
 */
export function pngBytesFromDataUrl(dataUrl: string): Uint8Array | undefined {
  const PREFIX = 'data:image/png;base64,';
  if (!dataUrl.startsWith(PREFIX)) {
    return undefined;
  }
  const b64 = dataUrl.slice(PREFIX.length);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length === 0) {
    return undefined;
  }
  return Buffer.from(b64, 'base64');
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const IHDR_TYPE = [0x49, 0x48, 0x44, 0x52]; // "IHDR", the first chunk of every PNG

/**
 * Largest side we are willing to believe. No framebuffer this extension can
 * meet comes near it, and a corrupt or hostile header must not be able to ask
 * for a canvas allocation measured in gigapixels.
 */
const MAX_PNG_SIDE = 32768;

/**
 * Read a PNG's declared dimensions out of its header, or undefined when the
 * bytes are not a PNG.
 *
 * `pngBytesFromDataUrl` validates only the *envelope* — the `data:` prefix and
 * the base64 charset — so without a magic-byte check anything at all behind a
 * correct prefix ends up written into a file named `.png`. `recordingBytes`
 * already takes this posture for GIF and WebM and its own comment calls itself
 * "the mirror of `pngBytesFromDataUrl`"; this supplies the PNG half. It is
 * also the host's own authority on the source image's size, which is what lets
 * the crop editor refuse a webview that returns a full-resolution image while
 * claiming a small selection.
 *
 * It is a separate function rather than a tightening of
 * `pngBytesFromDataUrl` because that function's shipped contract really is the
 * envelope alone — a test round-trips a four-byte fixture, half a signature,
 * through it — and moving the check inside would change that contract
 * silently.
 */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  // Signature, chunk length, chunk type, width, height: 24 bytes get read, so
  // nothing shorter can be a PNG.
  if (bytes.length < 24 || !PNG_SIGNATURE.every((b, i) => bytes[i] === b)) {
    return undefined;
  }
  // Multiply rather than shift for the top byte: `<< 24` is a signed 32-bit
  // operation, so a width above 2^31 would come back negative and slip past a
  // simple upper bound.
  const u32 = (at: number) =>
    bytes[at] * 0x1000000 + (bytes[at + 1] << 16) + (bytes[at + 2] << 8) + bytes[at + 3];
  if (u32(8) !== 13 || !IHDR_TYPE.every((b, i) => bytes[12 + i] === b)) {
    return undefined;
  }
  const width = u32(16);
  const height = u32(20);
  if (width < 1 || height < 1 || width > MAX_PNG_SIDE || height > MAX_PNG_SIDE) {
    return undefined;
  }
  return { width, height };
}

/** Expand a leading `~` (only as the whole first segment) to the home dir. */
export function expandHome(dir: string, home: string): string {
  if (dir === '~') {
    return home;
  }
  if (dir.startsWith('~/') || dir.startsWith('~\\')) {
    return home + dir.slice(1);
  }
  return dir;
}
