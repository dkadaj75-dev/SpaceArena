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

const HALF_PI = Math.PI / 2;

/** A yaw+pitch orientation. Mutated in place by the helpers below (no per-tick alloc). */
export interface Attitude {
  heading: number;
  pitch: number;
}

/**
 * The OTHER (heading, pitch) pair that names the same facing direction
 * (BUBBLE.md §A, free-pitch loops).
 *
 * `facingVec` is `(cos p·cos h, sin p, cos p·sin h)`, and that map is two-to-one:
 * `(h + PI, PI − p)` produces exactly the same vector, because `cos(PI − p) =
 * −cos p` cancels against the `cos(h + PI) = −cos h` in both horizontal terms
 * while `sin(PI − p) = sin p` leaves the vertical one alone. Applying this twice
 * returns the original pair, so it is an involution: there are exactly two names
 * for every attitude and this swaps between them.
 *
 * Once pitch is free to run the whole circle, both names are reachable states,
 * and code that has to CHOOSE one — a boundary reflection, a bot's desired
 * attitude, the chase camera's orbit — must choose the one that is continuous
 * with where the ship already is, or the ship teleports between two spellings of
 * the same nose direction. That choice is {@link attitudeNear}.
 */
export function mirrorAttitude(heading: number, pitch: number, out: Attitude): Attitude {
  const p = wrapAngle(pitch);
  out.heading = wrapAngle(heading + Math.PI);
  out.pitch = p >= 0 ? Math.PI - p : -Math.PI - p;
  return out;
}

/**
 * The same facing direction with its pitch folded into [-PI/2, PI/2] — the
 * "upright" spelling, where `cos pitch >= 0` and the heading really is the
 * direction the nose travels horizontally.
 *
 * This is what the view layer wants: a canonical elevation is continuous through
 * a loop (it rises to PI/2, then falls back), while the canonical heading flips
 * by PI at the pole, which is the honest statement that a ship that has just gone
 * over the top is now flying the other way.
 */
export function canonicalAttitude(heading: number, pitch: number, out: Attitude): Attitude {
  const p = wrapAngle(pitch);
  if (p > HALF_PI || p < -HALF_PI) return mirrorAttitude(heading, p, out);
  out.heading = wrapAngle(heading);
  out.pitch = p;
  return out;
}

/**
 * Whichever of the two names for this facing direction sits the SHORT way from
 * `refPitch` — the continuity rule for every consumer that replaces one attitude
 * with another (boundary reflection, bot aim, prediction).
 *
 * Ties go to the canonical spelling so the choice is deterministic. While the
 * reference attitude is upright this always answers the canonical pair, which is
 * why authoring the legacy `maxPitchRad` clamp keeps behaviour bit-identical to
 * the pre-loop sim: a clamped hull can never be inverted, so the mirror can never
 * win.
 */
export function attitudeNear(heading: number, pitch: number, refPitch: number, out: Attitude): Attitude {
  const p = wrapAngle(pitch);
  const canonPitch = p > HALF_PI || p < -HALF_PI ? (p >= 0 ? Math.PI - p : -Math.PI - p) : p;
  const canonHeading = p > HALF_PI || p < -HALF_PI ? wrapAngle(heading + Math.PI) : wrapAngle(heading);
  const mirrorPitch = canonPitch >= 0 ? Math.PI - canonPitch : -Math.PI - canonPitch;
  if (Math.abs(angleDelta(refPitch, mirrorPitch)) < Math.abs(angleDelta(refPitch, canonPitch))) {
    out.heading = wrapAngle(canonHeading + Math.PI);
    out.pitch = mirrorPitch;
    return out;
  }
  out.heading = canonHeading;
  out.pitch = canonPitch;
  return out;
}

