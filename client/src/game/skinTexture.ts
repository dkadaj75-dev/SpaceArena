import { Color3, Texture, type BaseTexture, type Scene } from "@babylonjs/core";

/**
 * Authored skin textures (owner 2026-08-22) — loading one hand-painted image
 * and putting it on one material channel.
 *
 * This is the CURRENT skin pipeline's only image work, and it is deliberately
 * tiny: the owner paints each variation against the hull's own UV layout
 * outside the game, so nothing here composites, tints or generates anything.
 * Compare `paintPattern.ts`, the LEGACY procedural path, which draws a livery
 * into a canvas because a colour+pattern recipe has no file to load.
 *
 * The three rules that are easy to get wrong live here rather than at the call
 * site, so every caller gets them for free:
 *
 *  1. UV ORIENTATION. glTF puts the UV origin at the TOP-left, so Babylon's
 *     glTF loader creates every texture with `invertY: false`
 *     (`@babylonjs/loaders/glTF/2.0/glTFLoader.js`, `invertY: false` in
 *     `_createTextureAsync`). A `new Texture(url, scene)` defaults to
 *     `invertY: true` and would land the owner's repaint UPSIDE DOWN against
 *     the very UVs he painted it on. {@link loadSkinTexture} matches the loader.
 *  2. MISSING FILE IS NORMAL. The owner scaffolds a pack and paints it over
 *     days; half of it does not exist yet. A texture that 404s must leave the
 *     material exactly as the GLB shipped it — which is why the image is
 *     applied only once it has LOADED. Assigning first and rolling back on
 *     error would blank the hull for the whole length of the failed request,
 *     because a PBR material with an unready texture is not drawn at all.
 *  3. THE MAP CARRIES THE COLOUR. A base-colour factor multiplies the albedo
 *     map, and the shipped hulls author real ones (the Interceptor's plates are
 *     tinted by factor alone). Left in place it would double-tint the repaint,
 *     so applying an albedo neutralises it — the same rule the legacy path
 *     documents for composited maps.
 */

/** Content-relative asset path → the URL the dev server and the build both serve. */
export function contentUrl(path: string): string {
  return `${import.meta.env.BASE_URL}content/${path}`;
}

/**
 * The material channels a texture swap touches — duck-typed, like the legacy
 * path's `StyleTarget`, so tests can hand in a plain object and so a
 * StandardMaterial (which has `diffuseTexture` and no `albedoTexture`) and a
 * PBRMaterial (the reverse) both work through one function.
 */
export interface TextureSlot {
  name?: string;
  albedoColor?: Color3;
  diffuseColor?: Color3;
  emissiveColor?: Color3;
  albedoTexture?: BaseTexture | null;
  diffuseTexture?: BaseTexture | null;
  emissiveTexture?: BaseTexture | null;
}

/** Paths already reported. One warning per missing FILE, not one per ship. */
const warned = new Set<string>();

/**
 * Report a texture the owner has not painted yet — once per path, ever.
 *
 * Once matters: a missing body map is missing for every ship in the match, on
 * every LOD, on every re-stage of the editor preview. Logged per occurrence it
 * would be thousands of lines and the console would stop being readable, which
 * is the same as not reporting it at all.
 */
export function warnMissingSkinTexture(path: string): void {
  if (warned.has(path)) return;
  warned.add(path);
  console.warn(
    `[skin] texture not found: content/${path} — the material keeps the look the GLB shipped with. ` +
      `Paint the file and drop it there, or clear the path in F10 → Skins.`,
  );
}

/** Test hook: forget which paths have been reported. */
export function resetSkinTextureWarnings(): void {
  warned.clear();
}

/**
 * Start loading `path` and hand the texture to `apply` ONCE IT IS THERE. A
 * missing file warns and never calls `apply`, so the caller's material keeps
 * what the GLB gave it (rule 2 above).
 *
 * Returns the Texture immediately so the caller can OWN it — the ship paint
 * bank records it against the variant and disposes it with the rest, whether or
 * not it ever loaded.
 */
export function loadSkinTexture(scene: Scene, path: string, apply: (texture: Texture) => void): Texture {
  const texture = new Texture(
    contentUrl(path),
    scene,
    // noMipmap: false — a hull is seen at every distance and an unmipped
    // 2048 map shimmers badly at the LOD ranges these arenas fight at.
    false,
    // invertY: false — see rule 1. This is the whole reason this wrapper exists.
    false,
    Texture.TRILINEAR_SAMPLINGMODE,
    () => apply(texture),
    () => warnMissingSkinTexture(path),
  );
  // A skin texture is a bespoke unwrap, never a tiling plate: exactly one
  // repeat, clamped, or a UV island that grazes the edge would smear.
  texture.wrapU = Texture.CLAMP_ADDRESSMODE;
  texture.wrapV = Texture.CLAMP_ADDRESSMODE;
  return texture;
}

/**
 * Put an authored albedo on one material slot.
 *
 * The emissive re-point is not an extra: `render.emissiveGlow` wires a hull's
 * exhaust slot by setting `emissiveTexture = albedoTexture` (see
 * `core/thrustGlow.ts`), so a slot whose two channels are the SAME object is a
 * thrust glow emitting its own albedo. Swapping only the albedo would leave it
 * emitting the old paint — a repainted nozzle glowing in the shipped colour.
 */
export function applySkinAlbedo(slot: TextureSlot, texture: BaseTexture): void {
  const previous = slot.albedoTexture ?? slot.diffuseTexture ?? null;
  if (previous && slot.emissiveTexture === previous) slot.emissiveTexture = texture;
  if ("albedoTexture" in slot) slot.albedoTexture = texture;
  if ("diffuseTexture" in slot) slot.diffuseTexture = texture;
  // Rule 3: the painted image already carries its own colour.
  if (slot.albedoColor) slot.albedoColor = new Color3(1, 1, 1);
  if (slot.diffuseColor) slot.diffuseColor = new Color3(1, 1, 1);
}

/**
 * Put the emissive LIGHT map on one material slot.
 *
 * `emissiveColor` is the multiplier over that map, and glTF's default is BLACK
 * — so a map dropped on an unlit material would emit nothing at all and read as
 * "the texture did not load". It is lifted to white only when it is black: a
 * hull whose artist authored a coloured emissive keeps that tint.
 */
export function applySkinEmissive(slot: TextureSlot, texture: BaseTexture): void {
  if (!("emissiveTexture" in slot)) return;
  slot.emissiveTexture = texture;
  const color = slot.emissiveColor;
  if (color && color.r === 0 && color.g === 0 && color.b === 0) slot.emissiveColor = new Color3(1, 1, 1);
}
