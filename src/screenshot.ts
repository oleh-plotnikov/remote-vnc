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
