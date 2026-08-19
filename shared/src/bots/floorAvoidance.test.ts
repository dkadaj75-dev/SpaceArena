import { beforeAll, describe, expect, it } from "vitest";
import type { ConfigService } from "../core/ConfigService.js";
import { botprofileSchema, type BotprofileConfig, type ShipConfig } from "../schemas/index.js";
import { ArenaSimulation } from "../sim/ArenaSimulation.js";
import { deriveRng } from "../sim/rng.js";
import { asteroidSurfaceRadiusToward } from "../sim/asteroidCollision.js";
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
    const sim = new ArenaSimulation(configs, "arena.lunar-rift", "gamemode.practice-bots-1v1", 19);
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

  it("actively climbs away after spawning on the floor collision plane", () => {
    const sim = new ArenaSimulation(configs, "arena.lunar-rift", "gamemode.practice-bots-1v1", 21);
    const ship = configs.get<ShipConfig>("ship", "ship.interceptor")!;
    const radius = 1.4;
    const id = sim.spawnPlayerAt(ship.id, ship.defaultFitting, 0, { x: 0, y: radius, z: 0 }, 0, undefined, 0);
    const profile = configs.get<BotprofileConfig>("botprofile", "bot.rookie")!;
    const driver = new BotDriver({ entityId: id, profile, configs, rng: deriveRng(21, id), floorY: 0 });
    let nowMs = 0;
    let recoverySeen = false;
    for (let tick = 0; tick < 8 / DT; tick++) {
      nowMs += DT * 1000;
      const snapshot = sim.snapshot();
      for (const order of driver.update(snapshot, nowMs)) sim.applyOrder(id, order);
      recoverySeen ||= driver.lastDecision?.floorRecovery === true;
      sim.tick(DT);
      sim.getEvents();
    }
    expect(recoverySeen).toBe(true);
    expect(sim.world.transforms.get(id)!.pos.y).toBeGreaterThan(radius + 3);
  });

  // Two different collision worlds, one recovery behaviour: lunar-rift's cover is
  // static PROPS (staticWorld/BVH), the Ring's is ASTEROIDS (per-rock mesh BVH).
  // The rock case moved to the Ring on 2026-08-18 — lunar-rift has no asteroid
  // placements at all, so it cannot host it.
  it.each([
    { surface: "terrain", arenaId: "arena.lunar-rift", gamemodeId: "gamemode.practice-ctf-5v5", seconds: 10 },
    // Five seconds, not ten: the Ring is a radius-126 bubble and its rocks sit
    // well out in it, so a hull that has separated and is flying free reaches
    // the boundary — and has its throttle cut by the boundary rule — before a
    // ten-second window is up. Recovery latches and releases inside two.
    { surface: "rock", arenaId: "arena.ring-nebula", gamemodeId: "gamemode.practice-bots-5v5", seconds: 5 },
  ] as const)(
    "separates a zero-throttle bot parked nose-first against shipped $surface, then releases recovery",
    ({ surface, arenaId, gamemodeId, seconds }) => {
      const sim = new ArenaSimulation(configs, arenaId, gamemodeId, 31);
      const ship = configs.get<ShipConfig>("ship", "ship.interceptor")!;
      const radius = 1.4;
      let position = { x: -120, y: radius, z: -120 };
      let heading = 0;
      let pitch = -Math.PI / 2;
      let id = 0;
      let clearance = (): number => sim.world.transforms.get(id)!.pos.y - radius;
      if (surface === "rock") {
        const asteroidId = sim.world.asteroidIds()[0]!;
        const asteroid = sim.world.transforms.get(asteroidId)!;
        // Measured against the rock's real SURFACE, not any single radius
        // (2026-08-15): `collider.radius` became the bounding sphere when rocks
        // gained shapes, and parking on it would park the hull in clear space
        // beside a lumpy rock — exactly the bug shapes were introduced to fix.
        const tag = sim.world.asteroids.get(asteroidId)!;
        const bound = sim.world.colliders.get(asteroidId)!.radius;
        const surfaceToward = (pos: { x: number; y: number; z: number }) =>
          asteroidSurfaceRadiusToward(sim.world, tag, asteroid, bound, pos.x, pos.y, pos.z);
        const noseOn = { x: asteroid.pos.x + bound, y: asteroid.pos.y, z: asteroid.pos.z };
        position = { x: asteroid.pos.x + surfaceToward(noseOn) + radius - 0.2, y: asteroid.pos.y, z: asteroid.pos.z };
        heading = Math.PI;
        pitch = 0;
        clearance = () => {
          const at = sim.world.transforms.get(asteroidId)!.pos;
          const pos = sim.world.transforms.get(id)!.pos;
          return Math.hypot(pos.x - at.x, pos.y - at.y, pos.z - at.z) - surfaceToward(pos) - radius;
        };
      }
      id = sim.spawnPlayerAt(ship.id, ship.defaultFitting, 0, position, heading, undefined, pitch);
      const idle: BotBehavior = {
        score: () => 1,
        plan: (ctx) => clearance() >= 4
          ? { aim: { x: ctx.self.pos.x + 100, y: ctx.self.pos.y, z: ctx.self.pos.z }, throttle: 1, boost: false, engaged: false }
          : { aim: null, throttle: 0, boost: false, engaged: false },
      };
      const profile = botprofileSchema.parse({
        id: `bot.surface-${surface}`,
        type: "botprofile",
        version: 1,
        decisionIntervalMs: 100,
        orderJitterMs: 0,
        preferredRange: [10, 20],
        behaviors: { idle: { baseWeight: 1 } },
        moduleDiscipline: { heatShutdownAt: 0.9, reactivateBelow: 0.5, energyReserve: 0, shieldOnlyWhenEngaged: false },
      });
      const driver = new BotDriver({
        entityId: id,
        profile,
        configs,
        rng: deriveRng(31, id),
        behaviors: new Map([["idle", idle]]),
        floorY: 0,
      });
      let nowMs = 0;
      let recoverySeen = false;
      let released = false;
      for (let tick = 0; tick < seconds / DT; tick++) {
        nowMs += DT * 1000;
        const snapshot = sim.snapshot();
        for (const order of driver.update(snapshot, nowMs)) sim.applyOrder(id, order);
        const recovering = driver.lastDecision?.surfaceRecovery === true || driver.lastDecision?.floorRecovery === true;
        recoverySeen ||= recovering;
        released ||= recoverySeen && !recovering;
        sim.tick(DT);
        sim.getEvents();
      }
      expect(recoverySeen).toBe(true);
      expect(clearance()).toBeGreaterThanOrEqual(4);
      expect(released).toBe(true);
      expect(driver.lastDecision?.flight?.throttle).toBe(1);
    },
  );
});
