import { describe, expect, it } from "vitest";

import { botprofileSchema, type BotprofileConfig } from "../schemas/botprofile.js";
import type { AsteroidSnapshot, ProjectileSnapshot, ShipSnapshot, Snapshot } from "../sim/ArenaSimulation.js";
import { angleDelta } from "../sim/math.js";
import { botBehaviors, BUILTIN_BEHAVIOR_KEYS, type BotPlan, type FlightCommand } from "./behaviors.js";
import { buildBotContext, type BehaviorParams, type BotContext } from "./context.js";
import { bearing } from "./flight.js";

// ---------------------------------------------------------------------------
// Fixtures — a behaviour only ever sees a BotContext built from a Snapshot.
// ---------------------------------------------------------------------------

function ship(id: number, team: number, x: number, z: number, over: Partial<ShipSnapshot> = {}): ShipSnapshot {
  return {
    id,
    team,
    pos: { x, z },
    heading: 0,
    hull: 100,
    hullMax: 100,
    energy: { cur: 100, max: 100 },
    heat: { cur: 0, capacity: 100 },
    targetId: null,
    throttle: 0,
    lockProgress: 0,
    locked: false,
    modules: [],
    ...over,
  };
}

function rock(id: number, x: number, z: number, radius = 8): AsteroidSnapshot {
  return { id, configId: "asteroid.large-hazard", pos: { x, z }, radius, state: "intact" };
}

const PROFILE: BotprofileConfig = botprofileSchema.parse({
  id: "bot.test",
  type: "botprofile",
  version: 1,
  decisionIntervalMs: 250,
  orderJitterMs: 0,
  preferredRange: [20, 40],
  behaviors: {},
  moduleDiscipline: {
    heatShutdownAt: 0.85,
    reactivateBelow: 0.5,
    energyReserve: 0.15,
    shieldOnlyWhenEngaged: true,
  },
});

interface CtxOptions {
  self?: Partial<ShipSnapshot>;
  enemyAt?: { x: number; z: number };
  enemy?: Partial<ShipSnapshot>;
  asteroids?: AsteroidSnapshot[];
  projectiles?: ProjectileSnapshot[];
  weaponRange?: number;
  orbitSign?: 1 | -1;
  elapsed?: number;
  profile?: BotprofileConfig;
}

function context(opts: CtxOptions = {}): BotContext {
  const self = ship(1, 0, 0, 0, { targetId: 2, ...opts.self });
  const at = opts.enemyAt ?? { x: 30, z: 0 };
  const enemy = ship(2, 1, at.x, at.z, opts.enemy);
  const snapshot: Snapshot = {
    tick: 1,
    elapsed: opts.elapsed ?? 1,
    phase: "live",
    winnerTeam: null,
    ships: [self, enemy],
    asteroids: opts.asteroids ?? [],
    projectiles: opts.projectiles ?? [],
  };
  return buildBotContext({
    snapshot,
    self,
    profile: opts.profile ?? PROFILE,
    weaponRange: opts.weaponRange ?? 40,
    targetId: 2,
    missileScanRadius: 80,
    orbitSign: opts.orbitSign ?? 1,
    rng: () => 0,
    turnRate: 3,
    turnHorizonSec: 0.25,
  });
}

function behavior(key: string) {
  const b = botBehaviors().get(key);
  expect(b, key).toBeDefined();
  return b!;
}

function plan(key: string, params: Record<string, unknown>, ctx: BotContext): BotPlan {
  return behavior(key).plan(ctx, params as unknown as BehaviorParams);
}

function score(key: string, params: Record<string, unknown>, ctx: BotContext): number {
  return behavior(key).score(ctx, params as unknown as BehaviorParams);
}

/** Signed heading error from the ship's nose to a plan's aim point. */
function aimDelta(ctx: BotContext, p: BotPlan): number {
  expect(p.aim).not.toBeNull();
  return angleDelta(ctx.self.heading, bearing(ctx.self.pos, p.aim!));
}

const BASE: FlightCommand = { turn: 0.1, throttle: 0.5, boost: false };

// ---------------------------------------------------------------------------

describe("behaviour registry", () => {
  it("registers exactly the documented built-in keys", () => {
    expect([...botBehaviors().keys()].sort()).toEqual([...BUILTIN_BEHAVIOR_KEYS].sort());
  });
});

