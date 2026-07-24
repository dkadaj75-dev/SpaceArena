import { hasLineOfSightAmong } from "../sim/los.js";
import { clamp, dist } from "../sim/math.js";
import { boolParam, hasParam, numParam, type BehaviorParams, type BotContext } from "./context.js";

/** What a chosen behaviour wants the bot to do this decision. */
export interface BotPlan {
  /** Destination for a `move` order, or null to keep the current order. */
  move: { x: number; z: number } | null;
  /** Request afterburner on the move order (double-tap equivalent). */
  boost: boolean;
  /**
   * Whether the bot considers itself in an engagement this decision. Feeds
   * `moduleDiscipline.shieldOnlyWhenEngaged` — behaviours declare it, the
   * discipline layer interprets it.
   */
  engaged: boolean;
}

/**
 * One utility behaviour. `score` returns a *situational factor* (≥ 0) that the
 * driver multiplies by the profile's `baseWeight`; returning 0 means "not
 * applicable right now". `plan` is only called for the winner.
 *
 * Adding a behaviour = write one of these + register it. No switch statements.
 */
export interface BotBehavior {
  score(ctx: BotContext, params: BehaviorParams): number;
  plan(ctx: BotContext, params: BehaviorParams): BotPlan;
}

export type BehaviorRegistry = ReadonlyMap<string, BotBehavior>;

const registry = new Map<string, BotBehavior>();

/** Register (or replace) a behaviour scorer under a config key. */
export function registerBotBehavior(key: string, behavior: BotBehavior): void {
  registry.set(key, behavior);
}

/** The live registry of behaviour keys a botprofile may reference. */
export function botBehaviors(): BehaviorRegistry {
  return registry;
}

const IDLE_PLAN: BotPlan = { move: null, boost: false, engaged: false };

function midRange(ctx: BotContext): number {
  return (ctx.preferredMin + ctx.preferredMax) / 2;
}

/** Point at `radius` from `origin` on the bearing `angle`. */
function pointOnRing(origin: { x: number; z: number }, angle: number, radius: number): { x: number; z: number } {
  return { x: origin.x + Math.cos(angle) * radius, z: origin.z + Math.sin(angle) * radius };
}

function bearing(from: { x: number; z: number }, to: { x: number; z: number }): number {
  return Math.atan2(to.z - from.z, to.x - from.x);
}

// ---------------------------------------------------------------------------
// engage — close to the preferred band and orbit at range (5.2 arrival/orbit)
// ---------------------------------------------------------------------------

const engage: BotBehavior = {
  score(ctx, params) {
    if (!ctx.target) return 0;
    // Health-weighted willingness to be in the fight.
    let factor = 0.5 + 0.5 * clamp(ctx.hullFraction, 0, 1);
    if (ctx.distance > ctx.preferredMax) {
      // Farther than we want to be ⇒ stronger pull to close.
      factor *= 1 + clamp((ctx.distance - ctx.preferredMax) / Math.max(ctx.preferredMax, 1), 0, 1);
    } else if (ctx.distance < ctx.preferredMin) {
      factor *= numParam(params, "tooCloseFalloff", 0.6);
    }
    if (!ctx.hasLoS) factor *= numParam(params, "noLosFalloff", 1.2); // press to regain LoS
    return factor;
  },
  plan(ctx, params) {
    const target = ctx.target;
    if (!target) return IDLE_PLAN;
    const desired = midRange(ctx);
    const fromTarget = bearing(target.pos, ctx.self.pos);
    const step = numParam(params, "orbitStepRad", 0.6) * ctx.orbitSign;
    const move = pointOnRing(target.pos, fromTarget + step, desired);
    const boostChance = numParam(params, "doubleTapBoostChance", 0);
    const boost = ctx.distance > ctx.preferredMax && ctx.rng() < boostChance;
    return { move, boost, engaged: true };
  },
};

// ---------------------------------------------------------------------------
// kite — back off to the preferred band when the enemy is inside it
// ---------------------------------------------------------------------------

const kite: BotBehavior = {
  score(ctx, params) {
    if (!ctx.target) return 0;
    const min = ctx.preferredMin;
    if (min <= 0 || ctx.distance >= min) return 0;
    const urgency = clamp((min - ctx.distance) / min, 0, 1);
    return 1 + urgency * numParam(params, "urgencyGain", 1);
  },
  plan(ctx, params) {
    const target = ctx.target;
    if (!target) return IDLE_PLAN;
    const away = bearing(target.pos, ctx.self.pos);
    // Retreat outward with a tangential component so the bot keeps circling
    // rather than reversing straight through the enemy's firing line.
    const lateral = numParam(params, "lateralRad", 0.4) * ctx.orbitSign;
    const move = pointOnRing(target.pos, away + lateral, midRange(ctx));
    const boost = ctx.rng() < numParam(params, "doubleTapBoostChance", 0);
    return { move, boost, engaged: true };
  },
};

// ---------------------------------------------------------------------------
// breakLoS — hide behind an asteroid (reuses the sim's LoS math)
// ---------------------------------------------------------------------------

