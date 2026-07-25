import type { Vec2 } from "../schemas/common.js";
import { hasLineOfSightAmong } from "../sim/los.js";
import { angleDelta, clamp, dist } from "../sim/math.js";
import { boolParam, hasParam, numParam, type BehaviorParams, type BotContext } from "./context.js";
import { bearing, noseBlocker, pointOnRing } from "./flight.js";

/**
 * What a chosen behaviour wants the bot to do this decision, in flight terms
 * (FLIGHT.md §1/§7). A plan is *intent*: an aim point plus how hard to push the
 * engine. {@link import("./flight.js").turnForPoint} — driven by the ship's
 * calibrated `turnRate` and the driver's control horizon — turns it into the
 * `turn` axis of a `flight` order, so no behaviour needs to know the stick.
 */
export interface BotPlan {
  /**
   * World point to put the nose on, or null to hold the current heading. The
   * flight-model replacement for the old `move` destination: the ship never
   * "arrives", it flies through, so this is a bearing source, not a target.
   */
  aim: Vec2 | null;
  /** Engine command, 0..1 (clamped by the driver). */
  throttle: number;
  /** Request afterburner (resolves in the sim exactly as a human's boost does). */
  boost: boolean;
  /**
   * Whether the bot considers itself in an engagement this decision. Feeds
   * `moduleDiscipline.shieldOnlyWhenEngaged` — behaviours declare it, the
   * discipline layer interprets it.
   */
  engaged: boolean;
}

/** The `flight` order payload the driver is about to send. */
export interface FlightCommand {
  turn: number;
  throttle: number;
  boost: boolean;
}

/**
 * One utility behaviour. `score` returns a *situational factor* (≥ 0) that the
 * driver multiplies by the profile's `baseWeight`; returning 0 means "not
 * applicable right now". `plan` is only called for the winner.
 *
 * `overlay` is the optional second half: a behaviour that is situationally live
 * (factor > 0) but did *not* win still gets to layer itself onto the winner's
 * flight command — how a jink rides on top of a pursuit instead of replacing it.
 * A behaviour with `baseWeight: 0` can never win, so it becomes a pure overlay.
 *
 * Adding a behaviour = write one of these + register it. No switch statements.
 */
export interface BotBehavior {
  score(ctx: BotContext, params: BehaviorParams): number;
  plan(ctx: BotContext, params: BehaviorParams): BotPlan;
  overlay?(ctx: BotContext, params: BehaviorParams, cmd: FlightCommand): FlightCommand;
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

/** Nothing to do: hold heading and cut the engine (the ship coasts to a stop). */
const IDLE_PLAN: BotPlan = { aim: null, throttle: 0, boost: false, engaged: false };

/** Heading error between the nose and a world point, in radians (unsigned). */
function aimError(ctx: BotContext, at: Vec2): number {
  return Math.abs(angleDelta(ctx.self.heading, bearing(ctx.self.pos, at)));
}

/**
 * Throttle while swinging the nose around: turn rate is speed-independent in this
 * sim, so the way to turn "tighter" is to travel less while turning. Behaviours
 * apply it whenever the aim point is far off the nose (post-joust reversal), which
 * is also what keeps a bot from drifting out of its range band mid-turn.
 */
function turnThrottle(base: number, err: number, params: BehaviorParams): number {
  const hard = numParam(params, "hardTurnRad", 1.2);
  if (err < hard) return base;
  return Math.min(base, numParam(params, "throttleTurn", 0.35));
}

/** Roll a boost chance for this decision (`allowed: false` skips the roll entirely). */
function rollBoost(ctx: BotContext, chance: number, allowed = true): boolean {
  if (!allowed || chance <= 0) return false;
  return ctx.rng() < chance;
}

/** Standoff distance a bot tries to hold: the far edge of where it can still shoot. */
function standoffRange(ctx: BotContext, params: BehaviorParams): number {
  const frac = numParam(params, "standoffFrac", 0.9);
  // `weaponRange` is the range that actually matters for damage, and for all
  // shipped content it sits inside `sensors.lockRange` (which a bot cannot see —
  // it is not in the snapshot). Profiles without weapons fall back to the band.
  const anchor = ctx.weaponRange > 0 ? ctx.weaponRange : ctx.preferredMax;
  return anchor * frac;
}

// ---------------------------------------------------------------------------
// engage — pure pursuit with a throttle-managed range band
// ---------------------------------------------------------------------------

/**
 * Nose on the target, engine used to sit in the preferred band.
 *
 * Maneuver: pursuit is the only geometry that both closes and keeps the target in
 * the lock cone (orbiting points the hull *across* the enemy, which is why the
 * RTS-era orbit plan never completed a lock). Range is managed with the throttle
 * instead of the heading:
 *   - beyond the band → `throttleApproach` (+ boost) to close;
 *   - inside the band → `throttleBand`, so the bot lingers where its weapons are;
 *   - inside `preferredMin` → `throttleClose`, a deliberate crawl: bearing rate is
 *     `speed / distance`, so slowing down at knife range is what lets the turn rate
 *     keep the nose on target instead of flying a wide overshoot.
 * Jousting falls out of this naturally — a head-on pass is the best lock geometry
 * there is (bearing rate ≈ 0), and after the pass `throttleTurn` bleeds speed for
 * the reversal.
 */
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
    const far = ctx.distance > ctx.preferredMax;
    let throttle: number;
    if (far) throttle = numParam(params, "throttleApproach", 1);
    else if (ctx.distance < ctx.preferredMin) throttle = numParam(params, "throttleClose", 0.2);
    else throttle = numParam(params, "throttleBand", 0.55);
    return {
      aim: target.pos,
      throttle: turnThrottle(throttle, aimError(ctx, target.pos), params),
      boost: rollBoost(ctx, numParam(params, "boostChance", 0), far),
      engaged: true,
    };
  },
};

