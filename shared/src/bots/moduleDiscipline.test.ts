import { beforeAll, describe, expect, it } from "vitest";

import type { ConfigService } from "../core/ConfigService.js";
import { botprofileSchema, type BotprofileConfig } from "../schemas/botprofile.js";
import type { ModuleConfig } from "../schemas/module.js";
import type { ModuleSnapshot, ShipSnapshot, Snapshot } from "../sim/ArenaSimulation.js";
import type { ModuleState } from "../sim/components.js";
import { INTERCEPTOR_FITTING_SHIELD as INTERCEPTOR_FITTING, loadTestConfigs } from "../sim/testutil.js";

/**
 * Slots the discipline may actually touch: non-weapon support hardpoints. The internal bay
 * (slots 2..6 — engine, generator, transformer, heatsink, sensors) is the ship
 * itself and is deliberately never cycled (2026-07-31).
 */
const TOGGLEABLE_SLOTS = 1;
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
  opts: { moduleHeat?: number[]; shipHeat?: number; energy?: number; moduleEnergy?: number[] } = {},
): ShipSnapshot {
  const modules: ModuleSnapshot[] = INTERCEPTOR_FITTING.map((moduleId, i) => ({
    moduleId,
    hardpointIndex: i,
    state: states[i] ?? "retracted",
    heat: opts.moduleHeat?.[i] ?? 0,
    heatCapacity: 100,
    energy: (opts.moduleEnergy?.[i] ?? opts.energy ?? 100) * 0.01 * 100,
    energyCapacity: 100,
    stateTimer: 0,
    rounds: 0,
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
    flags: [],
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

/**
 * Heat capacity of the rack at a hardpoint index of the test fitting. Every
 * module in {@link shipWith} is given the same round capacity, so a discipline
 * fraction reads directly off it.
 */
function threshold(_index: number): number {
  return 100;
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

  it("leaves weapon cooling to fire discipline and cycles hot support modules", () => {
    const laser = 0;
    const support = shieldIndex();
    const heats = [threshold(laser) * 0.9, threshold(support) * 0.9, 0, 0];
    const hot = shipWith(["active", "active", "active", "active"], { moduleHeat: heats });
    const shutdown = planModuleOrders(contextFor(hot), configs, discipline, true);
    expect(shutdown.decisions.some((decision) => decision.hardpointIndex === laser)).toBe(false);
    expect(shutdown.decisions).toContainEqual(
      expect.objectContaining({ hardpointIndex: support, activate: false, reason: "heat-shutdown" }),
    );
    // Other modules stay up.
    expect(shutdown.orders.length).toBe(1);

    // Still hot after retracting (0.6 > reactivateBelow 0.5) ⇒ no reactivation.
    const warm = shipWith(["active", "retracted", "active", "active"], {
      moduleHeat: [0, threshold(support) * 0.6, 0, 0],
    });
    expect(planModuleOrders(contextFor(warm), configs, discipline, true).orders).toEqual([]);

    // Cooled below the threshold ⇒ redeploy.
    const cool = shipWith(["active", "retracted", "active", "active"], {
      moduleHeat: [0, threshold(support) * 0.2, 0, 0],
    });
    expect(planModuleOrders(contextFor(cool), configs, discipline, true).decisions).toContainEqual(
      expect.objectContaining({ hardpointIndex: support, activate: true }),
    );
  });

  it("treats the ship's HOTTEST RACK as a shutdown trigger too", () => {
    // There is no ship heat pool since 2026-08-07 — `ctx.heatFraction` is the
    // hottest module — so a cooking weapon still pulls the support modules down.
    const self = shipWith(["active", "active", "active", "active"], { moduleHeat: [90, 0, 0, 0] });
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

  it("gates shield activation on the shield's own tank, not another module's empty one", () => {
    const idx = shieldIndex();
    const self = shipWith(["retracted", "retracted", "retracted", "retracted"]);
    self.modules.push({
      ...self.modules[idx]!,
      moduleId: "module.shield-skirmish",
      hardpointIndex: self.modules.length,
      energy: 0,
    });

    expect(planModuleOrders(contextFor(self), configs, discipline, true).decisions).toContainEqual(
      expect.objectContaining({ hardpointIndex: idx, activate: true }),
    );
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

describe("shield collapse cooldown", () => {
  /** The shield hardpoint of the test fitting, with `cycleTimer` seconds left on its lockout. */
  function collapsedShield(secondsLeft: number): ShipSnapshot {
    const self = shipWith(["active", "retracted"]);
    const shield = self.modules[TOGGLEABLE_SLOTS]!;
    return {
      ...self,
      modules: self.modules.map((m) => (m === shield ? { ...m, cycleTimer: secondsLeft } : m)),
    };
  }

  it("does not re-issue a toggle the sim would refuse", () => {
    // Everything else says raise it — engaged, cool, tank full — so the ONLY
    // thing holding the order back is the collapse lockout.
    const self = collapsedShield(6);
    const plan = planModuleOrders(contextFor(self), configs, discipline, true);
    expect(plan.orders).toHaveLength(0);
    expect(plan.decisions).toHaveLength(0);
  });

  it("raises it again as soon as the lockout expires", () => {
    // Same snapshot with the clock run out: the bot must not stay shy of a
    // shield it is now allowed to use.
    const self = collapsedShield(0);
    const plan = planModuleOrders(contextFor(self), configs, discipline, true);
    expect(plan.orders).toHaveLength(1);
    expect(plan.decisions[0]).toMatchObject({ hardpointIndex: TOGGLEABLE_SLOTS, activate: true });
  });
});
