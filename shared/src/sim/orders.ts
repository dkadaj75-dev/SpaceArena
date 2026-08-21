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
       * purpose, and it stays optional now that the wire schema carries it (T2)
       * and bots emit it (T4): pitch is held state, so an absent axis means "no
       * pitch change this order" — the same thing a centred stick means, and the
       * same thing every pre-bubble recorded order fixture means. A present but
       * non-finite value is a malformed order and drops the whole order, like the
       * other axes.
       */
      pitchStick?: number;
      boost: boolean;
      /** True while a ship-wide "fire everything" trigger is held. */
      fire: boolean;
      /**
       * Per-weapon trigger bitmask over hardpoint index (2026-08-21). Bit `i`
       * held ⇒ the weapon in hardpoint `i` is firing. OPTIONAL for the same
       * reason `pitchStick` is: absent means "no per-weapon trigger held",
       * which is what every pre-2026-08-21 sender and every bot means.
       */
      triggers?: number;
    }
  /**
   * Raise or lower a DEPLOYABLE module (shield, boost, utility). Weapons are
   * not toggleable since 2026-08-21 — their button is a trigger now, not a
   * switch — so a toggle addressed at a weapon hardpoint is ignored.
   */
  | { kind: "moduleToggle"; hardpointIndex: number }
  /**
   * Blow the fitted countermeasure pod clear of the hull (owner 2026-07-31).
   * Takes no arguments: a hull has exactly one countermeasure bay, so the sim
   * finds it. A no-op
   * when the fitted sink cannot be jettisoned or is still on cooldown.
   */
  | { kind: "jettisonCountermeasure" };

export interface QueuedOrder {
  entityId: EntityId;
  order: Order;
}
