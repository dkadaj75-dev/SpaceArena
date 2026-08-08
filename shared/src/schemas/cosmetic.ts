import { z } from "zod";
import { baseShape, configId } from "./base.js";

/**
 * A cosmetic: something a pilot BUYS and EQUIPS that changes how a hull looks
 * and nothing else. `kind` is an enum with one member today because the second
 * one (decals, textures) must not be a breaking change to every stored
 * selection — the id space and the ownership tables are kind-agnostic.
 *
 * Prices are authored, not hardcoded free: every shipped cosmetic is `price: 0`
 * while the economy is switched off, and the buy flow still debits it. See
 * `client/src/game/offlineOwnership.ts` for why that distinction is load-bearing.
 */

/** `#rrggbb`. No named colours, no alpha — the renderer tints materials with this verbatim. */
export const hexColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "colour must be a #rrggbb hex string");

export const cosmeticSchema = z.object({
  ...baseShape("cosmetic"),
  kind: z.enum(["paint"]),
  price: z.number().int().nonnegative(),
  /**
   * `"any"` = every hull, or an explicit ship-id list. The list entries are
   * resolved as `ship` references at pack load, so a typo is a content error
   * rather than a paint nobody can equip.
   */
  appliesTo: z.union([z.literal("any"), z.array(configId).min(1)]),
  paint: z.object({
    /** Hull base albedo tint. */
    primary: hexColor,
    /** Trim / secondary material tint. */
    accent: hexColor,
    /** Engine-glow accent; absent leaves the authored emissive alone. */
    emissive: hexColor.optional(),
  }),
});

export type CosmeticConfig = z.infer<typeof cosmeticSchema>;

/**
 * The canonical default look — the ship exactly as it was authored. It exists as
 * a real, ownable, equippable config so "selected" is never undefined semantics
 * on the UI side; the RENDERER still treats an ABSENT selection as standard, so
 * this id and `null` mean the same pixels.
 */
export const STANDARD_COSMETIC_ID = "cosmetic.paint-standard";

/**
 * What a shop card shows. `name` follows the base-shape law and is optional, so
 * the id's slug is the fallback — a paint with no authored name still reads as
 * something, and no screen has to invent a placeholder.
 */
export function cosmeticDisplayName(cosmetic: Pick<CosmeticConfig, "id" | "name">): string {
  return cosmetic.name ?? cosmetic.id.split(".").pop() ?? cosmetic.id;
}

/** Whether `cosmetic` may be equipped on `shipId`. */
export function cosmeticAppliesTo(cosmetic: CosmeticConfig, shipId: string): boolean {
  return cosmetic.appliesTo === "any" || cosmetic.appliesTo.includes(shipId);
}
