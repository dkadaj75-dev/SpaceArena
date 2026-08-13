import { z } from "zod";
import type { FlagState, ModuleState } from "../sim/components.js";
import type { EntityId } from "../sim/components.js";
import type { Order } from "../sim/orders.js";
import type { MatchStatDelta, MatchStatLine } from "../sim/MatchStats.js";

/**
 * Wire protocol contracts shared by client and server. The transport is
 * Colyseus: schema state gives the delta-synced world (see server ArenaState),
 * and these message types cover the request/reply + fire-event channels that are
 * intentionally NOT schema-synced (beams/kinetics are one-shot events, orders are
 * request/ack). Keep this file the single source of truth for both sides.
 *
 * ## Per-module heat/energy (protocol 4, 2026-08-07)
 *
 * Heat and energy are replicated PER MODULE, never per ship. Every module entry
 * — schema-synced as `ModuleState`, and identical in the offline
 * `ModuleSnapshot` the same client code consumes — carries exactly four store
 * fields:
 *
 *   `heat` / `heatCapacity`     — the weapon rack's own heat and its resolved cap
 *   `energy` / `energyCapacity` — the module's own tank and its resolved cap
 *
 * Capacities are resolved SERVER-SIDE against the hull (its `heatStore` /
 * `energyStore` multipliers) and replicated rather than recomputed from config,
 * for the same reason `hullMax` is. **A capacity of 0 means the module has no
 * store of that kind**, which is the entire signal a renderer needs to decide
 * whether to draw a ring. There are no ship-wide heat or energy fields: the pool
 * and the capacitor were deleted, not deprecated (docs/COMBAT-REWORK.md,
 * 2026-08-07 amendment).
 */

/** Numeric wire encoding for the §2.3 module state machine (uint8 in schema). */
export const MODULE_STATE_CODE: Record<ModuleState, number> = {
  retracted: 0,
  deploying: 1,
  active: 2,
  retracting: 3,
  overheated: 4,
};

/** Inverse of {@link MODULE_STATE_CODE}; index by the uint8 wire value. */
export const MODULE_STATE_BY_CODE: readonly ModuleState[] = [
  "retracted",
  "deploying",
  "active",
  "retracting",
  "overheated",
];

export function encodeModuleState(state: ModuleState): number {
  return MODULE_STATE_CODE[state];
}

export function decodeModuleState(code: number): ModuleState {
  return MODULE_STATE_BY_CODE[code] ?? "retracted";
}

/** Compact wire encoding for capture-the-flag state. */
export const FLAG_STATE_CODE: Record<FlagState, number> = {
  home: 0,
  dropped: 1,
  carried: 2,
};

/** Inverse of {@link FLAG_STATE_CODE}; index by the uint8 wire value. */
export const FLAG_STATE_BY_CODE: readonly FlagState[] = ["home", "dropped", "carried"];

export function encodeFlagState(state: FlagState): number {
  return FLAG_STATE_CODE[state];
}

export function decodeFlagState(code: number): FlagState {
  return FLAG_STATE_BY_CODE[code] ?? "home";
}

// ---------------------------------------------------------------------------
// Client → server
// ---------------------------------------------------------------------------

/** Message name for a client order (validated by {@link orderMessageSchema}). */
export const MSG_ORDER = "order";

/** Client-sent order envelope: a monotonically increasing seq + one sim order. */
export interface ClientOrderMessage {
  seq: number;
  order: Order;
}

// ---------------------------------------------------------------------------
// Server → client
// ---------------------------------------------------------------------------

export const MSG_ORDER_ACK = "orderAck";
export const MSG_FIRE_EVENT = "fireEvent";
export const MSG_SIM_EVENT = "simEvent";
export const MSG_MATCH_STATS = "matchStats";

/** Reliable, on-change scoreboard update. `lines` is used once for join sync. */
export interface MatchStatsMessage { deltas?: MatchStatDelta[]; lines?: MatchStatLine[] }

/** Why an order was rejected (client can surface/roll back its optimistic UI). */
export type OrderRejectReason =
  | "malformed"
  | "no-entity"
  | "bad-hardpoint"
  | "rate-limited"
  | "not-live";

/** Reply to every client order. `accepted:false` carries a `reason`. */
export interface OrderAckMessage {
  seq: number;
  accepted: boolean;
  reason?: OrderRejectReason;
}

/**
 * One-shot fire event for beams/kinetics (no schema entity). Clients render a
 * tracer/beam from shooter to target (or along heading) for a fade duration.
 */
export interface FireEventMessage {
  type: "beam" | "kinetic";
  moduleId: string;
  shooterEntityId: EntityId;
  targetEntityId: EntityId | null;
}

