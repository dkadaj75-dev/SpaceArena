import { beforeAll, describe, expect, it } from "vitest";
import type { ConfigService } from "../core/ConfigService.js";
import { COMBAT_MULT_MAX, COMBAT_MULT_MIN } from "../schemas/common.js";
import type { ModuleConfig, ShipConfig } from "../schemas/index.js";
import type { EntityId } from "./components.js";
import { applyDamageToShip } from "./damage.js";
import { reresolveShipCore, reresolveShipsUsingConfig } from "./reresolveShip.js";
import { effectiveCycleTime, rateOfFireFor, resolveShipStats } from "./resolveStats.js";
import { moduleTankCapacity, spawnShipFromConfig } from "./spawn.js";
import { combatSystem } from "./systems/CombatSystem.js";
import { energySystem } from "./systems/EnergySystem.js";
import { INTERCEPTOR_FITTING, INTERCEPTOR_FITTING_SHIELD, loadTestConfigs, makeWorld, rebuildSpatial } from "./testutil.js";
import type { World } from "./World.js";

/**
 * HULL ROLE PROFILE (`core.combat`, owner request 2026-08-21) — outgoing damage
 * per leaf type, rate of fire per weapon type, shield reserve efficiency.
 *
 * The contract these pin, in one line each:
 *   - absent block ⇒ every multiplier is 1 ⇒ the pre-feature sim, exactly;
 *   - a knob scales what it says it scales, and nothing else;
 *   - a HYBRID hit is scaled per LEAF, so a kinetic specialist boosts exactly
 *     the kinetic half of a missile;
 *   - the resolver holds the post-upgrade value inside the authorable band.
 *
 * The light hull (`ship.interceptor`) is the fixture throughout: 0 energy
 * resist, 0.1 kinetic resist.
 */

const SHIELD = 1; // the light hull mounts a shield on hardpoint 1

let configs: ConfigService;
beforeAll(async () => {
  configs = await loadTestConfigs();
  // The shipped light hull is DESIGNER-OWNED content: it carries whatever role
  // profile the F10 tool last saved, and this suite is about the mechanism, not
  // about today's balance pass. Install a profile-free baseline in this file's
  // own in-memory registry (loadTestConfigs builds a fresh ConfigService and
  // `replace` never touches disk), so every case starts from all-1 no matter
  // what the pack currently authors.
  const shipped = configs.get<ShipConfig>("ship", "ship.interceptor")!;
  const core = { ...shipped.core };
  delete (core as Record<string, unknown>)["combat"];
  const result = configs.replace({ ...shipped, core });
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
});

function interceptor(): ShipConfig {
  return configs.get<ShipConfig>("ship", "ship.interceptor")!;
}

/** Spawn a ship and force its RESOLVED profile — the artifact the sim reads. */
function shipWithProfile(
  world: World,
  combat: Partial<{
    damageOutput: { kinetic: number; energy: number };
    rateOfFire: { kinetic: number; energy: number; hybrid: number };
    shieldEfficiency: number;
  }>,
  fitting = INTERCEPTOR_FITTING,
  team = 0,
): EntityId {
  const id = spawnShipFromConfig(world, configs, "ship.interceptor", fitting, team, { x: 0, z: 0 }, 0);
  const core = world.shipCores.get(id)!;
  core.combat = { ...core.combat, ...combat };
  return id;
}

