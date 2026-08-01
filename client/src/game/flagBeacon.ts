/**
 * Flag-base beacon maths (owner 2026-08-01).
 *
 * A CTF base is a point in empty space: without a marker, players fly past the
 * place they are supposed to deliver to. The renderer answers that with a
 * shiny translucent shell standing on the base — so this module owns the two
 * numbers that shell needs, kept pure and away from Babylon so they can be
 * tested without a scene.
 *
 * The pulse is deliberately TIME-DERIVED rather than integrated per frame:
 * every frame recomputes scale/alpha from a clock, so a hitch, a slow frame or
 * a paused tab can never leave a beacon permanently the wrong size.
 */

/** Shell radius used when content authored no capture radius (base radius 0). */
export const BEACON_DEFAULT_RADIUS = 10;
/** Below this a beacon is smaller than the flag marker inside it — unreadable. */
export const BEACON_MIN_RADIUS = 6;
/** Above this the shell swallows a meaningful slice of the arena. */
export const BEACON_MAX_RADIUS = 60;

/** One full breath, in ms. Slow on purpose: this is "live tech", not a strobe. */
export const BEACON_PULSE_MS = 3400;
/** Peak scale deviation, ±. Small — the base must not appear to move. */
export const BEACON_SCALE_SWING = 0.045;
/** Mid-breath opacity. Low enough to fight inside the shell and still see. */
export const BEACON_ALPHA = 0.28;
/** Peak opacity deviation, ±. */
export const BEACON_ALPHA_SWING = 0.06;

const TAU = Math.PI * 2;

/**
 * The shell radius for an authored `baseRadius`. A base that authored no radius
 * (or a garbage one) still gets a beacon, because an invisible objective is a
 * worse bug than a slightly wrong-sized one.
 */
export function beaconRadius(baseRadius: number): number {
  if (!Number.isFinite(baseRadius) || baseRadius <= 0) return BEACON_DEFAULT_RADIUS;
  return Math.min(BEACON_MAX_RADIUS, Math.max(BEACON_MIN_RADIUS, baseRadius));
}

/**
 * A stable per-beacon offset in `[0, 1)` of a breath, derived from the flag's
 * entity id. Two bases pulsing in perfect lockstep read as a UI overlay; offset
 * ones read as two independent installations.
 */
export function beaconPhase(id: number): number {
  if (!Number.isFinite(id)) return 0;
  const frac = (Math.abs(id) * 0.6180339887498949) % 1;
  return frac;
}

/** Scale multiplier and opacity for a beacon at `elapsedMs` on the beacon clock. */
export function beaconPulse(elapsedMs: number, phase = 0): { scale: number; alpha: number } {
  const t = Number.isFinite(elapsedMs) ? elapsedMs : 0;
  const wave = Math.sin(TAU * (t / BEACON_PULSE_MS + (Number.isFinite(phase) ? phase : 0)));
  return {
    scale: 1 + BEACON_SCALE_SWING * wave,
    alpha: BEACON_ALPHA + BEACON_ALPHA_SWING * wave,
  };
}

/**
 * Advance the shared beacon clock, wrapped to one breath. Wrapping keeps the
 * value small forever, so `sin` never loses precision in a long match.
 */
export function advanceBeaconClock(clockMs: number, frameDtMs: number): number {
  const dt = Number.isFinite(frameDtMs) ? frameDtMs : 0;
  const next = (Number.isFinite(clockMs) ? clockMs : 0) + dt;
  const wrapped = next % BEACON_PULSE_MS;
  return wrapped < 0 ? wrapped + BEACON_PULSE_MS : wrapped;
}