// ---------------------------------------------------------------------------
// kite — hold the far edge of weapon range, trading lock time for range
// ---------------------------------------------------------------------------

/**
 * Maneuver ("extend and re-perch"), and the throttle/geometry trade the flight
 * model forces:
 *
 * The bearing rate of an enemy is `v_perp / range`, and a hull can only track what
 * its `turnRate` can follow. Far out that is free — at 50 units a crossing 34 u/s
 * enemy sweeps 0.7 rad/s against a 3.0 rad/s hull, so the nose sits on it and
 * `lockProgress` fills the whole time. Inside ~10 units the same enemy sweeps
 * 3.4 rad/s: the nose *cannot* follow, both ships pin the stick and the fight
 * degenerates into a co-rotating scissors where neither ever completes a lock.
 * That merge trap is what kills a flight-model bot, and breaking it is this
 * behaviour's entire job. `engage` holds the standoff band with its throttle;
 * kite only fires when the band has already collapsed.
 *
 *   - **Extend leg** (`distance < standoffRange`): nose `slipRad` off dead astern
 *     and run at `throttleRun`. The target leaves the cone and `lockProgress`
 *     drains at `tuning.lockDecayMult` — that is the honest, deliberate price of
 *     un-merging, and it is why `breakRange` should sit well inside the band
 *     rather than at its edge.
 *   - **Perch leg** (at or beyond the standoff): nose straight back on at
 *     `throttleHold`, which is where the lock refills and the guns reach. The
 *     slip offset means the bot arrives beside the enemy's nose rather than in
 *     front of it, so the re-perch starts with an aspect advantage.
 *
 * `breakRange` (defaulting to the profile's `preferredMin`) is the trigger, kept
 * separate from `standoffRange` so a profile can say "break out at 12 units, but
 * do not stop running until 30" — a hysteresis band, without which the bot would
 * chatter across a single threshold.
 */
