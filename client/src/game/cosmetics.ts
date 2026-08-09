import { allCosmetics, cosmeticAppliesTo, type ConfigService, type CosmeticConfig } from "@space-arena/shared";

/**
 * Shop-side cosmetic reads. The queries themselves live in shared
 * (`content/cosmetics.ts`) because the room and the sim spawn paths ask the
 * same questions; this adds only what a CARD needs and nothing else does.
 */

export function cosmeticById(configs: Pick<ConfigService, "getAll">, id: string): CosmeticConfig | undefined {
  return allCosmetics(configs).find((c) => c.id === id);
}

/** Applicability line under a swatch. Names the hulls rather than their ids. */
export function applicabilityLabel(cosmetic: CosmeticConfig, shipName: (id: string) => string): string {
  return cosmetic.target.startsWith("ship.") ? `Fits ${shipName(cosmetic.target)}` : `Fits module ${cosmetic.target}`;
}

/** The three authored colours of a paint. */
export type CosmeticPaint = CosmeticConfig["paint"];

export { allCosmetics, cosmeticAppliesTo as appliesToShip };
export { baseCosmeticIdFor } from "@space-arena/shared";
export type { CosmeticConfig } from "@space-arena/shared";
