import * as crypto from 'crypto';

export type ControlRoute =
  | { kind: 'list' }
  | { kind: 'screenshot' | 'record' | 'recordStop' | 'reload'; id: string };

/**
 * The complete routing table, as a function. Anything not matched here is a
 * 404 — including input routes, which deliberately do not exist: a leaked
 * token must buy a view, not actions taken in the user's name.
 */
export function parseControlRoute(method: string, path: string): ControlRoute | undefined {
  if (method === 'GET' && path === '/targets') {
    return { kind: 'list' };
  }
  if (method !== 'POST') {
    return undefined;
  }
  const m = /^\/targets\/([A-Za-z0-9_-]{1,64})\/(screenshot|record\/stop|record|reload)$/.exec(path);
  if (!m) {
    return undefined;
  }
  const [, id, action] = m;
  if (action === 'record/stop') {
    return { kind: 'recordStop', id };
  }
  return { kind: action as 'screenshot' | 'record' | 'reload', id };
}

/**
 * Rejections that are the caller's category error rather than a failure on our
 * side. A session has no "reload" and never will (see VncSession.reload), so a
 * 500 would invite a client to retry something that cannot ever succeed.
 * Matched on the message because that is all a rejected `PanelEntry` promise
 * carries; test/vncCapture.test.mjs pins the two together so a reworded
 * rejection cannot quietly fall back to 500.
 */
const CLIENT_ERRORS = new Set(['reload applies to page targets only']);

/** HTTP status for a rejected panel operation: 400 when the request was wrong,
 *  500 when we were. */
export function controlErrorStatus(message: string): number {
  return CLIENT_ERRORS.has(message) ? 400 : 500;
}

/**
 * The endpoint file's name — one per window, keyed by the extension host's pid.
 *
 * `globalStorageUri` is per-extension and machine-wide, not per-window, so a
 * fixed name has every open window writing the same file: the last one to start
 * overwrites the others' `{ url, token }`, leaving their servers listening at an
 * address no client can discover, and the first one to close deletes the file
 * out from under the rest. A pid-keyed name gives each window a file only it
 * writes and only it removes. Clients glob `control-*.json`; every file present
 * is a live endpoint.
 */
export function endpointFileName(pid: number): string {
  return `control-${pid}.json`;
}

/**
 * Constant-time token comparison — the same reasoning as vncBridge's
 * tokensMatch: a length-or-content early return leaks the token one byte at a
 * time to a local process that can retry freely.
 */
export function tokenOk(supplied: unknown, expected: string): boolean {
  if (typeof supplied !== 'string') {
    return false;
  }
  // Byte lengths, not String#length: Node decodes header values as latin1, so
  // a header of raw high bytes is a string whose UTF-16 length matches the
  // token's while its UTF-8 buffer is twice as long. Comparing the two
  // different units let such a value past the gate and into timingSafeEqual,
  // which throws RangeError — out of the request handler, before routing, with
  // nothing to catch it.
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
