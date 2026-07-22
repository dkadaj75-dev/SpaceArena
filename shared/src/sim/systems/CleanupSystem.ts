import type { World } from "../World.js";

/**
 * CleanupSystem — removes destroyed ships (hull ≤ 0) at end of tick. Destroyed
 * asteroids stay as entities in the `destroyed` asset state (every other system
 * already skips them), so their placement is preserved for the render layer while
 * they no longer block LoS or collide. Events are drained by the caller.
 */
export function cleanupSystem(world: World): void {
  for (const id of world.shipIds()) {
    if (world.shipCores.get(id)!.hull <= 0) {
      world.destroyEntity(id);
    }
  }
}
