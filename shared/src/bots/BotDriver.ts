import type { ConfigService } from "../core/ConfigService.js";
import type { BotprofileConfig } from "../schemas/botprofile.js";
import type { Vec3 } from "../schemas/common.js";
import type { ModuleConfig } from "../schemas/module.js";
import type { TuningConfig } from "../schemas/tuning.js";
import type { ShipSnapshot, Snapshot } from "../sim/ArenaSimulation.js";
import type { EntityId } from "../sim/components.js";
import { hasLineOfSightAmong } from "../sim/los.js";
import { angleDelta, clamp, dist3 } from "../sim/math.js";
import type { Order } from "../sim/orders.js";
import { deriveRng } from "../sim/rng.js";
import { pitchTuningOf } from "../sim/tuningDefaults.js";
import {
  botBehaviors,
  type BehaviorRegistry,
  type BotBehavior,
  type BotPlan,
  type FlightCommand,
} from "./behaviors.js";
import { boolParam, buildBotContext, numParam, strParam, type BehaviorParams, type BotContext } from "./context.js";
import { steerForPoint } from "./flight.js";
import { planModuleOrders, type ModuleDecision } from "./moduleDiscipline.js";

/**
 * Read-only record of one decision tick — the substrate for the Phase 5.3
 * Behavior Editor debug overlay (current behaviour, utility scores, chosen move
 * point). Replaced wholesale each decision; never mutated.
 */
export interface BotDecisionSnapshot {
  /** Sim-clock milliseconds at which this decision was taken. */
  atMs: number;
  /** Winning behaviour key, or null when the profile produced no candidate. */
  behavior: string | null;
  /** Final utility score per behaviour key considered (baseWeight × factor). */
  scores: Readonly<Record<string, number>>;
  /**
   * Aim point behind the `flight` order actually emitted this decision, or null
   * when the standing flight state was close enough to keep (level-triggered
   * orders mean "no order" is the normal case, not an error).
   *
   * `y` is the bubble altitude (BUBBLE.md §D). It is OPTIONAL rather than
   * required so an overlay or fixture that only cares about the top-down
   * projection keeps compiling; the driver always fills it in.
   */
  movePoint: { x: number; y?: number; z: number } | null;
  /**
   * Aim point the winning behaviour *chose* this decision, whether or not the
   * resulting stick input differed enough to be re-issued. This is the point the
   * 5.3 debug overlay draws — {@link movePoint} only tells you which decisions
   * produced traffic.
   */
  plannedMove: { x: number; y?: number; z: number } | null;
  /**
   * Stick state the driver settled on this decision (after overlays), whether or
   * not it was re-sent. Optional so the field can be added without disturbing
   * consumers that build decision fixtures.
   */
  flight?: FlightCommand;
  boost: boolean;
  /**
   * Enemy this decision manoeuvred against. A purely LOCAL planning focus — the
   * sim owns targeting outright (FLIGHT.md §2), so this never travels as an
   * order and never grants the bot a lock.
   */
  targetId: EntityId | null;
  engaged: boolean;
  /** Module toggles emitted by `moduleDiscipline` this decision. */
  moduleDecisions: readonly ModuleDecision[];
  /** Every order actually emitted this decision. */
  orders: readonly Order[];
}

export interface BotDriverOptions {
  /** Sim entity id of the ship this driver commands. */
  entityId: EntityId;
  profile: BotprofileConfig;
  configs: ConfigService;
  /**
   * Stream this driver draws its jitter/orbit/roll decisions from. Production
   * callers derive it from the MATCH seed plus the bot's entity id
   * (`deriveRng(seed, entityId)`) so a replayed match produces a byte-identical
   * bot; tests may inject any function. Omitted ⇒ derived from the entity id
   * alone, which is still deterministic — there is no `Math.random` default,
   * because one nondeterministic driver desyncs the whole match.
   */
  rng?: () => number;
  /** Behaviour registry override (defaults to the global built-in registry). */
  behaviors?: BehaviorRegistry;
  /** Orbit direction; derived from the RNG when omitted. */
  orbitSign?: 1 | -1;
}

/**
 * Shared empty order list. `BotDriver.update` runs once per bot per sim tick
 * (30 Hz) and returns nothing on the vast majority of them — a fresh `[]` each
 * time is pure garbage. Frozen so a caller can never mutate the shared value.
 */
const NO_ORDERS: readonly Order[] = Object.freeze([]);

