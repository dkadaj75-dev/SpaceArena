import { beforeAll, describe, expect, it } from "vitest";
import type { ConfigService } from "../core/ConfigService.js";
import { botprofileSchema, type ShipConfig } from "../schemas/index.js";
import { ArenaSimulation } from "../sim/ArenaSimulation.js";
import { deriveRng } from "../sim/rng.js";
import { loadTestConfigs } from "../sim/testutil.js";
import type { BotBehavior } from "./behaviors.js";
import { BotDriver } from "./BotDriver.js";

const DT = 1 / 30;
let configs: ConfigService;

beforeAll(async () => {
  configs = await loadTestConfigs();
});

describe("floored-arena bot avoidance", () => {
  it("never contacts terrain during a long scripted dive", () => {
    const sim = new ArenaSimulation(configs, "arena.lunar-crater", "gamemode.practice-bots-1v1", 19);
    const ship = configs.get<ShipConfig>("ship", "ship.interceptor")!;
    const id = sim.spawnPlayerAt("ship.interceptor", ship.defaultFitting, 0, { x: -50, y: 12, z: -55 }, 0, undefined, -0.8);
    const dive: BotBehavior = {
      score: () => 1,
      plan: (ctx) => ({ aim: { x: ctx.self.pos.x + 1, y: -80, z: ctx.self.pos.z }, throttle: 1, boost: true, engaged: false }),
    };
    const profile = botprofileSchema.parse({
      id: "bot.floor-test",
      type: "botprofile",
      version: 1,
      decisionIntervalMs: 200,
      orderJitterMs: 0,
      preferredRange: [10, 20],
      behaviors: { dive: { baseWeight: 1 } },
      moduleDiscipline: { heatShutdownAt: 0.9, reactivateBelow: 0.5, energyReserve: 0, shieldOnlyWhenEngaged: false },
    });
    const driver = new BotDriver({
      entityId: id,
      profile,
      configs,
      rng: deriveRng(19, id),
      behaviors: new Map([["dive", dive]]),
      floorY: 0,
    });

    let nowMs = 0;
    let floorHits = 0;
    let minY = Infinity;
    for (let tick = 0; tick < 60 * 30; tick++) {
      nowMs += DT * 1000;
      const snapshot = sim.snapshot();
      for (const order of driver.update(snapshot, nowMs)) sim.applyOrder(id, order);
      sim.tick(DT);
      const transform = sim.world.transforms.get(id);
      expect(transform, `ship survived scripted tick ${tick}`).toBeDefined();
      minY = Math.min(minY, transform!.pos.y);
      floorHits += sim.getEvents().filter((event) =>
        event.type === "boundaryHit"
        && event.entityId === id
        && transform!.pos.y <= sim.world.colliders.get(id)!.radius + 0.01).length;
    }

    expect(floorHits).toBe(0);
    expect(minY).toBeGreaterThan(0 + sim.world.colliders.get(id)!.radius);
  });
});
