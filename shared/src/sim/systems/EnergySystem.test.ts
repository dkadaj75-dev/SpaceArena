import { beforeAll, describe, expect, it } from "vitest";
import type { ConfigService } from "../../core/ConfigService.js";
import type { ModuleConfig } from "../../schemas/index.js";
import type { ModuleRuntime } from "../components.js";
import { applyDamageToShip } from "../damage.js";
import { spawnShipFromConfig } from "../spawn.js";
import {
  INTERCEPTOR_FITTING,
  INTERCEPTOR_FITTING_BOOST,
  INTERCEPTOR_FITTING_SHIELD,
  loadTestConfigs,
  makeWorld,
} from "../testutil.js";
import type { World } from "../World.js";
import { energySystem } from "./EnergySystem.js";

const DT = 1 / 30;

let configs: ConfigService;
beforeAll(async () => {
  configs = await loadTestConfigs({ heatSystem: true });
});

function shipWorld(fitting: readonly (string | null)[] = INTERCEPTOR_FITTING): { world: World; id: number } {
  const world = makeWorld(configs);
  const id = spawnShipFromConfig(world, configs, "ship.interceptor", fitting, 0, { x: 0, z: 0 }, 0);
  return { world, id };
}

/** Effective cooling of a rack on this hull, per second. */
function coolingOf(world: World, id: number, moduleId: string): number {
  const cfg = configs.get<ModuleConfig>("module", moduleId)!;
  return cfg.heat!.coolingPerSec * world.shipCores.get(id)!.cooling.multiplier;
}

