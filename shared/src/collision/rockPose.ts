import type { AsteroidSpinConfig } from "../schemas/asteroid.js";
import type { RockQuat } from "./rockShape.js";

/**
 * ROCK POSE — where a rock is FACING, as a closed form of match time.
 *
 * Asteroids tumble. That used to be a purely cosmetic integration living in the
 * client (`client/src/game/asteroidSpin.ts`), which was fine while the sim
 * collided a sphere: a sphere has no orientation to disagree about. A rock with
 * a real shape does, and a 4 deg/s tumble decorrelates a static collision hull
 * from its mesh within a minute — so the pose has to be something both sides
 * compute, from the same inputs, without replicating a quaternion per rock.
 *
 * Hence a CLOSED FORM rather than an integration: pose is a pure function of
 *
 *   (placement index, authored spin range, authored base rotation, match time)
 *
 * The placement index — not the entity id — is the identity, because it is the
 * one handle both sides genuinely share: the offline sim allocates entity ids,
 * while an online client rebuilds the rock list straight from
 * `arena.asteroidPlacements`. Match time is the sim's own `elapsed`, which the
 * wire already carries as `matchTimer`.
 *
 * The two clocks are not sampled at the same instant (a client renders between
 * server snapshots), so the poses differ by at most one snapshot interval of
 * tumble — a few hundredths of a degree at the authored rates. That is far
 * below the surface detail either side can resolve.
 */

/** Axis-angle tumble: a unit axis and a SIGNED rate (the sign is the direction). */
export interface RockSpin {
  axisX: number;
  axisY: number;
  axisZ: number;
  radiansPerSec: number;
}

/** Fallback tumble for a rock whose config authors no `render.spin`. */
export const DEFAULT_ROCK_SPIN: Readonly<AsteroidSpinConfig> = {
  minDegPerSec: 2,
  maxDegPerSec: 8,
};

/** Small integer mixer: deterministic on every JS engine and cheap at creation time. */
function mix(value: number): number {
  let v = value | 0;
  v = Math.imul(v ^ (v >>> 16), 0x7feb352d);
  v = Math.imul(v ^ (v >>> 15), 0x846ca68b);
  return (v ^ (v >>> 16)) >>> 0;
}

function signedUnit(hash: number): number {
  return (hash / 0xffffffff) * 2 - 1;
}

/**
 * Derive a stable, well-distributed axis, pace and direction from a rock's
 * placement index. The configured range is in degrees/sec and defaults to 2..8.
 */
export function rockSpinFor(index: number, configured: AsteroidSpinConfig | undefined): RockSpin {
  const range = configured ?? DEFAULT_ROCK_SPIN;
  const seed = index | 0;
  let axisX = signedUnit(mix(seed ^ 0x243f6a88));
  let axisY = signedUnit(mix(seed ^ 0x85a308d3));
  let axisZ = signedUnit(mix(seed ^ 0x13198a2e));
  const length = Math.hypot(axisX, axisY, axisZ);
  if (length <= 1e-8) {
    axisX = 0;
    axisY = 1;
    axisZ = 0;
  } else {
    axisX /= length;
    axisY /= length;
    axisZ /= length;
  }
  const paceUnit = mix(seed ^ 0x9e3779b9) / 0xffffffff;
  const degreesPerSec = range.minDegPerSec + (range.maxDegPerSec - range.minDegPerSec) * paceUnit;
  const direction = (mix(seed ^ 0xa4093822) & 1) === 0 ? -1 : 1;
  return {
    axisX,
    axisY,
    axisZ,
    radiansPerSec: degreesPerSec * direction * (Math.PI / 180),
  };
}

/**
 * World orientation of a rock at match time `seconds`, written into `out`.
 *
 * The authored placement `rotation` is applied first (as a yaw), then the
 * tumble — so an author who poses a rock keeps that pose as the thing that
 * tumbles, rather than having it overwritten.
 */
export function rockOrientationAt(
  spin: RockSpin,
  baseRotationY: number,
  seconds: number,
  out: RockQuat,
): void {
  const halfYaw = baseRotationY * 0.5;
  const bx = 0;
  const by = Math.sin(halfYaw);
  const bz = 0;
  const bw = Math.cos(halfYaw);

  const halfAngle = spin.radiansPerSec * seconds * 0.5;
  const sin = Math.sin(halfAngle);
  const sx = spin.axisX * sin;
  const sy = spin.axisY * sin;
  const sz = spin.axisZ * sin;
  const sw = Math.cos(halfAngle);

  // out = spin ⊗ base
  out.x = sw * bx + sx * bw + sy * bz - sz * by;
  out.y = sw * by - sx * bz + sy * bw + sz * bx;
  out.z = sw * bz + sx * by - sy * bx + sz * bw;
  out.w = sw * bw - sx * bx - sy * by - sz * bz;
}