describe("resolveShipStats — the role profile", () => {
  it("resolves an absent block to all-1, the pre-feature hull exactly", () => {
    const core = resolveShipStats(interceptor(), configs);
    expect(core.combat).toEqual({
      damageOutput: { kinetic: 1, energy: 1 },
      rateOfFire: { kinetic: 1, energy: 1, hybrid: 1 },
      shieldEfficiency: 1,
    });
  });

  it("carries authored knobs through, leaving unauthored siblings at 1", () => {
    const ship: ShipConfig = {
      ...interceptor(),
      core: {
        ...interceptor().core,
        combat: { damageOutput: { kinetic: 1.5 }, shieldEfficiency: 2 },
      },
    };
    const core = resolveShipStats(ship, configs);
    expect(core.combat.damageOutput.kinetic).toBe(1.5);
    expect(core.combat.damageOutput.energy).toBe(1);
    expect(core.combat.rateOfFire.hybrid).toBe(1);
    expect(core.combat.shieldEfficiency).toBe(2);
  });

  it("holds a passive-stacked value inside the band rather than merely above 0", () => {
    // A utility whose passive multiplies the knob far past the authorable max:
    // the schema bounds the FILE, the resolver has to bound the STACK.
    const stock = configs.get<ModuleConfig>("module", "module.sensors-common-mk1")!;
    const boosted: ModuleConfig = {
      ...stock,
      id: "module.test-dps-passive",
      passives: [
        { target: "core.combat.damageOutput.kinetic", op: "mul", value: 10 },
        { target: "combat.rateOfFire.energy", op: "mul", value: 0.001 },
      ],
    };
    const patched = configs.replace(boosted);
    expect(patched.ok).toBe(true);

    const ship: ShipConfig = {
      ...interceptor(),
      core: { ...interceptor().core, combat: { damageOutput: { kinetic: 2 } } },
    };
    const core = resolveShipStats(ship, configs, { fittedModuleIds: ["module.test-dps-passive"] });
    expect(core.combat.damageOutput.kinetic).toBe(COMBAT_MULT_MAX);
    expect(core.combat.rateOfFire.energy).toBe(COMBAT_MULT_MIN);
  });
});

describe("outgoing damage multipliers", () => {
  /** Hull points the TARGET loses from one unshielded hit by `attacker`. */
  function hullLoss(world: World, attacker: EntityId, target: EntityId, amount: number, type: "kinetic" | "energy" | "hybrid"): number {
    const core = world.shipCores.get(target)!;
    const before = core.hull;
    applyDamageToShip(world, target, attacker, amount, type);
    return before - core.hull;
  }

  it("scales a kinetic hit by the attacker's kinetic knob and leaves energy alone", () => {
    const world = makeWorld(configs);
    const attacker = shipWithProfile(world, { damageOutput: { kinetic: 2, energy: 1 } });
    const plain = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 1, { x: 50, z: 0 }, 0);
    const other = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 1, { x: 60, z: 0 }, 0);

    const boosted = hullLoss(world, attacker, plain, 20, "kinetic");
    const baseline = hullLoss(world, plain, other, 20, "kinetic");
    expect(boosted).toBeCloseTo(baseline * 2, 10);

    const energyBoosted = hullLoss(world, attacker, plain, 20, "energy");
    const energyBaseline = hullLoss(world, plain, other, 20, "energy");
    expect(energyBoosted).toBeCloseTo(energyBaseline, 10);
  });

  it("scales only the KINETIC half of a hybrid warhead", () => {
    const world = makeWorld(configs);
    const attacker = shipWithProfile(world, { damageOutput: { kinetic: 3, energy: 1 } });
    const plain = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 1, { x: 50, z: 0 }, 0);
    const other = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 1, { x: 60, z: 0 }, 0);

    const baselineK = hullLoss(world, plain, other, 20, "kinetic");
    const baselineE = hullLoss(world, plain, other, 20, "energy");
    const boostedHybrid = hullLoss(world, attacker, plain, 20, "hybrid");
    // Shipped mix is 50/50; each half runs its own leaf profile and resist, so
    // the expectation is built from the two leaf baselines rather than assumed.
    expect(boostedHybrid).toBeCloseTo((baselineK * 3 + baselineE) / 2, 10);
  });

  it("leaves an ownerless hit (hazard, dead attacker) unscaled", () => {
    const world = makeWorld(configs);
    const target = shipWithProfile(world, { damageOutput: { kinetic: 4, energy: 4 } });
    const core = world.shipCores.get(target)!;
    const before = core.hull;
    applyDamageToShip(world, target, null, 20, "kinetic");
    // The knob belongs to the ATTACKER: a hull cannot boost damage aimed at it.
    expect(before - core.hull).toBeCloseTo(20 * 0.9, 10);
  });
});

