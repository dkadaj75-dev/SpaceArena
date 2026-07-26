import { z } from "zod";
import type { ModuleState } from "../sim/components.js";
import type { EntityId } from "../sim/components.js";
import type { Order } from "../sim/orders.js";

/**
 * Wire protocol contracts shared by client and server. The transport is
 * Colyseus: schema state gives the delta-synced world (see server ArenaState),
 * and these message types cover the request/reply + fire-event channels that are
 * intentionally NOT schema-synced (beams/kinetics are one-shot events, orders are
 * request/ack). Keep this file the single source of truth for both sides.
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
  | { type: "shieldAbsorb"; targetId: EntityId; hardpointIndex: number; amount: number }
  | { type: "entityDestroyed"; entityId: EntityId; killerId: EntityId | null; isAsteroid: boolean; team?: number }
  | { type: "boundaryHit"; entityId: EntityId; rule: "bounce" | "damage" | "warning" }
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
    boost: z.boolean(),
  }),
  z.object({ kind: z.literal("moduleToggle"), hardpointIndex: z.number().int().nonnegative() }),
]);

/** Zod schema for the full client order envelope. */
export const orderMessageSchema = z.object({
  seq: z.number().int().nonnegative(),
  order: orderSchema,
});

export type ValidatedOrderMessage = z.infer<typeof orderMessageSchema>;
