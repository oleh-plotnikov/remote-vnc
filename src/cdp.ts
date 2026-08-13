/**
 * The wire vocabulary of the Chrome DevTools Protocol, kept free of `ws` and
 * `vscode` so the tests can load it. The socket itself lives in cdpClient.ts.
 */
export interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
  sessionId?: string;
}

/**
 * Split NUL-terminated CDP frames out of a byte stream.
 *
 * The pipe transport (`--remote-debugging-pipe`) hands us a stream, not
 * messages: Chrome writes each JSON object to fd 4 followed by a NUL, and the
 * chunk boundaries are wherever the OS put them — mid-message, mid-character,
 * or several messages at once. A WebSocket framed this for us; a pipe does not.
 *
 * Buffers rather than strings, and that is the load-bearing detail: decoding
 * each chunk as it arrives would put U+FFFD wherever a boundary fell inside a
 * multi-byte character, silently corrupting a screencast frame's base64 or a
 * page title. Only complete frames are decoded.
 *
 * `rest` is the caller's carry from the previous call; the returned `rest` is
 * the new carry.
 */
export function readCdpFrames(
  rest: Buffer,
  chunk: Buffer
): { frames: string[]; rest: Buffer } {
  let buffered = rest.length === 0 ? chunk : Buffer.concat([rest, chunk]);
  const frames: string[] = [];
  let end: number;
  while ((end = buffered.indexOf(0)) !== -1) {
    // Empty frames are dropped: a stray separator is not a message, and
    // parseCdpMessage would reject it one layer further in anyway.
    if (end > 0) {
      frames.push(buffered.subarray(0, end).toString('utf8'));
    }
    buffered = buffered.subarray(end + 1);
  }
  return { frames, rest: buffered };
}

/**
 * Parse one frame off the socket. Returns undefined for anything that is not a
 * JSON object — a malformed frame must be dropped, never forwarded to the
 * webview, where it would be interpreted as image data.
 */
export function parseCdpMessage(raw: unknown): CdpMessage | undefined {
  const text = typeof raw === 'string' ? raw : raw instanceof Uint8Array ? Buffer.from(raw).toString('utf8') : undefined;
  if (!text) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined;
  }
  return parsed as CdpMessage;
}
