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
 * Build the slot grid from a POSITIONAL module list — the shape the working
 * fitting is stored in (2026-07-31), so re-opening the Hangar on your main hull
 * shows the loadout you actually fly rather than the hull's stock one.
 *
 * Two kinds of staleness are dropped rather than shown, because the list is
 * `localStorage` and the sockets are content — the 2026-08-22 hardpoint pass
 * cut and re-ordered every hull's mounts under fittings already saved:
 *
 *  - entries PAST the socket count, which address a mount this hull no longer
 *    has at all;
 *  - entries whose family the socket at that index does not accept, which is
 *    what an index SHIFT looks like from here. Showing them would put an engine
 *    in a weapon bay in the Hangar and then throw at spawn (`spawn.ts` treats a
 *    family mismatch as a programming error), so the honest render of a shifted
 *    fitting is an empty slot the pilot can re-fill.
 *
 * `familyOf` resolves a module id to its family; a module the pack no longer
 * ships resolves to `undefined` and is dropped for the same reason.
 */
export function slotsFromModuleIds(
  ship: ShipConfig,
  moduleIds: readonly (string | null)[],
  familyOf?: (moduleId: string) => ModuleFamily | undefined,
): HangarSlot[] {
  return hardpointsOf(ship).map((socket, i) => {
    const moduleId = moduleIds[i] ?? null;
    const family = moduleId && familyOf ? familyOf(moduleId) : undefined;
    const fits = moduleId === null || familyOf === undefined || (family !== undefined && socket.accepts.includes(family));
    return {
      hardpointIndex: i,
      socketId: socket.id,
      kind: socket.kind,
      accepts: socket.accepts,
      moduleId: fits ? moduleId : null,
    };
  });
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
