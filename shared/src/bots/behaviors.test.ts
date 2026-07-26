import { describe, expect, it } from "vitest";

import { botprofileSchema, type BotprofileConfig } from "../schemas/botprofile.js";
import type { AsteroidSnapshot, ProjectileSnapshot, ShipSnapshot, Snapshot } from "../sim/ArenaSimulation.js";
import { hasLineOfSightAmong } from "../sim/los.js";
import { angleDelta } from "../sim/math.js";
import { botBehaviors, BUILTIN_BEHAVIOR_KEYS, type BotPlan, type FlightCommand } from "./behaviors.js";
import { buildBotContext, type BehaviorParams, type BotContext } from "./context.js";
import { bearing3 } from "./flight.js";

// ---------------------------------------------------------------------------
// Fixtures — a behaviour only ever sees a BotContext built from a Snapshot.
// ---------------------------------------------------------------------------

function ship(id: number, team: number, x: number, z: number, over: Partial<ShipSnapshot> = {}): ShipSnapshot {
  return {
    id,
    team,
    pos: { x, y: 0, z },
    heading: 0,
    pitch: 0,
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

function rock(id: number, x: number, z: number, radius = 8, y = 0): AsteroidSnapshot {
  return { id, configId: "asteroid.large-hazard", pos: { x, y, z }, radius, state: "intact" };
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
  /** `y` defaults to 0, so a planar case reads exactly as it did before the bubble. */
  enemyAt?: { x: number; y?: number; z: number };
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
  const enemy = ship(2, 1, at.x, at.z, { pos: { x: at.x, y: at.y ?? 0, z: at.z }, ...opts.enemy });
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
    pitchRate: 2.4,
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

/** Signed YAW error from the ship's nose to a plan's aim point. */
function aimDelta(ctx: BotContext, p: BotPlan): number {
  expect(p.aim).not.toBeNull();
  return angleDelta(ctx.self.heading, bearing3(ctx.self.pos, p.aim!).yaw);
}

/** Elevation of a plan's aim point relative to the ship (radians, + is above). */
function aimPitch(ctx: BotContext, p: BotPlan): number {
  expect(p.aim).not.toBeNull();
  return bearing3(ctx.self.pos, p.aim!).pitch;
}

const BASE: FlightCommand = { turn: 0.1, pitchStick: -0.2, throttle: 0.5, boost: false };

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
    // The aim point IS the target: pursuit needs no derived geometry.
    expect(p.aim).toEqual({ x: 20, y: 0, z: 20 });
    expect(p.engaged).toBe(true);
    expect(aimDelta(ctx, p)).toBeCloseTo(Math.PI / 4, 6);
  });

  it("noses onto the 3D bearing of a target at a different altitude", () => {
    // The whole point of T4: the sim's lock cone is a true 3D cone, so an enemy
    // 30 units above has to be pursued in elevation as well as bearing.
    const above = context({ enemyAt: { x: 40, y: 30, z: 0 } });
    const p = plan("engage", {}, above);
    expect(p.aim).toEqual({ x: 40, y: 30, z: 0 });
    expect(aimPitch(above, p)).toBeCloseTo(Math.atan2(30, 40), 6);
    // ...and downward for one below.
    const below = context({ enemyAt: { x: 40, y: -30, z: 0 } });
    expect(aimPitch(below, plan("engage", {}, below))).toBeCloseTo(Math.atan2(-30, 40), 6);
  });

  it("measures range and turn effort in 3D, so altitude cannot fake a range band", () => {
    // Planar (x,z) separation 10, true separation 50: the bot is well outside its
    // preferred band (20..40) even though the top-down projection says otherwise.
    const steep = context({ enemyAt: { x: 10, y: 48.99, z: 0 } });
    expect(steep.distance).toBeCloseTo(50, 1);
    // (hardTurnRad out of the way: this case is about the range band, and the
    // steep climb would otherwise trip the reversal throttle — see below.)
    expect(plan("engage", { throttleApproach: 1, throttleBand: 0.5, hardTurnRad: 3 }, steep).throttle).toBe(1);
    // And a target dead ahead in yaw but 80° up is a hard turn, not a straight run.
    const overhead = context({ enemyAt: { x: 5, y: 28, z: 0 } });
    expect(plan("engage", { throttleBand: 0.9, hardTurnRad: 1, throttleTurn: 0.3 }, overhead).throttle).toBe(0.3);
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
      const p = plan("kite", { breakRange: 14, standoffFrac: 0.75, slipRad: 0.5, verticalSlipRad: 0 }, ctx);
      const heading = bearing3(ctx.self.pos, p.aim!).yaw;
      expect(angleDelta(away, heading)).toBeCloseTo(0.5 * orbitSign, 6);
    }
  });

  it("tilts the extend leg out of the enemy's plane by verticalSlipRad", () => {
    // The vertical is the cheap direction to un-merge in: the hull pitches slower
    // than it yaws, so an enemy forced to follow vertically pays more than we do.
    for (const orbitSign of [1, -1] as const) {
      const ctx = context({ enemyAt: { x: 8, z: 0 }, orbitSign });
      const p = plan("kite", { breakRange: 14, standoffFrac: 0.75, slipRad: 0, verticalSlipRad: 0.4 }, ctx);
      expect(aimPitch(ctx, p)).toBeCloseTo(0.4 * orbitSign, 6);
    }
  });

  it("carries the enemy's elevation into the away bearing", () => {
    // Jumped from above ⇒ the extend leg runs DOWN and out, not level.
    const ctx = context({ enemyAt: { x: 6, y: 8, z: 0 } });
    const p = plan("kite", { breakRange: 14, standoffFrac: 0.75, slipRad: 0, verticalSlipRad: 0 }, ctx);
    expect(aimPitch(ctx, p)).toBeCloseTo(Math.atan2(-8, 6), 6);
  });

  it("never flips the extend leg back through the enemy on a near-vertical bearing", () => {
    // A steep away bearing plus verticalSlipRad can exceed vertical; past PI/2 a
    // naive spherical placement lands on the OPPOSITE yaw, i.e. straight back at
    // the shooter. The aim point must stay on the away side.
    const ctx = context({ enemyAt: { x: 1, y: -9, z: 0 } });
    const p = plan("kite", { breakRange: 14, standoffFrac: 0.75, slipRad: 0, verticalSlipRad: 1.4 }, ctx);
    expect(p.aim!.x).toBeLessThanOrEqual(0); // away from an enemy at +x
    expect(p.aim!.y!).toBeGreaterThan(0); // and climbing, away from one below
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

  it("takes cover on the far side of a rock in 3D, not merely beside it", () => {
    // LoS is a segment-vs-SPHERE test, so the point that actually eclipses a
    // threat BELOW the rock sits below the rock.
    const rocks = [rock(9, 20, 0, 8, 0)];
    const ctx = context({ enemyAt: { x: 60, y: -60, z: 0 }, asteroids: rocks, self: { hull: 20, targetId: 2 } });
    const p = plan("breakLoS", { triggerHullBelow: 0.4, coverOffset: 3 }, ctx);
    expect(p.aim).not.toBeNull();
    expect(p.aim!.y!).toBeGreaterThan(0); // opposite the threat's elevation
    // ...and it genuinely breaks LoS, which the planar point below it would not.
    expect(hasLineOfSightAmong(p.aim!, ctx.target!.pos, ctx.blockers)).toBe(false);
  });

  it("rejects cover whose 3D distance is outside the search radius", () => {
    // A rock 200 units straight up is planar-adjacent and utterly unreachable.
    const high = [rock(9, 20, 0, 8, 200)];
    const ctx = context({ enemyAt: { x: 60, z: 0 }, asteroids: high, self: { hull: 20, targetId: 2 } });
    expect(score("breakLoS", { triggerHullBelow: 0.4, coverSearchRadius: 80 }, ctx)).toBe(0);
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

  it("runs away in 3D: jumped from above, it dives out instead of levelling off", () => {
    const ctx = context({ enemyAt: { x: 30, y: 40, z: 0 }, self: { hull: 10, targetId: 2 } });
    const p = plan("retreat", { triggerHullBelow: 0.3 }, ctx);
    expect(aimPitch(ctx, p)).toBeCloseTo(Math.atan2(-40, 30), 6);
    expect(p.aim!.y!).toBeLessThan(0);
  });

  it("averages the enemy centroid in all three axes", () => {
    // Two shooters, one high one low, both at +x: the escape is level and -x.
    const self = ship(1, 0, 0, 0, { hull: 10, targetId: 2 });
    const snapshot: Snapshot = {
      tick: 1,
      elapsed: 1,
      phase: "live",
      winnerTeam: null,
      ships: [self, ship(2, 1, 20, 0, { pos: { x: 20, y: 30, z: 0 } }), ship(3, 1, 20, 0, { pos: { x: 20, y: -30, z: 0 } })],
      asteroids: [],
      projectiles: [],
    };
    const ctx = buildBotContext({
      snapshot,
      self,
      profile: PROFILE,
      weaponRange: 40,
      targetId: 2,
      missileScanRadius: 80,
      orbitSign: 1,
      rng: () => 0,
    });
    const p = plan("retreat", { triggerHullBelow: 0.3 }, ctx);
    expect(aimPitch(ctx, p)).toBeCloseTo(0, 6);
    expect(p.aim!.x).toBeLessThan(0);
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
  const missile: ProjectileSnapshot = { id: 50, kind: "missile", pos: { x: 10, y: 0, z: 0 }, heading: Math.PI };

  it("breaks across an inbound missile's track", () => {
    const ctx = context({ projectiles: [missile], enemyAt: { x: 40, z: 0 } });
    expect(score("dodge", { dodgeRadius: 20 }, ctx)).toBeGreaterThan(1);
    const p = plan("dodge", { dodgeRadius: 20, dodgeDistance: 12 }, ctx);
    // Missile runs along -x; the break is perpendicular to it, on the orbit side.
    expect(Math.abs(aimDelta(ctx, p))).toBeCloseTo(Math.PI / 2, 6);
  });

  it("dodges an overhead diver in 3D but ignores an overhead missile climbing away", () => {
    const diver: ProjectileSnapshot = {
      id: 51,
      kind: "missile",
      pos: { x: 0, y: 10, z: 0 },
      heading: 0,
      velocity: { x: 0, y: -30, z: 0 },
    };
    const diving = context({ projectiles: [diver] });
    expect(score("dodge", { dodgeRadius: 20 }, diving)).toBeGreaterThan(1);
    const dodgePlan = plan("dodge", { dodgeRadius: 20, dodgeDistance: 12 }, diving);
    const offset = {
      x: dodgePlan.aim!.x - diving.self.pos.x,
      y: (dodgePlan.aim!.y ?? 0) - diving.self.pos.y,
      z: dodgePlan.aim!.z - diving.self.pos.z,
    };
    expect(offset.x * diver.velocity!.x + offset.y * diver.velocity!.y + offset.z * diver.velocity!.z).toBeCloseTo(0, 12);

    const climber = { ...diver, id: 52, velocity: { x: 0, y: 30, z: 0 } };
    expect(score("dodge", { dodgeRadius: 20 }, context({ projectiles: [climber] }))).toBe(0);
  });

  it("breaks out of the missile's plane as well as across its track", () => {
    for (const orbitSign of [1, -1] as const) {
      const ctx = context({ projectiles: [missile], enemyAt: { x: 40, z: 0 }, orbitSign });
      const p = plan("dodge", { dodgeRadius: 20, dodgeDistance: 12, dodgeClimbRad: 0.5 }, ctx);
      // Same yaw break as before, now selecting a different 3D break plane.
      expect(Math.abs(aimDelta(ctx, p))).toBeCloseTo(Math.PI / 2, 6);
      expect(aimPitch(ctx, p)).toBeCloseTo(0.5 * orbitSign, 6);
    }
    // A level break is still expressible.
    const level = context({ projectiles: [missile] });
    expect(aimPitch(level, plan("dodge", { dodgeRadius: 20, dodgeClimbRad: 0 }, level))).toBeCloseTo(0, 6);
  });

  it("ignores missiles beyond the dodge radius", () => {
    const far: ProjectileSnapshot = { ...missile, pos: { x: 60, y: 0, z: 0 } };
    expect(score("dodge", { dodgeRadius: 20 }, context({ projectiles: [far] }))).toBe(0);
    expect(score("dodge", { dodgeRadius: 20 }, context())).toBe(0);
  });

  it("layers a deterministic jink onto another behaviour's stick", () => {
    const params = { jinkAmp: 0.4, jinkPitchAmp: 0.4, jinkPeriodSec: 0.8, jinkPhasePerId: 0.618 };
    const at = (elapsed: number, id: number): FlightCommand =>
      behavior("dodge").overlay!(
        context({ projectiles: [missile], elapsed, self: { id, targetId: 2 } }),
        params as unknown as BehaviorParams,
        BASE,
      );
    /** Total deflection away from the base stick, whichever axis carries it. */
    const offset = (elapsed: number, id: number): number => {
      const c = at(elapsed, id);
      return c.turn - BASE.turn + (c.pitchStick - BASE.pitchStick);
    };

    // Same sim time + same entity ⇒ same stick, always (no Math.random anywhere).
    expect(at(1.0, 1)).toEqual(at(1.0, 1));
    // The weave actually moves, and two bots weave out of phase.
    expect(offset(1.0, 1)).not.toBe(offset(1.2, 1));
    expect(offset(1.0, 1)).not.toBe(offset(1.0, 2));
    // Amplitude is bounded, exactly one axis is ever touched, and neither axis
    // leaves [-1, 1].
    for (let t = 0; t < 4; t += 0.05) {
      const c = at(t, 1);
      const movedTurn = c.turn !== BASE.turn;
      const movedPitch = c.pitchStick !== BASE.pitchStick;
      expect(movedTurn && movedPitch).toBe(false);
      expect(Math.abs(offset(t, 1))).toBeLessThanOrEqual(0.4 + 1e-9);
      expect(Math.abs(c.turn)).toBeLessThanOrEqual(1);
      expect(Math.abs(c.pitchStick)).toBeLessThanOrEqual(1);
    }
    // Throttle and boost are the base maneuver's business, not the jink's.
    const layered = at(1.0, 1);
    expect(layered.throttle).toBe(BASE.throttle);
    expect(layered.boost).toBe(BASE.boost);
  });

  it("alternates the weave between the yaw and pitch axes, one whole period each", () => {
    // BUBBLE.md §D: jinks alternate axes deterministically. Derived from sim time
    // and entity id, so a replay reproduces it and neighbours are out of step.
    const params = { jinkAmp: 0.4, jinkPitchAmp: 0.4, jinkPeriodSec: 0.8, jinkPhasePerId: 0.618 };
    const cmdAt = (elapsed: number, id: number): FlightCommand =>
      behavior("dodge").overlay!(
        context({ projectiles: [missile], elapsed, self: { id, targetId: 2 } }),
        params as unknown as BehaviorParams,
        BASE,
      );
    const axisAt = (elapsed: number, id: number): "yaw" | "pitch" => {
      const c = cmdAt(elapsed, id);
      return c.turn !== BASE.turn ? "yaw" : "pitch";
    };

    // Sample the middle of successive periods for bot 1 (period 0.8, phase 0.618
    // ⇒ boundaries at elapsed 0.306, 1.106, 1.906, 2.706) and watch it flip.
    expect([0.7, 1.5, 2.3, 3.1].map((t) => axisAt(t, 1))).toEqual(["pitch", "yaw", "pitch", "yaw"]);
    // Two bots are not locked to one axis: the per-id phase offset that already
    // takes them out of step takes them off each other's axis too.
    expect(axisAt(0.7, 1)).not.toBe(axisAt(0.7, 2));
    // The handoff is clean: the wave is 0 at every period boundary, so an axis is
    // released at centre rather than abandoned mid-deflection.
    const boundary = cmdAt((2 - 0.618) * 0.8, 1);
    expect(Math.abs(boundary.turn - BASE.turn)).toBeLessThan(1e-9);
    expect(Math.abs(boundary.pitchStick - BASE.pitchStick)).toBeLessThan(1e-9);
  });

  it("is a no-op overlay at zero amplitude, on either axis", () => {
    // `jinkPitchAmp` is absent here on purpose: it inherits `jinkAmp`, so a
    // pre-bubble profile that switched the weave off stays switched off.
    for (const elapsed of [0.7, 1.5]) {
      const out = behavior("dodge").overlay!(
        context({ projectiles: [missile], elapsed }),
        { jinkAmp: 0 } as unknown as BehaviorParams,
        BASE,
      );
      expect(out).toEqual(BASE);
    }
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

  it("ignores a rock the bot is flying comfortably over", () => {
    // The corridor is a 3D cylinder now: scenery 40 units below a level nose is
    // not a collision course, and the planar test used to swerve off it.
    expect(overlay(context({ asteroids: [rock(9, 6, -1, 5, -40)] }))).toEqual(BASE);
    // Nose down at it and it is a threat again.
    const diving = context({ asteroids: [rock(9, 6, -1, 5, -40)], self: { pitch: -1.4 } });
    expect(overlay(diving, { ...params, lookahead: 60 }).turn).not.toBe(BASE.turn);
  });

  it("scores as live purely on the corridor, so baseWeight 0 makes it a pure overlay", () => {
    expect(score("avoidRocks", params, context({ asteroids: [rock(9, 4, -3, 5)] }))).toBe(1);
    expect(score("avoidRocks", params, context({ asteroids: [] }))).toBe(0);
  });
});
