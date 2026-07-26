import { beforeAll, describe, expect, it } from "vitest";
import type { ConfigService } from "../../core/ConfigService.js";
import { hasLineOfSight } from "../los.js";
import { spawnAsteroid, spawnShipFromConfig } from "../spawn.js";
import { INTERCEPTOR_FITTING, loadTestConfigs, makeWorld, rebuildSpatial } from "../testutil.js";
import { navigationSystem } from "./NavigationSystem.js";

const DT = 1 / 30;

let configs: ConfigService;
beforeAll(async () => {
  configs = await loadTestConfigs();
});

describe("NavigationSystem", () => {
  it("applies boost speed only when a boost module is active with headroom", () => {
    const world = makeWorld(configs);
    const id = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 0, z: 0 }, 0);
    const boost = world.modules.get(id)!.modules[3]!;
    boost.state = "active";
    world.queueOrder(id, { kind: "flight", throttle: 1, turn: 0, boost: true });
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
