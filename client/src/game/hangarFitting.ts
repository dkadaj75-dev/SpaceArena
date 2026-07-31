import { hardpointsOf, type HardpointMap, type FittableSocket, type ModuleFamily, type ShipConfig } from "@space-arena/shared";

/** One fitted slot in the Hangar's fitting grid UI. */
export interface HangarSlot {
  hardpointIndex: number;
  /** Socket id (used as the slot label, e.g. "hp-nose"). */
  socketId: string;
  /**
   * Which bay this slot belongs to: a `hardpoint` carries weapons and shields,
   * an `internal` carries the ship's own systems (2026-07-31). They share one
   * index space, so the UI needs this to group and label them.
   */
  kind: "hardpoint" | "internal";
  accepts: readonly ModuleFamily[];
  moduleId: string | null;
}

/** Build the slot grid for a ship from its (possibly empty) socket → module map. */
export function slotsFromHardpointMap(ship: ShipConfig, map: HardpointMap | undefined): HangarSlot[] {
  return hardpointsOf(ship).map((socket, i) => ({
    hardpointIndex: i,
    socketId: socket.id,
    kind: socket.kind,
    accepts: socket.accepts,
    moduleId: map?.[String(i)] ?? null,
  }));
}

/** Build the slot grid for a ship from its `defaultFitting` (positional, hardpoint order). */
export function slotsFromDefaultFitting(ship: ShipConfig): HangarSlot[] {
  return hardpointsOf(ship).map((socket, i) => ({
    hardpointIndex: i,
    socketId: socket.id,
    kind: socket.kind,
    accepts: socket.accepts,
    moduleId: ship.defaultFitting[i] ?? null,
  }));
}

/**
 * Inverse of {@link slotsFromHardpointMap}: the wire/API shape `/api/fittings`
 * expects (`{ "<hardpointIndex>": "<moduleId>" }`, empty hardpoints omitted).
 * Pure — no ConfigService/network access, so slot-grid UI state can be turned
 * into a save-fitting request body without touching Babylon or fetch.
 */
export function buildHardpointMap(slots: readonly HangarSlot[]): HardpointMap {
  const map: HardpointMap = {};
  for (const slot of slots) {
    if (slot.moduleId) map[String(slot.hardpointIndex)] = slot.moduleId;
  }
  return map;
}

/** Fitted module ids in hardpoint order (nulls for empty slots) — the shape ShipSocketRig/sim spawn want. */
export function fittedModuleIdsOf(slots: readonly HangarSlot[]): (string | null)[] {
  return slots.map((s) => s.moduleId);
}

/** Whether `moduleId`'s family is accepted by this slot (client-side pre-check; server re-validates). */
export function slotAccepts(slot: HangarSlot, family: ModuleFamily): boolean {
  return slot.accepts.includes(family);
}

/** Re-derive a slot's `FittableSocket` from a ship config (for accepts/label lookups after a change). */
export function socketFor(ship: ShipConfig, hardpointIndex: number): FittableSocket | undefined {
  return hardpointsOf(ship)[hardpointIndex];
}
