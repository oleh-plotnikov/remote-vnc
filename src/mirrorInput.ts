import type { CaptureChord } from './captureChord';

/**
 * The boundary between a mirrored panel's webview and the DevTools protocol.
 *
 * The host owns the CDP socket and the webview never sees it (cdpClient.ts says
 * why), so nothing crossing that gap is forwarded — it is translated here.
 * A webview renders a page we do not control; if that page ever gets to post
 * messages, an unchecked `method` field is all that separates a rendering bug
 * from `Page.navigate('file:///…')` or `Runtime.evaluate`. Two CDP methods are
 * reachable from this file and no others, with every parameter rebuilt from
 * validated primitives rather than passed through.
 *
 * Free of `vscode`, of DOM types and of Node globals: the host imports it, and
 * the tests load it directly.
 *
 * `chord` is the one message here that never becomes a CDP call: the two
 * capture chords (media/pageMirror.ts, guarded by captureChordAction) are
 * routed to VS Code commands instead (src/pagePanel.ts's handleMirrorMessage),
 * the same translation src/vncPanel.ts's onMessage does for its own webview.
 * It still belongs to this allowlist rather than being read off `raw` ad hoc —
 * an unrecognised `action` must come back undefined here, not be trusted to
 * whichever string a compromised bundle happened to send.
 */

export type MirrorRequest =
  | { kind: 'ack' }
  | { kind: 'viewport'; width: number; height: number }
  | { kind: 'chord'; action: CaptureChord }
  | {
      kind: 'cdp';
      method: 'Input.dispatchMouseEvent' | 'Input.dispatchKeyEvent';
      params: Record<string, unknown>;
    };

export interface MirrorSize {
  width: number;
  height: number;
}

/**
 * How many `Input.dispatch*` calls may be outstanding before pointer motion
 * stops being forwarded.
 *
 * Why a cap has to exist at all: `Input.dispatchKeyEvent`'s CDP response is
 * deferred by Chromium until the page's RENDERER has acknowledged the event.
 * So the number of unanswered dispatches is not bookkeeping — it is a direct
 * measurement of how far behind the renderer is, and nothing in this
 * extension ever capped, coalesced, timed out or even counted them. On a
 * loaded machine a renderer compositing an animating page cannot keep up,
 * every further event queues behind the last, and latency grows monotonically
 * until nothing lands at all: on the reporting machine a ~78 second session
 * that was TYPED into ended with 128 dispatches unanswered, a ~39 second one
 * with 15, and a ~4.5 minute session that was only WATCHED with none. The
 * depth tracks input volume, not uptime.
 *
 * Why eight. At the 30 fps active rate a mirror paints every ~33 ms and a
 * healthy renderer answers a dispatch well inside one such frame — the depth
 * on a healthy session sits at 0 or 1. Eight outstanding events is therefore
 * already something like a quarter of a second of input the page has not
 * looked at: past the point a typist can still attribute the lag to their own
 * hands, and far enough above the healthy depth that ordinary jitter (one
 * slow layout, one GC pause) never reaches it. Much lower would drop motion
 * during hiccups that resolve on their own; much higher and the queue is long
 * enough to feel dead before anything reacts to it.
 */
export const MAX_INFLIGHT_INPUT = 8;

/**
 * Whether a translated input event may be forwarded while `inFlight`
 * dispatches are still unanswered.
 *
 * Only `mouseMoved` is ever refused. It is the highest-volume event by an
 * order of magnitude — media/pageMirror.ts already thins it to roughly
 * display rate and it still dominates everything else together — and it is
 * the only one that costs nothing to lose: the NEXT move carries absolute
 * coordinates, so a dropped one leaves no trace, while presses and releases
 * carry the endpoints of a drag and a key carries a character the user typed.
 * A lost keystroke is worse than a late one, so keys are never refused here
 * however deep the queue is; the cap slows the queue's growth instead by
 * removing the traffic that was never worth the round trip.
 */
export function mayForwardInput(
  params: Record<string, unknown>,
  inFlight: number,
  limit: number = MAX_INFLIGHT_INPUT
): boolean {
  return inFlight < limit || params.type !== 'mouseMoved';
}

/**
 * Bounds on a webview-reported viewport. The low bound keeps a panel dragged
 * to a sliver from asking Chrome to lay a page out in a few pixels; the high
 * bound is the one that matters — `Emulation.setDeviceMetricsOverride` takes
 * the number at face value and allocates a framebuffer for it.
 */
const MIN_VIEWPORT = 64;
const MAX_VIEWPORT = 8192;

/** CDP's modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8. */
const MOD_CTRL = 2;
const MOD_META = 4;
const MODIFIER_MASK = 15;
/** Five buttons is all `MouseEvent.buttons` reports. */
const BUTTONS_MASK = 31;

