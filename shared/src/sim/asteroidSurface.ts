import type { ConfigService } from "../core/ConfigService.js";
import { rockOrientationAt, rockSpinFor } from "../collision/rockPose.js";
import { resolveRockShape, rockWorldRadius, type RockQuat } from "../collision/rockShape.js";
import type { AsteroidConfig } from "../schemas/asteroid.js";
import type { AsteroidSnapshot } from "./ArenaSimulation.js";

/**
 * SNAPSHOT-ONLY rock surface queries.
 *
 * The sim reads a rock's surface straight off its entity (`asteroidCollision.ts`).
 * Consumers that only hold a {@link import("./ArenaSimulation.js").Snapshot} —
 * bots, debug overlays, an online client with no asteroid entities at all —
 * cannot, and until rocks had shapes they simply used the collider radius.
 *
 * They do not have to settle for a sphere: everything the surface depends on is
 * either in the snapshot (placement index, nominal radius, position, match
 * time) or in the pack (the shape spec). This rebuilds the exact same surface
 * from those two, so a bot deciding whether its hull is against a rock gets the
 * same answer the sim's push-out just gave it.
 */
export interface RockSurfaceProbe {
  /**
   * Surface radius of `asteroid`, in world units, along the direction from its
   * centre toward `toward`. Falls back to the snapshot's sphere for a rock whose
   * config is missing or carries no shape.
   */
  (asteroid: AsteroidSnapshot, toward: { x: number; y: number; z: number }, elapsedSec: number): number;
}

/** Scratch orientation — the probe is called per contact test and never allocates. */
const probeQuat: RockQuat = { x: 0, y: 0, z: 0, w: 1 };

/**
 * Build a probe bound to a config registry. Cheap to call: shapes are resolved
 * once and cached by {@link resolveRockShape}, and the pose is a closed form.
 */
export function makeRockSurfaceProbe(configs: ConfigService): RockSurfaceProbe {
  return (asteroid, toward, elapsedSec) => {
    const config = configs.get<AsteroidConfig>("asteroid", asteroid.configId);
    if (!config?.shape) return asteroid.colliderRadius ?? asteroid.radius;
    const shape = resolveRockShape(config.shape);
    rockOrientationAt(rockSpinFor(asteroid.placementIndex ?? asteroid.id, config.render.spin), asteroid.rotationY ?? 0, elapsedSec, probeQuat);
    return rockWorldRadius(
      shape,
      asteroid.radius,
      probeQuat,
      toward.x - asteroid.pos.x,
      toward.y - asteroid.pos.y,
      toward.z - asteroid.pos.z,
    );
  };
}