const kite: BotBehavior = {
  score(ctx, params) {
    if (!ctx.target) return 0;
    const trigger = numParam(params, "breakRange", ctx.preferredMin);
    if (trigger <= 0 || ctx.distance >= trigger) return 0;
    const urgency = clamp((trigger - ctx.distance) / trigger, 0, 1);
    return 1 + urgency * numParam(params, "urgencyGain", 1);
  },
  plan(ctx, params) {
    const target = ctx.target;
    if (!target) return IDLE_PLAN;
    const standoff = standoffRange(ctx, params);

    if (ctx.distance < standoff) {
      // Extend: run out along a bearing offset from "straight away", so the bot
      // ends up beside the enemy's guns rather than in front of them coming back.
      const away = bearing(target.pos, ctx.self.pos);
      const slip = numParam(params, "slipRad", 0.5) * ctx.orbitSign;
      return {
        aim: pointOnRing(ctx.self.pos, away + slip, Math.max(standoff, 1)),
        throttle: numParam(params, "throttleRun", 1),
        boost: rollBoost(ctx, numParam(params, "boostChance", 0)),
        engaged: true,
      };
    }

    // Perched: nose on, engine only as much as holding the range needs.
    return {
      aim: target.pos,
      throttle: turnThrottle(numParam(params, "throttleHold", 0.25), aimError(ctx, target.pos), params),
      boost: false,
      engaged: true,
    };
  },
};

// ---------------------------------------------------------------------------
// breakLoS — put an asteroid between self and the threat (reuses the sim's LoS math)
// ---------------------------------------------------------------------------

/** Sample cover points on the far side of each asteroid relative to `threat`. */
function coverCandidates(ctx: BotContext, threat: Vec2, offset: number): Vec2[] {
  const out: Vec2[] = [];
  for (const b of ctx.blockers) {
    const away = bearing(threat, b.pos);
    out.push(pointOnRing(b.pos, away, b.radius + offset));
  }
  return out;
}

function bestCoverPoint(ctx: BotContext, params: BehaviorParams): Vec2 | null {
  const threat = ctx.target;
  if (!threat) return null;
  const offset = numParam(params, "coverOffset", 3);
  const searchRadius = numParam(params, "coverSearchRadius", ctx.preferredMax * 2);
  let best: Vec2 | null = null;
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

/**
 * Maneuver: unchanged intent (get a rock between us and the shooter), expressed as
 * a fly-to-point — the cover point becomes the aim point and the heading helper
 * flies the bot there. Full throttle by default: cover is only worth anything if
 * you reach it, and the bot is deliberately *not* `engaged` while running for it.
 */
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
    const aim = bestCoverPoint(ctx, params);
    if (!aim) return IDLE_PLAN;
    return {
      aim,
      throttle: turnThrottle(numParam(params, "throttle", 1), aimError(ctx, aim), params),
      boost: rollBoost(ctx, numParam(params, "boostChance", 0)),
      engaged: false,
    };
  },
};

// ---------------------------------------------------------------------------
// retreat — disengage entirely when the configured triggers fire
// ---------------------------------------------------------------------------

/** Maneuver: nose away from the enemy centroid, throttle open, burner lit. */
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
    const distance = Math.max(numParam(params, "retreatDistance", ctx.preferredMax * 2), 1);
    return {
      aim: pointOnRing(ctx.self.pos, away, distance),
      // No `turnThrottle` here: a retreat wants distance now, and easing off to
      // swing the nose around is exactly the moment the pursuer catches up.
      throttle: numParam(params, "throttle", 1),
      boost: rollBoost(ctx, numParam(params, "boostChance", 1)),
      engaged: false,
    };
  },
};

// ---------------------------------------------------------------------------
// dodge — jink off a missile track, and layer jinks onto whatever else is flying
// ---------------------------------------------------------------------------

/**
 * Deterministic jink phase. Advances with the sim's tick-integrated `elapsed` and
 * is offset per entity id, so two bots weave out of phase and a replay of the same
 * seed produces the same weave. Never `Math.random`.
 */
function jinkWave(ctx: BotContext, params: BehaviorParams): number {
  const period = Math.max(numParam(params, "jinkPeriodSec", 0.8), 1e-3);
  const phase = ctx.self.id * numParam(params, "jinkPhasePerId", 0.618);
  return Math.sin(Math.PI * 2 * (ctx.snapshot.elapsed / period + phase));
}

