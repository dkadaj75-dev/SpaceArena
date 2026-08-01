import { beforeAll, describe, expect, it } from "vitest";
import type { ConfigService } from "../../core/ConfigService.js";
import { spawnShipFromConfig } from "../spawn.js";
import { INTERCEPTOR_FITTING, INTERCEPTOR_FITTING_SHIELD, loadTestConfigs, makeWorld } from "../testutil.js";
import type { World } from "../World.js";
import { moduleSystem } from "./ModuleSystem.js";
import { energySystem } from "./EnergySystem.js";

const DT = 1 / 30;
const LASER = 0;

let configs: ConfigService;
beforeAll(async () => {
  configs = await loadTestConfigs();
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
  it("spawns weapons ONLINE and support modules retracted (2026-07-31)", () => {
    const { world, id } = shipWorld();
    const states = world.modules.get(id)!.modules.map((m) => m.state);
    // Light hull: laser + missile (weapons, online) then five internals, which
    // are always-on systems — nothing on this fitting starts retracted.
    expect(states).toEqual(["active", "active", "active", "active", "active", "active", "active"]);
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

  it("overheats a support module past threshold, then cools back to retracted", () => {
    const { world, id } = shieldWorld();
    const shield = world.modules.get(id)!.modules[1]!;
    shield.state = "active";

    // Start at the authored threshold: the balance pass deliberately reduced
    // the one-tick heat increment, so a fixed 0.1 headroom no longer crosses it.
    shield.heat = configs.get<any>("module", shield.moduleId)!.heat.overheatThreshold;
    shield.workedThisTick = true;
    energySystem(world, DT);
    expect(shield.state).toBe("overheated");
    expect(world.events.some((e) => e.type === "overheated")).toBe(true);

    // Cooldown (5s ≈ 150 ticks; a margin covers float drift) → retracted.
    tickModules(world, 160);
    expect(shield.state).toBe("retracted");
    expect(shield.heat).toBe(0);
  });

  it("re-arms a WEAPON straight to active after its overheat lockout", () => {
    const { world, id } = shipWorld();
    const laser = world.modules.get(id)!.modules[LASER]!;
    expect(laser.state).toBe("active");

    laser.heat = configs.get<any>("module", laser.moduleId)!.heat.overheatThreshold;
    laser.workedThisTick = true;
    energySystem(world, DT);
    expect(laser.state).toBe("overheated");

    // 3 s lockout (90 ticks; margin for float drift) → straight back online.
    tickModules(world, 100);
    expect(laser.state).toBe("active");
    expect(laser.heat).toBe(0);
  });

  it("ignores toggles while overheated", () => {
    const { world, id } = shipWorld();
    const mod = world.modules.get(id)!.modules[LASER]!;
    mod.state = "overheated";
    mod.stateTimer = 5;
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

  it("a brown-out force-retracts instantly, bypassing retractTime", () => {
    const { world, id } = shieldWorld();
    const mods = world.modules.get(id)!.modules;
    for (const m of mods) m.state = "active";
    world.shipCores.get(id)!.capacitor.cur = 0;
    for (const m of mods) m.workedThisTick = true;

    const mark = world.events.length;
    energySystem(world, DT);
    // Support modules shed before weapons (2026-07-31), so the shield is the
    // one dropped — instantly, with no `retracting` step at all.
    expect(mods[SHIELD]!.state).toBe("retracted");
    expect(transitions(world, mark)).toContain("active->retracted");
    expect(mods[SHIELD]!.workedThisTick).toBe(false); // dropped work does not draw or heat
  });

  it("regenerates the shield reservoir while active and drops it the moment it is not", () => {
    const { world, id } = shieldWorld();
    const shield = world.modules.get(id)!.modules[SHIELD]!;
    shield.state = "active";
    advance(world, id, 30); // 1s at absorbPerSecond 12
    expect(shield.shieldPool).toBeCloseTo(12, 5);

    advance(world, id, 30); // capped at one second's worth
    expect(shield.shieldPool).toBeCloseTo(12, 5);

    shield.state = "retracting";
    advance(world, id, 1);
    expect(shield.shieldPool).toBe(0);
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
        expect(m.shieldPool).toBeGreaterThanOrEqual(0);
      }
      expect(world.shipCores.get(id)!.capacitor.cur).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("ModuleSystem overheat exit (self-damage applied once per overheat)", () => {
  let ops: ConfigService;
  const SELF_DAMAGE_MODULE = "module.test-hotlaser";

  beforeAll(async () => {
    // Private ConfigService: no shipped module carries overheatSelfDamage > 0 yet,
    // so the branch needs a fixture. Kept off the shared instance on purpose.
    ops = await loadTestConfigs();
    const res = ops.replace({
      id: SELF_DAMAGE_MODULE,
      type: "module",
      version: 1,
      family: "laser",
      level: 1,
      activation: { deployTime: 0, retractTime: 0 },
      energy: { drawIdle: 0, drawActive: 0 },
      heat: { perSecondActive: 60, overheatThreshold: 10, overheatCooldown: 1, overheatSelfDamage: 5 },
      ui: { icon: "i", label: "Hot Laser" },
      price: 0,
      requiresLevel: 1,
    });
    if (!res.ok) throw new Error(`fixture module rejected: ${JSON.stringify(res.errors)}`);
  });

  it("charges overheatSelfDamage exactly once, then re-arms after the cooldown", () => {
    const world = makeWorld(ops);
    const id = spawnShipFromConfig(world, ops, "ship.interceptor", [SELF_DAMAGE_MODULE], 0, { x: 0, z: 0 }, 0);
    const core = world.shipCores.get(id)!;
    const mod = world.modules.get(id)!.modules[0]!;
    core.heat.dissipation = 0; // isolate the overheat path from cooling
    const startHull = core.hull;

    mod.state = "active";
    mod.heat = 9.9;
    mod.workedThisTick = true;
    energySystem(world, DT);
    expect(mod.state).toBe("overheated");
    expect(mod.overheatDamaged).toBe(true);
    expect(startHull - core.hull).toBeCloseTo(5, 6);

    // Still overheated: no further charge on subsequent ticks.
    for (let i = 0; i < 10; i++) {
      mod.workedThisTick = false;
      moduleSystem(world, DT);
      energySystem(world, DT);
    }
    expect(startHull - core.hull).toBeCloseTo(5, 6);

    // Cooldown (1s) elapses → back to retracted, heat cleared, damage flag re-armed.
    for (let i = 0; i < 32; i++) {
      mod.workedThisTick = false;
      moduleSystem(world, DT);
      energySystem(world, DT);
    }
    expect(mod.state).toBe("retracted");
    expect(mod.heat).toBe(0);
    expect(mod.overheatDamaged).toBe(false);

    // A second overheat charges again.
    mod.state = "active";
    mod.heat = 9.9;
    mod.workedThisTick = true;
    energySystem(world, DT);
    expect(startHull - core.hull).toBeCloseTo(10, 6);
  });
});
