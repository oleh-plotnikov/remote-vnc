import { load } from './bundle.mjs';

export default async function ({ ok, eq }) {
  const { captureChordAction } = await load('captureChord.ts');

  const ev = (over) => ({ code: 'KeyS', altKey: true, metaKey: true, ctrlKey: false, ...over });

  // the two chords, on both platforms' modifier
  eq(captureChordAction(ev()), 'screenshot', 'cmd+alt+s is the screenshot chord');
  eq(
    captureChordAction(ev({ metaKey: false, ctrlKey: true })),
    'screenshot',
    'ctrl+alt+s is the same chord on Windows/Linux'
  );
  eq(captureChordAction(ev({ code: 'KeyR' })), 'record', 'cmd+alt+r is the record chord');

  // Matching must key off `code`, never `key`: on macOS Option+S emits "ß" and
  // Option+R emits "®", so a `key`-based check silently never fires there.
  eq(captureChordAction(ev({ key: 'ß' })), 'screenshot', 'the emitted character is irrelevant');

  // every modifier is required
  eq(captureChordAction(ev({ altKey: false })), undefined, 'without alt it is not the chord');
  eq(
    captureChordAction(ev({ metaKey: false, ctrlKey: false })),
    undefined,
    'without cmd or ctrl it is not the chord'
  );
  eq(captureChordAction(ev({ shiftKey: true })), 'screenshot', 'shift is not consulted');

  // anything else passes through to the remote session
  eq(captureChordAction(ev({ code: 'KeyA' })), undefined, 'other letters are not chords');
  eq(captureChordAction(ev({ code: 'Escape' })), undefined, 'non-letters are not chords');
  ok(captureChordAction({}) === undefined, 'a shapeless event is not a chord');
}
