import type { ConfigService } from "../core/ConfigService.js";
import type { BotprofileConfig } from "../schemas/botprofile.js";
import type { ModuleConfig } from "../schemas/module.js";
import type { ShipSnapshot, Snapshot } from "../sim/ArenaSimulation.js";
import type { EntityId } from "../sim/components.js";
import { hasLineOfSightAmong } from "../sim/los.js";
import { dist } from "../sim/math.js";
import type { Order } from "../sim/orders.js";
import { botBehaviors, type BehaviorRegistry, type BotPlan } from "./behaviors.js";
import { buildBotContext, numParam, strParam, type BotContext } from "./context.js";
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
  /** Move point ordered this decision (null when the bot kept its order). */
  movePoint: { x: number; z: number } | null;
  boost: boolean;
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
  /** Injectable RNG for determinism in tests. Defaults to `Math.random`. */
  rng?: () => number;
  /** Behaviour registry override (defaults to the global built-in registry). */
  behaviors?: BehaviorRegistry;
  /** Orbit direction; derived from the RNG when omitted. */
  orbitSign?: 1 | -1;
}

/** Minimum spacing between decisions after jitter (ms). */
const MIN_DECISION_MS = 16;
/** Re-issuing a move order closer than this to the last one is pointless. */
const MOVE_EPSILON = 1.5;
/** Missiles farther than this multiple of the preferred range are ignored. */
const MISSILE_SCAN_MULT = 2;

/**
 * `BotDriver` (ROADMAP 5.1) — drives one ship by emitting the **same orders a
 * human client sends** (`move` / `target` / `moduleToggle`). It consumes a
 * read-only {@link Snapshot} plus its `botprofile` config and returns orders;
 * it never touches sim internals, so every rule (range, LoS, energy, heat,
 * order validation) applies to bots by construction.
 *
 * Utility decision-making: each behaviour key present in the profile is scored
 * as `baseWeight × situationalFactor`; the highest wins and plans the move. A
 * profile without a `retreat` block can never retreat — the config *is* the
 * behaviour set.
 *
 * Cadence, jitter, ranges, weights and thresholds all come from the profile.
 * Nothing bot-specific is hardcoded here.
 */
export class BotDriver {
  readonly entityId: EntityId;
  readonly profile: BotprofileConfig;

  private readonly configs: ConfigService;
  private readonly rng: () => number;
  private readonly behaviors: BehaviorRegistry;
  private readonly orbitSign: 1 | -1;

  private nextDecisionMs = 0;
  private started = false;
  private lastMove: { x: number; z: number } | null = null;
  private lastTargetId: EntityId | null = null;
  private decision: BotDecisionSnapshot | null = null;
  private weaponRangeCache = -1;

  constructor(options: BotDriverOptions) {
    this.entityId = options.entityId;
    this.profile = options.profile;
    this.configs = options.configs;
    this.rng = options.rng ?? Math.random;
    this.behaviors = options.behaviors ?? botBehaviors();
    this.orbitSign = options.orbitSign ?? (this.rng() < 0.5 ? -1 : 1);
  }

  /** Last decision taken, for debug overlays. Null before the first decision. */
  get lastDecision(): BotDecisionSnapshot | null {
    return this.decision;
  }

  /** Forget cadence + issued-order memory (e.g. after a respawn). */
  reset(): void {
    this.started = false;
    this.nextDecisionMs = 0;
    this.lastMove = null;
    this.lastTargetId = null;
    this.decision = null;
  }

  /**
   * Advance the driver. Call every sim tick with the current snapshot and the
   * elapsed sim time in milliseconds; returns the orders to feed through the
   * normal order pipeline (empty between decision intervals).
   */
  update(snapshot: Snapshot, nowMs: number): Order[] {
    if (snapshot.phase !== "live") return [];
    if (!this.started) {
      this.started = true;
      // Stagger first decisions across bots so they don't all fire on tick 0.
      this.nextDecisionMs = nowMs + this.rng() * this.profile.decisionIntervalMs;
      return [];
    }
    if (nowMs < this.nextDecisionMs) return [];
    this.nextDecisionMs = nowMs + this.jitteredInterval();

    const self = snapshot.ships.find((s) => s.id === this.entityId);
    if (!self) return [];

    return this.decide(snapshot, self, nowMs);
  }