const MOUSE_TYPES = new Set(['mousePressed', 'mouseReleased', 'mouseMoved']);
const MOUSE_BUTTONS = new Set(['none', 'left', 'middle', 'right', 'back', 'forward']);
const KEY_TYPES = new Set(['keyDown', 'keyUp']);

/**
 * Virtual key codes for the keys whose `key` name is not a character. Pages
 * still read `keyCode` (jQuery-era handlers and every "submit on Enter" form),
 * and CDP does not derive it for us.
 */
const VIRTUAL_KEYS: Record<string, number> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Shift: 16,
  Control: 17,
  Alt: 18,
  CapsLock: 20,
  Escape: 27,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Insert: 45,
  Delete: 46,
  Meta: 91,
};

/**
 * Virtual key codes keyed by the physical `code` (KeyboardEvent.code — e.g.
 * "Period", "Minus", "Space") rather than by `key`. Mostly punctuation, plus
 * Space — grouped together because both are keys whose `key` value is a bare
 * character, which is exactly the shape that made the old `key.charCodeAt(0)`
 * guess plausible-looking and wrong.
 *
 * `key` IS the character for these, and the bug this table fixes was mapping
 * it with `key.charCodeAt(0)` — the character's ASCII code, not its Windows
 * virtual key code. The two coincide for letters, digits, and (by the same
 * coincidence the old code relied on) space — VK_SPACE is 32, the same as
 * `' '.charCodeAt(0)` — but diverge for the rest of punctuation. Two of
 * those divergences were destructive rather than merely wrong: '.' is 46,
 * the same value VIRTUAL_KEYS above assigns to Delete, so typing a period
 * told Chrome the DELETE key was pressed; '-' is 45, the same as Insert.
 * Space fell into the SAME class of bug from the opposite direction: when
 * the coincidence-reliant guess was narrowed to stop trusting it for
 * punctuation (`/[A-Za-z0-9]/`), space was narrowed out too even though its
 * coincidence was never wrong — so it lost its virtual key code entirely
 * (every space/pause, "press space to continue" handler reading `keyCode`
 * saw 0) even though the character itself kept arriving fine via `text`.
 *
 * `code` is layout-independent (unlike `key`, which changes under
 * AZERTY/Dvorak/...) and is exactly the physical key CDP's own
 * `nativeVirtualKeyCode`/`windowsVirtualKeyCode` describe, so it is the
 * correct thing to key this table on, not a workaround.
 */
const CODE_VIRTUAL_KEYS: Record<string, number> = {
  Space: 32, // VK_SPACE — narrowing the letters/digits guess to exclude non-alnum lost this
  Period: 190, // VK_OEM_PERIOD — was colliding with Delete (46) via charCodeAt
  Comma: 188, // VK_OEM_COMMA
  Minus: 189, // VK_OEM_MINUS — was colliding with Insert (45) via charCodeAt
  Equal: 187, // VK_OEM_PLUS (also '+')
  Slash: 191, // VK_OEM_2
  Semicolon: 186, // VK_OEM_1
  Quote: 222, // VK_OEM_7
  BracketLeft: 219, // VK_OEM_4
  BracketRight: 221, // VK_OEM_6
  Backslash: 220, // VK_OEM_5
  Backquote: 192, // VK_OEM_3
};

/**
 * The Windows virtual key code CDP wants for a key event: named keys first
 * (Enter, the arrows, ...), then physical-code lookups — see
 * CODE_VIRTUAL_KEYS — and only THEN the letters/digits guess, because that
 * guess is exactly what let punctuation (and briefly, space) slip through
 * wrong. Anything left maps to 0, deliberately, not to another guess: a
 * WRONG virtual key code is strictly worse than none, since it can name some
 * other live binding (as 46/Delete and 45/Insert already have) — whereas 0
 * with `text` still set (see keyRequest) still inserts the character via
 * `text`, which is the actual mechanism Chrome uses to type into a field.
 * Deliberately NOT extended to shifted digits (Shift+1 → '!') or the numpad
 * — both fall to 0 here, which is a strict improvement over the old code
 * guessing a wrong NAMED key's code (e.g. '!'.charCodeAt(0) === 33, the
 * same as PageUp) rather than an absence, but neither has a `code` this file
 * can name a real virtual key code for with the same confidence as the table
 * above.
 *
 * The letters/digits guess stays: for A-Z and 0-9 the uppercase ASCII code
 * and the Windows virtual key code are the same numbers by construction, so
 * that guess was never the bug — only extending the same logic to characters
 * where the two diverge was.
 */
function virtualKeyCode(key: string, code: string | undefined): number {
  if (Object.prototype.hasOwnProperty.call(VIRTUAL_KEYS, key)) {
    return VIRTUAL_KEYS[key];
  }
  if (code !== undefined && Object.prototype.hasOwnProperty.call(CODE_VIRTUAL_KEYS, code)) {
    return CODE_VIRTUAL_KEYS[code];
  }
  return key.length === 1 && /[A-Za-z0-9]/.test(key) ? key.toUpperCase().charCodeAt(0) : 0;
}