describe("EnergySystem — per-module heat", () => {
  it("leaves authored heat inert when featureFlags.heatSystem is off", () => {
    const world = makeWorld(configs, { tuningOverride: { featureFlags: { heatSystem: false } } });
    const id = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 0, z: 0 }, 0);
    const laser = world.modules.get(id)!.modules[0]!;
    laser.heat = laser.heatCapacity;
    laser.workedThisTick = true;
    energySystem(world, DT);
    expect(laser.heat).toBe(laser.heatCapacity);
    expect(laser.state).toBe("active");
    expect(world.events.some((e) => e.type === "overheated")).toBe(false);
  });

  it("accumulates a rack's own heat while it works", () => {
    const { world, id } = shipWorld();
    const laser = world.modules.get(id)!.modules[0]!;
    laser.workedThisTick = true;
    energySystem(world, DT);
    // beam-less pulse lasers pay per SHOT (CombatSystem) — the per-second term
    // is 0 — so the only movement here is cooling. Give it a channel's rate.
    expect(laser.heat).toBe(0);

    const beamFitting: (string | null)[] = ["module.beamlaser-mk1", ...INTERCEPTOR_FITTING.slice(1)];
    const beamWorld = shipWorld(beamFitting);
    const beam = beamWorld.world.modules.get(beamWorld.id)!.modules[0]!;
    beam.workedThisTick = true;
    energySystem(beamWorld.world, DT);
    expect(beam.heat).toBeGreaterThan(0);
  });

  it("cools a resting rack at the authored rate times the hull's cooling multiplier", () => {
    const { world, id } = shipWorld();
    const laser = world.modules.get(id)!.modules[0]!;
    laser.heat = 60;
    energySystem(world, 1);
    expect(laser.heat).toBeCloseTo(60 - coolingOf(world, id, "module.laser-mk1"), 6);
  });

  it("scales cooling with fitted heatsink quality", () => {
    const rateFor = (sink: string): number => {
      const fitting = [...INTERCEPTOR_FITTING];
      fitting[5] = sink;
      const world = makeWorld(configs);
      const id = spawnShipFromConfig(world, configs, "ship.interceptor", fitting, 0, { x: 0, z: 0 }, 0);
      return world.shipCores.get(id)!.cooling.multiplier;
    };
    expect(rateFor("module.heatsink-mk2")).toBeGreaterThan(rateFor("module.heatsink-basic"));
    expect(rateFor("module.heatsink-mk3")).toBeGreaterThan(rateFor("module.heatsink-mk2"));
    expect(rateFor("module.heatsink-cryo")).toBeGreaterThan(rateFor("module.heatsink-mk3"));
    // With no sink at all the rack still cools — at its own authored rate.
    const bare: (string | null)[] = [...INTERCEPTOR_FITTING];
    bare[5] = null;
    const world = makeWorld(configs);
    const id = spawnShipFromConfig(world, configs, "ship.interceptor", bare, 0, { x: 0, z: 0 }, 0);
    expect(world.shipCores.get(id)!.cooling.multiplier).toBe(1);
  });

  it("locks a rack out at its own capacity and emits `overheated`", () => {
    const { world, id } = shipWorld();
    const laser = world.modules.get(id)!.modules[0]!;
    laser.heat = laser.heatCapacity + 5;
    energySystem(world, DT);
    expect(laser.state).toBe("overheated");
    expect(world.events.some((e) => e.type === "overheated" && e.hardpointIndex === 0)).toBe(true);
  });

  it("keeps cooling through the lockout and re-arms under `rearmBelow`", () => {
    const { world, id } = shipWorld();
    const laser = world.modules.get(id)!.modules[0]!;
    const cfg = configs.get<ModuleConfig>("module", "module.laser-mk1")!;
    // Comfortably past capacity: heat is cooled BEFORE the trip is evaluated,
    // so a rack sitting within one tick's cooling of its cap is not yet cooked.
    laser.heat = laser.heatCapacity + 5;
    energySystem(world, DT);
    expect(laser.state).toBe("overheated");

    const cooling = coolingOf(world, id, "module.laser-mk1");
    const seconds = (laser.heat - laser.heatCapacity * cfg.heat!.rearmBelow) / cooling;
    for (let t = 0; t < Math.ceil(seconds / DT) + 1; t++) energySystem(world, DT);
    expect(laser.state).toBe("active"); // weapons re-arm straight back online
    expect(laser.heat).toBeLessThanOrEqual(laser.heatCapacity * cfg.heat!.rearmBelow + 1e-9);
  });

  it("never damages the hull, however long a rack is held past its capacity", () => {
    const { world, id } = shipWorld();
    const core = world.shipCores.get(id)!;
    const laser = world.modules.get(id)!.modules[0]!;
    for (let t = 0; t < 30 * 60; t++) {
      laser.heat = laser.heatCapacity * 4; // pinned way past the trip point
      laser.workedThisTick = true;
      energySystem(world, DT);
    }
    expect(core.hull).toBe(core.hullMax);
    expect(world.events.some((e) => e.type === "damage")).toBe(false);
  });
});

describe("EnergySystem — per-module energy", () => {
  it("drains a working tank and refills a resting one", () => {
    const { world, id } = shipWorld(INTERCEPTOR_FITTING_BOOST);
    const engine = world.modules.get(id)!.modules.find((m) => m.energyCapacity > 0)!;
    engine.state = "active";
    engine.workedThisTick = true;
    energySystem(world, 1);
    const afterDrain = engine.energy;
    expect(afterDrain).toBeLessThan(engine.energyCapacity);

    engine.workedThisTick = false;
    energySystem(world, 1);
    expect(engine.energy).toBeGreaterThan(afterDrain);
  });

  it("cuts a module offline the moment its own tank runs dry", () => {
    const { world, id } = shipWorld(INTERCEPTOR_FITTING_BOOST);
    const engine = world.modules.get(id)!.modules.find((m) => m.energyCapacity > 0)!;
    engine.state = "active";
    engine.energy = 0.01;
    engine.workedThisTick = true;
    energySystem(world, DT);
    expect(engine.energy).toBe(0);
    expect(engine.state).toBe("retracted");
  });

  it("bills a raised shield its upkeep even on a tick nothing hits it", () => {
    const { world, id } = shipWorld(INTERCEPTOR_FITTING_SHIELD);
    const shield = world.modules.get(id)!.modules[1]!;
    shield.state = "active";
    const before = shield.energy;
    energySystem(world, 1);
    expect(shield.energy).toBeLessThan(before);
  });

  it("refills a retracted shield instead of billing it", () => {
    const { world, id } = shipWorld(INTERCEPTOR_FITTING_SHIELD);
    const shield = world.modules.get(id)!.modules[1]!;
    shield.state = "retracted";
    shield.energy = 1;
    energySystem(world, 1);
    expect(shield.energy).toBeGreaterThan(1);
  });

  it("scales refills with the fitted generator", () => {
    const rateFor = (gen: string): number => {
      const fitting = [...INTERCEPTOR_FITTING_BOOST];
      fitting[3] = gen;
      const world = makeWorld(configs);
      const id = spawnShipFromConfig(world, configs, "ship.interceptor", fitting, 0, { x: 0, z: 0 }, 0);
      return world.shipCores.get(id)!.recharge.multiplier;
    };
    expect(rateFor("module.generator-compact-mk2")).toBeGreaterThan(rateFor("module.generator-compact"));
    expect(rateFor("module.generator-siege")).toBeGreaterThan(rateFor("module.generator-heavy"));
  });
});

