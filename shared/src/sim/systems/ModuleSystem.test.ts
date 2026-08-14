import { beforeAll, describe, expect, it } from "vitest";
import type { ConfigService } from "../../core/ConfigService.js";
import type { ModuleConfig } from "../../schemas/module.js";
import { spawnShipFromConfig } from "../spawn.js";
import { INTERCEPTOR_FITTING, INTERCEPTOR_FITTING_SHIELD, loadTestConfigs, makeWorld } from "../testutil.js";
import type { World } from "../World.js";
import { moduleSystem } from "./ModuleSystem.js";
import { energySystem } from "./EnergySystem.js";

const DT = 1 / 30;
const LASER = 0;

let configs: ConfigService;
beforeAll(async () => {
  configs = await loadTestConfigs({ heatSystem: true });
});

function shipWorld(): { world: World; id: number } {
  const world = makeWorld(configs);
  const id = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 0, z: 0 }, 0);
  return { world, id };
}

/** The same hull, but with a deployable SHIELD on hardpoint 1 (slot index 1). */
function shieldWorld(): { world: World; id: number } {
  const world = makeWorld(configs);
  const id = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING_SHIELD, 0, { x: 0, z: 0 }, 0);
  return { world, id };
}

function tickModules(world: World, n: number): void {
  for (let i = 0; i < n; i++) {
    for (const m of world.modules.get(world.shipIds()[0]!)!.modules) m.workedThisTick = false;
    moduleSystem(world, DT);
  }
}

describe("ModuleSystem state machine", () => {
  it("spawns weapons ONLINE and ordinary internals active", () => {
    const { world, id } = shipWorld();
    const states = world.modules.get(id)!.modules.map((m) => m.state);
    // Light hull: laser + missile come online and its non-boosting internals
    // are always-on systems.
    expect(states).toEqual(["active", "active", "active", "active", "active", "active", "active"]);
  });

  it("spawns a boost-capable engine DISABLED until it is toggled on", () => {
    const world = makeWorld(configs);
    const id = spawnShipFromConfig(
      world,
      configs,
      "ship.interceptor",
      ["module.laser-mk1", "module.missile-mk1", "module.engine-sport", "module.generator-compact", "module.transformer-stock", "module.heatsink-basic", "module.sensors-basic"],
      0,
      { x: 0, z: 0 },
      0,
    );
    const boost = world.modules.get(id)!.modules[2]!;
    expect(boost.state).toBe("retracted");
    world.queueOrder(id, { kind: "moduleToggle", hardpointIndex: boost.hardpointIndex });
    moduleSystem(world, DT);
    expect(boost.state).toBe("active");
  });

  it("cycles retracted → deploying → active → retracting → retracted", () => {
    const { world, id } = shipWorld();
    const mod = world.modules.get(id)!.modules[LASER]!;
    // Weapons spawn active now; park it retracted to walk the full cycle with
    // the laser's authored timers (deploy 0.5s / retract 0.35s).
    mod.state = "retracted";

    world.queueOrder(id, { kind: "moduleToggle", hardpointIndex: LASER });
    moduleSystem(world, DT);
    expect(mod.state).toBe("deploying");

    tickModules(world, 45); // well past deployTime (0.5s)
    expect(mod.state).toBe("active");

    world.queueOrder(id, { kind: "moduleToggle", hardpointIndex: LASER });
    moduleSystem(world, DT);
    expect(mod.state).toBe("retracting");

    tickModules(world, 30); // well past retractTime (0.35s)
    expect(mod.state).toBe("retracted");
  });

  it("emits moduleStateChanged with activate action ids", () => {
    const { world, id } = shieldWorld();
    // Shield spawns retracted, so its toggle is the deploy edge.
    world.queueOrder(id, { kind: "moduleToggle", hardpointIndex: 1 });
    moduleSystem(world, DT);
    const evt = world.events.find((e) => e.type === "moduleStateChanged" && e.to === "deploying");
    expect(evt).toBeTruthy();
  });

  it("re-arms a WEAPON straight to active once its own heat falls under rearmBelow", () => {
    const { world, id } = shipWorld();
    const laser = world.modules.get(id)!.modules[LASER]!;
    expect(laser.state).toBe("active");

    laser.heat = laser.heatCapacity * 1.2;
    energySystem(world, DT);
    expect(laser.state).toBe("overheated");

    // Lockout is not a timer: it ends when cooling brings the rack under
    // `rearmBelow` (laser-mk1: 100 x 0.25 at 40/s ⇒ under 2.5 s).
    for (let i = 0; i < 90; i++) {
      for (const m of world.modules.get(id)!.modules) m.workedThisTick = false;
      moduleSystem(world, DT);
      energySystem(world, DT);
    }
    expect(laser.state).toBe("active");
    const rearm = configs.get<ModuleConfig>("module", laser.moduleId)!.heat!.rearmBelow;
    expect(laser.heat).toBeLessThanOrEqual(laser.heatCapacity * rearm);
  });

  it("routes a weapon's 100% lockout through the authored warning notification", () => {
    const { world, id } = shipWorld();
    const laser = world.modules.get(id)!.modules[LASER]!;
    laser.heat = laser.heatCapacity * 1.2;

    energySystem(world, DT);
    expect(world.events).toContainEqual(
      expect.objectContaining({
        type: "overheated",
        entityId: id,
        moduleId: laser.moduleId,
        actions: expect.arrayContaining(["action.notify-overheat"]),
      }),
    );
  });

  it("ignores toggles while overheated", () => {
    const { world, id } = shipWorld();
    const mod = world.modules.get(id)!.modules[LASER]!;
    mod.state = "overheated";
    world.queueOrder(id, { kind: "moduleToggle", hardpointIndex: LASER });
    moduleSystem(world, DT);
    expect(mod.state).toBe("overheated");
  });
});