/**
 * Editing commands attached to a keydown (`Input.dispatchKeyEvent`'s
 * `commands` field) so Chrome performs the actual editing action, not only a
 * keystroke — see `editCommandsFor` for why this is necessary at all, not
 * cosmetic.
 *
 * Only the base chord (Ctrl or Cmd, alone, no Shift/Alt) is mapped: the
 * handful everyone reaches for by reflex, and the ones actually reported
 * broken (paste). A modified variant (Cmd+Shift+Z for redo, Ctrl+Shift+V for
 * paste-without-formatting, ...) is left unmapped rather than guessed at —
 * it falls through with no `commands` and behaves as it already did (nothing
 * happens), which is a known gap, not a silently wrong one.
 */
const EDIT_COMMANDS: Record<string, string> = {
  v: 'Paste',
  c: 'Copy',
  x: 'Cut',
  a: 'SelectAll',
  z: 'Undo',
};

/**
 * Which Blink editing commands (if any) a keydown should carry.
 *
 * Why this exists at all: for a REAL keypress, the OS's own event handling
 * (Cocoa's NSResponder chain on macOS) recognises Cmd+V et al. as editing
 * commands and tells the renderer directly — Blink never has to infer one
 * from a raw keydown. A key event injected via `Input.dispatchKeyEvent`
 * skips that OS-level translation entirely (it lands in Blink's input
 * pipeline over IPC, downstream of where Cocoa would have intercepted it),
 * so a synthetic Cmd+V produces a keydown Blink has no default handler for —
 * nothing happens, silently. `commands` is CDP's explicit replacement for
 * the platform translation a synthetic event bypasses.
 *
 * This makes Chrome ATTEMPT the paste — it does not, on its own, guarantee
 * the paste completes: `Paste` still asks Chrome to read its own clipboard,
 * and whether the headless Chrome process this extension launches can reach
 * the OS clipboard on a given machine is a runtime property of that Chrome,
 * not something this file controls or (without launching Chrome, which this
 * fix deliberately avoids) can verify here. What was categorically broken
 * before this — no `commands` field ever reaching Blink, so Paste could
 * never even be attempted — is what this fixes.
 *
 * `platform` (a plain string — `process.platform`'s VALUE, passed in by the
 * caller, never read from `process` here) matters because Ctrl is not
 * uniformly the copy/paste modifier: on macOS, Ctrl+A is caret-to-line-start
 * (VS Code itself ships that exact binding) and Ctrl+V is nothing standard,
 * so treating Ctrl there as Cmd's equivalent is actively destructive — the
 * very next keystroke after a phantom SelectAll wipes a caret-selected
 * field instead of pasting into it. Meta (Cmd) is unambiguous on every
 * platform this ships to and always qualifies; Ctrl only qualifies when the
 * platform is not `darwin`.
 */
function editCommandsFor(key: string, modifiers: number, platform: string | undefined): string[] {
  const isMeta = modifiers === MOD_META;
  const isCtrl = modifiers === MOD_CTRL;
  if (!isMeta && !(isCtrl && platform !== 'darwin')) {
    return [];
  }
  const lower = key.toLowerCase();
  const command = Object.prototype.hasOwnProperty.call(EDIT_COMMANDS, lower)
    ? EDIT_COMMANDS[lower]
    : undefined;
  return command ? [command] : [];
}

/**
 * Keys that insert something despite not being one character wide. Chrome
 * inserts text only when `text` is set on the keyDown — a bare
 * `Enter` keyDown moves focus and submits nothing.
 */
const KEY_TEXT: Record<string, string> = { Enter: '\r', Tab: '\t' };

/**
 * The one entry point. Returns undefined for every message shape this file
 * does not know, which is what makes the set of reachable CDP calls closed.
 *
 * `platform` is optional and forwarded only to `keyRequest` (see
 * `editCommandsFor`) — this file stays free of `process`/`vscode` itself
 * (see the file doc comment), so the caller (src/pagePanel.ts) is the one
 * that reads `process.platform` and passes its VALUE in. Omitting it keeps
 * every existing call site (and every test that does not care about
 * platform-specific editing commands) unaffected, defaulting to "not
 * darwin" — i.e. Ctrl still qualifies, matching the behaviour before
 * platform-gating existed.
 */
