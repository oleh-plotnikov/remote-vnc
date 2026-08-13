import { clampFps } from './recording';

/**
 * Which frame rate a mirror should stream at, given how recently the webview
 * forwarded a real input event (mouse, key or wheel — see the final branch of
 * `handleMirrorMessage` in src/pagePanel.ts, the only caller that counts as
 * "input" for this purpose).
 *
 * One fixed rate cannot serve both things a mirror is for, measured on one
 * machine, one page: 30 fps keeps typing feeling immediate but costs CPU
 * whether or not anyone is looking; 10 fps is fine for watching but puts a
 * visible 100ms+ gap between a keystroke and its result, which reads as the
 * page glitching or hanging. So the rate follows activity instead of picking
 * one purpose over the other — ACTIVE for a short window after the last
 * input, IDLE once that window has passed.
 *
 * Pure and free of `vscode`/the DOM on purpose, so test/mirrorRate.test.mjs
 * (via test/bundle.mjs) can load it directly: it runs on every input event
 * and every idle-transition timer tick, and the boundary of the active
 * window is exactly the kind of thing that needs pinning at an exact
 * millisecond rather than raced against a real clock. `now` is a parameter
 * for the same reason — nothing in here calls `Date.now()`.
 */
export function selectMirrorFps(
  lastInputAt: number | undefined,
  now: number,
  activeFps: number,
  idleFps: number,
  activeWindowMs: number
): number {
  if (lastInputAt === undefined) {
    return idleFps; // nothing forwarded yet — there is no "recent" to measure from
  }
  // Inclusive: input landing exactly on the edge of the window still counts
  // as active. The alternative (exclusive) would flip a keystroke that lands
  // precisely on the boundary to idle for one tick — a worse failure than the
  // reverse, which is a frame or two of "still active" that costs nothing.
  return now - lastInputAt <= activeWindowMs ? activeFps : idleFps;
}

/**
 * How long after the last input the mirror stays on the active rate. About
 * two seconds: long enough that the pause between keystrokes in ordinary
 * typing does not visibly drop the rate mid-sentence, short enough that
 * genuinely idle time (reading, looking away) falls back to IDLE quickly
 * rather than paying the active rate's CPU for a tab nobody is touching.
 */
export const ACTIVE_WINDOW_MS = 2_000;

/**
 * The idle rate, derived from the active one rather than given its own
 * setting. Idle time has none of the failure mode that made the active rate
 * need tuning at all — nobody has reported a WATCHED mirror feeling too
 * slow — so a second dial for a number nobody has asked to independently
 * tune yet is complexity the feature has not earned.
 *
 * A third of the active rate, clamped through the same 1..30 range
 * `clampFps` already enforces for `remoteVnc.mirrorFrameRate` (so idle can
 * never land outside what the mirror already promises to support). At the
 * default active rate of 30 this lands on 10 — the fps this whole feature
 * defaulted to before typing into a mirror was a thing anyone did, so a page
 * that is only ever watched, never touched, streams exactly as before.
 */
export function deriveIdleFps(activeFps: number): number {
  return clampFps(Math.round(activeFps / 3));
}