describe("engage", () => {
  it("puts the nose on the target — the only geometry that fills a lock", () => {
    const ctx = context({ enemyAt: { x: 20, z: 20 } });
    const p = plan("engage", {}, ctx);
    expect(p.aim).toEqual({ x: 20, z: 20 });
    expect(p.engaged).toBe(true);
    expect(aimDelta(ctx, p)).toBeCloseTo(Math.PI / 4, 6);
  });

  it("modulates the throttle across the range band instead of the heading", () => {
    const params = { throttleApproach: 1, throttleBand: 0.5, throttleClose: 0.15 };
    expect(plan("engage", params, context({ enemyAt: { x: 70, z: 0 } })).throttle).toBe(1); // beyond max
    expect(plan("engage", params, context({ enemyAt: { x: 30, z: 0 } })).throttle).toBe(0.5); // in band
    expect(plan("engage", params, context({ enemyAt: { x: 10, z: 0 } })).throttle).toBe(0.15); // inside min
  });

  it("eases off the engine past hardTurnRad so the hull turns in less space", () => {
    const params = { throttleBand: 0.9, hardTurnRad: 1, throttleTurn: 0.3 };
    // Target dead astern: a reversal, not a pursuit.
    const p = plan("engage", params, context({ enemyAt: { x: -30, z: 0 } }));
    expect(p.throttle).toBe(0.3);
  });

  it("scores 0 without a target and grows with range beyond the band", () => {
    const noTarget = buildBotContext({
      snapshot: { tick: 1, elapsed: 1, phase: "live", winnerTeam: null, ships: [ship(1, 0, 0, 0)], asteroids: [], projectiles: [] },
      self: ship(1, 0, 0, 0),
      profile: PROFILE,
      weaponRange: 40,
      targetId: null,
      missileScanRadius: 80,
      orbitSign: 1,
      rng: () => 0,
    });
    expect(score("engage", {}, noTarget)).toBe(0);
    expect(score("engage", {}, context({ enemyAt: { x: 80, z: 0 } }))).toBeGreaterThan(
      score("engage", {}, context({ enemyAt: { x: 30, z: 0 } })),
    );
  });

  it("only asks for boost while closing from outside the band", () => {
    const params = { boostChance: 1 };
    expect(plan("engage", params, context({ enemyAt: { x: 80, z: 0 } })).boost).toBe(true);
    expect(plan("engage", params, context({ enemyAt: { x: 30, z: 0 } })).boost).toBe(false);
  });
});

describe("kite", () => {
  it("only fires once the merge has collapsed inside breakRange", () => {
    expect(score("kite", { breakRange: 14 }, context({ enemyAt: { x: 30, z: 0 } }))).toBe(0);
    expect(score("kite", { breakRange: 14 }, context({ enemyAt: { x: 8, z: 0 } }))).toBeGreaterThan(1);
    // Absent breakRange falls back to the profile's preferred minimum (20).
    expect(score("kite", {}, context({ enemyAt: { x: 15, z: 0 } }))).toBeGreaterThan(0);
    expect(score("kite", {}, context({ enemyAt: { x: 25, z: 0 } }))).toBe(0);
  });

  it("extends away from the enemy at run throttle while inside the standoff", () => {
    const ctx = context({ enemyAt: { x: 8, z: 0 }, weaponRange: 40 });
    const p = plan("kite", { breakRange: 14, standoffFrac: 0.75, slipRad: 0, throttleRun: 1 }, ctx);
    expect(p.throttle).toBe(1);
    expect(p.engaged).toBe(true);
    // Dead astern of the enemy: the nose points 180° from the target bearing.
    expect(Math.abs(aimDelta(ctx, p))).toBeCloseTo(Math.PI, 6);
  });

  it("offsets the extend leg by slipRad on the bot's orbit side", () => {
    const away = Math.PI; // enemy is at +x, so "away" is -x
    for (const orbitSign of [1, -1] as const) {
      const ctx = context({ enemyAt: { x: 8, z: 0 }, orbitSign });
      const p = plan("kite", { breakRange: 14, standoffFrac: 0.75, slipRad: 0.5 }, ctx);
      const heading = bearing(ctx.self.pos, p.aim!);
      expect(angleDelta(away, heading)).toBeCloseTo(0.5 * orbitSign, 6);
    }
  });

  it("stops bidding at breakRange, leaving the re-perch to engage", () => {
    // Kite is the merge-break, not a range keeper: the moment the bot is at or
    // beyond `breakRange` its factor is 0, so it can never win a decision —
    // which is why it has no "perched, nose back on" leg to reach.
    const ctx = context({ enemyAt: { x: 25, z: 0 }, weaponRange: 40 });
    const params = { breakRange: 20, standoffFrac: 0.5 };
    expect(score("kite", params, ctx)).toBe(0);
    expect(score("engage", {}, ctx)).toBeGreaterThan(0);
  });
});