/**
 * The SHIELD COLLAPSE COOLDOWN (2026-08-18). A shield is the one module whose
 * reserve can be emptied by someone else, so it is the one module that pays for
 * running dry: `mitigation.collapseCooldownSec` on its own `cycleTimer`.
 *
 * The design point these cases pin is that there is exactly ONE collapse — the
 * flameout — and both narratives reach it. "Fire broke my shield" and "my shield
 * ran out of power" are the same event seen from two sides, because the reserve
 * and the tank are the same pool (heat/energy overhaul 2026-08-07). Anything
 * else that puts a shield down is NOT a collapse and must not be charged for.
 */
describe("EnergySystem — shield collapse cooldown", () => {
  const COOLDOWN = 8; // module.shield-mk1's authored collapseCooldownSec

  /** A ship with its shield raised, holding `reserve` points (default: a full tank). */
  function raisedShield(reserve?: number): { world: World; id: number; shield: ModuleRuntime } {
    const { world, id } = shipWorld(INTERCEPTOR_FITTING_SHIELD);
    const shield = world.modules.get(id)!.modules[1]!;
    shield.state = "active";
    shield.energy = reserve ?? shield.energyCapacity;
    return { world, id, shield };
  }

  it("charges the cooldown when UPKEEP alone empties the tank", () => {
    // Nothing is shooting: holding the bubble up is what spent the reserve.
    const { world, shield } = raisedShield(0.01);
    energySystem(world, DT);
    expect(shield.state).toBe("retracted");
    expect(shield.energy).toBe(0);
    expect(shield.cycleTimer).toBe(COOLDOWN);
  });

  it("charges the same cooldown when FIRE empties it, through the same flameout", () => {
    // Damage spends the reserve directly (damage.ts stage 2) and leaves it at 0;
    // the flameout lands on the next EnergySystem pass. One rule, two causes.
    const { world, id, shield } = raisedShield();
    applyDamageToShip(world, id, null, 500, "energy");
    expect(shield.energy).toBe(0);
    energySystem(world, DT);
    expect(shield.state).toBe("retracted");
    expect(shield.cycleTimer).toBe(COOLDOWN);
  });

  it("does NOT charge a shield that still has charge left", () => {
    // The guard against the cooldown leaking onto every tick of ordinary upkeep.
    const { world, shield } = raisedShield(40);
    energySystem(world, DT);
    expect(shield.state).toBe("active");
    expect(shield.cycleTimer).toBe(0);
  });

  it("does NOT charge a non-shield module that flames out", () => {
    // A boost tank running dry is a flameout too, but it is not a collapse:
    // only a module authoring `mitigation` pays this.
    const { world, id } = shipWorld(INTERCEPTOR_FITTING_BOOST);
    const engine = world.modules.get(id)!.modules.find((m) => m.energyCapacity > 0)!;
    engine.state = "active";
    engine.energy = 0.01;
    engine.workedThisTick = true;
    energySystem(world, DT);
    expect(engine.energy).toBe(0);
    expect(engine.cycleTimer).toBe(0);
  });
});
