/**
 * Deterministic math helpers used across the sim. No wall-clock, no Math.random —
 * pure arithmetic so every host produces identical results.
 *
 * The planar (x,z) helpers survive because the spatial-hash broadphase and the
 * minimap projection are still planar (BUBBLE.md §A); every narrowphase check
 * uses the 3D variants below.
 */

/** Local planar point alias (kept internal; schema `Vec2` is the exported one). */
interface Vec2 {
  x: number;
  z: number;
}

/** Local 3D point alias (schema `Vec3` is the exported one). */
interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export function len(x: number, z: number): number {
  return Math.sqrt(x * x + z * z);
}

export function len3(x: number, y: number, z: number): number {
  return Math.sqrt(x * x + y * y + z * z);
}

export function dist3(a: Vec3, b: Vec3): number {
  return len3(b.x - a.x, b.y - a.y, b.z - a.z);
}

export function distSq3(a: Vec3, b: Vec3): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  return dx * dx + dy * dy + dz * dz;
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
 * Elevation of the vector (x,y,z) above the arena plane, in (-PI/2, PI/2) — the
 * `pitch` a nose pointed along that vector carries.
 */
export function pitchOf(x: number, y: number, z: number): number {
  return Math.atan2(y, len(x, z));
}

/**
 * Unit facing vector for a yaw+pitch orientation (BUBBLE.md §A):
 * `(cos p cos h, sin p, cos p sin h)`. Writes into `out` — callers in the sim
 * hot loop reuse one scratch object rather than allocating per tick.
 */
export function facingVec(heading: number, pitch: number, out: Vec3): Vec3 {
  const cp = Math.cos(pitch);
  out.x = cp * Math.cos(heading);
  out.y = Math.sin(pitch);
  out.z = cp * Math.sin(heading);
  return out;
}

/**
 * Unsigned angle between two 3D vectors, in [0, PI]. Replaces the planar
 * `angleDelta` check wherever a cone is tested in the bubble. Zero-length input
 * has no meaningful bearing and answers 0 (i.e. "dead ahead"), matching the
 * co-located special case the planar code carried.
 */
export function angleBetween3(a: Vec3, b: Vec3): number {
  const la = len3(a.x, a.y, a.z);
  const lb = len3(b.x, b.y, b.z);
  if (la === 0 || lb === 0) return 0;
  const cos = (a.x * b.x + a.y * b.y + a.z * b.z) / (la * lb);
  return Math.acos(clamp(cos, -1, 1));
}

/**
 * Move `pitch` toward `target` by at most `maxStep` radians. Unlike
 * {@link turnToward} there is no wrap: pitch is a clamped ±PI/2-ish quantity, so
 * the short way round is always the direct difference.
 */
export function pitchToward(pitch: number, target: number, maxStep: number): number {
  const delta = target - pitch;
  if (Math.abs(delta) <= maxStep) return target;
  return pitch + Math.sign(delta) * maxStep;
}

/**
 * Shortest squared distance from point `p` to segment `a`-`b` in 3D. The swept
 * projectile hit test uses this so a shot can neither tunnel through a target nor
 * "hit" one that is only planar-aligned but far above or below the flight path.
 */
export function pointSegmentDistSq3(p: Vec3, a: Vec3, b: Vec3): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const abz = b.z - a.z;
  const apx = p.x - a.x;
  const apy = p.y - a.y;
  const apz = p.z - a.z;
  const abLenSq = abx * abx + aby * aby + abz * abz;
  let t = abLenSq > 0 ? (apx * abx + apy * aby + apz * abz) / abLenSq : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const dx = p.x - (a.x + abx * t);
  const dy = p.y - (a.y + aby * t);
  const dz = p.z - (a.z + abz * t);
  return dx * dx + dy * dy + dz * dz;
}

/** True if segment `a`-`b` passes within `radius` of sphere center `c`. */
export function segmentIntersectsSphere(a: Vec3, b: Vec3, c: Vec3, radius: number): boolean {
  return pointSegmentDistSq3(c, a, b) <= radius * radius;
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}
