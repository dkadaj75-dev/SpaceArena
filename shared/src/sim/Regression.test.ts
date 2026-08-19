import { beforeAll, describe, expect, it } from "vitest";
import type { ConfigService } from "../core/ConfigService.js";
import { ArenaSimulation } from "./ArenaSimulation.js";
import { applyDamageToShip } from "./damage.js";
import { dist } from "./math.js";
import { spawnAsteroid, spawnShipFromConfig } from "./spawn.js";
import { collisionSystem } from "./systems/CollisionSystem.js";
import { navigationSystem } from "./systems/NavigationSystem.js";
import { INTERCEPTOR_FITTING, ROCK_SMALL, loadTestConfigs, makeWorld, rebuildSpatial, rockScaleFor } from "./testutil.js";

const DT = 1 / 30;

let configs: ConfigService;
beforeAll(async () => {
  configs = await loadTestConfigs();
});

describe("Bug 1 — collision grind death", () => {
  it("a ship flown into an asteroid takes one impact, not a grind, and never clips inside", () => {
    const world = makeWorld(configs);
    const ast = spawnAsteroid(world, configs, ROCK_SMALL, { x: 0, z: 0 }, rockScaleFor(configs, ROCK_SMALL, 3.5)); // r 3.5, impact 6
    const ship = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 0, z: -30 }, Math.PI / 2);
    const impactDamage = world.asteroids.get(ast)!.impactDamage;
    // "Never clips inside" is measured against the rock's real SURFACE now, not
    // a single radius (2026-08-15): `collider.radius` became the bounding sphere
    // when rocks gained shapes, and a hull resting against a flank thinner than
    // that bound is correctly INSIDE the old sphere. `innerRadius` is the
    // largest sphere that is solid rock everywhere, so the hull must always
    // stay outside it.
    const solidR = world.asteroids.get(ast)!.innerRadius + world.colliders.get(ship)!.radius;
    const before = world.shipCores.get(ship)!.hull;

    // Flight has no avoidance and no arrival (FLIGHT.md §1/§7): the pilot flies
    // straight at the rock and CollisionSystem is the only thing between them.
    world.queueOrder(ship, { kind: "flight", throttle: 1, turn: 0, boost: false, fire: true });

    for (let i = 0; i < 120; i++) {
      rebuildSpatial(world);
      navigationSystem(world, DT);
      collisionSystem(world, DT);
      expect(dist(world.transforms.get(ship)!.pos, { x: 0, z: 0 })).toBeGreaterThan(solidR - 0.1);
    }

    // Impact damage is capped by the per-pair cooldown, so 4 s of shoving into
    // the rock costs a handful of hits, not one per tick.
    const hullLoss = before - world.shipCores.get(ship)!.hull;
    expect(hullLoss).toBeGreaterThan(0);
    expect(hullLoss).toBeLessThanOrEqual(impactDamage * 5);
  });

  it("a sustained high-speed ram damages once, then respects the cooldown", () => {
    const world = makeWorld(configs);
    const ast = spawnAsteroid(world, configs, ROCK_SMALL, { x: 0, z: 0 }, rockScaleFor(configs, ROCK_SMALL, 3.5));
    // Inside contact range from the first tick: this test never integrates
    // position (it calls `collisionSystem` directly), and the rock's collision
    // sphere is inscribed in its silhouette rather than matching its drawn
    // radius (2026-07-31), so the old z: -4 no longer touches it.
    const ship = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 0, z: -3 }, 0);
    const impactDamage = world.asteroids.get(ast)!.impactDamage;

    let damageEvents = 0;
    for (let i = 0; i < 60; i++) {
      // Keep ramming inward at high closing speed every tick.
      world.velocities.get(ship)!.x = 0;
      world.velocities.get(ship)!.z = 20;
      rebuildSpatial(world);
      const before = world.events.length;
      collisionSystem(world, DT);
      for (let e = before; e < world.events.length; e++) {
        if (world.events[e]!.type === "damage") damageEvents++;
      }
    }

    // With the 1s cooldown, 2s of ramming yields ~2 impacts — not 60.
    expect(damageEvents).toBeGreaterThanOrEqual(1);
    expect(damageEvents).toBeLessThanOrEqual(3);
    const hullLoss = world.shipCores.get(ship)!.hullMax - world.shipCores.get(ship)!.hull;
    expect(hullLoss).toBeLessThanOrEqual(impactDamage * 3);
  });
});

describe("Bug 2 — defeat state", () => {
  it("player death ends a no-respawn practice match as a defeat", () => {
    const sim = new ArenaSimulation(configs, "arena.ring-nebula", "gamemode.duel-1v1");
    const player = sim.spawnPlayerAt("ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 0, z: 0 });
    sim.spawnPlayerAt("ship.interceptor", INTERCEPTOR_FITTING, 1, { x: 40, z: 0 });

    sim.world.shipCores.get(player)!.hull = 1;
    applyDamageToShip(sim.world, player, null, 100, "kinetic");
    sim.tick(DT);

    expect(sim.isEnded).toBe(true);
    const events = sim.getEvents();
    const ended = events.find((e) => e.type === "matchEnded");
    expect(ended).toBeTruthy();
    expect(ended && ended.type === "matchEnded" && ended.reason).toBe("elimination");
    expect(sim.snapshot().winnerTeam).toBe(1); // opposing team wins
  });

});
