import type { Vec3 } from "../schemas/common.js";
import { hasLineOfSightAmong } from "../sim/los.js";
import { angleBetween3, clamp, dist3, facingVec } from "../sim/math.js";
import { boolParam, hasParam, numParam, type BehaviorParams, type BotContext } from "./context.js";
import { bearing3, noseBlocker, pointOnRing, pointOnSphere } from "./flight.js";

/**
 * What a chosen behaviour wants the bot to do this decision, in flight terms
 * (FLIGHT.md §1/§7, BUBBLE.md §D). A plan is *intent*: an aim point plus how hard
 * to push the engine. {@link import("./flight.js").steerForPoint} — driven by the
 * ship's calibrated turn/pitch rates and the driver's control horizon — turns it
 * into the `turn` AND `pitchStick` axes of a `flight` order, so no behaviour needs
 * to know the stick, and none of them has to think about the two axes separately.
 */
export interface BotPlan {
  /**
   * World point in the bubble to put the nose on, or null to hold the current
   * attitude. The flight-model replacement for the old `move` destination: the
   * ship never "arrives", it flies through, so this is a bearing source, not a
   * target. `y` is the vertical axis; a plan that omits it means "my own
   * altitude", never "the ground plane".
   */
  aim: Vec3 | null;
  /** Engine command, 0..1 (clamped by the driver). */
  throttle: number;
  /** Terminal destination: cap throttle from measured turn radius so the hull converges. */
  arrive?: boolean;
  /** Radius that counts as arrival; steering manages the distance left to its edge. */
  arriveRadius?: number;
  /** This aim is an authored nav waypoint; terrain avoidance must not veto it. */
  aimPriority?: boolean;
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
  /** Pitch axis, -1..1, positive noses up (BUBBLE.md §A). */
  pitchStick: number;
  throttle: number;
  boost: boolean;
  /** Propagated from the winning plan for avoidance-overlay authority. */
  aimPriority?: boolean;
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

/**
 * Nothing to do: hold the current attitude and cut the engine (the ship coasts to
 * a stop). Both sticks centre, which in this sim means "keep the nose where it is"
 * on the pitch axis too — pitch is held state, not a self-levelling one
 * (BUBBLE.md §A).
 */
const IDLE_PLAN: BotPlan = { aim: null, throttle: 0, boost: false, engaged: false };

/** Scratch vectors: `aimError` runs a few times per decision, per bot. */
const facingScratch = { x: 0, y: 0, z: 0 };
const toAimScratch = { x: 0, y: 0, z: 0 };

/**
 * Attitude error between the nose and a world point, in radians (unsigned) — the
 * TRUE 3D angle (BUBBLE.md §D), so a target dead ahead but 60° above counts as
 * the hard turn it is, and `turnThrottle` bleeds speed for the pull-up exactly as
 * it does for a yaw reversal.
 */
function aimError(ctx: BotContext, at: Vec3): number {
  const facing = facingVec(ctx.self.heading, ctx.self.pitch, facingScratch);
  toAimScratch.x = at.x - ctx.self.pos.x;
  toAimScratch.y = (at.y ?? 0) - ctx.self.pos.y;
  toAimScratch.z = at.z - ctx.self.pos.z;
  return angleBetween3(facing, toAimScratch);
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
 * Maneuver ("extend"), and the throttle/geometry trade the flight model forces:
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
 * So kite is exactly one leg: inside `breakRange`, nose `slipRad` off dead astern
 * and run at `throttleRun` out to `standoffRange`. The target leaves the cone and
 * `lockProgress` drains at `tuning.lockDecayMult` — the honest, deliberate price
 * of un-merging. The slip offset means the bot ends up beside the enemy's nose
 * rather than in front of it, so whatever re-perches starts with an aspect
 * advantage.
 *
 * **There is no perch leg here, by construction.** `score` only bids while
 * `distance < breakRange`, and `breakRange` sits *inside* `standoffRange` in
 * every shipped profile (that hysteresis is the point: break out at 14, keep
 * running to 22). A "at or beyond the standoff, nose back on" branch in `plan`
 * could therefore only run in the range band where `score` already returned 0
 * and kite never wins the decision — it was unreachable code. Re-perching is
 * `engage`'s job and always was: once kite stops bidding, `engage` wins, puts the
 * nose back on and holds the band with `throttleBand`. Kite breaks the merge;
 * engage fights.
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
    // Extend: run out along a bearing offset from "straight away", so the bot
    // ends up beside the enemy's guns rather than in front of them coming back.
    // The away bearing is 3D, so an extend already carries whatever vertical
    // separation the merge had; `verticalSlipRad` optionally tilts the leg further
    // out of the enemy's plane, buying aspect on an axis their hull turns SLOWER
    // in (`tuning.pitchRateMult` < 1).
    //
    // **It defaults to 0, and that is a measured decision, not timidity.** A
    // constant-sign YAW slip is self-limiting: yaw wraps, so successive extends
    // curve around the enemy and the geometry re-centres. A constant-sign PITCH
    // slip is a RATCHET: pitch does not wrap, `orbitSign` is fixed for the bot's
    // life, and kite wins 100-270 decisions in a 30 s match — so every extend adds
    // elevation the same way and the bot walks monotonically toward the top (or
    // floor) of the bubble, where there is no fight. Probed on ring-nebula the
    // 0.3 rad default put bots 200-600 units off the plane of a radius-90 arena.
    // A content author who wants vertical un-merging can still ask for it.
    const away = bearing3(target.pos, ctx.self.pos);
    const slip = numParam(params, "slipRad", 0.5) * ctx.orbitSign;
    const climb = numParam(params, "verticalSlipRad", 0) * ctx.orbitSign;
    return {
      aim: pointOnSphere(ctx.self.pos, away.yaw + slip, away.pitch + climb, Math.max(standoffRange(ctx, params), 1)),
      throttle: numParam(params, "throttleRun", 1),
      boost: rollBoost(ctx, numParam(params, "boostChance", 0)),
      engaged: true,
    };
  },
};

