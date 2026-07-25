/**
 * ROADMAP §10 5.8 — the pure part of the results screen's XP/credit count-up.
 *
 * Kept away from the DOM so the animation curve is unit-tested: the overlay
 * only advances an elapsed-ms accumulator and asks this module what number to
 * paint. Deliberately *not* time-based interpolation between frames — a value
 * is a pure function of elapsed time, so a dropped frame can never leave the
 * counter short of its target.
 */

/** Default sweep length for a reward count-up. */
export const COUNT_UP_DURATION_MS = 900;

/** Classic ease-out cubic on a 0..1 input; out-of-range inputs are clamped. */
export function easeOutCubic(t: number): number {
  if (!Number.isFinite(t) || t <= 0) return 0;
  if (t >= 1) return 1;
  const inv = 1 - t;
  return 1 - inv * inv * inv;
}

/**
 * The integer to display for `target` after `elapsedMs` of a `durationMs`
 * sweep. Guarantees:
 *  - exactly 0 at t = 0 (for a non-negative target),
 *  - exactly `target` once the sweep is over — including a zero/negative
 *    duration, which means "no animation",
 *  - monotonic, and never overshooting `target`.
 *
 * Negative targets (never produced today, but rewards are just numbers) sweep
 * downward with the same easing.
 */
export function countUpValue(target: number, elapsedMs: number, durationMs = COUNT_UP_DURATION_MS): number {
  if (!Number.isFinite(target)) return 0;
  if (!(durationMs > 0) || !Number.isFinite(elapsedMs) || elapsedMs >= durationMs) return Math.round(target);
  const eased = easeOutCubic(elapsedMs / durationMs);
  const value = target * eased;
  // Round toward zero so the counter can never briefly show more than it awards.
  const rounded = target >= 0 ? Math.floor(value) : Math.ceil(value);
  return rounded === 0 ? 0 : rounded; // normalise -0, which renders as "-0"
}

/** True once a sweep of `durationMs` has finished. */
export function countUpDone(elapsedMs: number, durationMs = COUNT_UP_DURATION_MS): boolean {
  return !(durationMs > 0) || elapsedMs >= durationMs;
}