describe("rate of fire", () => {
  it("divides the authored cycle time, keyed by the weapon's own damage type", () => {
    const core = resolveShipStats(interceptor(), configs);
    core.combat.rateOfFire = { kinetic: 2, energy: 0.5, hybrid: 1 };
    expect(effectiveCycleTime(core, 1, "kinetic")).toBeCloseTo(0.5, 10);
    expect(effectiveCycleTime(core, 1, "energy")).toBeCloseTo(2, 10);
    expect(effectiveCycleTime(core, 1, "hybrid")).toBeCloseTo(1, 10);
  });

  it("is what CombatSystem actually stamps on the cycle timer after a shot", () => {
    const world = makeWorld(configs);
    // No lock, no target: the straight-fire path still spends a full cycle,
    // which is exactly the number under test here.
    const shooter = shipWithProfile(world, { rateOfFire: { kinetic: 1, energy: 2, hybrid: 1 } });
    for (const m of world.modules.get(shooter)!.modules) m.state = "retracted";
    const laser = world.modules.get(shooter)!.modules[0]!;
    laser.state = "active";
    laser.cycleTimer = 0;
    world.flightStates.set(shooter, {
      throttle: 0, turn: 0, pitchStick: 0, boost: false, fire: true, firePrev: false, triggers: 0,
    });
    rebuildSpatial(world);
    combatSystem(world, 1 / 30);

    const cfg = configs.get<ModuleConfig>("module", "module.laser-mk1")!;
    // `module.laser-mk1` is energy, and this hull cycles energy twice as fast.
    expect(laser.cycleTimer).toBeCloseTo(cfg.fire!.cycleTime / 2, 10);
  });

  it("routes hybrid weapons to the hybrid bucket, not to a leaf", () => {
    const core = resolveShipStats(interceptor(), configs);
    core.combat.rateOfFire = { kinetic: 4, energy: 4, hybrid: 0.5 };
    // A missile authors `hybrid`, so the missile bucket decides — the kinetic
    // and energy knobs at 4 must not touch it.
    expect(rateOfFireFor(core, "hybrid")).toBe(0.5);
  });
});

