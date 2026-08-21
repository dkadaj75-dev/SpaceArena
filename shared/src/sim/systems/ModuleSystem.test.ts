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
  it("spawns weapons ONLINE and ordinary internals active", () => {
    const { world, id } = shipWorld();
    const states = world.modules.get(id)!.modules.map((m) => m.state);
    // Light hull: laser + missile come online and its non-boosting internals
    // are always-on systems.
    expect(states).toEqual(["active", "active", "active", "active", "active", "active", "active"]);
  });

  it("counts down a clip reload, refills it, and re-arms automatically", () => {
    const world = makeWorld(configs);
    const fitting = [...INTERCEPTOR_FITTING];
    fitting[0] = "module.kinetic-mk1";
    const id = spawnShipFromConfig(world, configs, "ship.interceptor", fitting, 0, { x: 0, z: 0 }, 0);
    const gun = world.modules.get(id)!.modules[0]!;
    const clip = configs.get<ModuleConfig>("module", gun.moduleId)!.fire!.clip!;
    expect(gun.rounds).toBe(clip.size);
    gun.rounds = 0;
    gun.state = "reloading";
    gun.stateTimer = clip.reloadSec;
    tickModules(world, Math.ceil(clip.reloadSec / DT) - 1);
    expect(gun.state).toBe("reloading");
    expect(gun.rounds).toBe(0);
    tickModules(world, 2);
    expect(gun.state).toBe("active");
    expect(gun.rounds).toBe(clip.size);
    expect(gun.stateTimer).toBe(0);
  });

  it("spawns a boost-capable engine DISABLED until it is toggled on", () => {
    const world = makeWorld(configs);
    const id = spawnShipFromConfig(
      world,
      configs,
      "ship.interceptor",
      ["module.laser-mk1", "module.missile-mk1", "module.engine-sport", "module.generator-compact", "module.transformer-stock", "module.countermeasure-flare", "module.sensors-basic"],
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

  it("leaves a WEAPON online forever — a cycle timer never takes the rack down", () => {
    const { world, id } = shipWorld();
    const laser = world.modules.get(id)!.modules[LASER]!;
    expect(laser.state).toBe("active");

    // Heat was the only thing that could ever force a weapon offline
    // (deleted 2026-08-20). A rack mid-cycle is still `active`: the cooldown
    // gates the SHOT, never the module's state.
    laser.cycleTimer = configs.get<ModuleConfig>("module", laser.moduleId)!.fire!.cycleTime;
    for (let i = 0; i < 90; i++) {
      for (const m of world.modules.get(id)!.modules) m.workedThisTick = false;
      moduleSystem(world, DT);
      energySystem(world, DT);
    }
    expect(laser.state).toBe("active");
  });
});

/**
 * ROADMAP §11 6.1 — the transitions the happy-path cycle above does not reach:
 * mid-transition reversals, zero-duration activation, forced (brown-out /
 * brown-out) exits, the shield reservoir, and the no-op guards.
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
    const legal = new Set(["retracted", "deploying", "active", "retracting", "reloading"]);
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
        expect(m.energy).toBeGreaterThanOrEqual(0);
        expect(m.energy).toBeLessThanOrEqual(m.energyCapacity + 1e-9);
      }
    }
  });
});

/**
 * The raise side of the shield collapse cooldown (2026-08-18). EnergySystem
 * stamps `mitigation.collapseCooldownSec` on the module's `cycleTimer` when the
 * bubble goes down for lack of charge; refusing the raise until that runs out —
 * and counting it down at all — is this system's half of the rule.
 */
describe("ModuleSystem — shield collapse cooldown", () => {
  const SHIELD = 1;
  const COOLDOWN = 8; // module.shield-mk1's authored collapseCooldownSec

  /** Collapse the fitted shield for real, by holding it up until the tank dies. */
  function collapse(world: World, id: number): { shield: ReturnType<typeof shieldOf> } {
    const shield = shieldOf(world, id);
    shield.state = "active";
    shield.energy = 0.01;
    energySystem(world, DT);
    return { shield };
  }

  const shieldOf = (world: World, id: number) => world.modules.get(id)!.modules[SHIELD]!;

  it("refuses to raise a collapsed shield, and lets it up the moment the clock clears", () => {
    const { world, id } = shieldWorld();
    const { shield } = collapse(world, id);
    expect(shield.state).toBe("retracted");
    expect(shield.cycleTimer).toBe(COOLDOWN);

    // A pilot mashing the button through the lockout gets nothing — and the
    // refusal is silent, exactly like the tank and rail refusals beside it.
    for (let t = 0; t < 30; t++) {
      world.queueOrder(id, { kind: "moduleToggle", hardpointIndex: SHIELD });
      moduleSystem(world, DT);
      expect(shield.state).toBe("retracted");
    }

    // Run the clock out. The tank refills meanwhile (EnergySystem), so once the
    // cooldown clears the only remaining gate — `energy.rearmAbove` — is
    // satisfied and the bubble comes back on the next toggle.
    for (let t = 0; t < Math.ceil(COOLDOWN / DT) + 2; t++) {
      moduleSystem(world, DT);
      energySystem(world, DT);
    }
    expect(shield.cycleTimer).toBe(0);
    world.queueOrder(id, { kind: "moduleToggle", hardpointIndex: SHIELD });
    moduleSystem(world, DT);
    expect(shield.state).not.toBe("retracted");
  });

  it("counts the cooldown down at real time, not per toggle", () => {
    const { world, id } = shieldWorld();
    const { shield } = collapse(world, id);
    for (let t = 0; t < 30; t++) moduleSystem(world, DT); // one second, no orders
    expect(shield.cycleTimer).toBeCloseTo(COOLDOWN - 1, 6);
  });

  it("charges NOTHING to a pilot who lowers a healthy shield deliberately", () => {
    // The distinction the whole rule rests on: a collapse is the tank dying, not
    // the bubble going down. Retracting a charged shield must cost no lockout,
    // or the button becomes a trap.
    const { world, id } = shieldWorld();
    const shield = shieldOf(world, id);
    shield.state = "active";
    world.queueOrder(id, { kind: "moduleToggle", hardpointIndex: SHIELD });
    moduleSystem(world, DT);
    expect(shield.cycleTimer).toBe(0);
    // …and it can be raised straight back.
    tickModules(world, 30);
    world.queueOrder(id, { kind: "moduleToggle", hardpointIndex: SHIELD });
    moduleSystem(world, DT);
    expect(shield.state).not.toBe("retracted");
  });
});
