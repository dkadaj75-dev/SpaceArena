import {
  STANDARD_COSMETIC_ID,
  resolveCosmeticFor,
  type ApiInventory,
  type ConfigService,
  type ModuleConfig,
} from "@space-arena/shared";
import { ownedCosmeticsRepo, ownedModulesRepo, ownedShipsRepo, selectedCosmeticsRepo } from "../db/repos.js";

/**
 * Read-time ownership derivation — the server half of
 * `client/src/game/offlineOwnership.ts`, and it follows the same rule: only
 * PURCHASES are stored. The starter grants (the light hull, every free module,
 * the standard paint) are derived from content on every read, so re-authoring
 * the starter set repairs existing accounts instead of stranding them on rows
 * written under an older pack.
 */

/** The hull every pilot starts with. Mirrors `STARTER_SHIP_ID` on the client. */
export const STARTER_SHIP_ID = "ship.interceptor";

export function ownedShipIds(configs: ConfigService, userId: string): Set<string> {
  const owned = new Set(ownedShipsRepo.byUser(userId).map((r) => r.ship_id));
  if (configs.get("ship", STARTER_SHIP_ID)) owned.add(STARTER_SHIP_ID);
  return owned;
}

/**
 * Owned modules: purchase rows plus every `price: 0` module. The free kit is
 * also seeded as rows (`ensureStarterKit`) — deriving it here as well is what
 * keeps an account created before a module became free from looking poorer than
 * a fresh one.
 */
export function ownedModuleIds(configs: ConfigService, userId: string): Set<string> {
  const owned = new Set(ownedModulesRepo.byUser(userId).map((r) => r.module_id));
  for (const mod of configs.getAll<ModuleConfig>("module")) if (mod.price === 0) owned.add(mod.id);
  return owned;
}

export function ownedCosmeticIds(configs: ConfigService, userId: string): Set<string> {
  const owned = new Set(ownedCosmeticsRepo.byUser(userId).map((r) => r.cosmetic_id));
  if (configs.get("cosmetic", STANDARD_COSMETIC_ID)) owned.add(STANDARD_COSMETIC_ID);
  return owned;
}

/**
 * Equipped paint per hull, filtered through ownership AND applicability: a row
 * left behind by a re-authored paint (or one whose `appliesTo` no longer covers
 * the hull) reads as the authored look rather than travelling to a client that
 * would try to render it.
 */
export function cosmeticSelections(configs: ConfigService, userId: string): Record<string, string> {
  const owned = ownedCosmeticIds(configs, userId);
  const out: Record<string, string> = {};
  for (const row of selectedCosmeticsRepo.byUser(userId)) {
    if (!owned.has(row.cosmetic_id)) continue;
    const resolved = resolveCosmeticFor(configs, row.ship_id, row.cosmetic_id);
    if (resolved) out[row.ship_id] = resolved;
  }
  return out;
}

/** The full inventory payload attached to the profile read. */
export function inventoryFor(configs: ConfigService, userId: string): ApiInventory {
  return {
    ships: [...ownedShipIds(configs, userId)].sort(),
    modules: [...ownedModuleIds(configs, userId)].sort(),
    cosmetics: [...ownedCosmeticIds(configs, userId)].sort(),
    selections: cosmeticSelections(configs, userId),
  };
}
