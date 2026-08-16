import type { BotprofileConfig, ShipConfig } from "../schemas/index.js";
import type { EntityId } from "../sim/components.js";
import type { World } from "../sim/World.js";
import { BotDriver } from "./BotDriver.js";

/**
 * One place that knows how to wire a {@link BotDriver} to a world.
 *
 * The same nine-field block was written out at four production sites (the
 * client's offline fallback twice, the server's backfill, and the CTF review
 * tool), and the `visualRadius` formula five times. That is not merely repetitive
 * — it is how the wiring DRIFTS. `tools/bot-behavior-audit.ts` passed only
 * `arenaBounds` and `floorY`, so every bot it measured flew with no line-of-sight
 * geometry and no route planner (`BotDriver` gates both on those fields being
 * present), and it used a raw `render.modelScale` instead of the collider-floored
 * radius. Its numbers therefore described a bot that does not ship.
 *
 * Takes a {@link World} rather than an `ArenaSimulation`: everything needed is a
 * public readonly field on World, and a tool that has already built a sim can
 * pass `sim.world`. The import is TYPE-ONLY, so this adds no runtime edge in
 * either direction.
 *
 * `rng` stays a parameter — it is the one input callers legitimately differ on
 * (a test pins a stream; production derives one per entity from the room seed),
 * and folding it in would hide the determinism contract.
 */
export function createBotDriver(
  world: World,
  entityId: EntityId,
  profile: BotprofileConfig,
  ship: ShipConfig,
  rng: () => number,
): BotDriver {
  const bounds = world.arena.bounds;
  return new BotDriver({
    entityId,
    profile,
    configs: world.configs,
    rng,
    arenaBounds: bounds,
    // Only the legacy sphere arenas carry an independent kill floor; a box arena
    // gets its floor as one of the six shell faces, so passing one here would
    // double up. Deliberate, and preserved verbatim from the call sites.
    floorY: bounds.shape === "sphere" ? bounds.floorY : undefined,
    staticWorld: world.staticWorld,
    navRoute: world.navRoute,
    visualRadius: visualRadiusOf(ship),
  });
}

/**
 * The rendered half-extent a bot should treat as its own silhouette.
 * `modelScale` is approximately the authored forward length for a
 * unit-normalized hull; the gameplay collider is the honest floor.
 */
export function visualRadiusOf(ship: ShipConfig): number {
  return Math.max(ship.collider.radius, (ship.render.modelScale ?? ship.collider.radius * 2) / 2);
}
