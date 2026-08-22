import type { HardpointMap } from "@space-arena/shared";

/**
 * Local, unauthenticated loadout storage — a **TESTING AFFORDANCE** (owner
 * 2026-07-31: "we should be able to fit and save the fitting even playing
 * offline… this will be removed later but I need that for testing").
 *
 * With no account and no server there is nothing to own and nothing to save
 * against, so the Hangar falls back to this. Since 2026-08-22 it holds exactly
 * what the server does: ONE loadout per hull, keyed by ship id, being simply
 * whatever is in that hull's slots. There are no fitting names here because
 * there are no fitting names anywhere any more — fitting a module IS saving it.
 *
 * Removing this later is still a matter of deleting one module and its call
 * sites: the Hangar reads a loadout through a single accessor either way.
 */

const LS_KEY = "hangar.loadouts";

/** The pre-2026-08-22 store: an array of NAMED fittings, mimicking `/api`. */
const LEGACY_LS_KEY = "hangar.localFittings";
/** …and the id of the one the player had selected, written by the old Hangar. */
const LEGACY_SELECTED_KEY = "hangar.fittingId";

interface LegacyFitting {
  id: string;
  ship_id: string;
  hardpointMap: HardpointMap;
}

type LoadoutStore = Record<string, HardpointMap>;

function isHardpointMap(v: unknown): v is HardpointMap {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  return Object.values(v as Record<string, unknown>).every((entry) => typeof entry === "string");
}

function readStore(): LoadoutStore {
  migrateLegacy();
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: LoadoutStore = {};
    for (const [shipId, map] of Object.entries(parsed as Record<string, unknown>)) {
      if (isHardpointMap(map)) out[shipId] = map;
    }
    return out;
  } catch {
    // Corrupt/hand-edited storage must never break the Hangar.
    return {};
  }
}

function writeStore(store: LoadoutStore): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(store));
  } catch {
    // Private-mode / quota failures are not worth a crash on a test affordance.
  }
}

/**
 * Fold a pre-2026-08-22 browser's NAMED fittings into one loadout per hull, then
 * drop the old keys.
 *
 * The rule mirrors the server's (`ensureImplicitLoadouts`), with one thing the
 * server cannot know and this can: which fitting the player had SELECTED. That
 * one wins for its hull; every other hull takes its most recently saved fitting
 * (the old store appended, so that is the last entry); the rest are dropped.
 * They are unreachable the moment the UI stops naming fittings, and the owner's
 * instruction was that they must not wedge anything, not that they be kept.
 *
 * Runs on the first read and is a no-op forever after — the legacy keys are
 * removed, and a store that already exists is never re-derived.
 */
function migrateLegacy(): void {
  try {
    const legacyRaw = localStorage.getItem(LEGACY_LS_KEY);
    if (legacyRaw === null) return;
    // A store that already exists wins outright: re-deriving it could only
    // overwrite real edits with older named fittings.
    if (localStorage.getItem(LS_KEY) === null) {
      const parsed = JSON.parse(legacyRaw) as unknown;
      const selectedId = localStorage.getItem(LEGACY_SELECTED_KEY);
      /** Last entry wins — the old store appended, so that is the most recent. */
      const newest = new Map<string, HardpointMap>();
      /** …and the one the player had actually selected, per hull. */
      const selected = new Map<string, HardpointMap>();
      if (Array.isArray(parsed)) {
        for (const entry of parsed as LegacyFitting[]) {
          if (typeof entry?.ship_id !== "string" || !isHardpointMap(entry.hardpointMap)) continue;
          newest.set(entry.ship_id, entry.hardpointMap);
          if (entry.id === selectedId) selected.set(entry.ship_id, entry.hardpointMap);
        }
      }
      const store: LoadoutStore = {};
      for (const [shipId, map] of newest) store[shipId] = selected.get(shipId) ?? map;
      writeStore(store);
    }
    localStorage.removeItem(LEGACY_LS_KEY);
    localStorage.removeItem(LEGACY_SELECTED_KEY);
  } catch {
    // A migration is never worth a crash: drop the legacy keys and move on with
    // stock fits, which is exactly what a brand-new browser gets.
    try {
      localStorage.removeItem(LEGACY_LS_KEY);
      localStorage.removeItem(LEGACY_SELECTED_KEY);
    } catch {
      // ignore
    }
  }
}

/** This hull's stored loadout, or null when the player has never fitted it. */
export function loadLocalLoadout(shipId: string): HardpointMap | null {
  return readStore()[shipId] ?? null;
}

/** Make `map` this hull's loadout. Called on every slot edit — fitting IS saving. */
export function saveLocalLoadout(shipId: string, map: HardpointMap): void {
  const store = readStore();
  store[shipId] = map;
  writeStore(store);
}

/** Wipe the store (used by tests; no UI path). */
export function clearLocalLoadouts(): void {
  try {
    localStorage.removeItem(LS_KEY);
  } catch {
    // ignore
  }
}
