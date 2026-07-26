import { angleDeltaTo } from "./chaseCamera.js";

/**
 * BUBBLE.md §C — how a hull is POSED, as pure math so the three conventions the
 * view layer has to get right are testable without a scene.
 *
 * ## The three angles
 *
 *  1. **Yaw** — `π/2 − heading`, the mapping FLIGHT.md established: the models'
 *     nose axis is `+Z`, and a Babylon yaw of `a` sends `+Z` to
 *     `(sin a, 0, cos a)`, which at `a = π/2 − h` is the sim's `(cos h, 0, sin h)`.
 *  2. **Pitch** — `−pitch`. Babylon's `Matrix.RotationX(θ)` sends `+Z` to
 *     `(0, −sin θ, cos θ)` (row-vector convention, left-handed), so a POSITIVE
 *     x-rotation drops the nose. The sim's pitch is positive climbing, hence the
 *     negation ({@link meshPitchFor}).
 *  3. **Roll** — a purely visual bank, {@link bankRollFor}. The sim has no roll
 *     at all (BUBBLE.md's orientation model is yaw + pitch), so nothing here can
 *     change where a ship flies or what it can shoot.
 *
 * Babylon composes `node.rotation` as `RotationYawPitchRoll(y, x, z)`, i.e. roll
 * about the nose first, then pitch about the local right, then yaw about world
 * up — which is exactly the aircraft order this needs.
 */

/** Babylon yaw for a sim heading (nose axis `+Z`). */
export function meshYawFor(heading: number): number {
  return Math.PI / 2 - heading;
}

/** Babylon x-rotation for a sim pitch (positive pitch climbs, positive x-rotation dives). */
export function meshPitchFor(pitch: number): number {
  return -pitch;
}

/**
 * Signed turn rate (rad/s) between two snapshots of one ship's heading, taking
 * the short way round so a wrap past ±π reads as a small turn instead of a
 * violent one. `dtSec <= 0` (the same snapshot twice, a paused sim) reports 0 —
 * callers that would rather hold the last bank check `dtSec` themselves.
 */
export function headingRatePerSec(prevHeading: number, curHeading: number, dtSec: number): number {
  if (dtSec <= 0) return 0;
  return angleDeltaTo(prevHeading, curHeading) / dtSec;
}

/**
 * Visual bank angle for a ship turning at `ratePerSec` (radians of roll).
 *
 * Derived from the OBSERVED heading delta rather than from stick input, so it
 * reads identically for the local player, a remote pilot and a bot — none of
 * whose inputs the view layer has. Saturates at `maxRad` once the turn reaches
 * `referenceRateRadPerSec`, so a ship with a huge `turnRate` leans hard but
 * never past what the theme allows.
 *
 * The SIGN: heading grows counter-clockwise, which under the chase rig sweeps the
 * nose toward screen LEFT (see `chaseCamera.ts`). A Babylon z-rotation sends the
 * right wing `+X` to `(cos θ, sin θ, 0)`, so a POSITIVE roll lifts the right wing
 * — a left bank. Positive heading rate ⇒ positive roll therefore leans the hull
 * into the turn it is actually flying.
 */
export function bankRollFor(ratePerSec: number, maxRad: number, referenceRateRadPerSec: number): number {
  if (!(maxRad > 0) || !(referenceRateRadPerSec > 0)) return 0;
  const t = ratePerSec / referenceRateRadPerSec;
  const clamped = t > 1 ? 1 : t < -1 ? -1 : t;
  return maxRad * clamped;
}

/**
 * Frame-rate-independent exponential approach of the drawn roll toward the bank
 * the current turn rate asks for. Same `1 − (1 − lag)^(dt·60)` curve the camera
 * follow and `chaseCamera.approachPitch` use; roll does not wrap (it is bounded
 * by `maxRad`), so this is a plain linear approach. `lag >= 1` snaps.
 */
export function approachRoll(current: number, target: number, lag: number, dtSec: number): number {
  if (lag >= 1 || dtSec <= 0) return target;
  if (lag <= 0) return current;
  const t = 1 - Math.pow(1 - lag, dtSec * 60);
  return current + (target - current) * t;
}

/**
 * Babylon yaw for a 3D velocity/facing vector — how a projectile is oriented
 * (BUBBLE.md §C). Its heading is replicated, but a homing missile's real motion
 * has a vertical component that no scalar heading carries, so the view derives
 * both angles from the interpolated displacement instead.
 */
export function yawForDirection(dx: number, dz: number): number {
  return Math.atan2(dx, dz);
}

/**
 * Babylon x-rotation for a 3D direction: the nose rises with `dy`, so the
 * x-rotation is the negated elevation angle (same sign story as
 * {@link meshPitchFor}). A zero-length direction reports level rather than NaN.
 */
export function pitchForDirection(dx: number, dy: number, dz: number): number {
  const horizontal = Math.hypot(dx, dz);
  if (horizontal === 0 && dy === 0) return 0;
  return -Math.atan2(dy, horizontal);
}
