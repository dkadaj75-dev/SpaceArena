import { beforeAll, describe, expect, it } from "vitest";
import type { ConfigService } from "../../core/ConfigService.js";
import { hasLineOfSight } from "../los.js";
import { dist } from "../math.js";
import { spawnAsteroid, spawnShipFromConfig } from "../spawn.js";
import { INTERCEPTOR_FITTING, loadTestConfigs, makeWorld, rebuildSpatial } from "../testutil.js";
import { collisionSystem } from "./CollisionSystem.js";
import { navigationSystem } from "./NavigationSystem.js";

const DT = 1 / 30;

let configs: ConfigService;
beforeAll(async () => {
  configs = await loadTestConfigs();
});

describe("NavigationSystem", () => {
  it("seeks and stops at the target, clearing the order", () => {
    const world = makeWorld(configs);
    const id = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 0, z: -50 }, 0);
    world.queueOrder(id, { kind: "move", target: { x: 0, z: 0 }, boost: false });

    for (let i = 0; i < 500; i++) {
      navigationSystem(world, DT);
      if (!world.moveOrders.has(id)) break;
    }
    expect(world.moveOrders.has(id)).toBe(false);
    const p = world.transforms.get(id)!.pos;
    expect(dist(p, { x: 0, z: 0 })).toBeLessThan(3);
  });

  it("routes around a blocking asteroid without ever clipping through it", () => {
    const world = makeWorld(configs);
    const ast = spawnAsteroid(world, configs, "asteroid.small-rock", { x: 0, z: -25 });
    const id = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 0, z: -50 }, 0);
    world.queueOrder(id, { kind: "move", target: { x: 0, z: 0 }, boost: false });

    const astPos = world.transforms.get(ast)!.pos;
    const sumR = world.colliders.get(ast)!.radius + world.colliders.get(id)!.radius;

    let reached = false;
    for (let i = 0; i < 800; i++) {
      rebuildSpatial(world);
      navigationSystem(world, DT);
      collisionSystem(world, DT);
      const p = world.transforms.get(id)!.pos;
      expect(dist(p, astPos)).toBeGreaterThan(sumR - 0.05); // never inside the rock
      if (!world.moveOrders.has(id)) {
        reached = true;
        break;
      }
    }
    expect(reached).toBe(true);
  });

  it("applies boost speed only when a boost module is active with headroom", () => {
    const world = makeWorld(configs);
    const id = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 0, z: 0 }, 0);
    const boost = world.modules.get(id)!.modules[3]!;
    boost.state = "active";
    world.queueOrder(id, { kind: "move", target: { x: 1000, z: 0 }, boost: true });
    for (let i = 0; i < 200; i++) navigationSystem(world, DT); // let it accelerate
    const v = world.velocities.get(id)!;
    const speed = Math.sqrt(v.x * v.x + v.z * v.z);
    const core = world.shipCores.get(id)!;
    expect(speed).toBeGreaterThan(core.engine.nominalSpeed + 1); // boosted past nominal
    expect(boost.workedThisTick).toBe(true);
  });
});

describe("Line of sight", () => {
  it("is blocked by an asteroid on the segment and clear when it is not", () => {
    const world = makeWorld(configs);
    spawnAsteroid(world, configs, "asteroid.large-hazard", { x: 0, z: 0 });
    rebuildSpatial(world);
    expect(hasLineOfSight(world, { x: -30, z: 0 }, { x: 30, z: 0 })).toBe(false);
    expect(hasLineOfSight(world, { x: -30, z: 20 }, { x: 30, z: 20 })).toBe(true);
  });
});
