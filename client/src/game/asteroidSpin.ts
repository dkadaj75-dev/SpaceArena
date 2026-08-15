import { DEFAULT_ROCK_SPIN, rockOrientationAt, rockSpinFor, type RockSpin } from "@space-arena/shared";

/**
 * Asteroid tumble, as the renderer sees it.
 *
 * This used to OWN the tumble: a per-frame quaternion integration living only
 * in the client, which was fine while the sim collided a sphere (a sphere has
 * no orientation to disagree about). Rocks now carry a real shape and the sim
 * collides against its surface, so the pose has to be something both sides
 * derive from the same inputs — see `shared/src/collision/rockPose.ts`, which
 * this module is now a thin re-export of.
 *
 * Two consequences worth knowing at the call site:
 *  - the identity is the PLACEMENT INDEX, not the entity id (an online client
 *    never sees sim entity ids);
 *  - pose is a closed form of match time, so the renderer evaluates it from the
 *    snapshot clock rather than accumulating frame deltas.
 */
export { rockSpinFor, rockOrientationAt };
export type { RockSpin };

/** Legacy alias for {@link RockSpin}. */
export type AsteroidSpin = RockSpin;
/** Legacy alias for {@link DEFAULT_ROCK_SPIN}. */
export const DEFAULT_ASTEROID_SPIN = DEFAULT_ROCK_SPIN;
/** Legacy alias for {@link rockSpinFor}. */
export const asteroidSpinFor = rockSpinFor;

export interface MutableQuaternion {
  x: number;
  y: number;
  z: number;
  w: number;
}
