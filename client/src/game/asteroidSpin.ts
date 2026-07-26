import type { AsteroidSpinConfig, EntityId } from "@space-arena/shared";

export const DEFAULT_ASTEROID_SPIN: Readonly<AsteroidSpinConfig> = {
  minDegPerSec: 2,
  maxDegPerSec: 8,
};

export interface AsteroidSpin {
  axisX: number;
  axisY: number;
  axisZ: number;
  /** Signed radians per second; the sign supplies the rotation direction. */
  radiansPerSec: number;
}

export interface MutableQuaternion {
  x: number;
  y: number;
  z: number;
  w: number;
}

/** Small integer mixer: deterministic on every JS engine and cheap at creation time. */
function mix(value: number): number {
  value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
  value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
  return (value ^ (value >>> 16)) >>> 0;
}

function signedUnit(hash: number): number {
  return (hash / 0xffffffff) * 2 - 1;
}

/**
 * Derive a stable, well-distributed axis, pace, and direction from the sim id.
 * The configured range is interpreted in degrees/sec and defaults to 2..8.
 */
export function asteroidSpinFor(
  id: EntityId,
  configured: AsteroidSpinConfig | undefined,
): AsteroidSpin {
  const range = configured ?? DEFAULT_ASTEROID_SPIN;
  const seed = id | 0;
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
  const degreesPerSec =
    range.minDegPerSec + (range.maxDegPerSec - range.minDegPerSec) * paceUnit;
  const direction = (mix(seed ^ 0xa4093822) & 1) === 0 ? -1 : 1;
  return {
    axisX,
    axisY,
    axisZ,
    radiansPerSec: degreesPerSec * direction * (Math.PI / 180),
  };
}

/**
 * Append one axis-angle step to a quaternion in place. Inputs are normalized at
 * creation time; per-step normalization prevents long-run drift.
 */
export function advanceAsteroidSpin(
  quaternion: MutableQuaternion,
  spin: AsteroidSpin,
  dtSeconds: number,
): void {
  if (dtSeconds <= 0 || spin.radiansPerSec === 0) return;
  const halfAngle = spin.radiansPerSec * dtSeconds * 0.5;
  const sin = Math.sin(halfAngle);
  const rx = spin.axisX * sin;
  const ry = spin.axisY * sin;
  const rz = spin.axisZ * sin;
  const rw = Math.cos(halfAngle);
  const qx = quaternion.x;
  const qy = quaternion.y;
  const qz = quaternion.z;
  const qw = quaternion.w;
  quaternion.x = qw * rx + qx * rw + qy * rz - qz * ry;
  quaternion.y = qw * ry - qx * rz + qy * rw + qz * rx;
  quaternion.z = qw * rz + qx * ry - qy * rx + qz * rw;
  quaternion.w = qw * rw - qx * rx - qy * ry - qz * rz;
  const inverseLength = 1 / Math.hypot(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
  quaternion.x *= inverseLength;
  quaternion.y *= inverseLength;
  quaternion.z *= inverseLength;
  quaternion.w *= inverseLength;
}
