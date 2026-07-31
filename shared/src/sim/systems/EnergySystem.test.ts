import { beforeAll, describe, expect, it } from "vitest";
import type { ConfigService } from "../../core/ConfigService.js";
import { spawnShipFromConfig } from "../spawn.js";
import { INTERCEPTOR_FITTING, loadTestConfigs, makeWorld } from "../testutil.js";
import type { World } from "../World.js";
import { energySystem } from "./EnergySystem.js";

const DT = 1 / 30;

let configs: ConfigService;
beforeAll(async () => {
  configs = await loadTestConfigs();
});

function shipWorld(): { world: World; id: number } {
  const world = makeWorld(configs);
  const id = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 0, z: 0 }, 0);
  return { world, id };
}

describe("EnergySystem", () => {
  it("regenerates the capacitor up to max when idle", () => {
    const { world, id } = shipWorld();
    const core = world.shipCores.get(id)!;
    core.capacitor.cur = 50;
    energySystem(world, DT);
    expect(core.capacitor.cur).toBeGreaterThan(50);
    expect(core.capacitor.cur).toBeLessThanOrEqual(core.capacitor.max);
  });

  it("never lets the capacitor go negative and browns out modules under load", () => {
    const { world, id } = shipWorld();
    const core = world.shipCores.get(id)!;
    const mods = world.modules.get(id)!.modules;
    for (const m of mods) m.state = "active";
    core.capacitor.cur = 5;

    let forcedRetract = false;
    for (let i = 0; i < 40; i++) {
      for (const m of mods) m.workedThisTick = true; // all firing/absorbing
      energySystem(world, DT);
      expect(core.capacitor.cur).toBeGreaterThanOrEqual(0);
      if (mods.some((m) => m.state === "retracted")) forcedRetract = true;
    }
    expect(forcedRetract).toBe(true);
  });

  it("browns out in reverse hardpoint order (highest index first)", () => {
    const { world, id } = shipWorld();
    const core = world.shipCores.get(id)!;
    const mods = world.modules.get(id)!.modules;
    for (const m of mods) m.state = "active";
    core.capacitor.cur = 0;
    for (const m of mods) m.workedThisTick = true;
    energySystem(world, DT);
    // Internals are never shed (2026-07-31) — cutting the engine to afford a
    // gun would be worse than the brown-out — so the highest-index WEAPON goes
    // first and the ship's systems stay up.
    expect(mods[1]!.state).toBe("retracted");
    expect(mods[0]!.state).toBe("active");
    expect(mods[2]!.state).toBe("active"); // engine bay untouched
  });

  it("accumulates module heat while working (dissipation off)", () => {
    const { world, id } = shipWorld();
    const core = world.shipCores.get(id)!;
    core.heat.dissipation = 0; // isolate generation
    const laser = world.modules.get(id)!.modules[0]!;
    laser.state = "active";
    laser.workedThisTick = true;
    energySystem(world, DT);
    expect(laser.heat).toBeGreaterThan(0);
  });

  it("dissipates module heat when idle", () => {
    const { world, id } = shipWorld();
    const laser = world.modules.get(id)!.modules[0]!;
    laser.state = "active";
    laser.heat = 10;
    laser.workedThisTick = false; // not working → net cooling
    energySystem(world, DT);
    expect(laser.heat).toBeLessThan(10);
  });

  it("sets the shared ship heat pool to the sum of module heats", () => {
    const { world, id } = shipWorld();
    const core = world.shipCores.get(id)!;
    const mods = world.modules.get(id)!.modules;
    mods[0]!.heat = 10;
    mods[1]!.heat = 5;
    energySystem(world, DT);
    // Pool ≈ 15 minus a little dissipation.
    expect(core.heat.cur).toBeGreaterThan(10);
    expect(core.heat.cur).toBeLessThanOrEqual(15);
  });
});