/**
 * Maneuver: when a missile is close enough to win the utility contest, break hard
 * across its track (`plan`) — the flight analogue of the old perpendicular
 * sidestep, and the widest possible aspect change for a homing seeker.
 *
 * When something else won, `overlay` layers a jink *on top of it*: the base
 * maneuver keeps its aim point and throttle, the stick just weaves around it. That
 * costs lock progress, which is the honest price of not being hit — the profile's
 * `jinkAmp` is where that trade is tuned.
 */
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
    return {
      aim: pointOnRing(ctx.self.pos, perp, Math.max(numParam(params, "dodgeDistance", 12), 1)),
      throttle: numParam(params, "throttle", 1),
      boost: rollBoost(ctx, numParam(params, "boostChance", 0)),
      engaged: true,
    };
  },
  overlay(ctx, params, cmd) {
    const amp = numParam(params, "jinkAmp", 0.4);
    if (amp === 0) return cmd;
    return { ...cmd, turn: clamp(cmd.turn + amp * jinkWave(ctx, params), -1, 1) };
  },
};

// ---------------------------------------------------------------------------
// avoidRocks — nose-level collision awareness, entirely profile-gated
// ---------------------------------------------------------------------------

/**
 * Flight retired the sim's asteroid avoidance: a bot that flies straight at a rock
 * eats `impactDamage` exactly like a human pilot would. This behaviour is the
 * cheap replacement — a nose-corridor scan over the asteroids already in the bot's
 * context, biasing the stick away from the nearest blocker.
 *
 * It exists **only when a profile declares it**, and with `baseWeight: 0` it is a
 * pure overlay: it never takes a decision away from a fighting behaviour, it just
 * nudges the stick.
 *
 * **No shipped profile enables it, on measured evidence.** Across five seeds of
 * `bot.aggressive` vs `bot.cautious` on `arena.ring-nebula`, turning it on left
 * asteroid damage flat-to-worse (~40-60 per match either way — a swerve away from
 * one rock in a belt is a swerve toward the next) while cutting the share of the
 * match the bots held a lock from ~0.47 to ~0.17 and roughly halving weapon
 * damage. Impacts at ~40 hull per match across two 80-hull ships are a cost the
 * fight can carry; a permanently biased stick is not. Kept because it is the
 * right tool for a dense arena (FLIGHT.md §6 deep-field) and because a content
 * author can now reach for it without a code change.
 */
const avoidRocks: BotBehavior = {
  score(ctx, params) {
    return threat(ctx, params) === null ? 0 : 1;
  },
  plan(ctx, params) {
    const hit = threat(ctx, params);
    if (!hit) return IDLE_PLAN;
    // Only reachable when a profile gives it a non-zero weight: sidestep the rock.
    const clear = ctx.self.heading + (Math.PI / 2) * hit.side;
    return {
      aim: pointOnRing(ctx.self.pos, clear, Math.max(hit.along, 1)),
      throttle: numParam(params, "throttle", 0.6),
      boost: false,
      engaged: false,
    };
  },
  overlay(ctx, params, cmd) {
    const hit = threat(ctx, params);
    if (!hit) return cmd;
    // Imminence-scaled, not a flat offset: a rock at the far end of the corridor
    // barely moves the stick, one about to be hit moves it fully. A flat bias is
    // a permanent aim error whenever any scenery is roughly ahead, and measurably
    // costs more lock time than the impacts it prevents.
    const lookahead = Math.max(numParam(params, "lookahead", 16), 1e-3);
    const urgency = clamp(1 - hit.along / lookahead, 0, 1);
    const bias = numParam(params, "turnBias", 0.8) * urgency * hit.side;
    const slow = 1 - (1 - numParam(params, "throttleFactor", 1)) * urgency;
    return {
      ...cmd,
      turn: clamp(cmd.turn + bias, -1, 1),
      throttle: clamp(cmd.throttle * slow, 0, 1),
    };
  },
};

/**
 * The rock this bot is about to fly into, if any. Scans only the asteroids the
 * snapshot already carries (a handful per arena) — the sim's spatial hash is not
 * part of the read-only bot contract, and a linear pass over that list is the
 * same order of work a broadphase query would have returned anyway.
 */
