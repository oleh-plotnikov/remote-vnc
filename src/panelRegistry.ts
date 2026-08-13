/**
 * Where open panels live, for whoever needs to find "a panel" by id or by
 * "the one in front of me": the loopback control server (Task 3) and the
 * hotkey dispatcher (Task 4). One registry so both agree on identity instead
 * of growing their own bookkeeping that drifts apart.
 */

/** What a panel can do on request, whoever is asking. */
export interface PanelEntry {
  id: string;
  name: string;
  kind: 'page' | 'session';
  mirrored: boolean;
  screenshot(): Promise<string>;
  record(): Promise<void>;
  recordStop(): Promise<string>;
  reload(): Promise<void>;
  /** Whether this panel is recording right now — the hotkey toggle (Task 4)
   *  needs this to decide between record() and recordStop() without a round
   *  trip, and the registry already owns panel identity for it to ask. */
  isRecording(): boolean;
}

/** The wire shape: identity only, never the callables. */
export type PanelSummary = Pick<PanelEntry, 'id' | 'name' | 'kind' | 'mirrored'>;

const panels = new Map<string, PanelEntry>();

export function registerPanel(entry: PanelEntry): void {
  panels.set(entry.id, entry);
}

export function unregisterPanel(id: string): void {
  panels.delete(id);
  // A disposed panel must not linger as "focused" — nothing would ever
  // clear it otherwise, and the hotkey dispatcher would keep dispatching to
  // a panel that no longer exists.
  if (focusedId === id) {
    focusedId = undefined;
  }
}

export function getPanel(id: string): PanelEntry | undefined {
  return panels.get(id);
}

export function listPanels(): PanelSummary[] {
  return [...panels.values()].map(({ id, name, kind, mirrored }) => ({ id, name, kind, mirrored }));
}

/** Which panel last reported itself active, for the hotkey dispatcher. */
let focusedId: string | undefined;

export function setFocusedPanel(id: string | undefined): void {
  focusedId = id;
}

/**
 * The focused panel, or undefined when nothing is focused OR the focused id
 * was unregistered since — a stale id must not resolve to a stranger's panel
 * if that id is ever reused, and must not resolve to `undefined` silently
 * mistaken for "found" by a caller that only checks truthiness of the id.
 */
export function getFocusedPanel(): PanelEntry | undefined {
  return focusedId === undefined ? undefined : panels.get(focusedId);
}