/** Minimum spacing between decisions after jitter (ms). */
const MIN_DECISION_MS = 16;
/** Missiles farther than this multiple of the preferred range are ignored. */
const MISSILE_SCAN_MULT = 2;

/**
 * Rotation budget for one stick command, as a multiple of the decision interval.
 * Shared by yaw and pitch: it describes the control loop, not a hull, and the sim
 * integrates both axes on the same tick.
 */
const DEFAULT_TURN_HORIZON_MULT = 1;
/** Attitude error treated as "nose on" — inside it that axis centres (radians). */
const DEFAULT_AIM_TOLERANCE_RAD = 0.02;
/** Stick deltas below these keep the standing (level-triggered) flight state. */
const DEFAULT_TURN_EPSILON = 0.05;
const DEFAULT_PITCH_EPSILON = 0.05;
const DEFAULT_THROTTLE_EPSILON = 0.02;
/** Commanded |axis| below which a rotation sample is too small to calibrate from. */
const CALIBRATION_MIN_TURN = 0.05;
const CALIBRATION_MIN_PITCH_STICK = 0.05;
/**
 * Longest sample window accepted for a turn-rate measurement (seconds). Over a
 * longer span a fast hull could sweep past ±PI and `angleDelta` would alias the
 * rotation down; one sim tick is ~0.033 s, so this only rejects pathological gaps.
 */
const CALIBRATION_MAX_SPAN_SEC = 0.2;
/**
 * Slack when deciding a pitch sample was clamp-pinned. The sim's clamp returns
 * ±`maxPitchRad` exactly and the driver resolves the same tuning value, so this
 * only absorbs float noise — it is not a tolerance band.
 */
const CLAMP_PINNED_EPSILON = 1e-9;

/**
 * `BotDriver` (ROADMAP 5.1, re-planned for flight in FLIGHT.md §7) — drives one
 * ship by emitting the **same orders a human client sends** (`flight` /
 * `moduleToggle`; those are the only two that exist). It consumes a read-only
 * {@link Snapshot} plus its
 * `botprofile` config and returns orders; it never touches sim internals, so
 * every rule (lock gate, range, LoS, energy, heat, order validation) applies to
 * bots by construction. There is no bot aimbot and no sim-side privilege.
 *
 * Utility decision-making: each behaviour key present in the profile is scored
 * as `baseWeight × situationalFactor`; the highest wins and plans the maneuver.
 * A profile without a `retreat` block can never retreat — the config *is* the
 * behaviour set. Behaviours that are situationally live but lost still get to
 * {@link BotBehavior.overlay} the winner's stick (jinks, rock avoidance).
 *
 * **Flight**: a plan is an aim point plus a throttle. {@link steerForPoint}
 * converts the aim point into the `turn` AND `pitchStick` axes (BUBBLE.md §D),
 * which needs the hull's turn and pitch rates — stats the snapshot deliberately
 * does not carry. The driver therefore *measures* both (see
 * {@link BotDriver.calibrate}): each axis integrates as exactly
 * `axis * rate * dt`, so one tick of a known non-zero stick reveals the rate
 * exactly, and it then tracks modules/upgrades that change it for free.
 *
 * Cadence, jitter, ranges, weights, stick feel and thresholds all come from the
 * profile. Nothing bot-specific and nothing per-ship is hardcoded here.
 */
export class BotDriver {
  readonly entityId: EntityId;
  /** Profile handed in at spawn; used until/unless the registry has a newer one. */
  private readonly spawnProfile: BotprofileConfig;

  private readonly configs: ConfigService;
  private readonly rng: () => number;
  private readonly behaviors: BehaviorRegistry;
  private readonly orbitSign: 1 | -1;

  private nextDecisionMs = 0;
  private started = false;
  /** Flight state the ship is currently integrating (what we last sent), if any. */
  private lastFlight: FlightCommand | null = null;
  private decision: BotDecisionSnapshot | null = null;
  private weaponRangeCache = -1;
  /** `tuning.maxPitchRad`, resolved once (see {@link BotDriver.maxPitch}). */
  private maxPitchCache = -1;
  /** Measured hull turn rate in rad/s; 0 until the first usable sample. */
  private turnRateEst = 0;
  /** Measured hull pitch rate in rad/s per unit stick; 0 until measured. */
  private pitchRateEst = 0;
  private lastHeading: number | null = null;
  private lastPitch: number | null = null;
  private lastElapsed = 0;

