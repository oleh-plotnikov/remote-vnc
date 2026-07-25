export type SessionStatus = 'connected' | 'reconnecting';

export interface SessionInfo {
  id: string;
  label: string;
  status: SessionStatus;
}

/**
 * Tracks active sessions (id → label + status) and notifies a single listener
 * on change. Pure (no vscode dependency) so it can be unit-tested in isolation.
 */
export class SessionRegistry {
  private readonly items = new Map<string, { label: string; status: SessionStatus }>();
  private listener: (() => void) | undefined;

  add(id: string, label: string): void {
    this.items.set(id, { label, status: 'connected' });
    this.listener?.();
  }

  setStatus(id: string, status: SessionStatus): void {
    const item = this.items.get(id);
    if (item && item.status !== status) {
      item.status = status;
      this.listener?.();
    }
  }

  remove(id: string): void {
    if (this.items.delete(id)) {
      this.listener?.();
    }
  }

  list(): SessionInfo[] {
    return [...this.items].map(([id, { label, status }]) => ({ id, label, status }));
  }

  onChange(listener: () => void): void {
    this.listener = listener;
  }
}
