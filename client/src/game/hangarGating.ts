import type { OwnershipStore } from "./ownershipStore.js";

/**
 * Who decides what the Hangar lets a pilot fly or fit (contract §5).
 *
 * The Hangar predates the shop and answered ownership two different ways: the
 * local ledger offline, and "everything is unlocked" for an authenticated
 * session, because `/api/ships` had no `owned` flag to read. The ownership
 * store now answers both cases, so it is authoritative WHEREVER it is wired —
 * the legacy answer survives only as the fallback for a Hangar constructed
 * without one, which is what keeps the pre-shop screens and their tests intact.
 */
export type OwnershipGate = Pick<OwnershipStore, "ownedShips" | "ownedModules">;

/** Whether this hull can be flown. */
export function hullOwned(gate: OwnershipGate | null, shipId: string, legacy: boolean): boolean {
  return gate ? gate.ownedShips().has(shipId) : legacy;
}

/** Whether this module can be fitted. */
export function moduleOwned(gate: OwnershipGate | null, moduleId: string, legacy: boolean): boolean {
  return gate ? gate.ownedModules().has(moduleId) : legacy;
}
