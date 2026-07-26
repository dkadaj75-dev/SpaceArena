import type { EntityId } from "./components.js";

/** Discrete player/bot intents applied to the sim (mirrors the netcode order set). */
export type Order =
  /**
   * Continuous-flight input (FLIGHT.md §1) — the ONLY movement order. Level-
   * triggered: the sim stores it in a persistent
   * {@link import("./components.js").FlightState} and keeps integrating it until
   * a new flight order replaces it, so the client only sends one order per
   * meaningful input change.
   */
  | {
      kind: "flight";
      throttle: number /* 0..1 */;
      turn: number /* -1..1 */;
      /**
       * Pitch stick, -1..1, positive noses up (BUBBLE.md §A). OPTIONAL on
       * purpose: the wire schema does not carry it until stage T2, and pitch is
       * held state, so an absent axis means "no pitch change this order" — the
       * same thing a centred stick means. A present but non-finite value is a
       * malformed order and drops the whole order, like the other axes.
       */
      pitchStick?: number;
      boost: boolean;
    }
  | { kind: "moduleToggle"; hardpointIndex: number };

export interface QueuedOrder {
  entityId: EntityId;
  order: Order;
}
