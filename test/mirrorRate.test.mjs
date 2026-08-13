// The pure activity → frame-rate decision behind an adaptive mirror.
//
// Exists because one fixed rate cannot serve both things a mirror is for,
// measured on one machine, one page: 30 fps keeps typing feeling immediate
// but costs CPU whether or not anyone is looking; 10 fps is fine for
// watching but puts a visible 100ms+ gap between a keystroke and its result,
// which reads as the page glitching or hanging. `selectMirrorFps` is what
// src/pagePanel.ts calls on every forwarded input event and every
// idle-transition timer tick to decide which one applies right now — pure
// and clock-free (time is a parameter, nothing here reads Date.now()) so the
// edge of the active window can be pinned exactly, not raced against a real
// clock or a real setTimeout.
import { load } from './bundle.mjs';

export default async function ({ ok, eq }) {
  const { selectMirrorFps, deriveIdleFps, ACTIVE_WINDOW_MS } = await load('mirrorRate.ts');

  const ACTIVE = 30;
  const IDLE = 10;
  const now = 1_000_000; // an arbitrary fixed instant — nothing here touches the real clock

  // --- no input yet ---------------------------------------------------------
  eq(
    selectMirrorFps(undefined, now, ACTIVE, IDLE, ACTIVE_WINDOW_MS),
    IDLE,
    'nothing has been forwarded yet — there is no "recent" to measure from, so idle'
  );

  // --- just inside the window ------------------------------------------------
  eq(
    selectMirrorFps(now - (ACTIVE_WINDOW_MS - 1), now, ACTIVE, IDLE, ACTIVE_WINDOW_MS),
    ACTIVE,
    'one millisecond inside the active window is still active'
  );

  // --- exactly at the boundary ------------------------------------------------
  eq(
    selectMirrorFps(now - ACTIVE_WINDOW_MS, now, ACTIVE, IDLE, ACTIVE_WINDOW_MS),
    ACTIVE,
    'exactly at the edge of the window is inclusive — still active, not the exclusive reading'
  );

  // --- just outside the window ------------------------------------------------
  eq(
    selectMirrorFps(now - (ACTIVE_WINDOW_MS + 1), now, ACTIVE, IDLE, ACTIVE_WINDOW_MS),
    IDLE,
    'one millisecond past the edge is idle'
  );

  // --- an input timestamp that is not in the past -----------------------------
  // Should never happen (lastInputAt is always Date.now() at the moment it was
  // recorded), but the function takes `now` as a bare parameter rather than
  // deriving it, so nothing stops a caller passing one — and "the window has
  // not even started yet" must not be misread as "expired".
  eq(
    selectMirrorFps(now + 500, now, ACTIVE, IDLE, ACTIVE_WINDOW_MS),
    ACTIVE,
    'an input timestamp ahead of `now` is still within the window, not treated as stale'
  );

  // --- the window itself is the ~2s this feature's design promises -----------
  eq(ACTIVE_WINDOW_MS, 2_000, 'the active window is about two seconds');

  // --- deriveIdleFps: a fixed third of the active rate, clamped 1..30 --------
  for (const [activeFps, idleFps, note] of [
    [30, 10, 'the default active rate: idle lands on 10, the fps this feature defaulted to entirely before typing into a mirror was a thing anyone did'],
    [15, 5, 'a mid active rate divides exactly'],
    [9, 3, 'another exact division'],
    [1, 1, 'rounding down toward zero is clamped up to the 1 fps floor — the active minimum has nowhere lower for idle to go either'],
  ]) {
    eq(deriveIdleFps(activeFps), idleFps, `deriveIdleFps(${activeFps}): ${note}`);
  }
}
