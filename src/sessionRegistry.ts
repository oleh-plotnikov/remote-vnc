export type SessionStatus = 'connected' | 'reconnecting';

export interface SessionInfo {
  id: string;
  label: string;
  /** VNC target, so the tree can find the saved connection a session
   *  belongs to (labels are not unique: two sessions of one target share one). */
  host: string;
  port: number;
  status: SessionStatus;
  recording: boolean;
}

/**
 * Tracks active sessions (id → label + status + recording) and notifies a
 * single listener on change. Pure (no vscode dependency) so it can be
 * unit-tested in isolation.
 */
export class SessionRegistry {
  private readonly items = new Map<
    string,
    Omit<SessionInfo, 'id'>
  >();
  private listener: (() => void) | undefined;

  add(id: string, label: string, host: string, port: number): void {
    this.items.set(id, { label, host, port, status: 'connected', recording: false });
    this.listener?.();
  }

  setStatus(id: string, status: SessionStatus): void {
    const item = this.items.get(id);
    if (item && item.status !== status) {
      item.status = status;
      this.listener?.();
    }
  }

  setRecording(id: string, recording: boolean): void {
    const item = this.items.get(id);
    if (item && item.recording !== recording) {
      item.recording = recording;
      this.listener?.();
    }
  }

  remove(id: string): void {
    if (this.items.delete(id)) {
      this.listener?.();
    }
  }

  list(): SessionInfo[] {
    return [...this.items].map(([id, item]) => ({ id, ...item }));
  }

  onChange(listener: () => void): void {
    this.listener = listener;
  }
}
