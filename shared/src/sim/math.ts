/**
 * Deterministic planar (2.5D) math helpers used across the sim. No wall-clock,
 * no Math.random — pure arithmetic so every host produces identical results.
 */

/** Local planar point alias (kept internal; schema `Vec2` is the exported one). */
interface Vec2 {
  x: number;
  z: number;
}

export function len(x: number, z: number): number {
  return Math.sqrt(x * x + z * z);
}

export function dist(a: Vec2, b: Vec2): number {
  return len(b.x - a.x, b.z - a.z);
}

export function distSq(a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  return dx * dx + dz * dz;
}

/** Wrap an angle to (-PI, PI]. */
export function wrapAngle(a: number): number {
  let r = a % (Math.PI * 2);
  if (r <= -Math.PI) r += Math.PI * 2;
  else if (r > Math.PI) r -= Math.PI * 2;
  return r;
}

/** Smallest signed delta to rotate `from` toward `to`. */
export function angleDelta(from: number, to: number): number {
  return wrapAngle(to - from);
}

/** Rotate `heading` toward `target` by at most `maxStep` radians. */
export function turnToward(heading: number, target: number, maxStep: number): number {
  const delta = angleDelta(heading, target);
  if (Math.abs(delta) <= maxStep) return wrapAngle(target);
  return wrapAngle(heading + Math.sign(delta) * maxStep);
}

export function headingOf(x: number, z: number): number {
  return Math.atan2(z, x);
}

/**
 * Shortest distance from point `p` to segment `a`-`b`, and whether the closest
 * point falls within the segment. Used by segment-vs-circle LoS + sweeps.
 */
export function pointSegmentDistSq(p: Vec2, a: Vec2, b: Vec2): number {
  const abx = b.x - a.x;
  const abz = b.z - a.z;
  const apx = p.x - a.x;
  const apz = p.z - a.z;
  const abLenSq = abx * abx + abz * abz;
  let t = abLenSq > 0 ? (apx * abx + apz * abz) / abLenSq : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const cx = a.x + abx * t;
  const cz = a.z + abz * t;
  const dx = p.x - cx;
  const dz = p.z - cz;
  return dx * dx + dz * dz;
}

/** True if segment `a`-`b` passes within `radius` of circle center `c`. */
export function segmentIntersectsCircle(a: Vec2, b: Vec2, c: Vec2, radius: number): boolean {
  return pointSegmentDistSq(c, a, b) <= radius * radius;
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}
