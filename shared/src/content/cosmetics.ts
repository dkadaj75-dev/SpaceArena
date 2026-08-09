import type { ConfigService } from "../core/ConfigService.js";
import { baseCosmeticIdFor, cosmeticAppliesTo, type CosmeticConfig } from "../schemas/cosmetic.js";

/**
 * Content-side cosmetic queries shared by the shop, the sim spawn paths and the
 * room's join validation. Every one of them is total: an unknown id resolves to
 * "standard look", never to an exception, because a stale selection (renamed
 * paint, older pack) must not be able to block a spawn.
 */

/** Every cosmetic in the pack, id-sorted so any derived roll is pack-order independent. */
export function allCosmetics(configs: Pick<ConfigService, "getAll">): CosmeticConfig[] {
  return configs.getAll<CosmeticConfig>("cosmetic").slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Cosmetics equippable on `shipId`, id-sorted. */
export function cosmeticsForShip(configs: Pick<ConfigService, "getAll">, shipId: string): CosmeticConfig[] {
  return allCosmetics(configs).filter((c) => cosmeticAppliesTo(c, shipId));
}

/**
 * `cosmeticId` if it exists AND targets `shipId`, else that hull's base paint.
 * The one gate every trust boundary uses: the room on join, the store on select,
 * the offline ledger on read.
 */
export function resolveCosmeticFor(
  configs: Pick<ConfigService, "get">,
  shipId: string,
  cosmeticId: string | null | undefined,
): string {
  const baseId = baseCosmeticIdFor(shipId);
  if (!cosmeticId) return baseId;
  const cosmetic = configs.get<CosmeticConfig>("cosmetic", cosmeticId);
  if (!cosmetic || !cosmeticAppliesTo(cosmetic, shipId)) return baseId;
  return cosmetic.id;
}

/**
 * The free paint a bot wears, drawn from its target hull's pool by a deterministic
 * key rather than a roll off a shared stream — two hosts building the same
 * roster (offline practice and the authoritative room) must dress it the same,
 * and neither may perturb the other's seeded randomness to do it.
 */
export function botCosmeticFor(
  configs: Pick<ConfigService, "getAll">,
  shipId: string,
  seed: number,
  entityId: number,
): string {
  const pool = cosmeticsForShip(configs, shipId);
  if (pool.length === 0) return baseCosmeticIdFor(shipId);
  // 32-bit integer hash of (seed, entityId): cheap, stable across engines, and
  // independent of how many cosmetics happen to be authored.
  let h = (Math.imul(seed | 0, 0x9e3779b1) ^ Math.imul(entityId | 0, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2545f491) >>> 0;
  return pool[h % pool.length]!.id;
}
