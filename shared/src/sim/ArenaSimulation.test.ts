import { beforeAll, describe, expect, it } from "vitest";
import type { ConfigService } from "../core/ConfigService.js";
import { ArenaSimulation } from "./ArenaSimulation.js";
import { applyDamageToShip } from "./damage.js";
import { spawnShipFromConfig } from "./spawn.js";
import { collisionSystem } from "./systems/CollisionSystem.js";
import { INTERCEPTOR_FITTING, loadTestConfigs, makeWorld } from "./testutil.js";

const DT = 1 / 30;

let configs: ConfigService;
beforeAll(async () => {
  configs = await loadTestConfigs();
});

describe("CollisionSystem boundary", () => {
  it("bounces a ship off a circular boundary", () => {
    const world = makeWorld(configs, {
      gamemodeOverride: { boundaryRule: { type: "bounce", restitution: 1 } },
    });
    const id = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 89, z: 0 }, 0);
    world.velocities.get(id)!.x = 30;
    collisionSystem(world, DT);
    expect(world.velocities.get(id)!.x).toBeLessThan(0); // reflected inward
    const p = world.transforms.get(id)!.pos;
    expect(Math.sqrt(p.x * p.x + p.z * p.z)).toBeLessThanOrEqual(90);
  });

  it("damages a ship that leaves a damaging boundary", () => {
    const world = makeWorld(configs, { gamemodeId: "gamemode.duel-1v1" }); // boundary: damage
    const id = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 100, z: 0 }, 0);
    const before = world.shipCores.get(id)!.hull;
    collisionSystem(world, DT);
    expect(world.shipCores.get(id)!.hull).toBeLessThan(before);
    expect(world.events.some((e) => e.type === "boundaryHit")).toBe(true);
  });
});

