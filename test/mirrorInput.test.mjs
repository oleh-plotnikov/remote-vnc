// The webview→CDP boundary for mirrored pages. This is the file that decides
// which DevTools calls a webview can reach, so the negative assertions matter
// as much as the positive ones: everything not recognised must come back
// undefined, never a half-built CDP command.
import { load } from './bundle.mjs';

export default async function ({ ok, eq }) {
  const { parseMirrorRequest, mirrorViewport, mayForwardInput, MAX_INFLIGHT_INPUT } =
    await load('mirrorInput.ts');
  const { captureChordAction } = await load('captureChord.ts');

  // --- the allowlist -------------------------------------------------------
  eq(parseMirrorRequest({ type: 'ack' }), { kind: 'ack' }, 'ack is recognised');
  for (const hostile of [
    { type: 'cdp', method: 'Page.navigate', params: { url: 'file:///etc/passwd' } },
    { type: 'input', kind: 'mouse', event: 'Runtime.evaluate' },
    { type: 'input', kind: 'eval', expression: '1' },
    { type: 'frame', data: 'AAA' },
    { method: 'Page.navigate' },
    'ack',
    null,
    ['ack'],
  ]) {
    eq(
      parseMirrorRequest(hostile),
      undefined,
      `rejected: ${JSON.stringify(hostile)}`
    );
  }

  // --- mouse ---------------------------------------------------------------
  const press = parseMirrorRequest({
    type: 'input',
    kind: 'mouse',
    event: 'mousePressed',
    x: 10.4,
    y: 20.6,
    button: 'left',
    buttons: 1,
    modifiers: 8,
  });
  eq(press.method, 'Input.dispatchMouseEvent', 'a mouse press maps to dispatchMouseEvent');
  eq(press.params.x, 10, 'coordinates are rounded to integers');
  eq(press.params.y, 21, 'coordinates are rounded to integers');
  eq(press.params.button, 'left', 'the button name survives');
  eq(press.params.modifiers, 8, 'the modifier mask survives');
  // Chrome ignores a press with no clickCount, which is the difference between
  // a button that highlights and a button that fires.
  eq(press.params.clickCount, 1, 'a press carries clickCount 1');
  eq(
    parseMirrorRequest({ type: 'input', kind: 'mouse', event: 'mouseMoved', x: 0, y: 0 }).params
      .clickCount,
    0,
    'a move carries no click'
  );
  eq(
    parseMirrorRequest({ type: 'input', kind: 'mouse', event: 'mouseDown', x: 1, y: 1 }),
    undefined,
    'an unknown mouse event name is rejected, not passed through'
  );
  eq(
    parseMirrorRequest({ type: 'input', kind: 'mouse', event: 'mousePressed', x: 'NaN', y: 1 }),
    undefined,
    'a non-numeric coordinate is rejected'
  );
  eq(
    parseMirrorRequest({
      type: 'input',
      kind: 'mouse',
      event: 'mousePressed',
      x: 1,
      y: 1,
      button: 'sudo',
      buttons: -3,
      modifiers: 999,
    }).params,
    { type: 'mousePressed', x: 1, y: 1, button: 'none', buttons: 0, modifiers: 999 & 15, clickCount: 1 },
    'unknown button, negative buttons and out-of-range modifiers are sanitised, not refused'
  );

  // --- wheel ---------------------------------------------------------------
  const wheel = parseMirrorRequest({
    type: 'input',
    kind: 'wheel',
    x: 5,
    y: 5,
    deltaX: -3,
    deltaY: 1e9,
  });
  eq(wheel.params.type, 'mouseWheel', 'a wheel event is a mouseWheel dispatch');
  eq(wheel.params.deltaX, -3, 'a sane delta passes through');
  eq(wheel.params.deltaY, 10000, 'an absurd delta is clamped');

  // --- keyboard ------------------------------------------------------------
  const typed = parseMirrorRequest({
    type: 'input',
    kind: 'key',
    event: 'keyDown',
    key: 'a',
    code: 'KeyA',
    modifiers: 0,
  });
  eq(typed.method, 'Input.dispatchKeyEvent', 'a key maps to dispatchKeyEvent');
  eq(typed.params.text, 'a', 'a printable keyDown carries text, which is what inserts it');
  eq(typed.params.windowsVirtualKeyCode, 65, 'a printable key carries its virtual key code');
  eq(
    parseMirrorRequest({ type: 'input', kind: 'key', event: 'keyUp', key: 'a', code: 'KeyA' }).params
      .text,
    undefined,
    'a keyUp never carries text — it would type the character twice'
  );
  // Cmd/Ctrl chords are commands, not characters.
  eq(
    parseMirrorRequest({ type: 'input', kind: 'key', event: 'keyDown', key: 'a', modifiers: 4 })
      .params.text,
    undefined,
    'a Cmd chord carries no text'
  );
  eq(
    parseMirrorRequest({ type: 'input', kind: 'key', event: 'keyDown', key: 'Enter' }).params,
    {
      type: 'keyDown',
      key: 'Enter',
      code: '',
      modifiers: 0,
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      text: '\r',
    },
    'Enter carries its virtual key code and the carriage return that submits forms'
  );
  eq(
    parseMirrorRequest({ type: 'input', kind: 'key', event: 'keyDown', key: 'ArrowLeft' }).params
      .text,
    undefined,
    'a named non-inserting key carries no text'
  );
  eq(
    parseMirrorRequest({ type: 'input', kind: 'key', event: 'keyPress', key: 'a' }),
    undefined,
    'an unknown key event name is rejected'
  );
  eq(
    parseMirrorRequest({ type: 'input', kind: 'key', event: 'keyDown', key: 'x'.repeat(64) }),
    undefined,
    'an implausibly long key name is rejected'
  );

  // --- punctuation's virtual key code: by `code`, never by charCodeAt ------
  // The bug this covers: `key.charCodeAt(0)` was used as a stand-in Windows
  // virtual key code for punctuation, and for two keys that ASCII code
  // collided with an unrelated NAMED key above — silently retargeting the
  // keystroke. This must fail against the pre-fix code, not just document
  // the new behaviour.
  eq(
    parseMirrorRequest({ type: 'input', kind: 'key', event: 'keyDown', key: '.', code: 'Period' })
      .params.windowsVirtualKeyCode,
    190,
    "a period's virtual key code is VK_OEM_PERIOD (190), looked up by its physical code"
  );
  // '.'.charCodeAt(0) === 46, and VIRTUAL_KEYS above maps Delete to 46 — this
  // is the exact collision that made typing a period act as Delete.
  ok(
    parseMirrorRequest({ type: 'input', kind: 'key', event: 'keyDown', key: '.', code: 'Period' })
      .params.windowsVirtualKeyCode !== 46,
    'a period does not act as Delete (was 46 via charCodeAt; VIRTUAL_KEYS.Delete is also 46)'
  );
  eq(
    parseMirrorRequest({ type: 'input', kind: 'key', event: 'keyDown', key: '-', code: 'Minus' })
      .params.windowsVirtualKeyCode,
    189,
    "a minus's virtual key code is VK_OEM_MINUS (189), looked up by its physical code"
  );
  ok(
    parseMirrorRequest({ type: 'input', kind: 'key', event: 'keyDown', key: '-', code: 'Minus' })
      .params.windowsVirtualKeyCode !== 45,
    'a minus does not act as Insert (was 45 via charCodeAt; VIRTUAL_KEYS.Insert is also 45)'
  );
  // The rest of the punctuation table, round-tripped the same way.
  for (const [key, code, want] of [
    [',', 'Comma', 188],
    ['=', 'Equal', 187],
    ['/', 'Slash', 191],
    [';', 'Semicolon', 186],
    ["'", 'Quote', 222],
    ['[', 'BracketLeft', 219],
    [']', 'BracketRight', 221],
    ['\\', 'Backslash', 220],
    ['`', 'Backquote', 192],
  ]) {
    eq(
      parseMirrorRequest({ type: 'input', kind: 'key', event: 'keyDown', key, code }).params
        .windowsVirtualKeyCode,
      want,
      `${code} (key "${key}") maps to its VK_OEM code ${want}`
    );
  }
  // Letters and digits keep the char-code guess — that mapping was never the
  // bug, only extending it past A-Z/0-9 was.
  eq(
    parseMirrorRequest({ type: 'input', kind: 'key', event: 'keyDown', key: '5', code: 'Digit5' })
      .params.windowsVirtualKeyCode,
    53,
    'a digit still gets its virtual key code from the char-code guess'
  );
  // Unmapped punctuation (no entry in PUNCTUATION_VIRTUAL_KEYS, e.g. an
  // unrecognised or missing `code`) must fall back to 0, never to another
  // guessed char code — a wrong virtual key code can name a live binding
  // (as 46/Delete and 45/Insert already proved), whereas 0 is inert and
  // `text` (asserted separately) is what actually inserts the character.
  eq(
    parseMirrorRequest({ type: 'input', kind: 'key', event: 'keyDown', key: '.', code: 'NumpadDecimal' })
      .params.windowsVirtualKeyCode,
    0,
    'punctuation with no entry in the table falls back to 0, not a guessed char code'
  );
  eq(
    parseMirrorRequest({ type: 'input', kind: 'key', event: 'keyDown', key: '.' }).params
      .windowsVirtualKeyCode,
    0,
    'punctuation with no `code` at all falls back to 0 the same way'
  );
  eq(
    parseMirrorRequest({ type: 'input', kind: 'key', event: 'keyDown', key: '.', code: 'Period' })
      .params.text,
    '.',
    'the character itself still arrives via `text`, which is the actual insertion mechanism — ' +
      'unaffected by the virtual key code fix'
  );

  // --- editing commands: paste and friends actually reach Chrome -----------
  // Input.dispatchKeyEvent alone does not make Chrome paste — the OS-level
  // translation a real keypress gets (Cocoa's NSResponder chain recognising
  // Cmd+V) is exactly what a synthetic CDP event bypasses. `commands` is
  // CDP's own replacement for that translation.
  eq(
    parseMirrorRequest({ type: 'input', kind: 'key', event: 'keyDown', key: 'v', code: 'KeyV', modifiers: 4 })
      .params.commands,
    ['Paste'],
    'Cmd+V carries the Paste editing command'
  );
  eq(
    parseMirrorRequest({ type: 'input', kind: 'key', event: 'keyDown', key: 'v', code: 'KeyV', modifiers: 2 })
      .params.commands,
    ['Paste'],
    'Ctrl+V does too — Windows/Linux use Ctrl where macOS uses Cmd'
  );
  for (const [key, want] of [
    ['c', 'Copy'],
    ['x', 'Cut'],
    ['a', 'SelectAll'],
    ['z', 'Undo'],
  ]) {
    eq(
      parseMirrorRequest({ type: 'input', kind: 'key', event: 'keyDown', key, modifiers: 4 }).params
        .commands,
      [want],
      `Cmd+${key.toUpperCase()} carries ${want}`
    );
  }
  eq(
    parseMirrorRequest({ type: 'input', kind: 'key', event: 'keyDown', key: 'v', code: 'KeyV', modifiers: 4 })
      .params.text,
    undefined,
    'a Paste chord still carries no text — it must not ALSO type a literal "v"'
  );
  eq(
    parseMirrorRequest({ type: 'input', kind: 'key', event: 'keyUp', key: 'v', code: 'KeyV', modifiers: 4 })
      .params.commands,
    undefined,
    'keyUp carries no commands — one physical press must paste once, not on both edges'
  );
  eq(
    parseMirrorRequest({ type: 'input', kind: 'key', event: 'keyDown', key: 'v', code: 'KeyV', modifiers: 12 })
      .params.commands,
    undefined,
    'Cmd+Shift+V (modifiers 12: Meta|Shift) is a different chord and is left unmapped, not guessed at'
  );
  eq(
    parseMirrorRequest({ type: 'input', kind: 'key', event: 'keyDown', key: 'v', code: 'KeyV', modifiers: 0 })
      .params.commands,
    undefined,
    'a plain "v" with no modifier carries no editing command'
  );

  // --- CRITICAL 2: the space bar kept its virtual key code -----------------
  // ' '.charCodeAt(0) === 32 === VK_SPACE under the old guess, correctly by
  // coincidence — the same coincidence letters/digits rely on. Narrowing that
  // guess to `/[A-Za-z0-9]/` (to stop trusting it for punctuation) excluded
  // space too, even though its coincidence was never wrong: every
  // space-to-play/pause or "press space to continue" handler reading
  // `keyCode`/`which` then saw 0. `text: ' '` still arrives regardless, which
  // is exactly why this bug is invisible just from watching the mirror.
  eq(
    parseMirrorRequest({ type: 'input', kind: 'key', event: 'keyDown', key: ' ', code: 'Space' }).params
      .windowsVirtualKeyCode,
    32,
    'space keeps VK_SPACE (32), looked up by its physical code like the punctuation table'
  );
  eq(
    parseMirrorRequest({ type: 'input', kind: 'key', event: 'keyDown', key: ' ', code: 'Space' }).params
      .text,
    ' ',
    'and still inserts the character via text, unaffected by the virtual-key fix'
  );

  // --- IMPORTANT 6: Ctrl+A / Ctrl+V do not get editing commands on macOS ---
  // Ctrl+A is caret-to-line-start on macOS (VS Code itself ships that exact
  // binding), not select-all — so treating Ctrl there as Cmd's equivalent
  // selects the whole field and the next keystroke wipes it. Meta (Cmd) is
  // unambiguous on every platform and always qualifies.
  for (const [key, want] of [
    ['a', undefined],
    ['v', undefined],
    ['c', undefined],
    ['x', undefined],
    ['z', undefined],
  ]) {
    eq(
      parseMirrorRequest(
        { type: 'input', kind: 'key', event: 'keyDown', key, modifiers: 2 /* Ctrl */ },
        'darwin'
      ).params.commands,
      want,
      `Ctrl+${key.toUpperCase()} carries no editing command on darwin`
    );
  }
  eq(
    parseMirrorRequest(
      { type: 'input', kind: 'key', event: 'keyDown', key: 'a', modifiers: 4 /* Meta */ },
      'darwin'
    ).params.commands,
    ['SelectAll'],
    'Cmd+A still carries SelectAll on darwin — only Ctrl is gated off, not Meta'
  );
  eq(
    parseMirrorRequest(
      { type: 'input', kind: 'key', event: 'keyDown', key: 'v', code: 'KeyV', modifiers: 2 },
      'win32'
    ).params.commands,
    ['Paste'],
    'Ctrl+V still carries Paste on a non-darwin platform — Ctrl is the copy/paste modifier there'
  );
  eq(
    parseMirrorRequest({ type: 'input', kind: 'key', event: 'keyDown', key: 'v', code: 'KeyV', modifiers: 2 })
      .params.commands,
    ['Paste'],
    'and with no platform argument at all (every earlier assertion in this file), Ctrl still qualifies — ' +
      'the default is backward-compatible, not silently darwin'
  );

  // --- MINOR: a prototype property name must not smuggle a command through -
  // EDIT_COMMANDS['constructor'] resolves via the prototype chain to
  // Object's own constructor function on a plain `{}`-style lookup, not
  // `undefined` — `commands: [Object]` would then reach JSON.stringify as
  // `commands: [null]`, and Chrome rejects the whole key event for it.
  eq(
    parseMirrorRequest({ type: 'input', kind: 'key', event: 'keyDown', key: 'constructor', modifiers: 4 })
      .params.commands,
    undefined,
    'a key literally named "constructor" carries no editing command, not a poisoned one'
  );

  // --- viewport ------------------------------------------------------------
  eq(
    parseMirrorRequest({ type: 'viewport', width: 900.6, height: 500 }),
    { kind: 'viewport', width: 901, height: 500 },
    'a viewport is rounded and passed on'
  );
  // setDeviceMetricsOverride allocates for whatever number it is given.
  eq(
    parseMirrorRequest({ type: 'viewport', width: 1e6, height: 2 }),
    { kind: 'viewport', width: 8192, height: 64 },
    'a viewport is clamped at both ends'
  );
  eq(
    parseMirrorRequest({ type: 'viewport', width: 'wide', height: 500 }),
    undefined,
    'a non-numeric viewport is rejected'
  );

  // --- the capture chords --------------------------------------------------
  // media/pageMirror.ts consults captureChordAction BEFORE forwarding a key,
  // and posts {type:'chord'} instead of an input message when it matches. That
  // ordering lives in a webview and is not loadable here, but both of the pure
  // halves it rests on are, and each would break it on its own.
  //
  // Half one: the chords are recognisable from what a keydown carries, so the
  // webview always has an answer before it decides to forward.
  const chordKeys = { code: 'KeyS', altKey: true, metaKey: true };
  eq(captureChordAction(chordKeys), 'screenshot', 'a chord is identifiable from the keydown alone');
  eq(
    captureChordAction({ code: 'KeyK', altKey: true, metaKey: true }),
    undefined,
    'a near miss is not a chord, and is forwarded like any other key'
  );
  // The keys a chord is made of are an ordinary keystroke to this module —
  // proof that withholding them is the webview's job, done before the message
  // is ever built, and not something the host could undo by accident.
  ok(
    parseMirrorRequest({
      type: 'input',
      kind: 'key',
      event: 'keyDown',
      key: 's',
      code: 'KeyS',
      modifiers: 5,
    }) !== undefined,
    'a chord that HAS been forwarded as input is indistinguishable here'
  );

  // Half two: Task 7 puts the chord message itself in the allowlist, so the
  // host (src/pagePanel.ts's handleMirrorMessage) can route it to the two
  // focused-panel commands instead of a CDP call. This assertion is what makes
  // that a deliberate change rather than a silent one.
  eq(
    parseMirrorRequest({ type: 'chord', action: 'screenshot' }),
    { kind: 'chord', action: 'screenshot' },
    'a chord message is recognised and carries its action through'
  );
  eq(
    parseMirrorRequest({ type: 'chord', action: 'record' }),
    { kind: 'chord', action: 'record' },
    'the other chord action is recognised too'
  );
  eq(
    parseMirrorRequest({ type: 'chord', action: 'sudo' }),
    undefined,
    'an unrecognised chord action is rejected, not passed through to the executed command'
  );

  // --- which size wins -----------------------------------------------------
  eq(
    mirrorViewport({ width: 1280, height: 800 }, { width: 600, height: 400 }),
    { width: 1280, height: 800 },
    'a saved canvas size beats the measured panel — it is why it was configured'
  );
  eq(
    mirrorViewport(undefined, { width: 600, height: 400 }),
    { width: 600, height: 400 },
    'a responsive page follows the panel'
  );

  // --- backpressure: which events may still be forwarded, and which may not -
  // Input.dispatch*'s CDP response is deferred by Chromium until the page's
  // RENDERER acknowledges the event, so an unanswered dispatch is a renderer
  // that has fallen behind — 128 of them were outstanding at teardown of one
  // ~78s typed session, against 0 for a ~4.5 minute session that was only
  // watched. Nothing capped, coalesced or counted them, so the queue only
  // ever grew. This is the decision that stops it.
  eq(MAX_INFLIGHT_INPUT, 8, 'the cap is 8 outstanding dispatches — see its own comment for why');

  {
  const moved = { type: 'mouseMoved', x: 1, y: 2 };

  eq(mayForwardInput(moved, 0), true, 'an idle mirror forwards pointer motion');
  eq(
    mayForwardInput(moved, MAX_INFLIGHT_INPUT - 1),
    true,
    'one below the cap still forwards motion — the cap is a ceiling, not a suggestion to start dropping early'
  );
  eq(
    mayForwardInput(moved, MAX_INFLIGHT_INPUT),
    false,
    'AT the cap, pointer motion stops being forwarded: the highest-volume event and the only one a later event replaces outright'
  );
  eq(mayForwardInput(moved, 500), false, 'and stays dropped however deep the queue gets');

  // The half this must never do. A dropped keystroke is a character the user
  // typed and never got; a dropped move is invisible, because the next move
  // carries absolute coordinates.
  for (const [params, note] of [
    [{ type: 'keyDown', key: 'a' }, 'a key is forwarded even far past the cap — a lost keystroke is worse than a late one'],
    [{ type: 'keyUp', key: 'a' }, 'so is its release, or the page sees a key held down forever'],
    [{ type: 'mousePressed', x: 1, y: 2 }, 'a press is forwarded — it carries the point a drag starts at'],
    [{ type: 'mouseReleased', x: 1, y: 2 }, 'so is a release — it carries the point the drag ends at'],
    [{ type: 'mouseWheel', x: 1, y: 2, deltaY: 10 }, 'a wheel event is forwarded: a dropped scroll is lost distance, not a stale position'],
  ]) {
    eq(mayForwardInput(params, 500), true, note);
  }

  // The limit is a parameter so this decision can be exercised (and tuned)
  // without the constant, but its default IS the constant — a caller that
  // forgets to pass one must not silently get "never drop anything".
  eq(mayForwardInput(moved, 2, 2), false, 'an explicit lower limit is honoured');
  eq(mayForwardInput(moved, 1, 2), true, 'and below that limit motion still flows');
  }
}
