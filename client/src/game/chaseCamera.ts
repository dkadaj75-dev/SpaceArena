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
  beta: number;
  yawLag: number;
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
 * Deliberately the same numbers as `content/camera/default.json` — except `fov`,
 * which is null here for the same reason it is optional in the schema: there is
 * no defensible FOV to invent for a pack that never asked for one.
 */
export const DEFAULT_CHASE_SETTINGS: ChaseSettings = {
  radius: 14,
  height: 1.4,
  beta: 1.34,
  yawLag: 0.12,
  fov: null,
};

/** Resolve `camera.chase` against the built-in defaults. */
export function chaseSettingsOf(camera: CameraConfig | undefined): ChaseSettings {
  const c = camera?.chase;
  const d = DEFAULT_CHASE_SETTINGS;
  return {
    radius: c?.radius ?? d.radius,
    height: c?.height ?? d.height,
    beta: c?.beta ?? d.beta,
    yawLag: c?.yawLag ?? d.yawLag,
    fov: c?.fov ?? d.fov, // both null-by-default: absent everywhere ⇒ engine default
  };
}

/**
 * Orbit `alpha` that parks the camera directly behind a ship flying at `heading`
 * (see the derivation above). Not wrapped: `ArcRotateCamera` is happy with any
 * real alpha, and the smoothing in {@link approachHeading} is what keeps the
 * value continuous.
 */
export function chaseAlphaFor(heading: number): number {
  return heading + Math.PI;
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
