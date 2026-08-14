import { beforeAll, describe, expect, it } from "vitest";

import type { ConfigService } from "../core/ConfigService.js";
import { botprofileSchema, type BotprofileConfig } from "../schemas/botprofile.js";
import type { ShipSnapshot, Snapshot } from "../sim/ArenaSimulation.js";
import { loadTestConfigs } from "../sim/testutil.js";
import { buildBotContext } from "./context.js";
import { decideFire } from "./fireDiscipline.js";

let configs: ConfigService;

beforeAll(async () => {
  configs = await loadTestConfigs();
});

function profile(): BotprofileConfig {
  return botprofileSchema.parse({
    id: "bot.fire-test",
    type: "botprofile",
    version: 1,
    decisionIntervalMs: 400,
    orderJitterMs: 0,
    preferredRange: [20, 35],
    behaviors: { engage: { baseWeight: 1 } },
    moduleDiscipline: {
      heatShutdownAt: 0.85,
      reactivateBelow: 0.5,
      energyReserve: 0.15,
      shieldOnlyWhenEngaged: true,
    },
  });
}

function ship(id: number, team: number, x: number, locked: boolean, heat = 0): ShipSnapshot {
  return {
    id,
    team,
    pos: { x, y: 0, z: 0 },
    heading: team === 0 ? 0 : Math.PI,
    pitch: 0,
    up: { x: 0, y: 1, z: 0 },
    hull: 80,
    hullMax: 80,
    targetId: team === 0 ? 2 : 1,
    throttle: 0,
    lockProgress: locked ? 1 : 0,
    locked,
    modules: [
      {
        moduleId: "module.laser-mk1",
        hardpointIndex: 0,
        state: "active",
        heat,
        heatCapacity: 100,
        energy: 0,
        energyCapacity: 0,
      stateTimer: 0,
      rounds: 0,
        cycleTimer: 0,
        channeling: false,
        shieldPool: 0,
      },
    ],
  };
}

function context(locked: boolean, heat = 0) {
  const self = ship(1, 0, 0, locked, heat);
  const enemy = ship(2, 1, 20, false);
  const snapshot: Snapshot = {
    tick: 30,
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
    weaponRange: 38,
    targetId: enemy.id,
    missileScanRadius: 70,
    orbitSign: 1,
    rng: () => 0,
    driverTick: 30,
  });
}

describe("fireDiscipline", () => {
  const discipline = {
    engageRangeMult: 1,
    heatHeadroom: 0.8,
    minEnergyFraction: 0.2,
  };

  it("holds fire without a lock", () => {
    expect(decideFire(context(false), configs, discipline, true)).toEqual({
      fire: false,
      reason: "no-lock",
    });
  });

  it("fires while locked and inside the armed-weapon envelope", () => {
    expect(decideFire(context(true), configs, discipline, true)).toEqual({
      fire: true,
      reason: "fire",
    });
  });

  it("stops at the configured armed-module heat headroom", () => {
    // The bench snapshot gives every rack a capacity of 100 (see `ship`), which
    // is what a per-module heat fraction is measured against now.
    const capacity = 100;
    expect(decideFire(context(true, capacity * 0.8), configs, discipline, true)).toEqual({
      fire: false,
      reason: "heat-headroom",
    });
  });

  it("holds through cooling and re-arms at the configured hysteresis floor", () => {
    const capacity = 100;
    const state = { heatHeld: false };
    const hysteretic = { ...discipline, rearmHeatBelow: 0.4 };
    expect(decideFire(context(true, capacity * 0.81), configs, hysteretic, true, state).fire).toBe(false);
    expect(decideFire(context(true, capacity * 0.6), configs, hysteretic, true, state).fire).toBe(false);
    expect(decideFire(context(true, capacity * 0.4), configs, hysteretic, true, state).fire).toBe(true);
  });

  it("holds fire outside the authored armed-weapon envelope", () => {
    expect(
      decideFire({ ...context(true), distance: 100 }, configs, discipline, true),
    ).toEqual({ fire: false, reason: "out-of-range" });
  });

  it("holds fire when no weapon module is armed", () => {
    const ctx = context(true);
    expect(
      decideFire({ ...ctx, self: { ...ctx.self, modules: [] } }, configs, discipline, true),
    ).toEqual({ fire: false, reason: "no-armed-weapons" });
  });

  it("holds fire below the floor of an ARMED WEAPON'S OWN tank", () => {
    // The ship-wide capacitor is gone (2026-08-07): the floor is asked of the
    // guns themselves, so a drained shield reserve cannot silence them.
    const ctx = context(true);
    const drained = {
      ...ctx,
      energyFraction: 0.1, // a nearly-empty shield elsewhere on the hull
      self: {
        ...ctx.self,
        modules: ctx.self.modules.map((m) => ({ ...m, energy: 10, energyCapacity: 100 })),
      },
    };
    expect(decideFire(drained, configs, discipline, true)).toEqual({ fire: false, reason: "energy-floor" });
    // …while the shipped, tank-less weapons keep firing on heat alone.
    expect(decideFire({ ...ctx, energyFraction: 0.1 }, configs, discipline, true)).toEqual({
      fire: true,
      reason: "fire",
    });
  });

  it("follows the exact burst/pause pattern at the simulation tick rate", () => {
    const rhythmic = { ...discipline, burstSec: 0.1, pauseSec: 0.1 };
    const decisions = Array.from({ length: 12 }, (_, driverTick) =>
      decideFire({ ...context(true), driverTick }, configs, rhythmic, true),
    );
    expect(decisions.map((decision) => decision.fire)).toEqual([
      true, true, true, false, false, false,
      true, true, true, false, false, false,
    ]);
    expect(decisions[3]).toEqual({ fire: false, reason: "burst-pause" });
  });

  it("preserves lethality without a configured discipline", () => {
    expect(decideFire(context(true), configs, undefined, true).fire).toBe(true);
  });
});
