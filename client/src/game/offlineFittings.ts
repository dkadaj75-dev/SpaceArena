import type { HardpointMap } from "@space-arena/shared";
import type { ApiFitting } from "./HangarApi.js";

/**
 * Local, unauthenticated fitting storage — a **TESTING AFFORDANCE** (owner
 * 2026-07-31: "we should be able to fit and save the fitting even playing
 * offline… this will be removed later but I need that for testing").
 *
 * With no account and no server there is nothing to own and nothing to save
 * against, so the Hangar falls back to this: every module counts as owned and
 * named fittings live in `localStorage`. It deliberately mimics the `/api`
 * shape ({@link ApiFitting}) so the Hangar's rendering, selection and
 * save/delete paths are the same code either way — which is also what makes
 * removing this later a matter of deleting one module and its call sites
 * rather than untangling a second UI.
 *
 * These fittings never reach the server: an online match still sends the
 * server-side `fittingId`, and the working loadout that offline practice flies
 * is the separate `hangar.moduleIds` entry.
 */

const LS_KEY = "hangar.localFittings";
/** Marks a fitting as locally stored, so it is never mistaken for a server id. */
export const LOCAL_FITTING_PREFIX = "local:";

export function isLocalFittingId(id: string | null | undefined): boolean {
  return typeof id === "string" && id.startsWith(LOCAL_FITTING_PREFIX);
}

function readAll(): ApiFitting[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isFitting);
  } catch {
    // Corrupt/hand-edited storage must never break the Hangar.
    return [];
  }
}

function isFitting(v: unknown): v is ApiFitting {
  if (typeof v !== "object" || v === null) return false;
  const f = v as Partial<ApiFitting>;
  return (
    typeof f.id === "string" &&
    typeof f.ship_id === "string" &&
    typeof f.name === "string" &&
    typeof f.hardpointMap === "object" &&
    f.hardpointMap !== null
  );
}

function writeAll(fittings: readonly ApiFitting[]): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(fittings));
  } catch {
    // Private-mode / quota failures are not worth a crash on a test affordance.
  }
}

/** Every locally saved fitting, newest last (the order the Hangar lists them). */
export function listLocalFittings(): ApiFitting[] {
  return readAll();
}

/**
 * Create or update a local fitting. Passing an existing local `id` updates it
 * in place (keeping its position in the list); otherwise a new one is appended.
 * Returns the stored record, exactly as the API's create/update do.
 */
export function saveLocalFitting(params: {
  id?: string | null;
  shipId: string;
  name: string;
  hardpointMap: HardpointMap;
  /** Injectable so a test can pin the generated id. */
  now?: () => number;
}): ApiFitting {
  const all = readAll();
  const existing = isLocalFittingId(params.id) ? all.findIndex((f) => f.id === params.id) : -1;
  const stamp = (params.now ?? Date.now)();
  const record: ApiFitting = {
    id: existing >= 0 ? all[existing]!.id : `${LOCAL_FITTING_PREFIX}${params.shipId}:${stamp}`,
    user_id: "local",
    ship_id: params.shipId,
    name: params.name,
    hardpointMap: params.hardpointMap,
    created_at: existing >= 0 ? all[existing]!.created_at : new Date(stamp).toISOString(),
  };
  if (existing >= 0) all[existing] = record;
  else all.push(record);
  writeAll(all);
  return record;
}

/** Delete one local fitting. Unknown ids are a no-op. */
export function deleteLocalFitting(id: string): void {
  const all = readAll();
  const next = all.filter((f) => f.id !== id);
  if (next.length !== all.length) writeAll(next);
}

/** Wipe the local store (used by tests; no UI path). */
export function clearLocalFittings(): void {
  try {
    localStorage.removeItem(LS_KEY);
  } catch {
    // ignore
  }
}