/**
 * One tick of the pitch axis (BUBBLE.md §A as amended for free-pitch loops).
 *
 * `maxPitchRad` is the OPTIONAL legacy clamp: authored, the nose stops there and
 * the pre-loop behaviour is reproduced exactly; absent (`null`, the shipped
 * default), pitch simply WRAPS to (-PI, PI] and the ship flies a full loop —
 * `facingVec` stays valid for any pitch, and past vertical `cos pitch` goes
 * negative, which flips the horizontal component of the nose. That flip IS the
 * loop: heading is untouched, so holding the stick up carries the ship over the
 * top and back, exactly the way holding it left yaws forever.
 *
 * Both integrators (NavigationSystem and `flightStep`) call THIS, so the sim and
 * the client predictor cannot drift apart at the wrap.
 */
export function advancePitch(pitch: number, delta: number, maxPitchRad: number | null): number {
  const next = pitch + delta;
  return maxPitchRad === null ? wrapAngle(next) : clamp(next, -maxPitchRad, maxPitchRad);
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

/**
 * One tick of the ATTITUDE — both axes, in the ship's own frame (BUBBLE.md §A,
 * body-frame yaw amendment).
 *
 * `turn` used to be a plain `heading += delta` about world Y. That is wrong for a
 * flier that can invert, and not just by a sign: the chase rig is locked to the
 * nose, so a world-Y yaw shows up on screen as a *mixture* of turning (∝ cos p)
 * and rolling the whole view (∝ sin p). Near vertical the roll is the entire
 * visual and the turn has vanished, and no choice of sign can make both components
 * read consistently — flipping the one that fixes turning reverses the one the
 * player is actually looking at. See `client/src/game/screenSteering.test.ts`.
 *
 * So yaw rotates the nose about the ship's OWN up `U` instead:
 *
 *     N = (cos p·cos h, sin p, cos p·sin h)     the nose
 *     U = (−cos h·sin p, cos p, −sin h·sin p)   the ship's up (the chase rig's up)
 *     W = N × U = (−sin h, 0, cos h)            the ship's right-hand axis
 *
 * `U ⊥ N`, so Rodrigues collapses to `N' = N·cos ψ + W·sin ψ`, and `dN/dψ = W`
 * with `|W| = 1` at EVERY attitude: constant authority, the same screen direction
 * upright or inverted, no dead zone at vertical, and zero parasitic roll (rotating
 * about `U` leaves `U` fixed). At `p = 0`, `U` is world Y and this reduces to
 * `h += ψ` exactly — level flight is bit-identical to the old model, which is the
 * strongest safety property this change has.
 *
 * The pitch axis is unchanged: it already rotated the nose about `W`, the ship's
 * own right-hand axis, which is what a body-frame pitch is.
 *
 * Decomposing `N'` back into (heading, pitch) is two-to-one, so the spelling is
 * chosen by continuity with the attitude we came from ({@link attitudeNear}) —
 * an inverted ship stays inverted through a turn instead of snapping upright.
 *
 * `yawDelta === 0` returns the attitude untouched. That is an exact test, not an
 * epsilon: it exists because a ship sitting precisely at the pole has no
 * horizontal component to read a heading from, and with no yaw commanded there is
 * nothing to recompute anyway.
 *
 * Both integrators — `flightStep` and `NavigationSystem` — call THIS, so the sim
 * and the client predictor cannot drift apart.
 */
export function advanceAttitude(
  heading: number,
  pitch: number,
  yawDelta: number,
  pitchDelta: number,
  maxPitchRad: number | null,
  out: Attitude,
): Attitude {
  let h = heading;
  let p = pitch;
  if (yawDelta !== 0) {
    const cp = Math.cos(p);
    const sp = Math.sin(p);
    const ch = Math.cos(h);
    const sh = Math.sin(h);
    const cy = Math.cos(yawDelta);
    const sy = Math.sin(yawDelta);
    // N' = N·cos ψ + W·sin ψ, with W = (−sin h, 0, cos h).
    const nx = cp * ch * cy - sh * sy;
    const ny = sp * cy;
    const nz = cp * sh * cy + ch * sy;
    attitudeNear(headingOf(nx, nz), pitchOf(nx, ny, nz), p, out);
    h = out.heading;
    p = out.pitch;
  }
  out.heading = wrapAngle(h);
  out.pitch = advancePitch(p, pitchDelta, maxPitchRad);
  return out;
}