  constructor(options: BotDriverOptions) {
    this.entityId = options.entityId;
    this.spawnProfile = options.profile;
    this.configs = options.configs;
    this.rng = options.rng ?? deriveRng(options.entityId);
    this.behaviors = options.behaviors ?? botBehaviors();
    this.orbitSign = options.orbitSign ?? (this.rng() < 0.5 ? -1 : 1);
  }

  /**
   * The profile driving this bot, re-read from the config registry every time
   * it is used. `ConfigService.replace` stores a *new* frozen object, so
   * resolving by id is what makes a Behavior Editor tweak (or a content hot
   * reload) apply to the bots already flying, with the spawn-time profile as the
   * fallback for registries that do not hold it (tests, ad-hoc drivers).
   */
  get profile(): BotprofileConfig {
    return this.configs.get<BotprofileConfig>("botprofile", this.spawnProfile.id) ?? this.spawnProfile;
  }

  /** Last decision taken, for debug overlays. Null before the first decision. */
  get lastDecision(): BotDecisionSnapshot | null {
    return this.decision;
  }

  /**
   * Measured hull turn rate in rad/s (0 before the first usable sample). Exposed
   * for the debug overlay and for tests that assert the calibration converges.
   */
  get measuredTurnRate(): number {
    return this.turnRateEst;
  }

  /**
   * Measured hull pitch rate in rad/s per unit stick (0 before the first usable
   * sample — samples taken while the nose was pinned at `tuning.maxPitchRad` do
   * not count, see {@link BotDriver.calibrate}).
   */
  get measuredPitchRate(): number {
    return this.pitchRateEst;
  }

  /** Forget cadence, calibration and issued-order memory (e.g. after a respawn). */
  reset(): void {
    this.started = false;
    this.nextDecisionMs = 0;
    this.lastFlight = null;
    this.decision = null;
    this.turnRateEst = 0;
    this.pitchRateEst = 0;
    this.lastHeading = null;
    this.lastPitch = null;
    this.lastElapsed = 0;
  }

  /**
   * Advance the driver. Call every sim tick with the current snapshot and the
   * elapsed sim time in milliseconds; returns the orders to feed through the
   * normal order pipeline (empty between decision intervals).
   *
   * Turn-rate calibration runs on *every* tick, not just decision ticks — the
   * ship keeps integrating the standing flight state in between, so those ticks
   * are free measurements.
   *
   * The `phase !== "live"` guard is what keeps bots honest during the start
   * countdown: no orders at all, so no bot burns boost (or banks a calibration
   * sample off a frozen hull) before GO. It costs the bot nothing — a held
   * flight state is stored the instant it decides, and the countdown is over
   * before its first decision interval would have elapsed anyway.
   */
  update(snapshot: Snapshot, nowMs: number): readonly Order[] {
    if (snapshot.phase !== "live") return NO_ORDERS;
    const self = findShipSnapshot(snapshot, this.entityId);
    if (!self) return NO_ORDERS;
    this.calibrate(self, snapshot.elapsed);

    if (!this.started) {
      this.started = true;
      // Stagger first decisions across bots so they don't all fire on tick 0.
      this.nextDecisionMs = nowMs + this.rng() * this.profile.decisionIntervalMs;
      return NO_ORDERS;
    }
    if (nowMs < this.nextDecisionMs) return NO_ORDERS;
    this.nextDecisionMs = nowMs + this.jitteredInterval();

    return this.decide(snapshot, self, nowMs);
  }

