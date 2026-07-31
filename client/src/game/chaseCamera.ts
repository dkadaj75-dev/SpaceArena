import type { CameraConfig } from "@space-arena/shared";

/**
 * FLIGHT.md §3 — the chase rig as pure math, so the derivation below is
 * testable without an engine, a canvas or a scene.
 *
 * ## Sign conventions (the whole point of this file)
 *
 * Three conventions have to agree, and getting any one of them backwards
 * silently inverts the controls:
 *
 *  1. **Sim heading**: `0` faces `+X`, and it grows counter-clockwise in the
 *     (x, z) plane — velocity is `(cos h, sin h)`, so heading `π/2` faces `+Z`
 *     (`shared/src/sim/steering.ts`). `turn > 0` increases heading.
 *  2. **Model yaw**: Babylon yaw `= π/2 − heading`, because the hulls' nose axis
 *     is `+Z` (`EntityView.ts`). A yaw of `a` sends `+Z` to `(sin a, 0, cos a)`,
 *     which at `a = π/2 − h` is exactly `(cos h, 0, sin h)` — the sim heading.
 *  3. **ArcRotateCamera orbit**: position `= target + R·(cos α·sin β, cos β,
 *     sin α·sin β)`. To sit BEHIND the ship the camera offset must point along
 *     `−heading`, i.e. `(cos α, sin α) = (−cos h, −sin h)` ⇒ **α = h + π**
 *     ({@link chaseAlphaFor}).
 *
 * ## Which way is "screen right"?
 *
 * Babylon's `LookAtLH` builds its screen-right axis as `cross(up, forward)`.
 * With `F = (cos h, 0, sin h)` the chase rig's forward is
 * `d = F·sin β − Y·cos β` and its up is `u = F·cos β + Y·sin β`, so
 * `right = u × d = Y × F = (sin h, 0, −cos h)` — the `sin β/cos β` terms cancel,
 * which means the answer does not depend on the camera's tilt at all.
 *
 * The nose swings with heading at `dF/dh = (−sin h, 0, cos h) = −right`.
 * **Increasing heading therefore moves the nose toward screen LEFT**, so a
 * stick pushed right must send a NEGATIVE turn — see
 * {@link TURN_SIGN_FOR_SCREEN_RIGHT} and `flightInput.ts`. (Cross-check with the
 * old top-down rig: at `alpha = −π/2` the view has `+X` right and `+Z` up-screen,
 * and heading `0 → π/2` walks right → up, i.e. counter-clockwise = left turn.)
 */

/** The camera config's `chase` block, fully defaulted. */
export interface ChaseSettings {
  radius: number;
  /**
   * Multiplier on `radius` while the viewport is landscape (1 = same as
   * portrait). The shipped pack pulls the wide-screen default in to 0.7×; the
   * player's camera-distance setting multiplies on top of this baseline.
   */
  landscapeRadiusScale: number;
  height: number;
  /** BASE tilt — the tilt seen while flying LEVEL; the ship's pitch is added to it. */
  beta: number;
  yawLag: number;
  /** Tilt smoothing, 0..1 like `yawLag`. */
  pitchLag: number;
  /**
   * Vertical FOV in radians, or **null to keep the engine default** — an absent
   * `fov` is a genuine "don't touch it", not a substituted number. The rig
   * restores its captured engine default when this is null, including on a
   * hot-reload that deletes the key.
   */
  fov: number | null;
}

/**
 * Built-in chase feel, used when a content pack ships no `camera.chase` block.
 * Deliberately the same numbers as `content/camera/default.json`, with two
 * documented exceptions:
 *
 *  - `fov` is null here for the same reason it is optional in the schema: there
 *    is no defensible FOV to invent for a pack that never asked for one.
 *
 * `pitchLag` has no built-in of its own: an omitted value resolves to `yawLag`,
 * which keeps both axes matched for a pack that never asked for a pitch feel.
 */
export const DEFAULT_CHASE_SETTINGS: ChaseSettings = {
  radius: 12,
  landscapeRadiusScale: 1,
  height: 1.4,
  beta: 1.34,
  yawLag: 0.12,
  pitchLag: 0.12,
  fov: null,
};

/** Resolve `camera.chase` against the built-in defaults. */
export function chaseSettingsOf(camera: CameraConfig | undefined): ChaseSettings {
  const c = camera?.chase;
  const d = DEFAULT_CHASE_SETTINGS;
  const yawLag = c?.yawLag ?? d.yawLag;
  return {
    radius: c?.radius ?? d.radius,
    landscapeRadiusScale: c?.landscapeRadiusScale ?? d.landscapeRadiusScale,
    height: c?.height ?? d.height,
    beta: c?.beta ?? d.beta,
    yawLag,
    // Omitted ⇒ the tilt smooths exactly like the yaw does.
    pitchLag: c?.pitchLag ?? yawLag,
    fov: c?.fov ?? d.fov, // both null-by-default: absent everywhere ⇒ engine default
  };
}

/**
 * Orbit `alpha` that parks the camera directly behind a ship flying at `heading`
 * (see the derivation above). Not wrapped: `ArcRotateCamera` is happy with any
 * real alpha, and the smoothing in {@link approachHeading} is what keeps the
 * value continuous.
 *
 * Feed this the ship's RAW heading. It never needs folding: the rolled rig
 * ({@link chaseUpFor}) rotates the whole camera frame into the loop plane, so the
 * azimuth stays put for the entire loop and the camera never has to swing round
 * to the far side of the ship.
 */
export function chaseAlphaFor(heading: number): number {
  return heading + Math.PI;
}

