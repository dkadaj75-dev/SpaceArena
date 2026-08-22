import { z } from "zod";
import { configId } from "./base.js";

/**
 * Skin elements — the vocabulary both halves of the tool constellation speak.
 *
 * A skin is not a list of the model's material names. It is a set of ELEMENTS,
 * and the indirection is the whole point:
 *
 *  - The SHIP tool wires each element to whichever of that hull's own materials
 *    belong to it ({@link shipSkinWiring}). One element can hold several
 *    materials, and an element left empty is a GATE: nothing paints there, no
 *    matter what a skin says about it. That is what gives a designer control
 *    over which plates of a specific model a livery is even allowed to reach.
 *  - The SKINS tool authors the look per element ({@link skinElementStyle}):
 *    a texture off the project library, a colour, a pattern, a surface finish.
 *
 * Skins stay per-ship (a skin targets one hull), because the same element name
 * means different plates on different models. Textures are what travel.
 *
 * Adding a sixth element is two edits: this enum and {@link SKIN_ELEMENT_LABEL}
 * — plus the wiring/style objects below, which are spelled out rather than
 * derived so both stay statically typed.
 */
export const skinElement = z.enum(["body", "canopy", "wings", "emissive", "propulsion"]);
export type SkinElement = z.infer<typeof skinElement>;

/** Every element, in the order both tools list them. */
export const SKIN_ELEMENTS = skinElement.options;

/** What a designer sees. The ids are singular and lowercase; these are not. */
export const SKIN_ELEMENT_LABEL: Record<SkinElement, string> = {
  body: "Body",
  canopy: "Canopies",
  wings: "Wings",
  emissive: "Emissive light",
  propulsion: "Propulsion",
};

/**
 * The elements that address MATERIALS of the model. `propulsion` is deliberately
 * not one of them: it addresses emitter SOCKETS and swaps a particle system, so
 * every surface-shaped code path has to exclude it explicitly.
 */
export const SURFACE_ELEMENTS = ["body", "canopy", "wings", "emissive"] as const;
export type SurfaceElement = (typeof SURFACE_ELEMENTS)[number];

export function isSurfaceElement(element: SkinElement): element is SurfaceElement {
  return element !== "propulsion";
}

const nameList = z.array(z.string().min(1));

/**
 * A content-relative image file: `ships/textures/interceptor/standard/body.png`.
 *
 * Deliberately a PATH and not a `texture.*` config id, unlike the legacy paint
 * path's {@link skinElementStyle.texture}. A texture config is the right shape
 * for a REUSABLE tiling plate (it carries scale, category, companion maps and a
 * designer-chosen name); an authored skin texture is the opposite — one bespoke
 * image unwrapped for exactly one material of exactly one hull, that nothing
 * else will ever point at. Wrapping each of those in its own config would mean
 * one JSON file per PNG the owner paints, for no reuse and no extra data.
 *
 * Rejects a leading `/` and a leading `content/`: every asset path in the pack
 * is relative to content/ (`render.model`, `skybox.texture`, `texture.source`),
 * and the one convention that is authored WITH the prefix (theme music) is the
 * one that keeps tripping the content sweep.
 */
export const contentImagePath = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith("/") && !p.startsWith("content/"), {
    message: "texture path is relative to content/ — drop the leading \"/\" or \"content/\"",
  })
  .refine((p) => /\.(png|jpe?g|webp|ktx2)$/i.test(p), {
    message: "texture path must name an image file (.png, .jpg, .webp, .ktx2)",
  });

/**
 * Ship-side wiring: which of THIS hull's materials (and, for propulsion, which
 * of its emitter sockets) each element covers.
 *
 * Absent or empty ⇒ that element is not paintable on this hull. A skin's canopy
 * entry is inert on a hull whose canopy list is empty, and the model renders as
 * the artist shipped it.
 */
export const shipSkinWiring = z.object({
  /** GLB material names, matched case-insensitively. */
  body: nameList.optional(),
  canopy: nameList.optional(),
  wings: nameList.optional(),
  emissive: nameList.optional(),
  /** Emitter SOCKET ids (`eng-l`, `boost-plume`), not material names. */
  propulsion: nameList.optional(),
  /**
   * THE HULL'S OWN EMISSIVE LIGHT MAP (owner 2026-08-22, the one hard rule of
   * the texture-skin redesign: "there should be an emissive light texture for
   * each ship").
   *
   * The odd one out in this object — a path, not a list of names — and it is
   * here rather than on a skin because it belongs to the HULL: the lit strips,
   * windows and exhaust interiors are geometry the model was built with, and
   * every livery lights the same ones. A skin may override it
   * (`cosmetic.emissive`); a skin that does not, wears this.
   *
   * Applied to the materials `emissive` wires, so a hull that authors this and
   * wires nothing has a gap — reported by {@link shipEmissiveGap}, never fixed
   * silently.
   */
  emissiveTexture: contentImagePath.optional(),
}).strict();
export type ShipSkinWiring = z.infer<typeof shipSkinWiring>;