  /**
   * Recover the hull's `turnRate` and pitch rate from what the ship actually did
   * with the last stick we sent. NavigationSystem integrates
   * `heading += turn * turnRate * dt` and
   * `pitch = clamp(pitch + pitchStick * turnRate * pitchRateMult * dt)`, and
   * nothing else rotates a ship, so each quotient is that axis's rate exactly —
   * no estimator, no smoothing, and it re-measures every tick, which is what keeps
   * a module/upgrade that changes `turnRate` mid-match working with zero extra
   * code. The two axes are measured INDEPENDENTLY rather than deriving pitch as
   * `turnRate × tuning.pitchRateMult`: measuring what the hull did is the same
   * trick that already makes the yaw axis free of ship stats, and it survives a
   * future pitch stat or a pitch-only module without touching this file.
   *
   * Samples are skipped when that stick was ~centred (no signal), when sim time
   * did not advance (a replayed snapshot) or when the window is long enough that
   * the hull could have swept past ±PI and aliased.
   *
   * **Pitch has one extra rejection, and it matters** (BUBBLE.md §A): the pitch
   * integration is CLAMPED at ±`tuning.maxPitchRad`. A tick that ends with the
   * nose pinned there rotated less than the stick asked for, so its quotient
   * under-reports the rate — sometimes by an order of magnitude, sometimes to
   * exactly 0. Either poisons the estimate permanently in the direction that
   * makes {@link steerForPoint} saturate the pitch axis on every later
   * correction, which is precisely the oscillation the proportional rule exists
   * to avoid. So a pinned sample is not a slightly-wrong measurement to be
   * smoothed; it is no measurement at all, and is dropped.
   */
  private calibrate(self: ShipSnapshot, elapsed: number): void {
    const prevHeading = this.lastHeading;
    const prevPitch = this.lastPitch;
    const span = elapsed - this.lastElapsed;
    this.lastHeading = self.heading;
    this.lastPitch = self.pitch;
    this.lastElapsed = elapsed;

    if (prevHeading === null || prevPitch === null) return;
    if (span <= 0 || span > CALIBRATION_MAX_SPAN_SEC) return;

    const turn = this.lastFlight?.turn ?? 0;
    if (Math.abs(turn) >= CALIBRATION_MIN_TURN) {
      const rate = angleDelta(prevHeading, self.heading) / (turn * span);
      if (Number.isFinite(rate) && rate > 0) this.turnRateEst = rate;
    }

    const stick = this.lastFlight?.pitchStick ?? 0;
    if (Math.abs(stick) < CALIBRATION_MIN_PITCH_STICK) return;
    // Nose pinned at the clamp at the END of the window ⇒ the observed delta is
    // truncated (or zero) — see the note above. Checking only the end state is
    // enough and is deliberately not extended to the start: leaving the clamp is
    // a perfectly clean, fully observed rotation.
    if (Math.abs(self.pitch) >= this.maxPitch() - CLAMP_PINNED_EPSILON) return;
    const rate = (self.pitch - prevPitch) / (stick * span);
    if (Number.isFinite(rate) && rate > 0) this.pitchRateEst = rate;
  }

  /**
   * `tuning.maxPitchRad` — the hull's pitch clamp, needed both to reject pinned
   * calibration samples and to keep {@link steerForPoint} from asking for an
   * elevation the sim will not give. Resolved from the registry exactly as the sim
   * and the client predictor do (`getAll("tuning")[0]`, documented default) and
   * cached: unlike the botprofile this is not an editor-hot-reload surface, and
   * `calibrate` runs every tick for every bot.
   */
  private maxPitch(): number {
    if (this.maxPitchCache >= 0) return this.maxPitchCache;
    const tuning = this.configs.getAll<TuningConfig>("tuning")[0];
    this.maxPitchCache = pitchTuningOf(tuning ?? ({} as TuningConfig)).maxPitchRad;
    return this.maxPitchCache;
  }

  private jitteredInterval(): number {
    const jitter = this.profile.orderJitterMs;
    const offset = jitter > 0 ? (this.rng() * 2 - 1) * jitter : 0;
    return Math.max(MIN_DECISION_MS, this.profile.decisionIntervalMs + offset);
  }