describe("breakLoS", () => {
  const cover = [rock(9, 15, 10, 6)];

  it("aims at a point that actually blocks line of sight to the threat", () => {
    const ctx = context({ enemyAt: { x: 60, z: 0 }, asteroids: cover, self: { hull: 20, targetId: 2 } });
    const p = plan("breakLoS", { triggerHullBelow: 0.4, coverOffset: 3 }, ctx);
    expect(p.aim).not.toBeNull();
    expect(p.engaged).toBe(false);
    // On the far side of the rock from the enemy (enemy is at +x).
    expect(p.aim!.x).toBeLessThan(15);
  });

  it("scores 0 with no cover, with no LoS to break, or above the hull trigger", () => {
    const hurt = { hull: 20, targetId: 2 };
    expect(score("breakLoS", { triggerHullBelow: 0.4 }, context({ enemyAt: { x: 60, z: 0 }, self: hurt }))).toBe(0);
    expect(
      score("breakLoS", { triggerHullBelow: 0.4 }, context({ enemyAt: { x: 60, z: 0 }, asteroids: cover, self: { targetId: 2 } })),
    ).toBe(0); // healthy
    // Already behind a rock ⇒ nothing to break.
    const blocked = context({ enemyAt: { x: 60, z: 0 }, asteroids: [rock(9, 30, 0, 8)], self: hurt });
    expect(blocked.hasLoS).toBe(false);
    expect(score("breakLoS", { triggerHullBelow: 0.4 }, blocked)).toBe(0);
  });
});

describe("retreat", () => {
  it("runs away from the enemy centroid, flat out, with the burner lit", () => {
    const ctx = context({ enemyAt: { x: 30, z: 0 }, self: { hull: 10, targetId: 2 } });
    const p = plan("retreat", { triggerHullBelow: 0.3, throttle: 1, boostChance: 1 }, ctx);
    expect(p.throttle).toBe(1);
    expect(p.boost).toBe(true);
    expect(p.engaged).toBe(false);
    expect(Math.abs(aimDelta(ctx, p))).toBeCloseTo(Math.PI, 6);
  });

  it("never eases off the engine to swing the nose around", () => {
    // Enemy dead ahead ⇒ the away bearing is a full reversal, but throttle stays 1.
    const ctx = context({ enemyAt: { x: 5, z: 0 }, self: { hull: 10, targetId: 2 } });
    const p = plan("retreat", { triggerHullBelow: 0.3, throttle: 1, hardTurnRad: 0.1, throttleTurn: 0.2 }, ctx);
    expect(p.throttle).toBe(1);
  });

  it("fires only on the configured triggers", () => {
    const healthy = context({ self: { targetId: 2 } });
    expect(score("retreat", { triggerHullBelow: 0.3 }, healthy)).toBe(0);
    expect(score("retreat", { triggerShieldDown: true }, healthy)).toBeGreaterThan(0); // no shield module
    expect(score("retreat", {}, healthy)).toBeGreaterThan(0); // no trigger ⇒ always eligible
  });
});

