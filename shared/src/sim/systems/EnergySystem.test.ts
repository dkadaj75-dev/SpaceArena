import { beforeAll, describe, expect, it } from "vitest";
import type { ConfigService } from "../../core/ConfigService.js";
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
  configs = await loadTestConfigs();
});

function shipWorld(fitting: readonly (string | null)[] = INTERCEPTOR_FITTING): { world: World; id: number } {
  const world = makeWorld(configs);
  const id = spawnShipFromConfig(world, configs, "ship.interceptor", fitting, 0, { x: 0, z: 0 }, 0);
  return { world, id };
}

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
 * and the tank are the same pool (energy overhaul 2026-08-07). Anything
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