/**
 * ROADMAP §11 6.1 — the transitions the happy-path cycle above does not reach:
 * mid-transition reversals, zero-duration activation, forced (brown-out /
 * overheat) exits, the shield reservoir, and the no-op guards.
 */
describe("ModuleSystem state machine — reversals, forced exits and guards", () => {
  // Slot layout since 2026-07-31: 0 laser, 1 missile, then the internal bay.
  const SHIELD = 1;
  const UTILITY_BAY = 6; // the sensors bay — the light hull's last slot

  /** Advance `n` ticks with every module idle (the per-tick flag reset tick() does). */
  function advance(world: World, id: number, n: number): void {
    for (let i = 0; i < n; i++) {
      for (const m of world.modules.get(id)!.modules) m.workedThisTick = false;
      moduleSystem(world, DT);
    }
  }

  const toggle = (world: World, id: number, hardpointIndex: number): void => {
    world.queueOrder(id, { kind: "moduleToggle", hardpointIndex });
    moduleSystem(world, DT);
  };

  const transitions = (world: World, from: number): Array<`${string}->${string}`> =>
    world.events
      .slice(from)
      .filter((e) => e.type === "moduleStateChanged")
      .map((e) => `${e.from}->${e.to}` as const);

  it("a toggle mid-deploy reverses straight into retracting (deploy is cancellable)", () => {
    const { world, id } = shipWorld();
    const mod = world.modules.get(id)!.modules[LASER]!;
    mod.state = "retracted"; // weapons spawn active; the test wants the deploy edge
    toggle(world, id, LASER);
    advance(world, id, 5); // 0.17s into a 0.5s deploy
    expect(mod.state).toBe("deploying");

    const mark = world.events.length;
    toggle(world, id, LASER);
    expect(mod.state).toBe("retracting");
    expect(transitions(world, mark)).toEqual(["deploying->retracting"]);
    expect(mod.stateTimer).toBeCloseTo(0.35 - DT, 6); // full retractTime, not the remaining deploy

    advance(world, id, 30);
    expect(mod.state).toBe("retracted");
  });

  it("a toggle mid-retract re-deploys from the start of deployTime", () => {
    const { world, id } = shipWorld();
    const mod = world.modules.get(id)!.modules[LASER]!;
    mod.state = "retracted"; // weapons spawn active; the test wants the deploy edge
    toggle(world, id, LASER);
    advance(world, id, 45);
    expect(mod.state).toBe("active");
    toggle(world, id, LASER);
    advance(world, id, 6); // 0.2s into a 0.35s retract
    expect(mod.state).toBe("retracting");

    const mark = world.events.length;
    toggle(world, id, LASER);
    expect(mod.state).toBe("deploying");
    expect(transitions(world, mark)).toEqual(["retracting->deploying"]);
    expect(mod.stateTimer).toBeCloseTo(0.5 - DT, 6);

    advance(world, id, 45);
    expect(mod.state).toBe("active");
  });

  it("a zero-duration module skips deploying/retracting entirely", () => {
    // The sensors bay carries a zero-duration internal. Internals SPAWN active
    // (they are always-on systems), so the first toggle here is the retract.
    const world = makeWorld(configs);
    const id = spawnShipFromConfig(
      world,
      configs,
      "ship.interceptor",
      [null, null, null, null, null, null, "module.sensors-basic"],
      0,
      { x: 0, z: 0 },
      0,
    );
    const mod = world.modules.get(id)!.modules[0]!;
    expect(mod.hardpointIndex).toBe(UTILITY_BAY);
    expect(mod.state).toBe("active");

    let mark = world.events.length;
    toggle(world, id, UTILITY_BAY);
    expect(mod.state).toBe("retracted");
    expect(transitions(world, mark)).toEqual(["active->retracted"]);

    mark = world.events.length;
    toggle(world, id, UTILITY_BAY);
    expect(mod.state).toBe("active");
    expect(transitions(world, mark)).toEqual(["retracted->active"]);
  });

  it("carries the module's onActivate / onDeactivate action ids on the state change", () => {
    const { world, id } = shieldWorld();
    // shield-mk1 declares both hooks.
    toggle(world, id, SHIELD);
    const up = world.events.find((e) => e.type === "moduleStateChanged" && e.to === "deploying");
    expect(up && up.type === "moduleStateChanged" && up.actions).toEqual(["action.play-sound-shield-up"]);

    advance(world, id, 30);
    const mark = world.events.length;
    toggle(world, id, SHIELD);
    const down = world.events.slice(mark).find((e) => e.type === "moduleStateChanged");
    expect(down && down.type === "moduleStateChanged" && down.actions).toEqual(["action.play-sound-shield-down"]);
  });

  it("an empty tank force-retracts instantly, bypassing retractTime", () => {
    const { world, id } = shieldWorld();
    const mods = world.modules.get(id)!.modules;
    const shield = mods[SHIELD]!;
    shield.state = "active";
    shield.energy = 0.01;

    const mark = world.events.length;
    energySystem(world, DT);
    // The shield's reserve IS its tank: run it dry and the shield drops that
    // tick, with no `retracting` step at all.
    expect(shield.state).toBe("retracted");
    expect(shield.energy).toBe(0);
    expect(transitions(world, mark)).toContain("active->retracted");
    expect(shield.workedThisTick).toBe(false); // dropped work costs nothing more
  });

  it("refuses to raise a module again until its tank passes `rearmAbove`", () => {
    const { world, id } = shieldWorld();
    const shield = world.modules.get(id)!.modules[SHIELD]!;
    const cfg = configs.get<ModuleConfig>("module", shield.moduleId)!;
    shield.state = "retracted";
    shield.energy = shield.energyCapacity * cfg.energy!.rearmAbove * 0.5;
    toggle(world, id, SHIELD);
    expect(shield.state).toBe("retracted"); // still flamed out

    shield.energy = shield.energyCapacity * cfg.energy!.rearmAbove;
    toggle(world, id, SHIELD);
    expect(shield.state).toBe("deploying");
  });

  it("ignores a toggle addressed to an empty or out-of-range hardpoint", () => {
    const { world, id } = shipWorld();
    const before = world.modules.get(id)!.modules.map((m) => m.state);
    const mark = world.events.length;
    world.queueOrder(id, { kind: "moduleToggle", hardpointIndex: 7 });
    world.queueOrder(id, { kind: "moduleToggle", hardpointIndex: -1 });
    moduleSystem(world, DT);
    expect(world.modules.get(id)!.modules.map((m) => m.state)).toEqual(before);
    expect(transitions(world, mark)).toEqual([]);
  });

  it("emits nothing when a transition would not change the state", () => {
    const { world, id } = shipWorld();
    const mod = world.modules.get(id)!.modules[LASER]!;
    mod.state = "retracted";
    const mark = world.events.length;
    advance(world, id, 5); // retracted has no timer — nothing to emit
    expect(transitions(world, mark)).toEqual([]);
  });

  it("never leaves a module in a state outside the declared enum across a scripted toggle storm", () => {
    const { world, id } = shipWorld();
    const legal = new Set(["retracted", "deploying", "active", "retracting", "overheated"]);
    // Deterministic pseudo-random toggle schedule (no Math.random in sim tests).
    let seed = 1337;
    const nextInt = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let t = 0; t < 900; t++) {
      if (nextInt(5) === 0) world.queueOrder(id, { kind: "moduleToggle", hardpointIndex: nextInt(4) });
      const mods = world.modules.get(id)!.modules;
      for (const m of mods) m.workedThisTick = m.state === "active";
      moduleSystem(world, DT);
      energySystem(world, DT);
      for (const m of mods) {
        expect(legal.has(m.state)).toBe(true);
        expect(m.heat).toBeGreaterThanOrEqual(0);
        expect(m.energy).toBeGreaterThanOrEqual(0);
        expect(m.energy).toBeLessThanOrEqual(m.energyCapacity + 1e-9);
      }
    }
  });
});

