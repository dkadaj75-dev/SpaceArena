import { z } from "zod";
import { baseShape, configId } from "./base.js";
import {
  contentImagePath,
  SKIN_ELEMENTS,
  skinElements,
  skinTextures,
  styleIsEmpty,
  SURFACE_ELEMENTS,
  texturesAreEmpty,
  wiringFor,
  type ShipSkinWiring,
  type SkinElement,
  type SkinElementStyle,
  type SurfaceElement,
} from "./skin.js";

/**
 * A cosmetic: something a pilot BUYS and EQUIPS that changes how a hull looks
 * and nothing else.
 *
 * TWO KINDS, and `kind` decides which half of this config is read:
 *
 *  - `kind: "skin"` — the CURRENT pipeline (owner 2026-08-22). A swap of
 *    AUTHORED textures: `textures` carries one hand-painted albedo per element,
 *    `emissive` carries the light map. The images are painted outside the game
 *    against each hull's own UV layout; the code's job is only to put them on
 *    the right materials.
 *  - `kind: "paint"` — the LEGACY procedural pipeline. Per-element colour,
 *    pattern and finish recipes (`elements`). The 32 shipped paints, the shop
 *    and the ownership tables all still run on it and it is not going anywhere
 *    until the owner has authored packs to replace them, one at a time.
 *
 * Both kinds address the hull through ELEMENTS (body, canopy, wings, emissive,
 * propulsion), never through the model's material names. Which of a hull's
 * materials each element covers is the SHIP's business — see `shipSkinWiring`
 * in ./skin.ts — so a hull that wires an element to nothing simply refuses that
 * part of the livery, whichever kind it is.
 *
 * Cosmetics stay per-hull (`target`) either way: an authored texture is
 * unwrapped for one model's UVs and cannot mean anything on another.
 *
 * Prices are authored, not hardcoded free: every shipped cosmetic is `price: 0`
 * while the economy is switched off, and the buy flow still debits it. See
 * `client/src/game/offlineOwnership.ts` for why that distinction is load-bearing.
 */
export const cosmeticSchema = z
  .object({
    ...baseShape("cosmetic"),
    kind: z.enum(["paint", "skin"]),
    price: z.number().int().nonnegative(),
    /** The single ship or module config this skin belongs to. */
    target: configId,
    /**
     * `kind: "skin"` — the authored albedo per element. An absent element keeps
     * whatever the GLB shipped on those materials, and so does an element whose
     * FILE is missing: the owner paints the pack over time and a half-finished
     * one has to render as a partly-reskinned hull, never as a black one.
     */
    textures: skinTextures.default({}),
    /**
     * `kind: "skin"` — this livery's emissive LIGHT map, overriding the hull's
     * own (`ship.skin.emissiveTexture`). Absent is the normal case: the lit
     * strips are the hull's geometry and most liveries relight them the same
     * way.
     */
    emissive: contentImagePath.optional(),
    /**
     * `kind: "paint"` (LEGACY) — the procedural look, one entry per element. An
     * absent or blank element leaves that part of the hull exactly as the
     * artist shipped it, which is also what a hull that wires the element to no
     * materials produces, from the other side.
     *
     * `elements.propulsion` is the exception that belongs to BOTH kinds: it
     * swaps a particle effect rather than a surface, so a texture skin authors
     * it here too.
     */
    elements: skinElements.default({}),
  })
  .superRefine((cosmetic, ctx) => {
    // The two kinds are not additive: a field belonging to the other one is a
    // mistake that would render as silence (a paint whose textures nothing
    // reads, a texture skin whose colours nothing applies) and look correct in
    // the JSON. Fail the load instead — that is the same bet `skinElements`
    // makes with `.strict()`.
    if (cosmetic.kind === "paint" && (!texturesAreEmpty(cosmetic.textures) || cosmetic.emissive)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["textures"],
        message: 'a kind:"paint" cosmetic is the legacy procedural path and reads no textures — use kind:"skin"',
      });
    }
    if (cosmetic.kind === "skin") {
      // Propulsion is deliberately allowed: it is the one element that is not a
      // surface, and a texture skin still wants to swap the engine plume.
      const styled = SURFACE_ELEMENTS.filter((element) => !styleIsEmpty(cosmetic.elements?.[element]));
      if (styled.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["elements"],
          message: `a kind:"skin" cosmetic authors surfaces as textures, not styles — drop elements.${styled.join(", elements.")}`,
        });
      }
    }
  });

export type CosmeticConfig = z.infer<typeof cosmeticSchema>;

/** Whether this cosmetic is an authored texture pack rather than a legacy paint. */
export function isTextureSkin(cosmetic: Pick<CosmeticConfig, "kind">): boolean {
  return cosmetic.kind === "skin";
}

