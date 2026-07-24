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
  | "out-of-bounds"
  | "bad-hardpoint"
  | "bad-target"
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
 * absorbs, destructions, boundary hits. Missiles are schema entities; beams and
 * kinetics travel via {@link FireEventMessage}.
 */
export type SimEventMessage =
  | { type: "damage"; targetId: EntityId; sourceId: EntityId | null; amount: number; damageType: string; isAsteroid: boolean }
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

const vec2 = z.object({ x: z.number().finite(), z: z.number().finite() });

/** Zod schema for a single sim {@link Order}. Structural validation only; */
/* semantic checks (in-bounds, hardpoint count, enemy target) live in the room. */
export const orderSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("move"), target: vec2, boost: z.boolean() }),
  z.object({ kind: z.literal("target"), targetId: z.number().int().nullable() }),
  z.object({ kind: z.literal("moduleToggle"), hardpointIndex: z.number().int().nonnegative() }),
]);

/** Zod schema for the full client order envelope. */
export const orderMessageSchema = z.object({
  seq: z.number().int().nonnegative(),
  order: orderSchema,
});

export type ValidatedOrderMessage = z.infer<typeof orderMessageSchema>;