/**
 * Passthrough subset of {@link import("../sim/events.js").SimEvent} that clients
 * need but that isn't derivable from schema state: damage numbers, shield
 * absorbs, destructions, boundary hits, lock flips. Missiles are schema
 * entities; beams and kinetics travel via {@link FireEventMessage}.
 */
export type SimEventMessage =
  | { type: "damage"; targetId: EntityId; sourceId: EntityId | null; amount: number; damageType: string; isAsteroid: boolean }
  /**
   * Sensor lock completed / broke. `PlayerState.locked` replicates the STATE, but
   * the audio cue and the haptic buzz are edges, and an edge recovered by diffing
   * a 20 Hz patch stream is one that fires late and can be missed entirely across
   * a dropped frame. These are exactly-once-per-flip and low-rate, so they travel
   * as events like every other cue (client/src/audio/soundIds.ts, Haptics.ts).
   */
  | { type: "lockAcquired"; entityId: EntityId; targetId: EntityId }
  | { type: "lockLost"; entityId: EntityId }
  | {
      type: "shieldAbsorb";
      targetId: EntityId;
      sourceId: EntityId | null;
      hardpointIndex: number;
      amount: number;
      damageType: string;
    }
  | {
      type: "entityDestroyed";
      entityId: EntityId;
      killerId: EntityId | null;
      isAsteroid: boolean;
      team?: number;
      /** World-space death point; effects must not depend on a still-live entity. */
      pos?: { x: number; y: number; z: number };
    }
  | { type: "flagTaken"; flagId: EntityId; flagTeam: number; carrierId: EntityId; carrierTeam: number }
  | { type: "flagDropped"; flagId: EntityId; flagTeam: number; carrierId: EntityId | null; returnSec: number }
  | { type: "flagReturned"; flagId: EntityId; flagTeam: number; byId: EntityId | null; timedOut: boolean }
  | { type: "flagCaptured"; flagId: EntityId; flagTeam: number; carrierId: EntityId; scoringTeam: number; captures: number }
  | { type: "boundaryHit"; entityId: EntityId; rule: "bounce" | "damage" | "damageAndBounce" | "warning" }
  /**
   * Start-countdown beats. `ArenaState.countdownRemaining` replicates the
   * continuous VALUE (the numeral on screen reads it), but the per-second cue is
   * an edge, and an edge recovered by diffing a 20 Hz patch stream lands late —
   * exactly the argument the lock flips above make. Three messages per match.
   */
  | { type: "countdownTick"; remaining: number }
  | { type: "matchStarted" }
  | { type: "matchEnded"; winnerTeam: number | null; reason: "winCondition" | "elimination" }
  /**
   * Per-player progression summary sent individually (client.send) after a match
   * ends. Only authenticated (non-anon) participants receive one. `leveledUp`
   * lets the results screen play a level-up flourish.
   */
  | { type: "matchRewards"; credits: number; xp: number; newLevel: number; leveledUp: boolean };

// ---------------------------------------------------------------------------
// Order validation (trust boundary — the server never trusts client shape)
// ---------------------------------------------------------------------------

/** Zod schema for a single sim {@link Order}. Structural validation only; */
/* semantic checks (hardpoint count) live in the room. */
export const orderSchema = z.discriminatedUnion("kind", [
  /** Continuous flight input (FLIGHT.md §1/§5) — the joystick/throttle/boost state. */
  z.object({
    kind: z.literal("flight"),
    throttle: z.number().min(0).max(1),
    turn: z.number().min(-1).max(1),
    /**
     * Pitch stick, -1..1, positive noses up (BUBBLE.md §A/§B). OPTIONAL, matching
     * the sim `Order` type: pitch is HELD state, so an omitted axis means
     * "no pitch change", exactly what a centred stick means — which keeps older
     * senders (and the planar bot path) valid without a default that would
     * pretend they commanded a level nose. When PRESENT it is held to the same
     * bounds as `turn`: `z.number()` already refuses NaN/±Infinity, and
     * `min/max` reject anything outside the axis, so a malformed pitch drops the
     * whole order at the trust boundary. `ArenaRoom.validateOrder` enforces the
     * identical rule for orders that never cross the wire (bots).
     */
    pitchStick: z.number().min(-1).max(1).optional(),
    boost: z.boolean(),
    fire: z.boolean(),
  }),
  z.object({ kind: z.literal("moduleToggle"), hardpointIndex: z.number().int().nonnegative() }),
]);

/** Zod schema for the full client order envelope. */
export const orderMessageSchema = z.object({
  seq: z.number().int().nonnegative(),
  order: orderSchema,
});

export type ValidatedOrderMessage = z.infer<typeof orderMessageSchema>;