describe("live re-resolve (F10 ship tool during a match)", () => {
  /** Install an edited `ship.interceptor` the way `configService.replace` does. */
  function editInterceptor(combat: Record<string, unknown>): void {
    const result = configs.replace({
      ...interceptor(),
      core: { ...interceptor().core, combat },
    });
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
  }

  /** Restore the shipped hull so one case cannot leak into the next. */
  function restoreInterceptor(): void {
    const core = { ...interceptor().core };
    delete (core as Record<string, unknown>)["combat"];
    const result = configs.replace({ ...interceptor(), core });
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
  }

  it("reaches a hull that is already flying, without a respawn", () => {
    const world = makeWorld(configs);
    const id = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 0, z: 0 }, 0);
    expect(world.shipCores.get(id)!.combat.damageOutput.kinetic).toBe(1);

    try {
      editInterceptor({ damageOutput: { kinetic: 2.5 }, rateOfFire: { energy: 2 } });
      expect(reresolveShipsUsingConfig(world, configs, "ship.interceptor")).toBe(1);
      const core = world.shipCores.get(id)!;
      expect(core.combat.damageOutput.kinetic).toBe(2.5);
      expect(core.combat.rateOfFire.energy).toBe(2);
    } finally {
      restoreInterceptor();
    }
  });

  it("touches only ships flying the edited config", () => {
    const world = makeWorld(configs);
    const light = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 0, z: 0 }, 0);
    const brawler = configs.get<ShipConfig>("ship", "ship.brawler")!;
    const heavy = spawnShipFromConfig(world, configs, "ship.brawler", brawler.defaultFitting, 1, { x: 60, z: 0 }, 0);
    try {
      editInterceptor({ damageOutput: { kinetic: 3 } });
      expect(reresolveShipsUsingConfig(world, configs, "ship.interceptor")).toBe(1);
      expect(world.shipCores.get(light)!.combat.damageOutput.kinetic).toBe(3);
      expect(world.shipCores.get(heavy)!.combat.damageOutput.kinetic).toBe(1);
    } finally {
      restoreInterceptor();
    }
  });

  it("is an exact no-op when the config did not actually move", () => {
    const world = makeWorld(configs);
    const id = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 0, z: 0 }, 0);
    const core = world.shipCores.get(id)!;
    core.hull = core.hullMax * 0.37;
    const hullBefore = core.hull;
    const shield = world.modules.get(id)!.modules[1]!;
    const energyBefore = shield.energy;

    reresolveShipCore(world, configs, id);
    // Not `toBeCloseTo`: a designer-tool seam that runs on every config:changed
    // must not drift a flying ship's state by a float ulp per keystroke.
    expect(core.hull).toBe(hullBefore);
    expect(shield.energy).toBe(energyBefore);
  });

  it("keeps the hull FRACTION across a hull-size change", () => {
    const world = makeWorld(configs);
    const id = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 0, z: 0 }, 0);
    const core = world.shipCores.get(id)!;
    core.hull = core.hullMax / 2;

    const base = interceptor();
    const result = configs.replace({
      ...base,
      core: { ...base.core, hull: { ...base.core.hull, base: base.core.hull.base * 2 } },
    });
    expect(result.ok).toBe(true);
    try {
      reresolveShipCore(world, configs, id);
      expect(core.hullMax).toBe(base.core.hull.base * 2);
      // Half-health stays half-health: a bigger hull is not a heal.
      expect(core.hull).toBeCloseTo(core.hullMax / 2, 10);
    } finally {
      const restored = configs.replace(base);
      expect(restored.ok).toBe(true);
    }
  });

  it("rescales a shield reserve by state of charge, not by refilling it", () => {
    const world = makeWorld(configs);
    const id = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING_SHIELD, 0, { x: 0, z: 0 }, 0);
    const shield = world.modules.get(id)!.modules[SHIELD]!;
    const capacityBefore = shield.energyCapacity;
    shield.energy = capacityBefore / 4;

    try {
      editInterceptor({ shieldEfficiency: 2 });
      reresolveShipCore(world, configs, id);
      expect(shield.energyCapacity).toBeCloseTo(capacityBefore * 2, 10);
      // A quarter tank is still a quarter tank — a bigger bubble, not a free recharge.
      expect(shield.energy).toBeCloseTo(shield.energyCapacity / 4, 10);
    } finally {
      restoreInterceptor();
    }
  });

  it("never leaves a tank holding more than a shrunken capacity", () => {
    const world = makeWorld(configs);
    const id = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING_SHIELD, 0, { x: 0, z: 0 }, 0);
    const shield = world.modules.get(id)!.modules[SHIELD]!;
    shield.energy = shield.energyCapacity;

    try {
      editInterceptor({ shieldEfficiency: 0.5 });
      reresolveShipCore(world, configs, id);
      expect(shield.energy).toBeLessThanOrEqual(shield.energyCapacity);
      expect(shield.energy).toBeCloseTo(shield.energyCapacity, 10);
    } finally {
      restoreInterceptor();
    }
  });

  it("rescales a running weapon cycle without granting a free shot", () => {
    const world = makeWorld(configs);
    const id = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 0, z: 0 }, 0);
    const laser = world.modules.get(id)!.modules[0]!;
    const cfg = configs.get<ModuleConfig>("module", "module.laser-mk1")!;
    laser.cycleTimer = cfg.fire!.cycleTime; // just fired

    try {
      editInterceptor({ rateOfFire: { energy: 2 } });
      reresolveShipCore(world, configs, id);
      // Doubling the fire rate halves the wait already being served...
      expect(laser.cycleTimer).toBeCloseTo(cfg.fire!.cycleTime / 2, 10);
      // ...but never zeroes it: the weapon is still on cooldown.
      expect(laser.cycleTimer).toBeGreaterThan(0);
    } finally {
      restoreInterceptor();
    }
  });

  it("leaves a collapsed shield's lockout alone — that timer is not cadence", () => {
    const world = makeWorld(configs);
    const id = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING_SHIELD, 0, { x: 0, z: 0 }, 0);
    const shield = world.modules.get(id)!.modules[SHIELD]!;
    // A collapsed shield parks `collapseCooldownSec` on the same field a weapon
    // uses for its cycle. Rate of fire must not touch it.
    shield.cycleTimer = 8;

    try {
      editInterceptor({ rateOfFire: { energy: 4, kinetic: 4, hybrid: 4 } });
      reresolveShipCore(world, configs, id);
      expect(shield.cycleTimer).toBe(8);
    } finally {
      restoreInterceptor();
    }
  });

  it("reports nothing to do for an entity the sim never spawned", () => {
    const world = makeWorld(configs);
    expect(reresolveShipCore(world, configs, 999)).toBe(false);
    expect(reresolveShipsUsingConfig(world, configs, "ship.interceptor")).toBe(0);
  });
});

