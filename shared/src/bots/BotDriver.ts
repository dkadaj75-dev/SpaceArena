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
// Side-effect import: behaviours self-register on load, and nothing else here
// pulls this one in — without it a capture-the-flag profile would name an
// `objective` behaviour the registry has never heard of and silently ignore it.
import "./ctfBehavior.js";
import { steerForPoint } from "./flight.js";
import { decideFire, type FireDecisionReason, type FireDisciplineState } from "./fireDiscipline.js";
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
  /** True while the floor recovery override is commanding a climb. */
  floorRecovery?: boolean;
  /** True while no-progress recovery owns flight until real surface separation. */
  surfaceRecovery?: boolean;
  /** Level-triggered fire decision and its debug-overlay explanation. */
  fire?: boolean;
  fireReason?: FireDecisionReason;
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
  /** Arena floor plane. Omit for fully enclosed/unfloored arenas. */
  floorY?: number;
  /** Maximum rendered hull extent, when larger than the gameplay collider. */
  visualRadius?: number;
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
const FLOOR_LOOKAHEAD_SEC = 2.5;
const FLOOR_NOMINAL_SPEED = 20;
const CARRIER_STUCK_MS = 5_000;
const CARRIER_COMMIT_MS = 3_000;
const CARRIER_PROGRESS_EPSILON = 0.75;
const WEDGE_CONTACT_EPSILON = 0.35;
const WEDGE_SPEED = 0.75;
const WEDGE_DETECT_MS = 900;
const UNSTUCK_COMMIT_MS = 2_000;
const UNSTUCK_AIM_DISTANCE = 28;
const FLOOR_RECOVERY_CLEARANCE_MULT = 4;
const SURFACE_STALL_MS = 1_500;
const SURFACE_STALL_RADIUS = 1;
const SURFACE_ESCAPE_CLEARANCE = 4;
const SURFACE_ESCAPE_AIM_DISTANCE = 30;
const SURFACE_ESCAPE_RADIUS_MULT = 3;
const SURFACE_VISUAL_MARGIN = 0.35;
const SURFACE_ANTIPARALLEL_BIAS = 0.35;

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
  private readonly floorY: number | undefined;
  private readonly visualRadius: number | undefined;

  private nextDecisionMs = 0;
  private started = false;
  /** Flight state the ship is currently integrating (what we last sent), if any. */
  private lastFlight: FlightCommand | null = null;
  private lastFire: boolean | null = null;
  /** Engagement choice held between utility decisions; trigger phase samples it every tick. */
  private lastEngaged = false;
  private lastTargetId: EntityId | null = null;
  /** Increments once per live update; deterministic source for trigger bursts. */
  private driverTick = 0;
  private decision: BotDecisionSnapshot | null = null;
  private weaponRangeCache = -1;
  /** `tuning.maxPitchRad`, resolved once (see {@link BotDriver.maxPitch}). */
  private maxPitchCache: number | null | undefined = undefined;
  /** Measured hull turn rate in rad/s; 0 until the first usable sample. */
  private turnRateEst = 0;
  /** Measured hull pitch rate in rad/s per unit stick; 0 until measured. */
  private pitchRateEst = 0;
  private lastHeading: number | null = null;
  private lastPitch: number | null = null;
  private lastElapsed = 0;
  /** Seeded combat-aim bias, held across decisions so misses look human, not noisy. */
  private marksmanship = { yaw: 0, pitch: 0, velocitySec: 0, untilMs: 0 };
  private targetMotion: { id: EntityId; pos: Required<Vec3>; atMs: number } | null = null;
  private fireState: FireDisciplineState = { heatHeld: false };
  private carrierProgress: { homeDistance: number; progressedAtMs: number; commitUntilMs: number } | null = null;
  private wedgeContactSinceMs: number | null = null;
  private unstuck: { untilMs: number; obstacleId: EntityId; side: 1 | -1 } | null = null;
  private surfaceStall: { key: string; sinceMs: number; anchor: Required<Vec3> } | null = null;
  private surfaceEscape: { key: string; normal: Required<Vec3>; side: 1 | -1 } | null = null;
  private floorRecovering = false;
  private heldBehavior: { key: string; untilMs: number } | null = null;

  constructor(options: BotDriverOptions) {
    this.entityId = options.entityId;
    this.spawnProfile = options.profile;
    this.configs = options.configs;
    this.rng = options.rng ?? deriveRng(options.entityId);
    this.behaviors = options.behaviors ?? botBehaviors();
    this.orbitSign = options.orbitSign ?? (this.rng() < 0.5 ? -1 : 1);
    this.floorY = options.floorY;
    this.visualRadius = options.visualRadius;
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
    this.lastFire = null;
    this.lastEngaged = false;
    this.lastTargetId = null;
    this.driverTick = 0;
    this.decision = null;
    this.turnRateEst = 0;
    this.pitchRateEst = 0;
    this.lastHeading = null;
    this.lastPitch = null;
    this.lastElapsed = 0;
    this.marksmanship = { yaw: 0, pitch: 0, velocitySec: 0, untilMs: 0 };
    this.targetMotion = null;
    this.fireState = { heatHeld: false };
    this.carrierProgress = null;
    this.wedgeContactSinceMs = null;
    this.unstuck = null;
    this.surfaceStall = null;
    this.surfaceEscape = null;
    this.floorRecovering = false;
    this.heldBehavior = null;
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
    this.driverTick += 1;
    this.calibrate(self, snapshot.elapsed);

    if (!this.started) {
      this.started = true;
      // Stagger first decisions across bots so they don't all fire on tick 0.
      this.nextDecisionMs = nowMs + this.rng() * this.profile.decisionIntervalMs;
      return NO_ORDERS;
    }
    if (nowMs < this.nextDecisionMs) return this.updateTrigger(snapshot, self);
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
   * **Pitch has one extra rejection when — and only when — a pack authors the
   * legacy clamp** (BUBBLE.md §A). Under free pitch there is no clamp to pin
   * against: every tick is a complete, honestly observed rotation, the rejection
   * never fires, and calibration converges on the very first stick the bot sends
   * (it re-measures every tick regardless). The observed delta is read through
   * `angleDelta` so a sample that straddles the ±PI wrap mid-loop reads as the
   * small rotation it was rather than a ~2PI one, which would otherwise bank a
   * wildly inflated rate and then centre every later correction to nothing.
   *
   * With the clamp authored the old rejection stands, for the old reason: the
   * pitch integration is CLAMPED at ±`tuning.maxPitchRad`, and a tick that ends
   * with the
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
      // `heading` is a COORDINATE, and yaw is applied in the ship's own frame
      // (BUBBLE.md §A), so a body-frame yaw of psi moves the heading by
      // `psi / cos(pitch)` — unbounded at the pole. Multiplying the observed
      // heading change back by `cos(pitch)` recovers the hull's actual yaw rate,
      // which is what {@link steerForPoint} plans with. Without this the estimate
      // would balloon with pitch and the bot would centre its stick to nothing in
      // a steep climb. The sample is taken at the END attitude, matching how the
      // pitch axis below reads its own.
      const rate = (angleDelta(prevHeading, self.heading) * Math.cos(self.pitch)) / (turn * span);
      if (Number.isFinite(rate) && rate > 0) this.turnRateEst = rate;
    }

    const stick = this.lastFlight?.pitchStick ?? 0;
    if (Math.abs(stick) < CALIBRATION_MIN_PITCH_STICK) return;
    // Nose pinned at the clamp at the END of the window ⇒ the observed delta is
    // truncated (or zero) — see the note above. Checking only the end state is
    // enough and is deliberately not extended to the start: leaving the clamp is
    // a perfectly clean, fully observed rotation. No clamp ⇒ nothing to pin on.
    const limit = this.maxPitch();
    if (limit !== null && Math.abs(self.pitch) >= limit - CLAMP_PINNED_EPSILON) return;
    const rate = angleDelta(prevPitch, self.pitch) / (stick * span);
    if (Number.isFinite(rate) && rate > 0) this.pitchRateEst = rate;
  }

  /**
   * `tuning.maxPitchRad` — the hull's OPTIONAL pitch clamp, needed both to reject
   * pinned calibration samples and to keep {@link steerForPoint} from asking for
   * an elevation the sim will not give. `null` means the pack authored none and
   * the hull can loop, which is the shipped case. Resolved from the registry
   * exactly as the sim and the client predictor do (`getAll("tuning")[0]`) and
   * cached: unlike the botprofile this is not an editor-hot-reload surface, and
   * `calibrate` runs every tick for every bot.
   */
  private maxPitch(): number | null {
    if (this.maxPitchCache !== undefined) return this.maxPitchCache;
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
        driverTick: this.driverTick,
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
      const ctfCombatMultiplier = snapshot.flags.length > 0 && key === "engage"
        ? (profile.ctfWeights?.threatResponse ?? 1)
        : 1;
      const score = params.baseWeight * factor * ctfCombatMultiplier;
      scores[key] = score;
      if (factor > 0 && behavior.overlay) live.push({ key, params, behavior });
      if (score > bestScore) {
        bestScore = score;
        bestKey = key;
      }
    }
    const roleHoldMs = profile.ctfWeights?.roleHoldMs ?? 2500;
    if (this.heldBehavior && nowMs < this.heldBehavior.untilMs && (scores[this.heldBehavior.key] ?? 0) > 0) {
      bestKey = this.heldBehavior.key;
    } else if (bestKey !== null && (bestKey === "objective" || this.heldBehavior?.key === "objective")) {
      this.heldBehavior = { key: bestKey, untilMs: nowMs + roleHoldMs };
    }
    if (bestKey !== null) {
      const params = profile.behaviors[bestKey]!;
      bestPlan = this.behaviors.get(bestKey)!.plan(ctx, params);
    }
    bestPlan = this.commitStuckCarrier(snapshot, self, bestPlan, nowMs);
    bestPlan = this.surfaceRecoveryPlan(snapshot, self, bestPlan, nowMs);
    bestPlan = this.unstuckPlan(snapshot, self, bestPlan, nowMs);
    const engaged = bestPlan?.engaged ?? false;
    // Objective travel owns steering, but it must not make nearby enemies
    // invulnerable. Fire opportunistically without replacing the route home.
    const opportunisticRange = weaponRange * (profile.ctfWeights?.opportunisticCombat ?? 1);
    const triggerEngaged = engaged || (
      bestKey === "objective" && ctx.target !== null && ctx.hasLoS && ctx.distance <= opportunisticRange
    );
    this.lastEngaged = triggerEngaged;
    this.lastTargetId = targetId;
    const fireDecision = decideFire(ctx, this.configs, profile.fireDiscipline, triggerEngaged, this.fireState);

    // --- flight order: aim point -> both sticks, then overlays, then epsilon gate ---
    const plannedAim = bestPlan?.aim ?? null;
    const aim = plannedAim && engaged && ctx.target
      ? this.imperfectCombatAim(plannedAim, ctx, profile, nowMs)
      : plannedAim;
    const tolerance = profile.flight?.aimToleranceRad ?? DEFAULT_AIM_TOLERANCE_RAD;
    const steer = aim
      ? steerForPoint(
          self.pos,
          self.heading,
          self.pitch,
          aim,
          {
            turnRate: this.turnRateEst,
            pitchRate: this.pitchRateEst,
            horizonSec,
            toleranceRad: tolerance,
            maxPitchRad: this.maxPitch(),
          },
          // The PERSISTED frame, not one rebuilt from heading/pitch: near the
          // poles the rebuild names a different frame from the one the sim is
          // integrating, and the bot would yaw about an axis its hull lacks.
          self.up,
        )
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
    // A measured surface escape already includes the floor normal when needed.
    // Letting predictive floor avoidance rewrite it here can deadlock a hull in
    // the seam between the plane and a rock, with the two overrides alternating.
    if (!this.surfaceEscape) cmd = this.avoidFloor(self, cmd, horizonSec, tolerance);
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
    if (this.shouldSendFlight(cmd, fireDecision.fire, profile)) {
      // Same shape, same validation, same pipeline as the human joystick — now
      // including the pitch axis a human gets from the joystick's y (BUBBLE.md §C).
      orders.push({
        kind: "flight",
        throttle: cmd.throttle,
        turn: cmd.turn,
        pitchStick: cmd.pitchStick,
        boost: cmd.boost,
        fire: fireDecision.fire,
      });
      this.lastFlight = cmd;
      this.lastFire = fireDecision.fire;
      issuedAim = aim ? aimPoint(aim) : null;
    }

    // --- module discipline ---
    const modulePlan = planModuleOrders(ctx, this.configs, this.profile.moduleDiscipline, triggerEngaged);
    orders.push(...modulePlan.orders);
    // Boost-capable engines spawn disabled. When a bot elects to boost, it
    // explicitly arms that engine through the normal module-toggle pipeline.
    for (const m of ctx.self.modules) {
      if (!cmd.boost || m.state !== "retracted") continue;
      const cfg = this.configs.get<ModuleConfig>("module", m.moduleId);
      if (!cfg?.boost) continue;
      // Read the BOTTLE before pulling the handle (heat/energy overhaul
      // 2026-08-07): the sim refuses to raise an energy module below its own
      // `rearmAbove`, so arming a flamed-out afterburner would be a toggle order
      // spent every decision tick for nothing — against the bot's rate budget.
      if (m.energyCapacity > 0 && m.energy < m.energyCapacity * (cfg.energy?.rearmAbove ?? 0)) continue;
      modulePlan.decisions.push({
        hardpointIndex: m.hardpointIndex,
        moduleId: m.moduleId,
        activate: true,
        reason: "boost-requested",
      });
    }

    this.decision = {
      atMs: nowMs,
      behavior: bestKey,
      scores,
      movePoint: issuedAim,
      plannedMove: aim ? aimPoint(aim) : null,
      flight: cmd,
      boost: cmd.boost,
      targetId,
      engaged: triggerEngaged,
      floorRecovery: this.floorRecovering,
      surfaceRecovery: this.surfaceEscape !== null,
      fire: fireDecision.fire,
      fireReason: fireDecision.reason,
      moduleDecisions: modulePlan.decisions,
      orders,
    };
    return orders;
  }

  /**
   * Apply one deterministic, sustained error sample to combat pursuit. The
   * angular component grows toward the authored error over preferred range, so
   * knife-range spatial error stays small. The velocity component models a bad
   * estimate of lateral motion rather than omniscient frame-perfect tracking.
   */
  private imperfectCombatAim(
    exact: Vec3,
    ctx: BotContext,
    profile: BotprofileConfig,
    nowMs: number,
  ): Required<Vec3> {
    const tuning = profile.behaviors.engage;
    if (!tuning || !Object.hasOwn(tuning, "aimErrorRad")) return aimPoint(exact);
    if (nowMs >= this.marksmanship.untilMs) {
      const angular = numParam(tuning, "aimErrorRad", 0);
      const velocity = numParam(tuning, "velocityErrorSec", 0);
      this.marksmanship = {
        yaw: (this.rng() * 2 - 1) * angular,
        pitch: (this.rng() * 2 - 1) * angular * 0.6,
        velocitySec: (this.rng() * 2 - 1) * velocity,
        untilMs: nowMs + numParam(tuning, "aimErrorHoldMs", 1200),
      };
    }
    const target = ctx.target;
    const prior = this.targetMotion;
    const samplePos = target ? aimPoint(target.pos) : aimPoint(exact);
    let targetVelocity = { x: 0, y: 0, z: 0 };
    if (target && prior?.id === target.id && nowMs > prior.atMs) {
      const dt = (nowMs - prior.atMs) / 1000;
      targetVelocity = {
        x: (samplePos.x - prior.pos.x) / dt,
        y: (samplePos.y - prior.pos.y) / dt,
        z: (samplePos.z - prior.pos.z) / dt,
      };
    }
    if (target) this.targetMotion = { id: target.id, pos: samplePos, atMs: nowMs };
    const tx = exact.x + (targetVelocity?.x ?? 0) * this.marksmanship.velocitySec;
    const ty = (exact.y ?? ctx.self.pos.y) + (targetVelocity?.y ?? 0) * this.marksmanship.velocitySec;
    const tz = exact.z + (targetVelocity?.z ?? 0) * this.marksmanship.velocitySec;
    const dx = tx - ctx.self.pos.x;
    const dy = ty - ctx.self.pos.y;
    const dz = tz - ctx.self.pos.z;
    const range = Math.max(Math.hypot(dx, dy, dz), 1e-6);
    const rangeScale = clamp(ctx.distance / Math.max(ctx.preferredMax, 1), 0.12, 1);
    const yaw = Math.atan2(dx, dz) + this.marksmanship.yaw * rangeScale;
    const pitch = Math.atan2(dy, Math.hypot(dx, dz)) + this.marksmanship.pitch * rangeScale;
    const horizontal = Math.cos(pitch) * range;
    return {
      x: ctx.self.pos.x + Math.sin(yaw) * horizontal,
      y: ctx.self.pos.y + Math.sin(pitch) * range,
      z: ctx.self.pos.z + Math.cos(yaw) * horizontal,
    };
  }

  /**
   * Re-evaluate only the trigger phase between utility decisions. Movement,
   * target selection and engagement remain latched from the last full decision;
   * burst/pause timing follows deterministic driver ticks instead of the
   * jittered decision cadence.
   */
  private updateTrigger(snapshot: Snapshot, self: ShipSnapshot): readonly Order[] {
    const flight = this.lastFlight;
    if (!flight) return NO_ORDERS;
    const profile = this.profile;
    const horizonSec =
      (profile.decisionIntervalMs / 1000) * (profile.flight?.turnHorizonMult ?? DEFAULT_TURN_HORIZON_MULT);
    const ctx = buildBotContext({
      snapshot,
      self,
      profile,
      weaponRange: this.weaponRange(self),
      targetId: this.lastTargetId,
      missileScanRadius: Math.max(profile.preferredRange[1], 1) * MISSILE_SCAN_MULT,
      orbitSign: this.orbitSign,
      rng: this.rng,
      turnRate: this.turnRateEst,
      pitchRate: this.pitchRateEst,
      turnHorizonSec: horizonSec,
      driverTick: this.driverTick,
    });
    const fireDecision = decideFire(ctx, this.configs, profile.fireDiscipline, this.lastEngaged);
    if (fireDecision.fire === this.lastFire) return NO_ORDERS;

    this.lastFire = fireDecision.fire;
    return [
      {
        kind: "flight",
        throttle: flight.throttle,
        turn: flight.turn,
        pitchStick: flight.pitchStick,
        boost: flight.boost,
        fire: fireDecision.fire,
      },
    ];
  }

  /**
   * Whether the stick moved enough to be worth a wire order. Flight orders are
   * level-triggered, so "send nothing" means "keep flying the last command" —
   * the epsilons are what keep a bot's order rate at a fraction of a decision per
   * second instead of one per decision, well inside `tuning.maxOrdersPerSec`.
   */
  private shouldSendFlight(cmd: FlightCommand, fire: boolean, profile: BotprofileConfig): boolean {
    const last = this.lastFlight;
    if (!last) return true;
    if (this.lastFire !== fire) return true;
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
    const carrierPriority = this.profile.carrierPriority ?? 8;
    const enemyCarrierIds = new Set(
      ctx.snapshot.flags
        .filter((flag) => flag.state === "carried" && flag.carrierId !== null)
        .map((flag) => flag.carrierId!),
    );
    const sensedCarrier = ctx.enemies.some((enemy) =>
      enemyCarrierIds.has(enemy.id)
      && dist3(ctx.self.pos, enemy.pos) <= (ctx.self.sensorRange ?? Math.max(ctx.weaponRange, ctx.preferredMax))
      && hasLineOfSightAmong(ctx.self.pos, enemy.pos, ctx.blockers));
    if (!sensedCarrier && hold && ctx.self.lockProgress > 0 && ctx.self.targetId !== null) {
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
      const inSensorRange = dist3(ctx.self.pos, e.pos) <= (ctx.self.sensorRange ?? Math.max(ctx.weaponRange, ctx.preferredMax));
      // A carrier is the team's main target, but only after ordinary sensors
      // can see it. Dividing cost preserves the authored nearest/lowest-hull
      // policy among non-carriers and immediately reverts when the flag drops.
      const priority = enemyCarrierIds.has(e.id) && visible && inSensorRange ? carrierPriority : 1;
      const cost = (visible ? base : base * losPenalty + 1) / priority;
      if (cost < bestCost) {
        bestCost = cost;
        best = e.id;
      }
    }
    return best;
  }

  /**
   * Blend a world-up correction over utility steering when the near-future
   * flight path enters the terrain safety band. This is intentionally an
   * overlay, not a position clamp: utility still owns the command above the
   * band and increasingly yields as impact approaches.
   */
  private avoidFloor(
    self: ShipSnapshot,
    cmd: FlightCommand,
    horizonSec: number,
    toleranceRad: number,
  ): FlightCommand {
    if (this.floorY === undefined) return cmd;
    const radius = self.colliderRadius ?? 0;
    // The terrain mesh has visual relief, but collision is the authored floor
    // plane. Keep a small hull clearance without treating normal lunar spawn/
    // base altitude (y=8..10) as an emergency band.
    const clearance = Math.max(radius * FLOOR_RECOVERY_CLEARANCE_MULT, radius + 3);
    const safeY = this.floorY + clearance;
    const noseY = Math.sin(self.pitch);
    const observedVy = self.velocity?.y ?? 0;
    const projectedVy = Math.min(observedVy, noseY * FLOOR_NOMINAL_SPEED * cmd.throttle);
    const predictedY = self.pos.y + projectedVy * FLOOR_LOOKAHEAD_SEC;
    const recoveryExitY = safeY + Math.max(radius, 2);
    if (self.pos.y <= safeY) this.floorRecovering = true;
    else if (self.pos.y >= recoveryExitY && predictedY >= safeY) this.floorRecovering = false;
    if (!this.floorRecovering && predictedY >= safeY) return cmd;

    const band = 4;
    const strength = this.floorRecovering ? 1 : clamp((safeY - predictedY) / band, 0, 1);
    const lift = steerForPoint(
      self.pos,
      self.heading,
      self.pitch,
      { x: self.pos.x, y: safeY + band, z: self.pos.z },
      { turnRate: this.turnRateEst, pitchRate: this.pitchRateEst, horizonSec, toleranceRad, maxPitchRad: this.maxPitch() },
      self.up,
    );
    return {
      turn: cmd.turn + (lift.turn - cmd.turn) * strength,
      pitchStick: cmd.pitchStick + (lift.pitchStick - cmd.pitchStick) * strength,
      // Rotation is speed-independent; retain enough thrust to turn the new
      // upward attitude into actual separation instead of hovering in a cut.
      // A ship already on the collision plane needs positive thrust along its
      // newly raised nose. Cutting throttle here was the ground-stick bug.
      // A recovering hull whose nose is not yet up still needs way on: rotation
      // is speed-independent, but a ship at a dead stop has nothing to convert
      // the new attitude into separation with, and (since the 2026-08-07
      // heat/energy overhaul removed self-destruction) nothing will ever kill it
      // out of the stall either. Keep a floor under the cut instead of zeroing
      // it — full cut only ever applied to a nose already pointing down.
      throttle: this.floorRecovering
        ? (self.pitch > 0.12 ? Math.max(cmd.throttle, 0.7) : Math.max(cmd.throttle * 0.5, 0.25))
        : cmd.throttle * (1 - strength) + (self.pitch > 0 ? Math.min(cmd.throttle, 0.35) : 0) * strength,
      boost: strength < 0.15 && cmd.boost,
    };
  }

  /** Time-box a carrier's wait and force a deterministic home commit after no progress. */
  private commitStuckCarrier(snapshot: Snapshot, self: ShipSnapshot, plan: BotPlan | null, nowMs: number): BotPlan | null {
    const carried = snapshot.flags.find((flag) => flag.state === "carried" && flag.carrierId === self.id && flag.team !== self.team);
    if (!carried || !plan) {
      this.carrierProgress = null;
      return plan;
    }
    const own = snapshot.flags.find((flag) => flag.team === self.team);
    const home = own?.home ?? carried.home;
    const distance = dist3(self.pos, home);
    const progress = this.carrierProgress ?? { homeDistance: distance, progressedAtMs: nowMs, commitUntilMs: 0 };
    if (distance <= progress.homeDistance - CARRIER_PROGRESS_EPSILON) {
      progress.homeDistance = distance;
      progress.progressedAtMs = nowMs;
    }
    if (nowMs - progress.progressedAtMs >= CARRIER_STUCK_MS) {
      progress.commitUntilMs = nowMs + CARRIER_COMMIT_MS;
      progress.progressedAtMs = nowMs;
      progress.homeDistance = distance;
    }
    this.carrierProgress = progress;
    if (nowMs >= progress.commitUntilMs) return plan;
    const clear = hasLineOfSightAmong(self.pos, home, snapshot.asteroids.map((a) => ({ pos: a.pos, radius: a.colliderRadius ?? a.radius })));
    return {
      ...plan,
      aim: clear ? home : { x: home.x, y: Math.max(home.y, self.pos.y + 24), z: home.z + this.orbitSign * 8 },
      throttle: 1,
      boost: false,
    };
  }

  /**
   * Break sustained powered contact with a collider. Collision resolution removes
   * inward velocity, but a level-triggered throttle command reconstructs it on
   * the next navigation tick; without memory the pilot can therefore press into
   * the same surface forever. After a short, measured wedge, commit to one
   * tangent for a bounded interval. The tangent side that still advances toward
   * the winning utility plan is preferred, with the seeded orbit sign as a
   * deterministic tie-break.
   */
  private unstuckPlan(snapshot: Snapshot, self: ShipSnapshot, plan: BotPlan | null, nowMs: number): BotPlan | null {
    if (this.surfaceEscape) return plan;
    if (!plan || plan.throttle < 0.2) {
      this.wedgeContactSinceMs = null;
      this.unstuck = null;
      return plan;
    }

    const obstacle = nearestContact(snapshot, self);
    const speed = self.velocity
      ? Math.hypot(self.velocity.x, self.velocity.y, self.velocity.z)
      : Infinity;
    if (!obstacle || speed >= WEDGE_SPEED) {
      this.wedgeContactSinceMs = null;
      if (this.unstuck && nowMs >= this.unstuck.untilMs) this.unstuck = null;
      return plan;
    }

    this.wedgeContactSinceMs ??= nowMs;
    if (!this.unstuck && nowMs - this.wedgeContactSinceMs >= WEDGE_DETECT_MS) {
      this.unstuck = {
        untilMs: nowMs + UNSTUCK_COMMIT_MS,
        obstacleId: obstacle.id,
        side: tangentSide(self, obstacle.pos, plan.aim, this.orbitSign),
      };
    }
    if (!this.unstuck || nowMs >= this.unstuck.untilMs) return plan;

    const active = colliderById(snapshot, self, this.unstuck.obstacleId) ?? obstacle;
    const dx = self.pos.x - active.pos.x;
    const dz = self.pos.z - active.pos.z;
    const length = Math.hypot(dx, dz) || 1;
    const nx = dx / length;
    const nz = dz / length;
    const side = this.unstuck.side;
    return {
      ...plan,
      aim: {
        x: self.pos.x + (-nz * side + nx * 0.35) * UNSTUCK_AIM_DISTANCE,
        y: plan.aim?.y ?? self.pos.y,
        z: self.pos.z + (nx * side + nz * 0.35) * UNSTUCK_AIM_DISTANCE,
      },
      throttle: Math.max(plan.throttle, 0.65),
      boost: false,
    };
  }

  /**
   * Last-resort progress invariant for every physical surface. Unlike the older
   * wedge and floor guards, detection is independent of the utility plan's
   * throttle, current attitude, descent, and predicted path. Once committed it
   * keeps ownership until the hull has measured clearance from the same surface.
   */
  private surfaceRecoveryPlan(
    snapshot: Snapshot,
    self: ShipSnapshot,
    plan: BotPlan | null,
    nowMs: number,
  ): BotPlan | null {
    let surface = this.surfaceEscape
      ? surfaceByKey(snapshot, self, this.floorY, this.surfaceEscape.key)
      : nearestRestSurface(snapshot, self, this.floorY);

    if (this.surfaceEscape) {
      const ownRadius = self.colliderRadius ?? 0;
      const visualOverhang = Math.max(0, (this.visualRadius ?? ownRadius) - ownRadius);
      const exitClearance = Math.max(
        SURFACE_ESCAPE_CLEARANCE,
        ownRadius * SURFACE_ESCAPE_RADIUS_MULT,
        visualOverhang + ownRadius * 2,
      );
      if (!surface || surface.clearance >= exitClearance) {
        this.surfaceEscape = null;
        this.surfaceStall = null;
        return plan;
      }
      this.surfaceEscape.normal = surface.normal;
    } else {
      const speed = self.velocity ? Math.hypot(self.velocity.x, self.velocity.y, self.velocity.z) : Infinity;
      const ownRadius = self.colliderRadius ?? 0;
      const visualOverhang = Math.max(0, (this.visualRadius ?? ownRadius) - ownRadius);
      const enterClearance = SURFACE_VISUAL_MARGIN + visualOverhang;
      if (!surface || surface.clearance > enterClearance || speed >= WEDGE_SPEED) {
        this.surfaceStall = null;
        return plan;
      }
      const stationary = this.surfaceStall
        && this.surfaceStall.key === surface.key
        && dist3(this.surfaceStall.anchor, self.pos) <= Math.max(SURFACE_STALL_RADIUS, ownRadius / 1.4);
      if (!stationary) {
        this.surfaceStall = { key: surface.key, sinceMs: nowMs, anchor: aimPoint(self.pos) };
        return plan;
      }
      if (nowMs - this.surfaceStall!.sinceMs < SURFACE_STALL_MS) return plan;
      this.surfaceEscape = { key: surface.key, normal: surface.normal, side: this.orbitSign };
      this.wedgeContactSinceMs = null;
      this.unstuck = null;
    }

    surface = surface ?? nearestRestSurface(snapshot, self, this.floorY);
    const normal = surface?.normal ?? this.surfaceEscape.normal;
    const noseDot = Math.cos(self.pitch) * Math.cos(self.heading) * normal.x
      + Math.sin(self.pitch) * normal.y
      + Math.cos(self.pitch) * Math.sin(self.heading) * normal.z;
    // A direction exactly opposite the nose is singular in the two-axis body
    // decomposition: both candidate turn planes are equally valid. Give that
    // case a deterministic tangential component so recovery cannot command
    // turn=0, pitch=0, throttle=0 forever while nose-in against a surface.
    const tangentLength = Math.hypot(normal.x, normal.z);
    const tx = tangentLength > 1e-6 ? -normal.z / tangentLength : 1;
    const tz = tangentLength > 1e-6 ? normal.x / tangentLength : 0;
    const bias = noseDot < -0.9 ? SURFACE_ANTIPARALLEL_BIAS * this.surfaceEscape.side : 0;
    const aimNormal = {
      x: normal.x + tx * bias,
      // Include lift for a mostly vertical wall. A pure planar tangent can
      // still project to signed zero in the persisted body frame at exactly
      // 180 degrees; the up component makes the escape direction unambiguous.
      y: normal.y + (Math.abs(normal.y) < 0.9 ? Math.abs(bias) : 0),
      z: normal.z + tz * bias,
    };
    return {
      aim: {
        x: self.pos.x + aimNormal.x * Math.max(SURFACE_ESCAPE_AIM_DISTANCE, (self.colliderRadius ?? 0) * 12),
        y: self.pos.y + aimNormal.y * Math.max(SURFACE_ESCAPE_AIM_DISTANCE, (self.colliderRadius ?? 0) * 12),
        z: self.pos.z + aimNormal.z * Math.max(SURFACE_ESCAPE_AIM_DISTANCE, (self.colliderRadius ?? 0) * 12),
      },
      // Do not rebuild the cancelled inward velocity while turning. As soon as
      // the nose has an outward component, full thrust creates real separation.
      throttle: noseDot > 0.12 ? 1 : 0,
      boost: false,
      engaged: false,
    };
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

interface ContactCollider { id: EntityId; pos: Required<Vec3>; radius: number }
interface RestSurface {
  key: string;
  clearance: number;
  normal: Required<Vec3>;
}

function nearestRestSurface(
  snapshot: Snapshot,
  self: ShipSnapshot,
  floorY: number | undefined,
): RestSurface | null {
  let nearest = floorY === undefined ? null : surfaceByKey(snapshot, self, floorY, "floor");
  const consider = (candidate: ContactCollider): void => {
    const surface = colliderRestSurface(self, candidate);
    if (!nearest || surface.clearance < nearest.clearance) nearest = surface;
  };
  for (const asteroid of snapshot.asteroids) {
    if (asteroid.state !== "destroyed") consider({ id: asteroid.id, pos: asteroid.pos, radius: asteroid.colliderRadius ?? asteroid.radius });
  }
  for (const ship of snapshot.ships) {
    if (ship.id !== self.id) consider({ id: ship.id, pos: ship.pos, radius: ship.colliderRadius ?? 0 });
  }
  return nearest;
}

function surfaceByKey(
  snapshot: Snapshot,
  self: ShipSnapshot,
  floorY: number | undefined,
  key: string,
): RestSurface | null {
  if (key === "floor") {
    return floorY === undefined ? null : {
      key,
      clearance: self.pos.y - floorY - (self.colliderRadius ?? 0),
      normal: { x: 0, y: 1, z: 0 },
    };
  }
  const id = Number(key.slice("collider:".length));
  const collider = colliderById(snapshot, self, id);
  return collider ? colliderRestSurface(self, collider) : null;
}

function colliderRestSurface(self: ShipSnapshot, collider: ContactCollider): RestSurface {
  const dx = self.pos.x - collider.pos.x;
  const dy = self.pos.y - collider.pos.y;
  const dz = self.pos.z - collider.pos.z;
  const length = Math.hypot(dx, dy, dz) || 1;
  return {
    key: `collider:${collider.id}`,
    clearance: length - (self.colliderRadius ?? 0) - collider.radius,
    normal: { x: dx / length, y: dy / length, z: dz / length },
  };
}

function colliderById(snapshot: Snapshot, self: ShipSnapshot, id: EntityId): ContactCollider | null {
  const asteroid = snapshot.asteroids.find((candidate) => candidate.id === id && candidate.state !== "destroyed");
  if (asteroid) return { id, pos: asteroid.pos, radius: asteroid.colliderRadius ?? asteroid.radius };
  const ship = snapshot.ships.find((candidate) => candidate.id === id && candidate.id !== self.id);
  return ship ? { id, pos: ship.pos, radius: ship.colliderRadius ?? 0 } : null;
}

function nearestContact(snapshot: Snapshot, self: ShipSnapshot): ContactCollider | null {
  const ownRadius = self.colliderRadius ?? 0;
  let nearest: ContactCollider | null = null;
  let bestSurface = Infinity;
  const consider = (candidate: ContactCollider): void => {
    const surface = dist3(self.pos, candidate.pos) - ownRadius - candidate.radius;
    if (surface <= WEDGE_CONTACT_EPSILON && surface < bestSurface) {
      bestSurface = surface;
      nearest = candidate;
    }
  };
  for (const asteroid of snapshot.asteroids) {
    if (asteroid.state !== "destroyed") consider({ id: asteroid.id, pos: asteroid.pos, radius: asteroid.colliderRadius ?? asteroid.radius });
  }
  for (const ship of snapshot.ships) {
    if (ship.id !== self.id) consider({ id: ship.id, pos: ship.pos, radius: ship.colliderRadius ?? 0 });
  }
  return nearest;
}

function tangentSide(self: ShipSnapshot, center: Vec3, objective: Vec3 | null, fallback: 1 | -1): 1 | -1 {
  if (!objective) return fallback;
  const dx = self.pos.x - center.x;
  const dz = self.pos.z - center.z;
  const ox = objective.x - self.pos.x;
  const oz = objective.z - self.pos.z;
  const cross = -dz * ox + dx * oz;
  return Math.abs(cross) < 1e-6 ? fallback : cross > 0 ? 1 : -1;
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