/**
 * The albedo image this skin puts on `element`, or `undefined` for "keep the
 * GLB's own". Total by design — a legacy paint answers `undefined` everywhere,
 * so callers never have to branch on `kind` before asking.
 */
export function skinTextureFor(
  cosmetic: Pick<CosmeticConfig, "kind" | "textures">,
  element: SkinElement,
): string | undefined {
  if (cosmetic.kind !== "skin" || element === "propulsion") return undefined;
  return cosmetic.textures?.[element];
}

/**
 * The emissive LIGHT map for this (hull, skin) pair: the skin's own if it
 * authors one, else the hull's, else none.
 *
 * The fallback is the whole reason the hull carries a map at all — the lit
 * strips are model geometry, so a livery that says nothing about them still
 * lights them, and only a livery that deliberately relights the ship overrides.
 */
export function skinEmissiveFor(
  wiring: ShipSkinWiring | undefined,
  cosmetic: Pick<CosmeticConfig, "kind" | "emissive"> | undefined,
): string | undefined {
  if (cosmetic?.kind === "skin" && cosmetic.emissive) return cosmetic.emissive;
  return wiring?.emissiveTexture;
}

/**
 * Whether this (hull, skin) pair swaps ANY texture — both sides have to agree:
 * the hull wires the element to at least one material AND the skin authors an
 * image for it. Neither alone changes a pixel.
 *
 * The emissive light map counts, and it counts even when only the HULL authors
 * it: a texture skin is already paying for its own painted master, and the lit
 * plates have to come along or an equipped livery would darken the ship.
 */
export function skinSwapsAnyTexture(
  wiring: ShipSkinWiring | undefined,
  cosmetic: Pick<CosmeticConfig, "kind" | "textures" | "emissive">,
): boolean {
  if (cosmetic.kind !== "skin") return false;
  return SURFACE_ELEMENTS.some(
    (element: SurfaceElement) =>
      wiringFor(wiring, element).length > 0 &&
      (cosmetic.textures?.[element] !== undefined ||
        (element === "emissive" && skinEmissiveFor(wiring, cosmetic) !== undefined)),
  );
}

/**
 * The canonical default look — the ship exactly as it was authored. It exists as
 * a real, ownable, equippable config so "selected" is never undefined semantics
 * on the UI side; the RENDERER still treats an ABSENT selection as standard, so
 * this id and `null` mean the same pixels.
 *
 * Still the LEGACY `paint-<hull>-standard` id, and it has to stay that: it is
 * written into every stored selection, every ownership row and every bot's
 * dressing. The texture pipeline's own `skin-<hull>-standard` is a separate,
 * ordinary cosmetic that happens to reproduce the shipped look; renaming this
 * would be a data migration, not a rename.
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

/** The style this skin gives one element, or `undefined` when it says nothing. */
export function styleFor(cosmetic: Pick<CosmeticConfig, "elements">, element: SkinElement): SkinElementStyle | undefined {
  if (element === "propulsion") return undefined;
  return cosmetic.elements?.[element];
}

/** Neutral shown when a skin authors no colour anywhere — a blank swatch is a bug report. */
const SWATCH_FALLBACK = "#8a94a6";

/** What a shop card paints its swatch with. `glow` absent = no lit corner. */
export interface CosmeticSwatch {
  primary: string;
  accent: string;
  glow?: string;
}

/**
 * The colours a shop swatch is drawn from.
 *
 * A legacy paint has up to four surface colours and a 40×30 card cannot show
 * them all: the first authored colour reads as the livery and the first
 * DIFFERING one reads as its trim. The glow corner lights when any element
 * self-illuminates.
 *
 * A `kind: "skin"` texture pack authors NO colour anywhere — its whole look is
 * in images this function has never loaded — so it gets the neutral, twice.
 * That is deliberate: a hue invented from the id would be a card promising red
 * over a hull the owner painted green, which is worse than a plain swatch. The
 * real fix is a thumbnail off the pack's own body texture, and it belongs in
 * the card renderer, not in a pure content query.
 */
export function cosmeticSwatch(cosmetic: Pick<CosmeticConfig, "elements">): CosmeticSwatch {
  const styles = SKIN_ELEMENTS.map((element) => styleFor(cosmetic, element)).filter(
    (style): style is SkinElementStyle => !styleIsEmpty(style),
  );
  const colors = styles.flatMap((style) => [style.color, style.patternColor].filter((c): c is string => !!c));
  const primary = colors[0] ?? SWATCH_FALLBACK;
  const lit = styles.find((style) => (style.finish?.glow ?? 0) > 0);
  return {
    primary,
    accent: colors.find((color) => color !== primary) ?? primary,
    ...(lit ? { glow: lit.color ?? primary } : {}),
  };
}