describe("shield efficiency", () => {
  it("scales a SHIELD's reserve at spawn and leaves other tanks alone", () => {
    const core = resolveShipStats(interceptor(), configs);
    core.combat.shieldEfficiency = 2;
    const shield = configs.get<ModuleConfig>("module", "module.shield-mk1")!;
    const engine = configs.get<ModuleConfig>("module", "module.engine-earth-eng2")!;

    expect(moduleTankCapacity(shield, core)).toBeCloseTo(
      shield.energy!.capacity * core.energyStore.multiplier * 2,
      10,
    );
    // The boost bottle is a tank too, and it is NOT a shield.
    expect(moduleTankCapacity(engine, core)).toBeCloseTo(
      engine.energy!.capacity * core.energyStore.multiplier,
      10,
    );
  });

  it("refills a shield faster by the same factor", () => {
    const world = makeWorld(configs);
    const id = shipWithProfile(world, { shieldEfficiency: 2 }, INTERCEPTOR_FITTING_SHIELD);
    const shield = world.modules.get(id)!.modules[SHIELD]!;
    // Retracted: not working, so this tick is a pure refill.
    shield.state = "retracted";
    shield.workedThisTick = false;
    shield.energy = 0;
    energySystem(world, 1);

    const cfg = configs.get<ModuleConfig>("module", "module.shield-mk1")!;
    const core = world.shipCores.get(id)!;
    const expected = cfg.energy!.rechargePerSec * core.recharge.multiplier * 2;
    expect(shield.energy).toBeCloseTo(Math.min(shield.energyCapacity, expected), 10);
    // Sanity: the doubled rate really is above the undoubled one, i.e. the tank
    // did not simply cap out and hide the effect.
    expect(expected).toBeGreaterThan(cfg.energy!.rechargePerSec * core.recharge.multiplier);
  });

  it("does not change the SHARE a shield takes out of a hit", () => {
    const world = makeWorld(configs);
    const tank = shipWithProfile(world, { shieldEfficiency: 3 }, INTERCEPTOR_FITTING_SHIELD, 1);
    const shield = world.modules.get(tank)!.modules[SHIELD]!;
    shield.state = "active";
    shield.energy = shield.energyCapacity;

    const before = shield.energy;
    applyDamageToShip(world, tank, null, 20, "energy");
    // Energy's shipped shield share is 0.8 — a property of the damage type, not
    // of the hull. Efficiency buys a bigger tank, never a better ratio.
    expect(before - shield.energy).toBeCloseTo(16, 10);
  });
});