function threat(ctx: BotContext, params: BehaviorParams) {
  return noseBlocker(
    ctx.self.pos,
    ctx.self.heading,
    ctx.blockers,
    numParam(params, "lookahead", 16),
    numParam(params, "clearance", 2),
  );
}

registerBotBehavior("engage", engage);
registerBotBehavior("kite", kite);
registerBotBehavior("breakLoS", breakLoS);
registerBotBehavior("retreat", retreat);
registerBotBehavior("dodge", dodge);
registerBotBehavior("avoidRocks", avoidRocks);

/** Built-in behaviour keys (for content validation / editor dropdowns). */
export const BUILTIN_BEHAVIOR_KEYS = ["engage", "kite", "breakLoS", "retreat", "dodge", "avoidRocks"] as const;

/**
 * Editor metadata for one tunable a behaviour reads out of its `catchall` param
 * bag. The bag is deliberately schema-free (a behaviour may read anything), so
 * this list is what the Behavior Editor offers in its "add param" dropdown —
 * it is documentation, not validation: an unknown key is still legal config.
 */
export interface BehaviorParamSpec {
  key: string;
  kind: "number" | "boolean" | "enum" | "string";
  /** Value the behaviour falls back to when the param is absent. */
  fallback: number | boolean | string;
  min?: number;
  max?: number;
  options?: readonly string[];
  doc: string;
}

const BOOST_CHANCE: BehaviorParamSpec = {
  key: "boostChance",
  kind: "number",
  fallback: 0,
  min: 0,
  max: 1,
  doc: "Chance the flight order requests afterburner this decision.",
};
const URGENCY: BehaviorParamSpec = {
  key: "urgencyGain",
  kind: "number",
  fallback: 1,
  min: 0,
  max: 4,
  doc: "How much the situational score grows with urgency (0 = flat).",
};
const HARD_TURN: BehaviorParamSpec = {
  key: "hardTurnRad",
  kind: "number",
  fallback: 1.2,
  min: 0,
  max: 3.15,
  doc: "Heading error past which the bot eases off the engine to swing the nose around.",
};
const THROTTLE_TURN: BehaviorParamSpec = {
  key: "throttleTurn",
  kind: "number",
  fallback: 0.35,
  min: 0,
  max: 1,
  doc: "Throttle held while reversing (beyond hardTurnRad) — travel less per radian.",
};

