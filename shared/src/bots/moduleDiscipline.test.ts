import { beforeAll, describe, expect, it } from "vitest";

import type { ConfigService } from "../core/ConfigService.js";
import { botprofileSchema, type BotprofileConfig } from "../schemas/botprofile.js";
import type { ModuleConfig } from "../schemas/module.js";
import type { ModuleSnapshot, ShipSnapshot, Snapshot } from "../sim/ArenaSimulation.js";
import type { ModuleState } from "../sim/components.js";
import { INTERCEPTOR_FITTING_SHIELD as INTERCEPTOR_FITTING, loadTestConfigs } from "../sim/testutil.js";

/**
 * Slots the discipline may actually touch: non-weapon support hardpoints. The internal bay
 * (slots 2..6 — engine, generator, alloy, countermeasure, sensors) is the ship
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
  opts: { energy?: number; moduleEnergy?: number[] } = {},
): ShipSnapshot {
  const modules: ModuleSnapshot[] = INTERCEPTOR_FITTING.map((moduleId, i) => ({
    moduleId,
    hardpointIndex: i,
    state: states[i] ?? "retracted",
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

/** `extra` seats additional ships (wingmen) alongside the standing enemy. */
function contextFor(self: ShipSnapshot, extra: readonly ShipSnapshot[] = []) {
  const enemy: ShipSnapshot = { ...shipWith([]), id: 2, team: 1, pos: { x: 25, y: 0, z: 0 }, targetId: 1 };
  const snapshot: Snapshot = {
    tick: 1,
    elapsed: 1,
    phase: "live",
    countdownRemaining: 0,
    teamScores: [],
    winnerTeam: null,
    ships: [self, enemy, ...extra],
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

  it("never touches a weapon rack — fire discipline owns the trigger, not the deploy toggle", () => {
    // Since heat was deleted (2026-08-20) nothing in this planner has an opinion
    // about a weapon at all: a rack is limited by its own cycle time, and
    // retracting it would only add deploy downtime for nothing.
    const laser = 0;
    const up = shipWith(["active", "active", "active", "active"]);
    const plan = planModuleOrders(contextFor(up), configs, discipline, true);
    expect(plan.decisions.some((decision) => decision.hardpointIndex === laser)).toBe(false);
    expect(plan.orders).toEqual([]);
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

  it("never toggles modules mid-transition or reloading", () => {
    const self = shipWith(["deploying", "retracting", "reloading", "reloading"]);
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

describe("support pulses (owner 2026-08-22)", () => {
  /**
   * The test fitting with the pulse module in the shield's slot, so the rest of
   * the harness above (which builds a light hull's seven slots) is unchanged.
   */
  function shipWithPulse(moduleId: string, over: Partial<ModuleSnapshot> = {}): ShipSnapshot {
    const self = shipWith([]);
    self.modules[TOGGLEABLE_SLOTS] = {
      ...self.modules[TOGGLEABLE_SLOTS]!,
      moduleId,
      state: "retracted",
      energy: 0,
      energyCapacity: 0,
      ...over,
    };
    return self;
  }

  const RAY = "module.ray-slow-mk1";
  const FIELD = "module.field-repair-mk1";

  it("fires the ray at a LOCKED target in range", () => {
    const self = { ...shipWithPulse(RAY), locked: true };
    const plan = planModuleOrders(contextFor(self), configs, discipline, true);
    expect(plan.decisions).toEqual([
      { hardpointIndex: TOGGLEABLE_SLOTS, moduleId: RAY, activate: true, reason: "slow-target" },
    ]);
  });

  it("holds the ray without a lock — the sim would spend the cooldown on nothing", () => {
    const self = { ...shipWithPulse(RAY), locked: false };
    expect(planModuleOrders(contextFor(self), configs, discipline, true).orders).toEqual([]);
  });

  it("holds the ray while it is cold rather than shouting at a closed door", () => {
    const self = { ...shipWithPulse(RAY, { cycleTimer: 4 }), locked: true };
    expect(planModuleOrders(contextFor(self), configs, discipline, true).orders).toEqual([]);
  });

  it("fires the repair field for its own hurt hull, and not for a healthy one", () => {
    const healthy = shipWithPulse(FIELD);
    expect(planModuleOrders(contextFor(healthy), configs, discipline, true).orders).toEqual([]);

    const hurt = { ...shipWithPulse(FIELD), hull: 50, hullMax: 100 };
    const plan = planModuleOrders(contextFor(hurt), configs, discipline, true);
    expect(plan.decisions).toEqual([
      { hardpointIndex: TOGGLEABLE_SLOTS, moduleId: FIELD, activate: true, reason: "repair-wing" },
    ]);
  });

  it("fires the repair field for a hurt WINGMAN inside the radius, and not one outside it", () => {
    const radius = configs.get<ModuleConfig>("module", FIELD)!.repairField!.radiusUnits;
    const wingman = (x: number): ShipSnapshot => ({
      ...shipWith([]),
      id: 3,
      team: 0,
      hull: 30,
      hullMax: 100,
      pos: { x, y: 0, z: 0 },
    });

    const near = planModuleOrders(contextFor(shipWithPulse(FIELD), [wingman(radius - 5)]), configs, discipline, true);
    expect(near.decisions).toEqual([
      { hardpointIndex: TOGGLEABLE_SLOTS, moduleId: FIELD, activate: true, reason: "repair-wing" },
    ]);

    const far = planModuleOrders(contextFor(shipWithPulse(FIELD), [wingman(radius + 5)]), configs, discipline, true);
    expect(far.orders).toEqual([]);
  });

  it("ignores a hurt ENEMY — the field only reaches its own team", () => {
    // `contextFor` seats one enemy 25 units away; wounding it must change
    // nothing, because allies is what the planner reads.
    const self = shipWithPulse(FIELD);
    const ctx = contextFor(self);
    for (const enemy of ctx.enemies) Object.assign(enemy, { hull: 5, hullMax: 100 });
    expect(planModuleOrders(ctx, configs, discipline, true).orders).toEqual([]);
  });
});
