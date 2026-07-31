import { beforeAll, describe, expect, it } from "vitest";

import type { ConfigService } from "../core/ConfigService.js";
import { botprofileSchema, type BotprofileConfig } from "../schemas/botprofile.js";
import type { ModuleConfig } from "../schemas/module.js";
import type { ModuleSnapshot, ShipSnapshot, Snapshot } from "../sim/ArenaSimulation.js";
import type { ModuleState } from "../sim/components.js";
import { INTERCEPTOR_FITTING_SHIELD as INTERCEPTOR_FITTING, loadTestConfigs } from "../sim/testutil.js";

/**
 * Slots the discipline may actually touch: the two hardpoints. The internal bay
 * (slots 2..6 — engine, generator, transformer, heatsink, sensors) is the ship
 * itself and is deliberately never cycled (2026-07-31).
 */
const TOGGLEABLE_SLOTS = 2;
import { buildBotContext } from "./context.js";
import { planModuleOrders } from "./moduleDiscipline.js";

let configs: ConfigService;

beforeAll(async () => {
  configs = await loadTestConfigs();
});

const discipline = {
  heatShutdownAt: 0.85,
  reactivateBelow: 0.5,
  energyReserve: 0.15,
  shieldOnlyWhenEngaged: true,
};

function profile(): BotprofileConfig {
  return botprofileSchema.parse({
    id: "bot.test",
    type: "botprofile",
    version: 1,
    decisionIntervalMs: 400,
    orderJitterMs: 0,
    preferredRange: [20, 35],
    behaviors: { engage: { baseWeight: 1 } },
    moduleDiscipline: discipline,
  });
}

/** Build a ship snapshot from the real interceptor fitting. */
function shipWith(
  states: ModuleState[],
  opts: { moduleHeat?: number[]; shipHeat?: number; energy?: number } = {},
): ShipSnapshot {
  const modules: ModuleSnapshot[] = INTERCEPTOR_FITTING.map((moduleId, i) => ({
    moduleId,
    hardpointIndex: i,
    state: states[i] ?? "retracted",
    heat: opts.moduleHeat?.[i] ?? 0,
    stateTimer: 0,
    cycleTimer: 0,
    channeling: false,
    shieldPool: 0,
  }));
  return {
    id: 1,
    team: 0,
    pos: { x: 0, y: 0, z: 0 },
    pitch: 0,
    heading: 0,
    up: { x: 0, y: 1, z: 0 },
    hull: 100,
    hullMax: 100,
    energy: { cur: opts.energy ?? 100, max: 100 },
    heat: { cur: opts.shipHeat ?? 0, capacity: 100 },
    targetId: 2,
    throttle: 0,
    lockProgress: 0,
    locked: false,
    modules,
  };
}

function contextFor(self: ShipSnapshot) {
  const enemy: ShipSnapshot = { ...shipWith([]), id: 2, team: 1, pos: { x: 25, y: 0, z: 0 }, targetId: 1 };
  const snapshot: Snapshot = {
    tick: 1,
    elapsed: 1,
    phase: "live",
    countdownRemaining: 0,
    teamScores: [],
    winnerTeam: null,
    ships: [self, enemy],
    asteroids: [],
    projectiles: [],
    decoys: [],
  };
  return buildBotContext({
    snapshot,
    self,
    profile: profile(),
    weaponRange: 40,
    targetId: 2,
    missileScanRadius: 70,
    orbitSign: 1,
    rng: () => 0,
  });
}

/** Overheat threshold of the module at a hardpoint index of the test fitting. */
function threshold(index: number): number {
  return configs.get<ModuleConfig>("module", INTERCEPTOR_FITTING[index]!)!.heat.overheatThreshold;
}

function shieldIndex(): number {
  return INTERCEPTOR_FITTING.findIndex(
    (id) => configs.get<ModuleConfig>("module", id)!.family === "shield",
  );
}