/**
 * How the rig follows a ship through a LOOP (BUBBLE.md §A) — **the camera rolls
 * with the ship**, and since the flight-frame handoff the up it rolls with is
 * the SHIP'S REPLICATED up axis, not one reconstructed from heading/pitch.
 *
 * The first cut at this kept the world-up orbit and folded an inverted attitude
 * into its upright spelling. The owner flew it and reported being "bumped in the
 * other direction" on reaching vertical, and they were right: a world-up chase rig
 * simply cannot represent an inverted attitude — the flip is topological, not a
 * tuning problem. So the rig rolls: `upVector` is the ship's own up, the horizon
 * rotates smoothly around the player, and "drag up" moves the nose toward the top
 * of the screen at every point of the loop.
 *
 * The second cut derived that up from heading/pitch, which is exactly the lossy
 * reconstruction the flight-frame handoff retired: near vertical the derived
 * frame spins even though the hull does not. The rig now consumes the
 * authoritative nose + up directly ({@link chaseOffsetForFrame}); nothing in
 * this module reconstructs a frame from the two Euler coordinates any more.
 */

/**
 * Where the camera sits relative to the ship, in WORLD space, given the ship's
 * authoritative frame: the orbit vector at the authored base tilt, expressed in
 * the ship's own (nose, up) plane —
 *
 *     offset = radius · (up·cos(baseBeta) − nose·sin(baseBeta))
 *
 * At level flight this is the plain orbit formula at `alpha = h + π`,
 * `beta = baseBeta` (behind the ship, tilted down by the authored base), and
 * through a loop it follows the frame continuously with NO fold and NO pole
 * clamp — the camera stays behind and above the hull the ship actually has,
 * inverted included.
 */
export function chaseOffsetForFrame(
  nose: Vec3,
  up: Vec3,
  baseBeta: number,
  radius: number,
  out: Vec3,
): Vec3 {
  const c = Math.cos(baseBeta) * radius;
  const s = Math.sin(baseBeta) * radius;
  out.x = up.x * c - nose.x * s;
  out.y = up.y * c - nose.y * s;
  out.z = up.z * c - nose.z * s;
  return out;
}

/**
 * Frame-rate-independent exponential approach of a smoothed unit DIRECTION
 * toward a target one — the frame smoother that replaced the per-coordinate
 * heading/pitch smoothers (the coordinates are not independent axes of the real
 * rotation, and near the poles smoothing them separately swept the rig through
 * rotations the ship never made). Nlerp with the same `1 − (1 − lag)^(dt·60)`
 * curve as every other follow in this file, renormalized; a degenerate blend
 * (antipodal directions) snaps to the target, which is deterministic and can
 * only arise from a teleport-scale correction. `lag >= 1` snaps; `lag <= 0`
 * holds. Mutates `current` in place.
 */
export function approachDirection(current: Vec3, target: Vec3, lag: number, dt: number): Vec3 {
  if (lag >= 1 || dt <= 0) {
    current.x = target.x;
    current.y = target.y;
    current.z = target.z;
    return current;
  }
  if (lag <= 0) return current;
  const t = 1 - Math.pow(1 - lag, dt * 60);
  const x = current.x + (target.x - current.x) * t;
  const y = current.y + (target.y - current.y) * t;
  const z = current.z + (target.z - current.z) * t;
  const lenSq = x * x + y * y + z * z;
  if (!(lenSq > 1e-12)) {
    current.x = target.x;
    current.y = target.y;
    current.z = target.z;
    return current;
  }
  const inv = 1 / Math.sqrt(lenSq);
  current.x = x * inv;
  current.y = y * inv;
  current.z = z * inv;
  return current;
}

/** A 3D point the rig math writes into (kept local so this module stays engine-free). */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Frame-rate-independent exponential approach on the rig's tilt. Same
 * `1 − (1 − lag)^(dt·60)` curve as {@link approachHeading}, and it takes the same
 * shortest way round.
 *
 * It did not always: while pitch was clamped this deliberately omitted the wrap
 * step, on the grounds that "treating −0.5 and +6.0 as neighbours would be a bug".
 * Free pitch makes them genuinely adjacent — a looping ship crosses ±π every
 * revolution — and the input here is the CANONICAL elevation, which is bounded by
 * ±π/2 and therefore never more than π from anything. `lag >= 1` snaps.
 */
export function approachPitch(current: number, target: number, lag: number, dt: number): number {
  if (lag >= 1 || dt <= 0) return target;
  if (lag <= 0) return current;
  const t = 1 - Math.pow(1 - lag, dt * 60);
  return current + angleDeltaTo(current, target) * t;
}

/**
 * Sign a screen-right stick deflection must carry as a sim `turn`.
 *
 * Derived, not chosen: heading grows counter-clockwise on screen under this rig,
 * so screen-right is the NEGATIVE heading direction. If the sim's heading
 * convention or the yaw mapping ever flips, this constant (and the test that
 * pins it) is the one place to change.
 */
export const TURN_SIGN_FOR_SCREEN_RIGHT = -1;

/** Shortest signed delta from `from` to `to`, in (−π, π]. */
export function angleDeltaTo(from: number, to: number): number {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d <= -Math.PI) d += Math.PI * 2;
  return d;
}

/**
 * Frame-rate-independent exponential approach of a smoothed heading toward the
 * ship's real heading — the same `1 − (1 − lag)^(dt·60)` curve the positional
 * follow uses, but taking the SHORT way around so a wrap past ±π never spins
 * the camera the long way. `lag >= 1` snaps.
 */
export function approachHeading(current: number, target: number, lag: number, dt: number): number {
  if (lag >= 1 || dt <= 0) return target;
  if (lag <= 0) return current;
  const t = 1 - Math.pow(1 - lag, dt * 60);
  return current + angleDeltaTo(current, target) * t;
}