// ---------------------------------------------------------------------------
// breakLoS — put an asteroid between self and the threat (reuses the sim's LoS math)
// ---------------------------------------------------------------------------

/**
 * Sample cover points on the far side of each asteroid relative to `threat`.
 * The "far side" is a 3D direction now (BUBBLE.md §D): asteroids carry `y`, LoS
 * is a segment-vs-SPHERE test since T1, and the point that actually eclipses a
 * threat 30 units below sits below the rock, not beside it.
 */
function coverCandidates(ctx: BotContext, threat: Vec3, offset: number): Required<Vec3>[] {
  const out: Required<Vec3>[] = [];
  for (const b of ctx.blockers) {
    const away = bearing3(threat, b.pos);
    out.push(pointOnSphere(b.pos, away.yaw, away.pitch, b.radius + offset));
  }
  return out;
}

function bestCoverPoint(ctx: BotContext, params: BehaviorParams): Required<Vec3> | null {
  const threat = ctx.target;
  if (!threat) return null;
  const offset = numParam(params, "coverOffset", 3);
  const searchRadius = numParam(params, "coverSearchRadius", ctx.preferredMax * 2);
  let best: Required<Vec3> | null = null;
  let bestCost = Infinity;
  for (const c of coverCandidates(ctx, threat.pos, offset)) {
    const d = dist3(ctx.self.pos, c);
    if (d > searchRadius) continue;
    if (hasLineOfSightAmong(c, threat.pos, ctx.blockers, ctx.staticWorld)) continue; // does not actually break LoS
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

/**
 * Maneuver: nose away from the enemy centroid **in 3D**, throttle open, burner
 * lit. The away bearing carries its elevation, so a bot jumped from above runs
 * down and out rather than levelling off into the plane of the shooters.
 */
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
    let cy = 0;
    let cz = 0;
    for (const e of ctx.enemies) {
      cx += e.pos.x;
      cy += e.pos.y;
      cz += e.pos.z;
    }
    const n = Math.max(1, ctx.enemies.length);
    cx /= n;
    cy /= n;
    cz /= n;
    const away = bearing3({ x: cx, y: cy, z: cz }, ctx.self.pos);
    const distance = Math.max(numParam(params, "retreatDistance", ctx.preferredMax * 2), 1);
    return {
      aim: pointOnSphere(ctx.self.pos, away.yaw, away.pitch, distance),
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
 * Deterministic weave clock, in whole-and-fractional jink periods. Advances with
 * the sim's tick-integrated `elapsed` and is offset per entity id, so two bots
 * weave out of phase and a replay of the same seed produces the same weave. Never
 * `Math.random`.
 */
function jinkPhase(ctx: BotContext, params: BehaviorParams): number {
  const period = Math.max(numParam(params, "jinkPeriodSec", 0.8), 1e-3);
  const phase = ctx.self.id * numParam(params, "jinkPhasePerId", 0.618);
  return ctx.snapshot.elapsed / period + phase;
}

/** The weave itself: one full oscillation per period, zero at every boundary. */
function jinkWave(ctx: BotContext, params: BehaviorParams): number {
  return Math.sin(Math.PI * 2 * jinkPhase(ctx, params));
}

/**
 * Which stick axis this weave cycle rides on (BUBBLE.md §D: "jinks alternate
 * between yaw and pitch axes deterministically"). It is the parity of the
 * whole-period count — sim time and the same per-entity phase offset the wave
 * already uses, never RNG and never wall-clock, so it replays byte-identically
 * and two bots with different phases are generally on opposite axes.
 *
 * Identity deliberately enters through `jinkPhasePerId` alone rather than an
 * extra `+ id` term: a second identity term does not decorrelate more (the two
 * can cancel for a given pair, since the phase offset already shifts the period
 * count) and it would give the axis a second source of truth to reason about.
 *
 * Alternating per WHOLE period (not per half) is what makes the handoff clean:
 * `jinkWave` is 0 at every integer phase, so an axis is always released at centre
 * and the next one picked up from centre. Alternating per half period would hand
 * each axis only same-signed lobes — a constant bias, not a weave.
 */
function jinkOnPitch(ctx: BotContext, params: BehaviorParams): boolean {
  const cycle = Math.floor(jinkPhase(ctx, params));
  return (((cycle % 2) + 2) % 2) === 1; // content may set a negative phase step
}

/**
 * Maneuver: when a missile is close enough to win the utility contest, break hard
 * across its track (`plan`) — the flight analogue of the old perpendicular
 * sidestep, and the widest possible aspect change for a homing seeker. In the
 * bubble the break also leaves the missile's plane (`dodgeClimbRad`): the seeker
 * spends one true 3D angular budget, so maximizing angular separation is the
 * useful geometry rather than exploiting independent yaw/pitch costs.
 *
 * That one-sided elevation DOES default to a real value, unlike kite's
 * `verticalSlipRad`, and the difference is frequency rather than taste: kite wins
 * 100-270 decisions in a 30 s match, so a fixed-sign pitch offset there ratchets
 * a bot out of the arena, while dodge only wins for the seconds a missile is
 * actually inbound (~20 decisions, and only under threat). An emergency maneuver
 * gets to be one-sided; a range keeper does not.
 *
 * When something else won, `overlay` layers a jink *on top of it*: the base
 * maneuver keeps its aim point and throttle, the stick just weaves around it —
 * alternating yaw and pitch cycle by cycle, so the weave is a spiral rather than a
 * flat S and a seeker cannot lead it on one axis. That costs lock progress, which
 * is the honest price of not being hit — the profile's `jinkAmp` / `jinkPitchAmp`
 * are where that trade is tuned.
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
    // Stable 3D perpendicular, signed per bot. Rotating it around the missile
    // track preserves perpendicularity while selecting a different break plane.
    const direction = inbound.direction;
    const reference = Math.abs(direction.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
    let px = direction.y * reference.z - direction.z * reference.y;
    let py = direction.z * reference.x - direction.x * reference.z;
    let pz = direction.x * reference.y - direction.y * reference.x;
    const plen = Math.hypot(px, py, pz);
    px = (px / plen) * ctx.orbitSign;
    py = (py / plen) * ctx.orbitSign;
    pz = (pz / plen) * ctx.orbitSign;
    const angle = -numParam(params, "dodgeClimbRad", 0.4);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const crossX = direction.y * pz - direction.z * py;
    const crossY = direction.z * px - direction.x * pz;
    const crossZ = direction.x * py - direction.y * px;
    const dodge = { x: px * cos + crossX * sin, y: py * cos + crossY * sin, z: pz * cos + crossZ * sin };
    const distance = Math.max(numParam(params, "dodgeDistance", 12), 1);
    return {
      aim: {
        x: ctx.self.pos.x + dodge.x * distance,
        y: ctx.self.pos.y + dodge.y * distance,
        z: ctx.self.pos.z + dodge.z * distance,
      },
      throttle: numParam(params, "throttle", 1),
      boost: rollBoost(ctx, numParam(params, "boostChance", 0)),
      engaged: true,
    };
  },
  overlay(ctx, params, cmd) {
    const yawAmp = numParam(params, "jinkAmp", 0.4);
    if (jinkOnPitch(ctx, params)) {
      // Absent `jinkPitchAmp` the vertical weave inherits `jinkAmp`, so a profile
      // written before the bubble keeps one amplitude across both axes and a
      // `jinkAmp: 0` profile stays a no-op overlay on either.
      const pitchAmp = numParam(params, "jinkPitchAmp", yawAmp);
      if (pitchAmp === 0) return cmd;
      return { ...cmd, pitchStick: clamp(cmd.pitchStick + pitchAmp * jinkWave(ctx, params), -1, 1) };
    }
    if (yawAmp === 0) return cmd;
    return { ...cmd, turn: clamp(cmd.turn + yawAmp * jinkWave(ctx, params), -1, 1) };
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
 * Shipped profiles use a finite corridor and retain utility steering underneath;
 * the driver's separate contact-memory escape handles the rare case where a
 * lookahead turn starts too late.
 */
const avoidRocks: BotBehavior = {
  score(ctx, params) {
    return threat(ctx, params) === null ? 0 : 1;
  },
  plan(ctx, params) {
    const hit = threat(ctx, params);
    if (!hit) return IDLE_PLAN;
    // Only reachable when a profile gives it a non-zero weight: sidestep the rock.
    // A YAW sidestep at the bot's own altitude, matching `NoseBlocker.side` — the
    // hull yaws faster than it pitches (`tuning.pitchRateMult` < 1), so yaw is the
    // quickest way out of the corridor and the swerve costs the least lock time.
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
    // Once a collision course is detected, commit to clearing it. Scaling the
    // turn down at the far edge of the corridor delays the response by most of
    // a decision interval at cruise speed, which is enough to pin a carrier to
    // ring-nebula's enlarged centre collider before the next command arrives.
    // A nav waypoint at/behind a bore entrance is authoritative: the probe may
    // see the portal lip while the routed centreline is still safe to fly.
    const authority = cmd.aimPriority ? 0 : 1;
    const bias = numParam(params, "turnBias", 0.8) * hit.side * authority;
    const slow = numParam(params, "throttleFactor", 1);
    return {
      ...cmd,
      turn: clamp(cmd.turn + bias, -1, 1),
      throttle: clamp(cmd.throttle * (1 - (1 - slow) * authority), 0, 1),
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
    ctx.self.pitch,
    ctx.blockers,
    numParam(params, "lookahead", 16),
    (ctx.self.colliderRadius ?? 0) + numParam(params, "clearance", 2),
    ctx.staticWorld,
    16,
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
  doc: "Attitude error (true 3D angle) past which the bot eases off the engine to swing the nose around.",
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
    { key: "slipRad", kind: "number", fallback: 0.5, min: 0, max: 1.6, doc: "Yaw offset from straight-away while extending (0 = dead astern)." },
    { key: "verticalSlipRad", kind: "number", fallback: 0.3, min: 0, max: 1.6, doc: "Elevation offset added to the extend leg, so the un-merge leaves the enemy's plane too (0 = level with the away bearing)." },
    { key: "throttleRun", kind: "number", fallback: 1, min: 0, max: 1, doc: "Throttle during the extend leg." },
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
    { key: "dodgeClimbRad", kind: "number", fallback: 0.4, min: -1.5, max: 1.5, doc: "Elevation of the break leg, so it leaves the missile's plane as well as its track (0 = level break)." },
    { key: "throttle", kind: "number", fallback: 1, min: 0, max: 1, doc: "Throttle during a hard break." },
    { key: "jinkAmp", kind: "number", fallback: 0.4, min: 0, max: 1, doc: "Turn-axis amplitude layered onto another behaviour's maneuver." },
    { key: "jinkPitchAmp", kind: "number", fallback: 0.4, min: 0, max: 1, doc: "Pitch-axis amplitude for the cycles the weave spends on the vertical (absent = whatever jinkAmp is)." },
    { key: "jinkPeriodSec", kind: "number", fallback: 0.8, min: 0.05, max: 5, doc: "Weave period in seconds (sim time, deterministic); the axis alternates every period." },
    { key: "jinkPhasePerId", kind: "number", fallback: 0.618, min: 0, max: 1, doc: "Per-entity phase offset, so bots weave out of step and on opposite axes." },
    URGENCY,
    BOOST_CHANCE,
  ],
  avoidRocks: [
    { key: "lookahead", kind: "number", fallback: 16, min: 0, max: 80, doc: "Nose-corridor length scanned for asteroids (0 = disabled)." },
    { key: "clearance", kind: "number", fallback: 2, min: 0, max: 20, doc: "Safety margin beyond the authoritative rock and ship collider radii." },
    { key: "turnBias", kind: "number", fallback: 0.8, min: 0, max: 1, doc: "Turn-axis bias applied away from the blocking rock." },
    { key: "throttleFactor", kind: "number", fallback: 1, min: 0, max: 1, doc: "Throttle multiplier while a rock is in the corridor." },
    { key: "throttle", kind: "number", fallback: 0.6, min: 0, max: 1, doc: "Throttle if the profile weights this high enough to win a decision outright." },
  ],
};
