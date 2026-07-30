import { angleDeltaTo } from "./chaseCamera.js";

/**
 * BUBBLE.md §C — the view layer's orientation conventions, as pure math so they
 * are testable without a scene.
 *
 * **Since the 2026-07-30 flight-frame amendment, SHIPS are no longer posed from
 * these Euler helpers**: a hull's rotation quaternion is built from the
 * interpolated authoritative forward/up frame (`EntityView.syncShips`), with the
 * cosmetic bank tilting the up around the nose. The angle helpers below remain
 * for PROJECTILES/beams (whose wire state is a scalar heading or a direction)
 * and as the documented convention reference the quaternion path must agree
 * with in the roll-less case (`shipOrientation.test.ts` pins that equivalence).
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
 *     CONTROL; the authoritative frame can carry roll as the integrated
 *     consequence of body-frame steering, and the cosmetic bank rides on top.
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
 * Derived from the OBSERVED rotation rather than from stick input, so it reads
 * identically for the local player, a remote pilot and a bot — none of whose
 * inputs the view layer has. Since the flight-frame amendment the rate fed in
 * is the SIGNED BODY YAW between snapshots (`bodyYawDelta / dt`), which equals
 * the heading rate at level flight and stays bounded by the commanded yaw at
 * every attitude — the raw heading-coordinate rate is `ψ / cos p`, unbounded
 * near the poles, and used to saturate and flip the bank across vertical.
 * Saturates at `maxRad` once the turn reaches `referenceRateRadPerSec`, so a
 * ship with a huge `turnRate` leans hard but never past what the theme allows.
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