describe("moduleDiscipline", () => {
  it("activates cool modules when engaged and above the energy reserve", () => {
    const self = shipWith(["retracted", "retracted", "retracted", "retracted"]);
    const { orders, decisions } = planModuleOrders(contextFor(self), configs, discipline, true);
    expect(orders.length).toBe(TOGGLEABLE_SLOTS);
    expect(decisions.every((d) => d.activate)).toBe(true);
  });

  it("shuts a module down at heatShutdownAt and reactivates it below reactivateBelow", () => {
    const laser = 0;
    const heats = [threshold(laser) * 0.9, 0, 0, 0];
    const hot = shipWith(["active", "active", "active", "active"], { moduleHeat: heats });
    const shutdown = planModuleOrders(contextFor(hot), configs, discipline, true);
    expect(shutdown.decisions).toContainEqual(
      expect.objectContaining({ hardpointIndex: laser, activate: false, reason: "heat-shutdown" }),
    );
    // Other modules stay up.
    expect(shutdown.orders.length).toBe(1);

    // Still hot after retracting (0.6 > reactivateBelow 0.5) ⇒ no reactivation.
    const warm = shipWith(["retracted", "active", "active", "active"], {
      moduleHeat: [threshold(laser) * 0.6, 0, 0, 0],
    });
    expect(planModuleOrders(contextFor(warm), configs, discipline, true).orders).toEqual([]);

    // Cooled below the threshold ⇒ redeploy.
    const cool = shipWith(["retracted", "active", "active", "active"], {
      moduleHeat: [threshold(laser) * 0.2, 0, 0, 0],
    });
    expect(planModuleOrders(contextFor(cool), configs, discipline, true).decisions).toContainEqual(
      expect.objectContaining({ hardpointIndex: laser, activate: true }),
    );
  });

  it("treats the ship heat pool as a shutdown trigger too", () => {
    const self = shipWith(["active", "active", "active", "active"], { shipHeat: 90 });
    const { decisions } = planModuleOrders(contextFor(self), configs, discipline, true);
    expect(decisions.length).toBe(TOGGLEABLE_SLOTS);
    expect(decisions.every((d) => !d.activate && d.reason === "heat-shutdown")).toBe(true);
  });

  it("respects energyReserve: nothing is activated below the reserve fraction", () => {
    const poor = shipWith(["retracted", "retracted", "retracted", "retracted"], { energy: 10 });
    expect(planModuleOrders(contextFor(poor), configs, discipline, true).orders).toEqual([]);

    const rich = shipWith(["retracted", "retracted", "retracted", "retracted"], { energy: 20 });
    expect(planModuleOrders(contextFor(rich), configs, discipline, true).orders.length).toBeGreaterThan(0);
  });

  it("toggles the shield with the engagement flag when shieldOnlyWhenEngaged", () => {
    const idx = shieldIndex();
    expect(idx).toBeGreaterThanOrEqual(0);

    const states: ModuleState[] = ["retracted", "retracted", "retracted", "retracted"];
    const disengaged = planModuleOrders(contextFor(shipWith(states)), configs, discipline, false);
    expect(disengaged.decisions.some((d) => d.hardpointIndex === idx)).toBe(false);

    const engaged = planModuleOrders(contextFor(shipWith(states)), configs, discipline, true);
    expect(engaged.decisions).toContainEqual(
      expect.objectContaining({ hardpointIndex: idx, activate: true }),
    );

    // Active shield + disengaged ⇒ retract.
    const active: ModuleState[] = ["active", "active", "active", "active"];
    const drop = planModuleOrders(contextFor(shipWith(active)), configs, discipline, false);
    expect(drop.decisions).toContainEqual(
      expect.objectContaining({ hardpointIndex: idx, activate: false, reason: "shield-disengaged" }),
    );

    // ...and a profile that does not gate the shield leaves it alone.
    const ungated = { ...discipline, shieldOnlyWhenEngaged: false };
    const keep = planModuleOrders(contextFor(shipWith(active)), configs, ungated, false);
    expect(keep.orders).toEqual([]);
  });

  it("never toggles modules mid-transition or force-overheated", () => {
    const self = shipWith(["deploying", "retracting", "overheated", "overheated"]);
    expect(planModuleOrders(contextFor(self), configs, discipline, true).orders).toEqual([]);
  });
});
