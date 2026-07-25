export interface ReconnectContext {
  autoReconnect: boolean;
  disposed: boolean;
  authFailed: boolean;
}

export type ReconnectDecision =
  | { action: 'reconnect'; delayMs: number }
  | { action: 'stop' };

/**
 * Pure reconnect decision. Reconnect only when the connection is meant to
 * recover (autoReconnect on), the session is still live, and the drop was not
 * an authentication/security failure (which a retry cannot fix). Fixed interval,
 * unbounded attempts — the caller stops by disposing.
 */
export class ReconnectPolicy {
  constructor(private readonly intervalMs: number) {}

  onBridgeClosed(ctx: ReconnectContext): ReconnectDecision {
    if (ctx.autoReconnect && !ctx.disposed && !ctx.authFailed) {
      return { action: 'reconnect', delayMs: this.intervalMs };
    }
    return { action: 'stop' };
  }
}
