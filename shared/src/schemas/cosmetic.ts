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

/**
 * Which authored colour a targeted material wears. The names are the paint's
 * own channels, not render terms, so the Skins tool can say "this material
 * takes the primary" without the designer knowing what a slot is.
 */
export const paintChannel = z.enum(["primary", "accent", "emissive"]);
export type PaintChannel = z.infer<typeof paintChannel>;

/**
 * Procedural finishes a paint can wear instead of a flat colour. They are drawn
 * into the targeted material's albedo TEXTURE and nothing else — metallic,
 * roughness and clearcoat stay exactly as the artist authored them, so a zebra
 * hull still reflects the arena like the painted plate it is.
 */
export const paintPattern = z.enum(["zebra", "tiger", "rust"]);
export type PaintPattern = z.infer<typeof paintPattern>;

/**
 * One material of the target's model, and the channel it wears.
 *
 * `material` is the GLB material NAME (`HUM_LGT_Shell_White`), matched
 * case-insensitively. Anything the list does not name is left completely
 * untouched — that is the whole point of the list: a paint reaches the white
 * shell plates of the Interceptor without smearing itself over the canopy
 * glass, the dark tech recesses or the engine bloom.
 */
/**
 * How the painted plate BEHAVES under light, on top of what colour it is.
 *
 * Colour alone cannot make a livery look expensive: a saturated hue on a matte
 * 0.38-roughness plate reads as primer. Gloss and clearcoat are what turn it
 * into automotive lacquer — sharp white highlights and a real reflection of the
 * arena riding over the hue. Every field is optional and ABSENT means "keep
 * what the artist authored", so a paint opts into a finish rather than
 * flattening the model's own material work by existing.
 */
export const paintFinish = z.object({
  /** 0 = flat matte, 1 = mirror. Drives PBR roughness (and a StandardMaterial's specular). */
  gloss: z.number().min(0).max(1).optional(),
  /** 0 = painted dielectric, 1 = bare metal. Small values read as metallic flake. */
  metallic: z.number().min(0).max(1).optional(),
  /** Clear lacquer over the colour: a white highlight layer independent of the hue. */
  clearcoat: z.number().min(0).max(1).optional(),
  /**
   * Self-illumination in the paint's OWN hue, 0..1. The arenas are dark and lit
   * by a small IBL, so gloss alone buys a highlight and loses the rest of the
   * plate to shadow; a little glow is what actually makes a livery read across
   * the screen. Keep it low — this is candy paint catching light, not a
   * light source, and the engine bloom has to stay the brightest thing on the hull.
   */
  glow: z.number().min(0).max(1).optional(),
});
export type PaintFinish = z.infer<typeof paintFinish>;

export const paintMaterialTarget = z.object({
  material: z.string().min(1),
  channel: paintChannel,
  /** Draw {@link CosmeticConfig.paint.pattern} into this material. Flat colour when false/absent. */
  patterned: z.boolean().optional(),
});
export type PaintMaterialTarget = z.infer<typeof paintMaterialTarget>;

export const cosmeticSchema = z.object({
  ...baseShape("cosmetic"),
  kind: z.enum(["paint"]),
  price: z.number().int().nonnegative(),
  /** The single ship or module config this skin belongs to. */
  target: configId,
  paint: z.object({
    /** Hull base albedo tint. */
    primary: hexColor,
    /** Trim / secondary material tint. */
    accent: hexColor,
    /** Engine-glow accent; absent leaves the authored emissive alone. */
    emissive: hexColor.optional(),
    /** Procedural finish for materials flagged `patterned`. Absent = flat colour. */
    pattern: paintPattern.optional(),
    /** The pattern's second colour (stripes, rust blotches). Defaults to `accent`. */
    patternColor: hexColor.optional(),
    /** Pattern repeats across one UV tile. Bigger = finer stripes. */
    patternScale: z.number().positive().max(64).optional(),
    /** Surface behaviour of the painted plates. Absent = the artist's own. */
    finish: paintFinish.optional(),
  }),
  /**
   * Exactly which of the model's materials this paint touches. ABSENT means
   * "guess from material names" — the pre-targeting behaviour, kept so a paint
   * authored before the Skins tool (and every procedural, single-material
   * recipe) still reads as painted. An EMPTY list paints nothing.
   */
  materials: z.array(paintMaterialTarget).optional(),
});

export type CosmeticConfig = z.infer<typeof cosmeticSchema>;

/**
 * The canonical default look — the ship exactly as it was authored. It exists as
 * a real, ownable, equippable config so "selected" is never undefined semantics
 * on the UI side; the RENDERER still treats an ABSENT selection as standard, so
 * this id and `null` mean the same pixels.
 */
export function baseCosmeticIdFor(shipId: string): string {
  return `cosmetic.paint-${shipId.split(".").pop() ?? shipId}-standard`;
}

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
  return cosmetic.target === shipId;
}

/**
 * The target entry for `materialName`, or `undefined` when the paint does not
 * touch it. Case-insensitive because GLB exporters disagree about casing and a
 * designer picking a name off a dropdown must not have to care.
 *
 * Returns `undefined` for a paint with NO `materials` list too — callers have to
 * distinguish "untargeted paint, fall back to name heuristics" (`materials`
 * absent) from "this material is not painted" themselves.
 */
export function paintTargetFor(
  cosmetic: Pick<CosmeticConfig, "materials">,
  materialName: string,
): PaintMaterialTarget | undefined {
  const wanted = materialName.trim().toLowerCase();
  return cosmetic.materials?.find((entry) => entry.material.trim().toLowerCase() === wanted);
}