/** Tunables each built-in behaviour reads, keyed by behaviour key. */
export const BEHAVIOR_PARAM_SPECS: Readonly<Record<string, readonly BehaviorParamSpec[]>> = {
  engage: [
    { key: "throttleApproach", kind: "number", fallback: 1, min: 0, max: 1, doc: "Throttle beyond the preferred band (closing)." },
    { key: "throttleBand", kind: "number", fallback: 0.55, min: 0, max: 1, doc: "Throttle inside the preferred band (lingering where the guns reach)." },
    { key: "throttleClose", kind: "number", fallback: 0.2, min: 0, max: 1, doc: "Throttle inside preferredMin — slow bearing rate so the nose can hold a lock." },
    HARD_TURN,
    THROTTLE_TURN,
    { key: "tooCloseFalloff", kind: "number", fallback: 0.6, min: 0, max: 2, doc: "Score multiplier while inside the preferred band." },
    { key: "noLosFalloff", kind: "number", fallback: 1.2, min: 0, max: 3, doc: "Score multiplier with no line of sight (>1 presses to regain it)." },
    { key: "targetPreference", kind: "enum", fallback: "nearest", options: ["nearest", "lowestHull"], doc: "Which enemy the bot focuses." },
    { key: "losPenalty", kind: "number", fallback: 2, min: 1, max: 10, doc: "Target-choice cost multiplier for enemies behind cover." },
    { key: "holdLockTarget", kind: "boolean", fallback: true, doc: "Never re-target while sensor lock progress is on the books (switching resets it)." },
    BOOST_CHANCE,
  ],
  kite: [
    URGENCY,
    { key: "breakRange", kind: "number", fallback: 0, min: 0, max: 200, doc: "Distance at which the merge is broken off (default: the profile's preferredRange minimum)." },
    { key: "standoffFrac", kind: "number", fallback: 0.9, min: 0, max: 1.5, doc: "Range the extend leg runs out to, as a fraction of the longest fitted weapon range." },
    { key: "slipRad", kind: "number", fallback: 0.5, min: 0, max: 1.6, doc: "Offset from straight-away while extending (0 = dead astern)." },
    { key: "throttleRun", kind: "number", fallback: 1, min: 0, max: 1, doc: "Throttle during the extend leg." },
    { key: "throttleHold", kind: "number", fallback: 0.25, min: 0, max: 1, doc: "Throttle while perched at the standoff range with the nose back on." },
    HARD_TURN,
    THROTTLE_TURN,
    BOOST_CHANCE,
  ],
  breakLoS: [
    { key: "triggerHullBelow", kind: "number", fallback: 0, min: 0, max: 1, doc: "Only seek cover under this hull fraction (absent = always eligible)." },
    URGENCY,
    { key: "coverOffset", kind: "number", fallback: 3, min: 0, max: 20, doc: "Standoff distance from the asteroid's surface." },
    { key: "coverSearchRadius", kind: "number", fallback: 70, min: 0, max: 200, doc: "How far to look for cover (default: 2 × preferred max range)." },
    { key: "throttle", kind: "number", fallback: 1, min: 0, max: 1, doc: "Throttle on the run to cover." },
    HARD_TURN,
    THROTTLE_TURN,
    BOOST_CHANCE,
  ],
  retreat: [
    { key: "triggerHullBelow", kind: "number", fallback: 0, min: 0, max: 1, doc: "Disengage under this hull fraction." },
    { key: "triggerShieldDown", kind: "boolean", fallback: false, doc: "Disengage whenever the shield is down." },
    URGENCY,
    { key: "retreatDistance", kind: "number", fallback: 70, min: 0, max: 200, doc: "How far to run (default: 2 × preferred max range)." },
    { key: "throttle", kind: "number", fallback: 1, min: 0, max: 1, doc: "Throttle while running (1 = flat out)." },
    { key: "boostChance", kind: "number", fallback: 1, min: 0, max: 1, doc: "Chance of lighting the burner while running (defaults to always)." },
  ],
  dodge: [
    { key: "dodgeRadius", kind: "number", fallback: 20, min: 0, max: 80, doc: "Consider missiles closer than this." },
    { key: "dodgeDistance", kind: "number", fallback: 12, min: 0, max: 60, doc: "How far across the missile track to break." },
    { key: "throttle", kind: "number", fallback: 1, min: 0, max: 1, doc: "Throttle during a hard break." },
    { key: "jinkAmp", kind: "number", fallback: 0.4, min: 0, max: 1, doc: "Turn-axis amplitude layered onto another behaviour's maneuver." },
    { key: "jinkPeriodSec", kind: "number", fallback: 0.8, min: 0.05, max: 5, doc: "Weave period in seconds (sim time, deterministic)." },
    { key: "jinkPhasePerId", kind: "number", fallback: 0.618, min: 0, max: 1, doc: "Per-entity phase offset, so bots weave out of step." },
    URGENCY,
    BOOST_CHANCE,
  ],
  avoidRocks: [
    { key: "lookahead", kind: "number", fallback: 16, min: 0, max: 80, doc: "Nose-corridor length scanned for asteroids (0 = disabled)." },
    { key: "clearance", kind: "number", fallback: 2, min: 0, max: 20, doc: "Extra corridor half-width beyond the rock's radius." },
    { key: "turnBias", kind: "number", fallback: 0.8, min: 0, max: 1, doc: "Turn-axis bias applied away from the blocking rock." },
    { key: "throttleFactor", kind: "number", fallback: 1, min: 0, max: 1, doc: "Throttle multiplier while a rock is in the corridor." },
    { key: "throttle", kind: "number", fallback: 0.6, min: 0, max: 1, doc: "Throttle if the profile weights this high enough to win a decision outright." },
  ],
};