  private jitteredInterval(): number {
    const jitter = this.profile.orderJitterMs;
    const offset = jitter > 0 ? (this.rng() * 2 - 1) * jitter : 0;
    return Math.max(MIN_DECISION_MS, this.profile.decisionIntervalMs + offset);
  }

  private decide(snapshot: Snapshot, self: ShipSnapshot, nowMs: number): Order[] {
    const orders: Order[] = [];

    // --- context (target choice first: behaviours score relative to it) ---
    const weaponRange = this.weaponRange(self);
    const preliminary = buildBotContext({
      snapshot,
      self,
      profile: this.profile,
      weaponRange,
      targetId: self.targetId,
      missileScanRadius: Math.max(this.profile.preferredRange[1], 1) * MISSILE_SCAN_MULT,
      orbitSign: this.orbitSign,
      rng: this.rng,
    });
    const targetId = this.pickTarget(preliminary);
    const ctx =
      targetId === preliminary.target?.id
        ? preliminary
        : buildBotContext({
            snapshot,
            self,
            profile: this.profile,
            weaponRange,
            targetId,
            missileScanRadius: Math.max(this.profile.preferredRange[1], 1) * MISSILE_SCAN_MULT,
            orbitSign: this.orbitSign,
            rng: this.rng,
          });

    // --- utility scoring over the behaviours the profile actually declares ---
    const scores: Record<string, number> = {};
    let bestKey: string | null = null;
    let bestScore = 0;
    let bestPlan: BotPlan | null = null;
    for (const [key, params] of Object.entries(this.profile.behaviors)) {
      const behavior = this.behaviors.get(key);
      if (!behavior) continue; // unknown key in config: ignored, never crashes a match
      const score = params.baseWeight * behavior.score(ctx, params);
      scores[key] = score;
      if (score > bestScore) {
        bestScore = score;
        bestKey = key;
      }
    }
    if (bestKey !== null) {
      const params = this.profile.behaviors[bestKey]!;
      bestPlan = this.behaviors.get(bestKey)!.plan(ctx, params);
    }

    // --- target order (same order a human's tap-on-enemy produces) ---
    if (targetId !== self.targetId && targetId !== this.lastTargetId) {
      orders.push({ kind: "target", targetId });
      this.lastTargetId = targetId;
    }

    // --- move order ---
    const move = bestPlan?.move ?? null;
    let issuedMove: { x: number; z: number } | null = null;
    if (move && (this.lastMove === null || dist(this.lastMove, move) > MOVE_EPSILON)) {
      orders.push({ kind: "move", target: { x: move.x, z: move.z }, boost: bestPlan?.boost ?? false });
      this.lastMove = { x: move.x, z: move.z };
      issuedMove = this.lastMove;
    }

    // --- module discipline ---
    const engaged = bestPlan?.engaged ?? false;
    const modulePlan = planModuleOrders(ctx, this.configs, this.profile.moduleDiscipline, engaged);
    orders.push(...modulePlan.orders);

    this.decision = {
      atMs: nowMs,
      behavior: bestKey,
      scores,
      movePoint: issuedMove,
      boost: bestPlan?.boost ?? false,
      targetId,
      engaged,
      moduleDecisions: modulePlan.decisions,
      orders,
    };
    return orders;
  }

  /**
   * Which enemy to focus. Policy comes from the profile's `engage` block
   * (`targetPreference: "nearest" | "lowestHull"`, default `nearest`); enemies
   * without line of sight are penalised by `losPenalty` so bots prefer someone
   * they can actually shoot. Returns the current target when nothing is visible.
   */
  private pickTarget(ctx: BotContext): EntityId | null {
    if (ctx.enemies.length === 0) return null;
    const params = this.profile.behaviors["engage"];
    const preference = params ? strParam(params, "targetPreference", "nearest") : "nearest";
    const losPenalty = params ? numParam(params, "losPenalty", 2) : 2;

    let best: EntityId | null = null;
    let bestCost = Infinity;
    for (const e of ctx.enemies) {
      const base =
        preference === "lowestHull" ? (e.hullMax > 0 ? e.hull / e.hullMax : 0) : dist(ctx.self.pos, e.pos);
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
