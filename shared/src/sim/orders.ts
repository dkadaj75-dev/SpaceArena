import type { EntityId } from "./components.js";

/** Discrete player/bot intents applied to the sim (mirrors the netcode order set). */
export type Order =
  | { kind: "move"; target: { x: number; z: number }; boost: boolean }
  | { kind: "target"; targetId: EntityId | null }
  | { kind: "moduleToggle"; hardpointIndex: number };

export interface QueuedOrder {
  entityId: EntityId;
  order: Order;
}
