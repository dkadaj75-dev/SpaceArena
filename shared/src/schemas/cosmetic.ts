import { z } from "zod";
import { baseShape, configId } from "./base.js";
import {
  SKIN_ELEMENTS,
  skinElements,
  styleIsEmpty,
  type SkinElement,
  type SkinElementStyle,
} from "./skin.js";

/**
 * A cosmetic: something a pilot BUYS and EQUIPS that changes how a hull looks
 * and nothing else. `kind` is an enum with one member today because the second
 * one (decals, badges) must not be a breaking change to every stored selection
 * — the id space and the ownership tables are kind-agnostic.
 *
 * A skin is authored as ELEMENTS (body, canopy, wings, emissive, propulsion),
 * never as the model's material names. Which of a hull's materials each element
 * covers is the SHIP's business — see `shipSkinWiring` in ./skin.ts — so the
 * same style lands differently on each hull, and a hull that wires an element
 * to nothing simply refuses that part of the livery.
 *
 * Skins stay per-hull (`target`) even so, because "wings" means different
 * plates on an Interceptor and a Brawler and the two want different colours.
 * TEXTURES are what get reused across skins and across ships.
 *
 * Prices are authored, not hardcoded free: every shipped cosmetic is `price: 0`
 * while the economy is switched off, and the buy flow still debits it. See
 * `client/src/game/offlineOwnership.ts` for why that distinction is load-bearing.
 */
export const cosmeticSchema = z.object({
  ...baseShape("cosmetic"),
  kind: z.enum(["paint"]),
  price: z.number().int().nonnegative(),
  /** The single ship or module config this skin belongs to. */
  target: configId,
  /**
   * The look, one entry per element. An absent or blank element leaves that
   * part of the hull exactly as the artist shipped it — which is also what a
   * hull that wires the element to no materials produces, from the other side.
   */
  elements: skinElements.default({}),
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
 * A skin has up to four surface colours now and a 40×30 card cannot show them
 * all: the first authored colour reads as the livery and the first DIFFERING
 * one reads as its trim. A texture-only skin still gets a swatch — its pattern
 * colour, or the neutral — because a card with no fill at all looks broken
 * rather than subtle. The glow corner lights when any element self-illuminates.
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
