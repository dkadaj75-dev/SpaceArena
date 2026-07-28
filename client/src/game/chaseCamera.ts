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
  radius: 14,
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
 * with the ship**.
 *
 * The first cut at this kept the world-up orbit and folded an inverted attitude
 * into its upright spelling. The owner flew it and reported being "bumped in the
 * other direction" on reaching vertical, and they were right: a world-up chase rig
 * simply cannot represent an inverted attitude. Staying behind the nose past the
 * pole demands a π flip of the orbit azimuth, and with the camera's up pinned to
 * world +Y that flip inverts the whole image in a single frame. The ship's
 * horizontal travel genuinely reverses at the same instant (`cos p` changes sign),
 * so the two together read as a hard kick backwards. No amount of tapering or
 * smoothing fixes it — it is topological, not a tuning problem.
 *
 * So the rig rolls instead. `upVector` is the SHIP's own up, which sweeps
 * continuously around the loop plane, and in that frame the ship is permanently
 * level: the camera sits behind and slightly above the nose at a constant tilt,
 * the horizon rotates smoothly around the player, and "drag up" moves the nose
 * toward the top of the screen at every point of the loop. That is the arcade
 * answer, and it is the only one that keeps the input's meaning stable.
 *
 * `up` is perpendicular to the nose by construction (`up · facing = 0` for every
 * pitch) and is continuous across the ±π wrap, where it passes cleanly through
 * `(0, −1, 0)`.
 */
export function chaseUpFor(heading: number, pitch: number, out: Vec3): Vec3 {
  const sp = Math.sin(pitch);
  out.x = -Math.cos(heading) * sp;
  out.y = Math.cos(pitch);
  out.z = -Math.sin(heading) * sp;
  return out;
}

/**
 * Where the camera sits relative to the ship, in WORLD space.
 *
 * Derivation: take the level chase offset (the orbit vector at `alpha = h + π`,
 * `beta = baseBeta`) and rotate the whole rig into the loop plane, i.e. by the
 * ship's pitch about the horizontal axis `w = (−sin h, 0, cos h)` that the loop
 * turns around. Rodrigues collapses almost entirely — `w` is perpendicular to the
 * level offset, so the `w(w·v)` term vanishes — and what survives is just an angle
 * addition:
 *
 *     offset = R·(−cos h·sin(baseBeta + p), cos(baseBeta + p), −sin h·sin(baseBeta + p))
 *
 * which is the plain orbit formula at `alpha = h + π`, `beta = baseBeta + p`, with
 * NO fold and NO pole clamp. That is worth stating plainly: the camera's POSITION
 * was always continuous through a loop under the naive rule. Only the roll was
 * ever broken, which is exactly why {@link chaseUpFor} is the whole fix.
 */
export function chaseOffsetFor(
  heading: number,
  pitch: number,
  baseBeta: number,
  radius: number,
  out: Vec3,
): Vec3 {
  const tilt = baseBeta + pitch;
  const s = Math.sin(tilt) * radius;
  out.x = -Math.cos(heading) * s;
  out.y = Math.cos(tilt) * radius;
  out.z = -Math.sin(heading) * s;
  return out;
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