describe("Win conditions", () => {
  it("ends a destroyTargets match after the required kills", () => {
    const sim = new ArenaSimulation(configs, "arena.ring-nebula", "gamemode.practice"); // destroyTargets 3
    const player = sim.spawnPlayerAt("ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 0, z: 0 });
    const enemies = [
      sim.spawnPlayerAt("ship.interceptor", INTERCEPTOR_FITTING, 1, { x: 10, z: 0 }),
      sim.spawnPlayerAt("ship.interceptor", INTERCEPTOR_FITTING, 1, { x: 12, z: 0 }),
      sim.spawnPlayerAt("ship.interceptor", INTERCEPTOR_FITTING, 1, { x: 14, z: 0 }),
    ];
    for (const e of enemies) {
      sim.world.shipCores.get(e)!.hull = 1;
      applyDamageToShip(sim.world, e, player, 100, "kinetic");
      sim.tick(DT);
    }
    expect(sim.isEnded).toBe(true);
    const events = sim.getEvents();
    expect(events.some((ev) => ev.type === "matchEnded")).toBe(true);
  });

  it("ends a timeLimit match when time elapses", () => {
    const r = configs.replace({
      id: "gamemode.timed-test",
      type: "gamemode",
      version: 1,
      teams: "1v1",
      winCondition: { type: "timeLimit", seconds: 1 },
      respawn: { enabled: false, delay: 0 },
      boundaryRule: { type: "warning" },
      rewards: { win: 0, loss: 0, perKill: 0 },
    });
    expect(r.ok).toBe(true);
    const sim = new ArenaSimulation(configs, "arena.ring-nebula", "gamemode.timed-test");
    sim.spawnPlayerAt("ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 0, z: 0 });
    for (let i = 0; i < 40 && !sim.isEnded; i++) sim.tick(DT); // 40 ticks > 1s
    expect(sim.isEnded).toBe(true);
  });
});

describe("Snapshots", () => {
  it("reports the ship's real FlightState throttle (0 without one)", () => {
    const sim = new ArenaSimulation(configs, "arena.ring-nebula", "gamemode.duel-1v1");
    const flyer = sim.spawnPlayerAt("ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 0, z: 0 });
    const drifter = sim.spawnPlayerAt("ship.interceptor", INTERCEPTOR_FITTING, 1, { x: 40, z: 0 });

    expect(sim.snapshot().ships.map((s) => s.throttle)).toEqual([0, 0]);

    sim.applyOrder(flyer, { kind: "flight", throttle: 0.6, turn: 0.2, boost: false });
    sim.tick(DT);
    const ships = sim.snapshot().ships;
    expect(ships.find((s) => s.id === flyer)!.throttle).toBeCloseTo(0.6, 6);
    expect(ships.find((s) => s.id === drifter)!.throttle).toBe(0);

    // Level-triggered: the value persists across ticks with no further orders,
    // and a move order hands the ship back to move control (throttle ⇒ 0).
    for (let t = 0; t < 10; t++) sim.tick(DT);
    expect(sim.snapshot().ships.find((s) => s.id === flyer)!.throttle).toBeCloseTo(0.6, 6);
    sim.applyOrder(flyer, { kind: "move", target: { x: 5, z: 5 }, boost: false });
    sim.tick(DT);
    expect(sim.snapshot().ships.find((s) => s.id === flyer)!.throttle).toBe(0);
  });
});

describe("Determinism", () => {
  it("two sims fed identical orders produce identical snapshots after 1000 ticks", () => {
    const build = () => {
      const sim = new ArenaSimulation(configs, "arena.ring-nebula", "gamemode.practice", 42);
      const a = sim.spawnPlayerAt("ship.interceptor", INTERCEPTOR_FITTING, 0, { x: -20, z: 0 }, 0);
      const b = sim.spawnPlayerAt("ship.interceptor", INTERCEPTOR_FITTING, 1, { x: 20, z: 0 }, Math.PI);
      return { sim, a, b };
    };
    const run = (r: ReturnType<typeof build>) => {
      const { sim, a, b } = r;
      for (let t = 0; t < 1000; t++) {
        if (t === 0) {
          sim.applyOrder(a, { kind: "moduleToggle", hardpointIndex: 0 });
          sim.applyOrder(b, { kind: "moduleToggle", hardpointIndex: 0 });
          sim.applyOrder(a, { kind: "target", targetId: b });
          sim.applyOrder(b, { kind: "target", targetId: a });
        }
        if (t === 3) {
          sim.applyOrder(a, { kind: "move", target: { x: 10, z: 5 }, boost: false });
          sim.applyOrder(b, { kind: "move", target: { x: -10, z: -5 }, boost: false });
        }
        // Flight is level-triggered: two orders drive 900+ ticks of motion, and
        // the integration must stay bit-identical across runs.
        if (t === 200) sim.applyOrder(a, { kind: "flight", throttle: 0.7, turn: -0.4, boost: true });
        if (t === 400) sim.applyOrder(b, { kind: "flight", throttle: 1, turn: 0.15, boost: false });
        sim.tick(DT);
        sim.getEvents();
      }
      return sim.snapshot();
    };
    const s1 = run(build());
    const s2 = run(build());
    expect(JSON.stringify(s1)).toEqual(JSON.stringify(s2));
  });
});

describe("Scripted 60s engagement (regression anchor)", () => {
  it("interceptor vs static target: energy never negative, target dies in sane time", () => {
    const sim = new ArenaSimulation(configs, "arena.ring-nebula", "gamemode.duel-1v1");
    const shooter = sim.spawnPlayerAt("ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 0, z: 0 });
    const target = sim.spawnPlayerAt("ship.interceptor", INTERCEPTOR_FITTING, 1, { x: 22, z: 0 });
    // Bring shooter's laser + missile online directly and lock the target.
    const mods = sim.world.modules.get(shooter)!.modules;
    mods[0]!.state = "active";
    mods[1]!.state = "active";
    sim.world.targets.get(shooter)!.targetId = target;
    sim.world.targets.get(shooter)!.manual = true;

    let diedTick = -1;
    for (let t = 0; t < 1800; t++) {
      sim.tick(DT);
      sim.getEvents();
      const s = sim.world.shipCores.get(shooter);
      if (s) {
        expect(s.capacitor.cur).toBeGreaterThanOrEqual(0);
        for (const m of sim.world.modules.get(shooter)!.modules) expect(m.heat).toBeGreaterThanOrEqual(0);
      }
      if (diedTick < 0 && !sim.world.shipCores.has(target)) diedTick = t;
    }
    expect(diedTick).toBeGreaterThan(15); // > 0.5s
    expect(diedTick).toBeLessThan(1800); // dead within the minute
  });
});