/** Sample cover points on the far side of each asteroid relative to `threat`. */
function coverCandidates(ctx: BotContext, threat: { x: number; z: number }, offset: number): { x: number; z: number }[] {
  const out: { x: number; z: number }[] = [];
  for (const b of ctx.blockers) {
    const away = bearing(threat, b.pos);
    out.push(pointOnRing(b.pos, away, b.radius + offset));
  }
  return out;
}

function bestCoverPoint(ctx: BotContext, params: BehaviorParams): { x: number; z: number } | null {
  const threat = ctx.target;
  if (!threat) return null;
  const offset = numParam(params, "coverOffset", 3);
  const searchRadius = numParam(params, "coverSearchRadius", ctx.preferredMax * 2);
  let best: { x: number; z: number } | null = null;
  let bestCost = Infinity;
  for (const c of coverCandidates(ctx, threat.pos, offset)) {
    const d = dist(ctx.self.pos, c);
    if (d > searchRadius) continue;
    if (hasLineOfSightAmong(c, threat.pos, ctx.blockers)) continue; // does not actually break LoS
    if (d < bestCost) {
      bestCost = d;
      best = c;
    }
  }
  return best;
}

const breakLoS: BotBehavior = {
  score(ctx, params) {
    if (!ctx.target) return 0;
    if (!ctx.hasLoS) return 0; // already unseen — nothing to break
    if (hasParam(params, "triggerHullBelow")) {
      const trigger = numParam(params, "triggerHullBelow", 0);
      if (ctx.hullFraction >= trigger) return 0;
      if (bestCoverPoint(ctx, params) === null) return 0;
      const depth = trigger > 0 ? clamp((trigger - ctx.hullFraction) / trigger, 0, 1) : 1;
      return 1 + depth * numParam(params, "urgencyGain", 1);
    }
    if (bestCoverPoint(ctx, params) === null) return 0;
    return 1;
  },
  plan(ctx, params) {
    const move = bestCoverPoint(ctx, params);
    return { move, boost: ctx.rng() < numParam(params, "doubleTapBoostChance", 0), engaged: false };
  },
};

// ---------------------------------------------------------------------------
// retreat — disengage entirely when the configured triggers fire
// ---------------------------------------------------------------------------

const retreat: BotBehavior = {
  score(ctx, params) {
    if (ctx.enemies.length === 0) return 0;
    const hullTrigger = hasParam(params, "triggerHullBelow");
    const shieldTrigger = boolParam(params, "triggerShieldDown", false);
    let triggered = !hullTrigger && !shieldTrigger; // untriggered profile ⇒ always eligible
    if (hullTrigger && ctx.hullFraction < numParam(params, "triggerHullBelow", 0)) triggered = true;
    if (shieldTrigger && ctx.shieldDown) triggered = true;
    if (!triggered) return 0;
    return 1 + clamp(1 - ctx.hullFraction, 0, 1) * numParam(params, "urgencyGain", 1);
  },
  plan(ctx, params) {
    // Away from the enemy centroid.
    let cx = 0;
    let cz = 0;
    for (const e of ctx.enemies) {
      cx += e.pos.x;
      cz += e.pos.z;
    }
    cx /= Math.max(1, ctx.enemies.length);
    cz /= Math.max(1, ctx.enemies.length);
    const away = bearing({ x: cx, z: cz }, ctx.self.pos);
    const distance = numParam(params, "retreatDistance", ctx.preferredMax * 2);
    const move = pointOnRing(ctx.self.pos, away, distance);
    return { move, boost: ctx.rng() < numParam(params, "doubleTapBoostChance", 0), engaged: false };
  },
};

// ---------------------------------------------------------------------------
// dodge — sidestep inbound missiles (5.2 missile-dodge repositioning)
// ---------------------------------------------------------------------------

const dodge: BotBehavior = {
  score(ctx, params) {
    const inbound = ctx.incomingMissiles[0];
    if (!inbound) return 0;
    const radius = numParam(params, "dodgeRadius", 20);
    if (inbound.distance > radius) return 0;
    return 1 + clamp((radius - inbound.distance) / radius, 0, 1) * numParam(params, "urgencyGain", 1);
  },
  plan(ctx, params) {
    const inbound = ctx.incomingMissiles[0];
    if (!inbound) return IDLE_PLAN;
    // Perpendicular to the missile's travel direction, on the bot's orbit side.
    const perp = inbound.projectile.heading + (Math.PI / 2) * ctx.orbitSign;
    const move = pointOnRing(ctx.self.pos, perp, numParam(params, "dodgeDistance", 12));
    return { move, boost: ctx.rng() < numParam(params, "doubleTapBoostChance", 0), engaged: true };
  },
};

registerBotBehavior("engage", engage);
registerBotBehavior("kite", kite);
registerBotBehavior("breakLoS", breakLoS);
registerBotBehavior("retreat", retreat);
registerBotBehavior("dodge", dodge);

/** Built-in behaviour keys (for content validation / editor dropdowns). */
export const BUILTIN_BEHAVIOR_KEYS = ["engage", "kite", "breakLoS", "retreat", "dodge"] as const;