describe("dodge", () => {
  const missile: ProjectileSnapshot = { id: 50, kind: "missile", pos: { x: 10, z: 0 }, heading: Math.PI };

  it("breaks across an inbound missile's track", () => {
    const ctx = context({ projectiles: [missile], enemyAt: { x: 40, z: 0 } });
    expect(score("dodge", { dodgeRadius: 20 }, ctx)).toBeGreaterThan(1);
    const p = plan("dodge", { dodgeRadius: 20, dodgeDistance: 12 }, ctx);
    // Missile runs along -x; the break is perpendicular to it, on the orbit side.
    expect(Math.abs(aimDelta(ctx, p))).toBeCloseTo(Math.PI / 2, 6);
  });

  it("ignores missiles beyond the dodge radius", () => {
    const far: ProjectileSnapshot = { ...missile, pos: { x: 60, z: 0 } };
    expect(score("dodge", { dodgeRadius: 20 }, context({ projectiles: [far] }))).toBe(0);
    expect(score("dodge", { dodgeRadius: 20 }, context())).toBe(0);
  });

  it("layers a deterministic jink onto another behaviour's stick", () => {
    const params = { jinkAmp: 0.4, jinkPeriodSec: 0.8, jinkPhasePerId: 0.618 };
    const at = (elapsed: number, id: number): number =>
      behavior("dodge").overlay!(
        context({ projectiles: [missile], elapsed, self: { id, targetId: 2 } }),
        params as unknown as BehaviorParams,
        BASE,
      ).turn;

    // Same sim time + same entity ⇒ same stick, always (no Math.random anywhere).
    expect(at(1.0, 1)).toBe(at(1.0, 1));
    // The weave actually moves, and two bots weave out of phase.
    expect(at(1.0, 1)).not.toBe(at(1.2, 1));
    expect(at(1.0, 1)).not.toBe(at(1.0, 2));
    // Half a period apart the wave is mirrored about the base command.
    expect(at(1.0, 1) - BASE.turn).toBeCloseTo(-(at(1.4, 1) - BASE.turn), 10);
    // Amplitude is bounded by jinkAmp, and the axis never leaves [-1, 1].
    for (let t = 0; t < 2; t += 0.05) {
      expect(Math.abs(at(t, 1) - BASE.turn)).toBeLessThanOrEqual(0.4 + 1e-9);
      expect(Math.abs(at(t, 1))).toBeLessThanOrEqual(1);
    }
    // Throttle and boost are the base maneuver's business, not the jink's.
    const layered = behavior("dodge").overlay!(
      context({ projectiles: [missile] }),
      params as unknown as BehaviorParams,
      BASE,
    );
    expect(layered.throttle).toBe(BASE.throttle);
    expect(layered.boost).toBe(BASE.boost);
  });

  it("is a no-op overlay at zero amplitude", () => {
    const out = behavior("dodge").overlay!(
      context({ projectiles: [missile] }),
      { jinkAmp: 0 } as unknown as BehaviorParams,
      BASE,
    );
    expect(out).toEqual(BASE);
  });
});

describe("avoidRocks", () => {
  const params = { lookahead: 20, clearance: 2, turnBias: 0.8, throttleFactor: 0.5 };
  const overlay = (ctx: BotContext, p: Record<string, unknown> = params): FlightCommand =>
    behavior("avoidRocks").overlay!(ctx, p as unknown as BehaviorParams, BASE);

  it("biases the stick away from a rock in the nose corridor", () => {
    // Rock to starboard, close in ⇒ strong positive (to port) bias.
    const near = overlay(context({ asteroids: [rock(9, 4, -3, 5)], enemyAt: { x: 60, z: 0 } }));
    expect(near.turn).toBeGreaterThan(BASE.turn);
    const mirrored = overlay(context({ asteroids: [rock(9, 4, 3, 5)], enemyAt: { x: 60, z: 0 } }));
    expect(mirrored.turn).toBeLessThan(BASE.turn);
  });

  it("scales the nudge with imminence, so distant scenery barely moves the stick", () => {
    const near = overlay(context({ asteroids: [rock(9, 3, -2, 5)], enemyAt: { x: 60, z: 0 } }));
    const far = overlay(context({ asteroids: [rock(9, 18, -2, 5)], enemyAt: { x: 60, z: 0 } }));
    expect(near.turn - BASE.turn).toBeGreaterThan(far.turn - BASE.turn);
    expect(far.turn - BASE.turn).toBeLessThan(0.2);
    expect(near.throttle).toBeLessThan(far.throttle);
  });

  it("passes the command through untouched with a clear corridor", () => {
    expect(overlay(context({ asteroids: [rock(9, 0, 40, 5)] }))).toEqual(BASE);
    expect(overlay(context({ asteroids: [rock(9, 4, -3, 5)] }), { ...params, lookahead: 0 })).toEqual(BASE);
  });

  it("scores as live purely on the corridor, so baseWeight 0 makes it a pure overlay", () => {
    expect(score("avoidRocks", params, context({ asteroids: [rock(9, 4, -3, 5)] }))).toBe(1);
    expect(score("avoidRocks", params, context({ asteroids: [] }))).toBe(0);
  });
});
