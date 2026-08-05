/**
 * Pure helpers for session recordings. The capture itself happens in the
 * webview (the framebuffer lives in noVNC's canvas — see media/recorder.ts);
 * everything here is the shared vocabulary and the validation around the
 * bytes it posts back, kept pure so tests can pin it down and so the
 * webview bundle can import it (no `vscode` allowed in this module).
 */

export type RecordingFormat = 'webm' | 'gif';

/** Why a recording ended — echoed back so the host can word its toast. */
export type RecordingStopReason = 'stopped' | 'maxDuration' | 'disconnected';

/** Hard cap on one recording: a forgotten recorder must not eat memory forever. */
export const MAX_RECORDING_MS = 10 * 60 * 1000;

const GIF_MAGIC = [0x47, 0x49, 0x46, 0x38]; // "GIF8" — covers GIF87a and GIF89a
const EBML_MAGIC = [0x1a, 0x45, 0xdf, 0xa3]; // WebM's Matroska container header

/**
 * Validate a recording payload by its magic bytes, or reject it. The mirror
 * of `pngBytesFromDataUrl`: a compromised or confused webview must not be
 * able to steer the file write into arbitrary content. postMessage may
 * deliver a bare ArrayBuffer; both shapes are accepted and normalised.
 */
export function recordingBytes(format: RecordingFormat, data: unknown): Uint8Array | undefined {
  const bytes =
    data instanceof Uint8Array ? data : data instanceof ArrayBuffer ? new Uint8Array(data) : undefined;
  if (!bytes || bytes.length === 0) {
    return undefined;
  }
  const magic = format === 'gif' ? GIF_MAGIC : EBML_MAGIC;
  return magic.every((b, i) => bytes[i] === b) ? bytes : undefined;
}

/** Clamp a configured frame rate to something a recorder can honour. */
export function clampFps(value: number): number {
  if (!Number.isFinite(value)) {
    return 10;
  }
  return Math.min(30, Math.max(1, Math.round(value)));
}