  private decide(snapshot: Snapshot, self: ShipSnapshot, nowMs: number): Order[] {
    const orders: Order[] = [];
    // One registry read per decision: the profile cannot change mid-decision.
    const profile = this.profile;
    const horizonSec =
      (profile.decisionIntervalMs / 1000) * (profile.flight?.turnHorizonMult ?? DEFAULT_TURN_HORIZON_MULT);

    // --- context (target choice first: behaviours score relative to it) ---
    const weaponRange = this.weaponRange(self);
    const build = (targetId: EntityId | null): BotContext =>
      buildBotContext({
        snapshot,
        self,
        profile,
        weaponRange,
        targetId,
        missileScanRadius: Math.max(profile.preferredRange[1], 1) * MISSILE_SCAN_MULT,
        orbitSign: this.orbitSign,
        rng: this.rng,
        turnRate: this.turnRateEst,
        pitchRate: this.pitchRateEst,
        turnHorizonSec: horizonSec,
      });
    const preliminary = build(self.targetId);
    const targetId = this.pickTarget(preliminary);
    const ctx = targetId === preliminary.target?.id ? preliminary : build(targetId);

    // --- utility scoring over the behaviours the profile actually declares ---
    // `factor` (situational, ≥ 0) and `score` (baseWeight × factor) are tracked
    // separately: the score decides who *plans*, the factor decides who is live
    // enough to *overlay*. That is what makes `baseWeight: 0` a pure overlay.
    const scores: Record<string, number> = {};
    const live: { key: string; params: BehaviorParams; behavior: BotBehavior }[] = [];
    let bestKey: string | null = null;
    let bestScore = 0;
    let bestPlan: BotPlan | null = null;
    for (const [key, params] of Object.entries(profile.behaviors)) {
      const behavior = this.behaviors.get(key);
      if (!behavior) continue; // unknown key in config: ignored, never crashes a match
      const factor = behavior.score(ctx, params);
      const score = params.baseWeight * factor;
      scores[key] = score;
      if (factor > 0 && behavior.overlay) live.push({ key, params, behavior });
      if (score > bestScore) {
        bestScore = score;
        bestKey = key;
      }
    }
    if (bestKey !== null) {
      const params = profile.behaviors[bestKey]!;
      bestPlan = this.behaviors.get(bestKey)!.plan(ctx, params);
    }

    // --- flight order: aim point -> both sticks, then overlays, then epsilon gate ---
    const aim = bestPlan?.aim ?? null;
    const tolerance = profile.flight?.aimToleranceRad ?? DEFAULT_AIM_TOLERANCE_RAD;
    const steer = aim
      ? steerForPoint(self.pos, self.heading, self.pitch, aim, {
          turnRate: this.turnRateEst,
          pitchRate: this.pitchRateEst,
          horizonSec,
          toleranceRad: tolerance,
          maxPitchRad: this.maxPitch(),
        })
      : null;
    let cmd: FlightCommand = {
      turn: steer?.turn ?? 0,
      pitchStick: steer?.pitchStick ?? 0,
      throttle: clamp(bestPlan?.throttle ?? 0, 0, 1),
      boost: bestPlan?.boost ?? false,
    };
    for (const l of live) {
      if (l.key === bestKey) continue; // the winner already spoke through its plan
      cmd = l.behavior.overlay!(ctx, l.params, cmd);
    }
    // `clamp` passes NaN straight through, and a non-finite axis would poison the
    // ship's attitude for the rest of the match (flight orders are level-triggered).
    // A mistyped content param is the realistic source, so neutralise it here
    // rather than shipping an order the sim would have to drop.
    cmd = {
      turn: Number.isFinite(cmd.turn) ? clamp(cmd.turn, -1, 1) : 0,
      pitchStick: Number.isFinite(cmd.pitchStick) ? clamp(cmd.pitchStick, -1, 1) : 0,
      throttle: Number.isFinite(cmd.throttle) ? clamp(cmd.throttle, 0, 1) : 0,
      boost: cmd.boost,
    };

    let issuedAim: Required<Vec3> | null = null;
    if (this.shouldSendFlight(cmd, profile)) {
      // Same shape, same validation, same pipeline as the human joystick — now
      // including the pitch axis a human gets from the joystick's y (BUBBLE.md §C).
      orders.push({
        kind: "flight",
        throttle: cmd.throttle,
        turn: cmd.turn,
        pitchStick: cmd.pitchStick,
        boost: cmd.boost,
      });
      this.lastFlight = cmd;
      issuedAim = aim ? aimPoint(aim) : null;
    }

    // --- module discipline ---
    const engaged = bestPlan?.engaged ?? false;
    const modulePlan = planModuleOrders(ctx, this.configs, this.profile.moduleDiscipline, engaged);
    orders.push(...modulePlan.orders);

    this.decision = {
      atMs: nowMs,
      behavior: bestKey,
      scores,
      movePoint: issuedAim,
      plannedMove: aim ? aimPoint(aim) : null,
      flight: cmd,
      boost: cmd.boost,
      targetId,
      engaged,
      moduleDecisions: modulePlan.decisions,
      orders,
    };
    return orders;
  }

