/**
 * Which capture the keyboard chords mean, shared by the webview (which has to
 * intercept them) and its tests.
 *
 * These chords cannot be left to VS Code's keybinding dispatcher inside a VNC
 * panel. noVNC exists to forward keystrokes to the remote machine, so its
 * keydown handler calls preventDefault + stopPropagation on everything it
 * tracks (`@novnc/novnc/core/input/keyboard.js`), and a webview's keys only
 * reach the workbench if the webview leaves them alone. With `focusOnClick`
 * set, one click in the canvas is enough to make the chords disappear into the
 * remote session — which is exactly what a user reported: the shortcut worked
 * only while focus happened to sit somewhere else, such as the sidebar.
 *
 * So the webview claims these two chords first, in the capture phase, before
 * noVNC's listener on the canvas ever sees them.
 *
 * Match on `code`, never on `key`: macOS turns Option+S into "ß" and Option+R
 * into "®", so a `key`-based comparison silently never fires there — the exact
 * platform this was reported on.
 */
export type CaptureChord = 'screenshot' | 'record';

/** The subset of a KeyboardEvent this decision needs. */
export interface ChordEvent {
  code?: string;
  altKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
}

/**
 * The chord these keys mean, or undefined when they mean nothing to us and
 * belong to the remote session.
 *
 * Shift is deliberately not consulted: the bindings in package.json do not
 * name it, so a user holding it should still get their screenshot rather than
 * silently sending Cmd+Alt+Shift+S to the remote machine.
 */
export function captureChordAction(event: ChordEvent): CaptureChord | undefined {
  if (!event.altKey || !(event.metaKey || event.ctrlKey)) {
    return undefined;
  }
  if (event.code === 'KeyS') {
    return 'screenshot';
  }
  if (event.code === 'KeyR') {
    return 'record';
  }
  return undefined;
}