/** The names an element covers on this hull. Never undefined — unwired is empty. */
export function wiringFor(wiring: ShipSkinWiring | undefined, element: SkinElement): readonly string[] {
  return wiring?.[element] ?? [];
}

/**
 * Which element a material belongs to on this hull, or `null` when the ship
 * wires none. Case-insensitive: GLB exporters disagree about casing and a
 * designer picking a name off a dropdown must not have to care.
 *
 * First match wins, in {@link SKIN_ELEMENTS} order, so a material listed under
 * two elements by mistake resolves predictably instead of flickering.
 */
export function elementOfMaterial(wiring: ShipSkinWiring | undefined, materialName: string): SurfaceElement | null {
  const wanted = materialName.trim().toLowerCase();
  for (const element of SURFACE_ELEMENTS) {
    for (const name of wiringFor(wiring, element)) {
      if (name.trim().toLowerCase() === wanted) return element;
    }
  }
  return null;
}

/** Whether `socketId` is one of this hull's propulsion emitters. */
export function isPropulsionSocket(wiring: ShipSkinWiring | undefined, socketId: string): boolean {
  const wanted = socketId.trim().toLowerCase();
  return wiringFor(wiring, "propulsion").some((id) => id.trim().toLowerCase() === wanted);
}

/**
 * Whether this hull can wear an emissive light map at all, and why not when it
 * cannot. `null` = no gap.
 *
 * The owner's rule is "an emissive light texture for EACH ship", and there are
 * two independent ways to miss it: no material wired to the `emissive` element
 * (nowhere to put the map), or no map authored (nothing to put). Both are
 * reported rather than enforced by the schema, because failing the pack load
 * would mean no hull could be added until its light map existed — and the whole
 * point of this pipeline is that the owner paints the images at his own pace.
 * The gap has to be LOUD (the Ship tool's warning row, the content validator's
 * summary) and never silent.
 */
export function shipEmissiveGap(wiring: ShipSkinWiring | undefined): "unwired" | "unpainted" | null {
  if (wiringFor(wiring, "emissive").length === 0) return "unwired";
  if (!wiring?.emissiveTexture) return "unpainted";
  return null;
}

/** One line a designer can act on, for each {@link shipEmissiveGap} state. */
export const EMISSIVE_GAP_MESSAGE: Record<"unwired" | "unpainted", string> = {
  unwired:
    "No material wired to Emissive light — this hull has nowhere to put an emissive map. Wire the lit slot (strips, windows, exhaust interiors) above.",
  unpainted:
    "No emissive light texture — every ship is meant to have one. Paint it and point the field below at it; until then the hull emits whatever the GLB authored.",
};

// -------------------------------------------------------------- textures ----

/**
 * A TEXTURE PACK: the authored images one skin swaps onto a hull (owner
 * 2026-08-22). This is what a skin IS now — "skins are basically a swap between
 * a ship texture, or a texture pack (when several textures are present)".
 *
 * Keyed by ELEMENT, not by GLB material name, for the same reason the styles
 * below are: the hull already declares which of its materials each element
 * covers ({@link shipSkinWiring}), so an element-keyed pack inherits the gate
 * (an unwired element refuses the texture), survives a material rename, and
 * lets one image cover the four plates a hull happens to have split its body
 * into. A material-keyed pack would re-state that wiring inside every skin and
 * make each one model-specific twice over.
 *
 * ONE entry is the whole-hull UV swap the owner described (a hull with a single
 * UV-mapped material wires only `body`); FOUR is a pack. Materials that need
 * their own separately-unwrapped image need their own element — which is what
 * the element vocabulary is for.
 *
 * Every value is an ALBEDO/base-colour map. The emissive LIGHT map is not in
 * here: it is `cosmetic.emissive`, because it belongs to the hull first and a
 * skin only overrides it.
 */
export const skinTextures = z.object({
  body: contentImagePath.optional(),
  canopy: contentImagePath.optional(),
  wings: contentImagePath.optional(),
  /** The albedo of the LIT plates. Their light map is `cosmetic.emissive`. */
  emissive: contentImagePath.optional(),
// STRICT for the same reason `skinElements` is: two tools write these keys and a
// typo'd element must fail the load, not vanish into a skin that renders nothing.
}).strict();
export type SkinTextures = z.infer<typeof skinTextures>;

/** Whether this pack would swap anything at all. An all-blank pack is not a pack. */
export function texturesAreEmpty(textures: SkinTextures | undefined): boolean {
  if (!textures) return true;
  return SURFACE_ELEMENTS.every((element) => textures[element] === undefined);
}

