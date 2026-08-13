import { parseCdpMessage, type CdpMessage } from './cdp';

/** The slice of a WebSocket this client needs. Keeps `ws` out of the unit tests. */
export interface CdpSocket {
  send(data: string): void;
  close(): void;
  onMessage(cb: (raw: unknown) => void): void;
  onClose(cb: () => void): void;
}

type EventHandler = (params: Record<string, unknown>, sessionId?: string) => void;

/**
 * How long a request may go unanswered before it is rejected and forgotten.
 *
 * `pending` had no timeout at all, no cap, and nothing ever read its size: a
 * request Chrome never answers sat there for the life of the connection,
 * holding its promise (and whatever the caller chained onto it) forever. That
 * is not hypothetical — a mirrored tab typed into for ~78 seconds tore down
 * with 128 unanswered entries in this map, because `Input.dispatchKeyEvent`'s
 * response is deferred by Chromium until the page's RENDERER acknowledges the
 * event, and a renderer that has fallen behind acknowledges nothing.
 *
 * Thirty seconds, not something tight: some CDP calls are legitimately slow.
 * `Page.captureScreenshot` on a large viewport encodes a full-resolution PNG
 * in the browser process, and `Target.createTarget`/`Page.navigate` wait on a
 * cold dev server. A timeout short enough to be a useful watchdog for input
 * would break capture outright, so the DEFAULT is deliberately far above any
 * healthy call and the callers who need a watchdog pass their own — see
 * INPUT_DISPATCH_TIMEOUT_MS in src/pagePanel.ts. This bound exists to reclaim
 * an entry that is never coming back, not to enforce latency.
 *
 * A timed-out request is only abandoned HERE. Chrome may still act on it
 * later (a keystroke that arrives late is still a keystroke); what the reject
 * ends is this side's belief that an answer is coming.
 */
export const CDP_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Request/response correlation over one CDP socket, plus event fan-out.
 *
 * The host owns this object; the webview never does. CDP is not a display
 * protocol — `Page.navigate` accepts file:// and `Runtime.evaluate` runs
 * arbitrary code — so the endpoint stays on this side of the boundary.
 */
export class CdpConnection {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }
  >();
  private readonly handlers = new Map<string, EventHandler[]>();
  private closed = false;

  constructor(private readonly socket: CdpSocket) {
    socket.onMessage((raw) => this.receive(raw));
    socket.onClose(() => this.failAll(new Error('CDP connection closed')));
  }

  /**
   * `timeoutMs` is per call because one number cannot serve both a keystroke
   * and a full-page screenshot — see CDP_REQUEST_TIMEOUT_MS for the default
   * and why it is as generous as it is.
   */
  send(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    timeoutMs: number = CDP_REQUEST_TIMEOUT_MS
  ): Promise<Record<string, unknown>> {
    if (this.closed) {
      return Promise.reject(new Error('CDP connection closed'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // Deleted, not merely rejected: a settled promise nobody can reach
        // again is not the leak — the entry left behind in `pending` is.
        this.pending.delete(id);
        reject(new Error(`${method}: no response in ${timeoutMs}ms`));
      }, timeoutMs);
      // Deliberately NOT `unref`ed. It looks tidy — a watchdog has no business
      // holding a process open — but an unref'd timer does not fire when it is
      // the only work left, so the request it guards would hang exactly in the
      // case where nothing else is happening. What bounds the timers instead is
      // that every settle clears one, and `dispose`/close settles all of them
      // at once through failAll.
      //
      // The timer is cleared through the stored callbacks so EVERY exit —
      // a result, a CDP error, and failAll's close/dispose sweep — clears it,
      // rather than only the paths that remember to.
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      try {
        this.socket.send(JSON.stringify({ id, method, params, sessionId }));
      } catch (err) {
        // A send that threw was never sent, so no response will ever carry
        // this id and nothing will delete the entry — it would sit in `pending`
        // for the life of the connection. `ws` throws synchronously on a socket
        // that is closing, which a long mirroring session reaches routinely.
        // Rethrown, so the promise still rejects with the real cause.
        clearTimeout(timer);
        this.pending.delete(id);
        throw err;
      }
    });
  }

  /** How many requests are still waiting for an answer. The map's size was
   *  never readable from outside, which is how it grew to 128 entries in a
   *  single typed session with nothing to notice — see src/pagePanel.ts's own
   *  in-flight input counter, which measures the same pressure per mirror. */
  get inFlight(): number {
    return this.pending.size;
  }

  on(method: string, handler: EventHandler): void {
    const list = this.handlers.get(method) ?? [];
    list.push(handler);
    this.handlers.set(method, list);
  }

  dispose(): void {
    this.failAll(new Error('CDP connection disposed'));
    this.socket.close();
  }

  private receive(raw: unknown): void {
    const msg: CdpMessage | undefined = parseCdpMessage(raw);
    if (!msg) {
      return;
    }
    if (typeof msg.id === 'number') {
      const entry = this.pending.get(msg.id);
      if (!entry) {
        return;
      }
      this.pending.delete(msg.id);
      if (msg.error) {
        entry.reject(new Error(`${msg.method ?? 'CDP'}: ${msg.error.message}`));
      } else {
        entry.resolve(msg.result ?? {});
      }
      return;
    }
    if (msg.method) {
      for (const h of this.handlers.get(msg.method) ?? []) {
        h(msg.params ?? {}, msg.sessionId);
      }
    }
  }

  private failAll(err: Error): void {
    this.closed = true;
    for (const { reject } of this.pending.values()) {
      reject(err);
    }
    this.pending.clear();
  }
}
