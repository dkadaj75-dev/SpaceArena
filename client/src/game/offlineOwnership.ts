import type { ConfigService, ShipConfig } from "@space-arena/shared";

/**
 * Local ownership ledger (owner 2026-07-31) — which hulls and modules this
 * device has unlocked, for the offline/testing Hangar.
 *
 * The brief: a new pilot starts with the LIGHT human hull and nothing else;
 * everything else must be BOUGHT, but for now every price is zero. That
 * distinction matters — "free" is a balance decision we can reverse by putting
 * numbers back, while "already owned" would be a structural one we'd have to
 * unpick. So the buy step is real; only the cost is not.
 *
 * ## TESTING AFFORDANCE — to be removed
 *
 * This is the offline sibling of the server's `/api/ships` + `/api/modules`
 * ownership, and it exists for the same reason `offlineFittings.ts` does: the
 * Hangar has to be usable without an account while the game is being built.
 * An authenticated session ignores this file entirely.
 *
 * Only PURCHASES are stored. The starter set is derived from content every
 * read, so re-authoring the starting hull's fitting never strands a player on
 * a loadout they no longer own.
 */

const LS_OWNED = "hangar.owned";

/** The hull every pilot starts with — the light human ship. */
export const STARTER_SHIP_ID = "ship.interceptor";

interface StoredOwnership {
  ships?: unknown;
  modules?: unknown;
}

function readStored(): { ships: Set<string>; modules: Set<string> } {
  const empty = { ships: new Set<string>(), modules: new Set<string>() };
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(LS_OWNED);
  } catch {
    return empty; // storage disabled (private mode): own the starter set only
  }
  if (!raw) return empty;
  try {
    const parsed = JSON.parse(raw) as StoredOwnership;
    const ids = (v: unknown): Set<string> =>
      new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : []);
    return { ships: ids(parsed.ships), modules: ids(parsed.modules) };
  } catch {
    // Corrupt/hand-edited storage is not worth a crash on the way into a fit.
    return empty;
  }
}

function writeStored(owned: { ships: Set<string>; modules: Set<string> }): void {
  try {
    localStorage.setItem(LS_OWNED, JSON.stringify({ ships: [...owned.ships], modules: [...owned.modules] }));
  } catch {
    // Nothing useful to do if storage is full or blocked; the session keeps
    // working, the unlock simply does not survive a reload.
  }
}

/**
 * The modules a pilot owns before buying anything: the starter hull's stock
 * fitting. Derived from content rather than listed here, so the starting ship
 * is always flyable no matter how it is re-authored.
 */
export function starterModules(configs: Pick<ConfigService, "get">): Set<string> {
  const ship = configs.get<ShipConfig>("ship", STARTER_SHIP_ID);
  const out = new Set<string>();
  for (const id of ship?.defaultFitting ?? []) if (id) out.add(id);
  return out;
}

/** Every hull this device has unlocked, starter included. */
export function ownedShips(): Set<string> {
  const owned = readStored().ships;
  owned.add(STARTER_SHIP_ID);
  return owned;
}

/** Every module this device has unlocked, starter fitting included. */
export function ownedModules(configs: Pick<ConfigService, "get">): Set<string> {
  const owned = readStored().modules;
  for (const id of starterModules(configs)) owned.add(id);
  return owned;
}

export function ownsShip(shipId: string): boolean {
  return shipId === STARTER_SHIP_ID || readStored().ships.has(shipId);
}

export function ownsModule(configs: Pick<ConfigService, "get">, moduleId: string): boolean {
  return ownedModules(configs).has(moduleId);
}

/** Record a hull purchase. Idempotent — buying twice is not an error. */
export function buyShipLocal(shipId: string): void {
  const owned = readStored();
  owned.ships.add(shipId);
  writeStored(owned);
}

/** Record a module purchase. Idempotent. */
export function buyModuleLocal(moduleId: string): void {
  const owned = readStored();
  owned.modules.add(moduleId);
  writeStored(owned);
}

/** Wipe every local purchase back to the starter set (test/reset helper). */
export function clearOwnership(): void {
  try {
    localStorage.removeItem(LS_OWNED);
  } catch {
    // See writeStored.
  }
}
