import { STANDARD_COSMETIC_ID, type ConfigService, type ShipConfig } from "@space-arena/shared";

/**
 * Local ownership ledger (owner 2026-07-31) — which hulls, modules and paints
 * this device has unlocked, for the offline/testing Hangar and Shop.
 *
 * The brief: a new pilot starts with the LIGHT human hull and nothing else;
 * everything else must be BOUGHT, but for now every price is zero. That
 * distinction matters — "free" is a balance decision we can reverse by putting
 * numbers back, while "already owned" would be a structural one we'd have to
 * unpick. So the buy step is real; only the cost is not.
 *
 * ## TESTING AFFORDANCE — to be removed
 *
 * This is the offline sibling of the server's `/api/ships` + `/api/modules` +
 * `/api/cosmetics` ownership, and it exists for the same reason
 * `offlineFittings.ts` does: the Hangar has to be usable without an account
 * while the game is being built. An authenticated session ignores this file
 * entirely.
 *
 * Only PURCHASES and SELECTIONS are stored. The starter set is derived from
 * content every read, so re-authoring the starting hull's fitting never strands
 * a player on a loadout they no longer own.
 */

const LS_OWNED = "hangar.owned";

/** The hull every pilot starts with — the light human ship. */
export const STARTER_SHIP_ID = "ship.interceptor";

/**
 * Stored-shape version. v1 (no `v` key) held `{ ships, modules }` only; it is
 * read as "no paints bought, nothing equipped" and rewritten as v2 on the next
 * purchase, so a tester who has been buying hulls for weeks keeps them.
 */
const STORED_VERSION = 2;

interface Ledger {
  ships: Set<string>;
  modules: Set<string>;
  cosmetics: Set<string>;
  /** ship id → equipped cosmetic id. Absent = the hull's authored look. */
  selections: Map<string, string>;
}

interface StoredOwnership {
  v?: unknown;
  ships?: unknown;
  modules?: unknown;
  cosmetics?: unknown;
  selections?: unknown;
}

function emptyLedger(): Ledger {
  return { ships: new Set(), modules: new Set(), cosmetics: new Set(), selections: new Map() };
}

function idSet(value: unknown): Set<string> {
  return new Set(Array.isArray(value) ? value.filter((x): x is string => typeof x === "string" && x.length > 0) : []);
}

function readStored(): Ledger {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(LS_OWNED);
  } catch {
    return emptyLedger(); // storage disabled (private mode): own the starter set only
  }
  if (!raw) return emptyLedger();
  try {
    const parsed = JSON.parse(raw) as StoredOwnership;
    const ledger = emptyLedger();
    ledger.ships = idSet(parsed.ships);
    ledger.modules = idSet(parsed.modules);
    // Absent on a v1 record — an older tester simply owns no paints yet.
    ledger.cosmetics = idSet(parsed.cosmetics);
    const selections = parsed.selections;
    if (selections && typeof selections === "object" && !Array.isArray(selections)) {
      for (const [shipId, cosmeticId] of Object.entries(selections as Record<string, unknown>)) {
        if (typeof cosmeticId === "string" && cosmeticId.length > 0) ledger.selections.set(shipId, cosmeticId);
      }
    }
    return ledger;
  } catch {
    // Corrupt/hand-edited storage is not worth a crash on the way into a fit.
    return emptyLedger();
  }
}

function writeStored(owned: Ledger): void {
  try {
    localStorage.setItem(
      LS_OWNED,
      JSON.stringify({
        v: STORED_VERSION,
        ships: [...owned.ships],
        modules: [...owned.modules],
        cosmetics: [...owned.cosmetics],
        selections: Object.fromEntries(owned.selections),
      }),
    );
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

/**
 * Every paint this device has unlocked. The standard look is always owned — it
 * is the ship as authored, so refusing to "own" it would make the default
 * unequippable.
 */
export function ownedCosmetics(): Set<string> {
  const owned = readStored().cosmetics;
  owned.add(STANDARD_COSMETIC_ID);
  return owned;
}

export function ownsShip(shipId: string): boolean {
  return shipId === STARTER_SHIP_ID || readStored().ships.has(shipId);
}

export function ownsModule(configs: Pick<ConfigService, "get">, moduleId: string): boolean {
  return ownedModules(configs).has(moduleId);
}

export function ownsCosmetic(cosmeticId: string): boolean {
  return cosmeticId === STANDARD_COSMETIC_ID || readStored().cosmetics.has(cosmeticId);
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

/** Record a paint purchase. Idempotent. */
export function buyCosmeticLocal(cosmeticId: string): void {
  const owned = readStored();
  owned.cosmetics.add(cosmeticId);
  writeStored(owned);
}

/**
 * The paint equipped on `shipId`, or null for the authored look. An unowned
 * selection reads as null rather than being trusted: ownership is the gate, and
 * it is re-derived on every read exactly like the starter set is.
 */
export function selectedCosmetic(shipId: string): string | null {
  const stored = readStored();
  const selected = stored.selections.get(shipId);
  if (!selected || selected === STANDARD_COSMETIC_ID) return null;
  return stored.cosmetics.has(selected) ? selected : null;
}

/**
 * Equip `cosmeticId` on `shipId` (null/standard clears back to the authored
 * look). Selecting an unowned paint is refused here rather than sanitised at
 * read time, so the ledger never carries a selection the pilot did not buy.
 * Applicability (does this paint fit this hull) is the caller's check — only it
 * holds the content.
 */
export function selectCosmeticLocal(shipId: string, cosmeticId: string | null): void {
  const owned = readStored();
  if (cosmeticId === null || cosmeticId === STANDARD_COSMETIC_ID) {
    owned.selections.delete(shipId);
  } else {
    if (!owned.cosmetics.has(cosmeticId)) return;
    owned.selections.set(shipId, cosmeticId);
  }
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