  /**
   * Whether the stick moved enough to be worth a wire order. Flight orders are
   * level-triggered, so "send nothing" means "keep flying the last command" —
   * the epsilons are what keep a bot's order rate at a fraction of a decision per
   * second instead of one per decision, well inside `tuning.maxOrdersPerSec`.
   */
  private shouldSendFlight(cmd: FlightCommand, profile: BotprofileConfig): boolean {
    const last = this.lastFlight;
    if (!last) return true;
    if (last.boost !== cmd.boost) return true;
    if (Math.abs(last.turn - cmd.turn) > (profile.flight?.turnEpsilon ?? DEFAULT_TURN_EPSILON)) return true;
    // Pitch gets its own epsilon: it is the axis a bot holds STILL for long
    // stretches (a level fight never touches it), so folding it into the turn
    // threshold would either add traffic on the yaw axis or make a genuine climb
    // command wait for the next decision that happened to move the yaw too.
    if (Math.abs(last.pitchStick - cmd.pitchStick) > (profile.flight?.pitchEpsilon ?? DEFAULT_PITCH_EPSILON)) {
      return true;
    }
    return Math.abs(last.throttle - cmd.throttle) > (profile.flight?.throttleEpsilon ?? DEFAULT_THROTTLE_EPSILON);
  }

  /**
   * Which enemy to MANOEUVRE against this decision. Purely local: targeting is
   * automatic in the sim and the bot has no way to pin it (FLIGHT.md §2), so
   * this only decides which enemy the behaviours plan around — put the nose on,
   * kite away from, break line of sight with.
   *
   * Policy comes from the profile's `engage` block (`targetPreference:
   * "nearest" | "lowestHull"`, default `nearest`); enemies without line of sight
   * are penalised by `losPenalty` so bots prefer someone they can actually shoot.
   *
   * `holdLockTarget` (default on) keeps the planning focus aligned with the
   * sim's sticky lock candidate: while the sensors have progress on the books,
   * fly against the enemy they are warming rather than re-ranking into a
   * manoeuvre that walks the warm-up out of the cone.
   */
  private pickTarget(ctx: BotContext): EntityId | null {
    if (ctx.enemies.length === 0) return null;
    const params = this.profile.behaviors["engage"];
    const preference = params ? strParam(params, "targetPreference", "nearest") : "nearest";
    const losPenalty = params ? numParam(params, "losPenalty", 2) : 2;
    const hold = params ? boolParam(params, "holdLockTarget", true) : true;
    if (hold && ctx.self.lockProgress > 0 && ctx.self.targetId !== null) {
      const held = ctx.self.targetId;
      if (ctx.enemies.some((e) => e.id === held)) return held;
    }

    let best: EntityId | null = null;
    let bestCost = Infinity;
    for (const e of ctx.enemies) {
      // 3D range, like every other distance a bot reasons about in the bubble:
      // the nearest enemy on the (x,z) projection can be the FARTHEST one to fly
      // at once altitude is in play (BUBBLE.md §D).
      const base =
        preference === "lowestHull" ? (e.hullMax > 0 ? e.hull / e.hullMax : 0) : dist3(ctx.self.pos, e.pos);
      const visible = hasLineOfSightAmong(ctx.self.pos, e.pos, ctx.blockers);
      const cost = visible ? base : base * losPenalty + 1;
      if (cost < bestCost) {
        bestCost = cost;
        best = e.id;
      }
    }
    return best;
  }

  /** Longest fitted weapon range (cached; the fitting never changes mid-match). */
  private weaponRange(self: ShipSnapshot): number {
    if (this.weaponRangeCache >= 0) return this.weaponRangeCache;
    let max = 0;
    for (const m of self.modules) {
      const cfg = this.configs.get<ModuleConfig>("module", m.moduleId);
      if (cfg?.fire) max = Math.max(max, cfg.fire.range);
    }
    this.weaponRangeCache = max;
    return max;
  }
}

/**
 * Copy an aim point for the debug record. A plan may legally omit `y` (a
 * behaviour that means "my own altitude"), so this normalises it — the overlay
 * should never have to guess whether a missing `y` meant zero or "unknown".
 */
function aimPoint(aim: Vec3): Required<Vec3> {
  return { x: aim.x, y: aim.y ?? 0, z: aim.z };
}

/** Indexed ship lookup — runs every sim tick per bot, so no predicate closure. */
function findShipSnapshot(snapshot: Snapshot, id: EntityId): ShipSnapshot | undefined {
  for (let i = 0; i < snapshot.ships.length; i++) {
    if (snapshot.ships[i]!.id === id) return snapshot.ships[i];
  }
  return undefined;
}