export function parseMirrorRequest(raw: unknown, platform?: string): MirrorRequest | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  const msg = raw as Record<string, unknown>;
  if (msg.type === 'ack') {
    return { kind: 'ack' };
  }
  if (msg.type === 'viewport') {
    const width = viewportSide(msg.width);
    const height = viewportSide(msg.height);
    return width && height ? { kind: 'viewport', width, height } : undefined;
  }
  if (msg.type === 'chord') {
    return msg.action === 'screenshot' || msg.action === 'record'
      ? { kind: 'chord', action: msg.action }
      : undefined;
  }
  if (msg.type === 'input') {
    if (msg.kind === 'mouse') {
      return mouseRequest(msg);
    }
    if (msg.kind === 'wheel') {
      return wheelRequest(msg);
    }
    if (msg.kind === 'key') {
      return keyRequest(msg, platform);
    }
  }
  return undefined;
}

/**
 * The viewport to emulate: a page's saved canvas size wins over whatever the
 * panel currently measures, because a fixed canvas is the whole reason that
 * size was configured — the tab scales the result to fit instead.
 */
export function mirrorViewport(canvas: MirrorSize | undefined, reported: MirrorSize): MirrorSize {
  return canvas ?? reported;
}

function mouseRequest(msg: Record<string, unknown>): MirrorRequest | undefined {
  const type = typeof msg.event === 'string' && MOUSE_TYPES.has(msg.event) ? msg.event : undefined;
  const x = coord(msg.x);
  const y = coord(msg.y);
  if (!type || x === undefined || y === undefined) {
    return undefined;
  }
  return {
    kind: 'cdp',
    method: 'Input.dispatchMouseEvent',
    params: {
      type,
      x,
      y,
      button: typeof msg.button === 'string' && MOUSE_BUTTONS.has(msg.button) ? msg.button : 'none',
      buttons: mask(msg.buttons, BUTTONS_MASK),
      modifiers: mask(msg.modifiers, MODIFIER_MASK),
      // Chrome only treats a press/release pair as a click when clickCount is
      // set. Left at its default, every button in the mirrored page would
      // highlight on press and then do nothing.
      clickCount: type === 'mouseMoved' ? 0 : 1,
    },
  };
}

function wheelRequest(msg: Record<string, unknown>): MirrorRequest | undefined {
  const x = coord(msg.x);
  const y = coord(msg.y);
  if (x === undefined || y === undefined) {
    return undefined;
  }
  return {
    kind: 'cdp',
    method: 'Input.dispatchMouseEvent',
    params: {
      type: 'mouseWheel',
      x,
      y,
      button: 'none',
      deltaX: delta(msg.deltaX),
      deltaY: delta(msg.deltaY),
      modifiers: mask(msg.modifiers, MODIFIER_MASK),
    },
  };
}

function keyRequest(msg: Record<string, unknown>, platform: string | undefined): MirrorRequest | undefined {
  const type = typeof msg.event === 'string' && KEY_TYPES.has(msg.event) ? msg.event : undefined;
  const key = shortString(msg.key);
  if (!type || key === undefined) {
    return undefined;
  }
  const modifiers = mask(msg.modifiers, MODIFIER_MASK);
  const code = shortString(msg.code);
  const virtualKey = virtualKeyCode(key, code);
  const params: Record<string, unknown> = {
    type,
    key,
    code: code ?? '',
    modifiers,
    windowsVirtualKeyCode: virtualKey,
    nativeVirtualKeyCode: virtualKey,
  };
  // `text` is what actually inserts a character, and it must not be set while
  // Ctrl/Cmd is down — Cmd+A would type an "A" into the page instead of
  // selecting it.
  const text = KEY_TEXT[key] ?? (key.length === 1 ? key : undefined);
  if (type === 'keyDown' && text !== undefined && (modifiers & (MOD_CTRL | MOD_META)) === 0) {
    params.text = text;
  }
  // Only on keyDown: CDP applies an editing command once, when the key goes
  // down, same as a real keyboard would — sending it again on keyUp would
  // ask Chrome to paste twice for one physical press.
  if (type === 'keyDown') {
    const commands = editCommandsFor(key, modifiers, platform);
    if (commands.length > 0) {
      params.commands = commands;
    }
  }
  return { kind: 'cdp', method: 'Input.dispatchKeyEvent', params };
}

/** A viewport side, clamped into the sane range, or 0 for anything unusable. */
function viewportSide(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0;
  }
  return Math.min(MAX_VIEWPORT, Math.max(MIN_VIEWPORT, Math.round(value)));
}

/** A pixel coordinate: a finite non-negative integer, or undefined. */
function coord(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(0, Math.min(MAX_VIEWPORT, Math.round(value)));
}

/** A wheel delta, bounded so one hostile message cannot scroll to infinity. */
function delta(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(-10000, Math.min(10000, value));
}

/** A bitmask field: integers only, and only the bits that mean something. */
function mask(value: unknown, limit: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return 0;
  }
  return value & limit;
}

/** A key name or code. Bounded: these are event names, not free text. */
function shortString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 32 ? value : undefined;
}