// --------------------------------------------------- style (LEGACY paint) ----
//
// Everything below this line belongs to the PROCEDURAL paint path — colour +
// pattern + finish recipes, `kind: "paint"`. It is the legacy pipeline as of
// the 2026-08-22 texture redesign: the 32 shipped paints and the whole shop /
// ownership surface still run on it, and it keeps working unchanged until the
// owner has authored texture packs to replace them. New liveries are
// `kind: "skin"` texture packs; nothing new should reach for these.

/** `#rrggbb`. No named colours, no alpha — the renderer tints materials with this verbatim. */
export const hexColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "colour must be a #rrggbb hex string");

/**
 * Procedural finishes a skin can wear on top of (or instead of) a texture.
 * Drawn into the element's albedo map and nothing else, so metal, roughness and
 * clearcoat stay wherever the surface block put them.
 */
export const paintPattern = z.enum(["zebra", "tiger", "rust"]);
export type PaintPattern = z.infer<typeof paintPattern>;

/**
 * How a painted plate BEHAVES under light, on top of what colour it is.
 *
 * Colour alone cannot make a livery look expensive: a saturated hue on a matte
 * 0.38-roughness plate reads as primer. Gloss and clear coat are what turn it
 * into automotive lacquer. Every field is optional and ABSENT means "keep what
 * the artist authored", so a colour-only style cannot flatten a hull's own
 * material work just by existing.
 */
export const paintFinish = z.object({
  /** 0 = flat matte, 1 = mirror. Drives PBR roughness (and a StandardMaterial's specular). */
  gloss: z.number().min(0).max(1).optional(),
  /**
   * 0 = painted dielectric, 1 = bare metal.
   *
   * A TRAP in these arenas: they are lit by one small IBL cube, and metal there
   * eats the diffuse term and turns a bright hue to mud. Keep it near zero
   * unless the element is meant to read as unpainted plate.
   */
  metallic: z.number().min(0).max(1).optional(),
  /** Clear lacquer over the colour: a white highlight layer independent of the hue. */
  clearcoat: z.number().min(0).max(1).optional(),
  /**
   * Self-illumination in the element's OWN hue, 0..1. The arenas are dark, so
   * gloss alone buys a highlight and loses the rest of the plate to shadow.
   * Keep it low — the engine bloom has to stay the brightest thing on a hull.
   */
  glow: z.number().min(0).max(1).optional(),
});
export type PaintFinish = z.infer<typeof paintFinish>;

/**
 * What a skin does to ONE surface element. Every field is optional and every
 * absent field means "leave the model's own". A style with nothing set is the
 * same as no style at all — which is exactly what an unfilled row in the tool
 * has to mean.
 */
export const skinElementStyle = z.object({
  /** `texture.*` from the project library. Absent = no albedo map of its own. */
  texture: configId.optional(),
  /** Base tint. Multiplies the texture when both are set, so keep it light there. */
  color: hexColor.optional(),
  /** Procedural pattern drawn into this element's albedo. */
  pattern: paintPattern.optional(),
  /** The pattern's second colour. Defaults to a readable contrast of `color`. */
  patternColor: hexColor.optional(),
  /** Pattern repeats across one UV tile. Bigger = finer stripes. */
  patternScale: z.number().positive().max(64).optional(),
  /** Surface behaviour. Absent = the artist's own roughness, metal and coat. */
  finish: paintFinish.optional(),
});
export type SkinElementStyle = z.infer<typeof skinElementStyle>;

/**
 * Propulsion is the one element that is not a surface: it swaps the particle
 * system on the hull's wired emitter sockets for any effect authored anywhere
 * in the project.
 */
export const skinPropulsionStyle = z.object({
  /** `fx.*` effect config. Absent = the socket keeps its authored effect. */
  effect: configId.optional(),
});
export type SkinPropulsionStyle = z.infer<typeof skinPropulsionStyle>;

/** Every element of a skin. Spelled out so each half stays statically typed. */
export const skinElements = z.object({
  body: skinElementStyle.optional(),
  canopy: skinElementStyle.optional(),
  wings: skinElementStyle.optional(),
  emissive: skinElementStyle.optional(),
  propulsion: skinPropulsionStyle.optional(),
// STRICT on purpose. Two separate tools write these keys, so a typo'd element
// ("fuselage", "canopies") must fail the pack load rather than be silently
// stripped into a skin that renders nothing and looks correct in the JSON.
}).strict();
export type SkinElements = z.infer<typeof skinElements>;

/** Whether a style would change anything at all. An all-blank row is not a style. */
export function styleIsEmpty(style: SkinElementStyle | undefined): boolean {
  if (!style) return true;
  return (
    style.texture === undefined &&
    style.color === undefined &&
    style.pattern === undefined &&
    style.finish === undefined
  );
}