describe("ModuleSystem overheat exit (hysteresis, not a timer)", () => {
  let ops: ConfigService;
  const HOT_MODULE = "module.test-hotlaser";

  beforeAll(async () => {
    // Private ConfigService: a fixture that out-paces its own cooling by a wide
    // margin, so the trip/lockout/re-arm cycle is reached in a handful of ticks.
    ops = await loadTestConfigs({ heatSystem: true });
    const res = ops.replace({
      id: HOT_MODULE,
      type: "module",
      version: 1,
      family: "laser",
      level: 1,
      name: "Test Hot Laser",
      activation: { deployTime: 0, retractTime: 0 },
      heat: { capacity: 10, coolingPerSec: 5, perSecondActive: 60, rearmBelow: 0.4 },
      fire: {
        mode: "continuous",
        range: 40,
        cycleTime: 0.1,
        damage: 1,
        damageType: "energy",
        requiresLineOfSight: false,
        projectile: null,
      },
      ui: { icon: "i", label: "Hot Laser" },
      price: 0,
      requiresLevel: 1,
    });
    if (!res.ok) throw new Error(`fixture module rejected: ${JSON.stringify(res.errors)}`);
  });

  it("locks out at capacity, stays locked while hot, and re-arms under rearmBelow", () => {
    const world = makeWorld(ops);
    const id = spawnShipFromConfig(world, ops, "ship.interceptor", [HOT_MODULE], 0, { x: 0, z: 0 }, 0);
    const core = world.shipCores.get(id)!;
    const mod = world.modules.get(id)!.modules[0]!;
    const startHull = core.hull;
    const cooling = 5 * core.cooling.multiplier;

    mod.state = "active";
    mod.heat = mod.heatCapacity;
    mod.workedThisTick = true;
    energySystem(world, DT);
    expect(mod.state).toBe("overheated");
    // The lockout carries no timer at all — that is the whole mechanic.
    expect(mod.stateTimer).toBe(0);

    // Half way down to the re-arm line it is still offline.
    const toRearm = (mod.heat - mod.heatCapacity * 0.4) / cooling;
    for (let i = 0; i < Math.floor(toRearm / DT / 2); i++) {
      mod.workedThisTick = false;
      moduleSystem(world, DT);
      energySystem(world, DT);
    }
    expect(mod.state).toBe("overheated");

    // …and comes back the moment it crosses it, still carrying real heat.
    for (let i = 0; i < Math.ceil(toRearm / DT) + 2; i++) {
      mod.workedThisTick = false;
      moduleSystem(world, DT);
      energySystem(world, DT);
    }
    expect(mod.state).toBe("active");
    expect(mod.heat).toBeGreaterThan(0);
    expect(mod.heat).toBeLessThanOrEqual(mod.heatCapacity * 0.4 + 1e-9);

    // And the hull never paid for any of it (no overheat self-damage exists).
    expect(core.hull).toBe(startHull);
  });
});
