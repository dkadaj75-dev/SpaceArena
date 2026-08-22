import { Color3, Mesh, MultiMaterial, Texture, type BaseTexture, type Material, type Scene } from "@babylonjs/core";
import {
  elementOfMaterial,
  isPropulsionSocket,
  skinEmissiveFor,
  skinSwapsAnyTexture,
  styleIsEmpty,
  SURFACE_ELEMENTS,
  wiringFor,
  type ConfigService,
  type CosmeticConfig,
  type PaintFinish,
  type ShipConfig,
  type ShipSnapshot,
  type SkinElementStyle,
  type SurfaceElement,
  type TextureConfig,
} from "@space-arena/shared";
import { mirrorThrustGlow } from "../core/thrustGlow.js";
import { cosmeticById } from "./cosmetics.js";
import { albedoTexture, DEFAULT_PATTERN_SCALE } from "./paintPattern.js";
import { applySkinAlbedo, applySkinEmissive, contentUrl, loadSkinTexture, type TextureSlot } from "./skinTexture.js";

/**
 * Cosmetics on a hull (contract §5) — both kinds of them.
 *
 * Ships render as INSTANCES of a shared, disabled master mesh, and an instance
 * cannot own a material — so a livery cannot be a per-ship material tweak
 * without blacking out every hull in the match (the same trap the Hangar's
 * locked silhouette documents). A cosmetic therefore produces its own painted
 * MASTER, cloned once per (hull, cosmetic) pair and instanced from like any
 * other: ten ships wearing one skin still cost one extra draw batch, not ten.
 * That is true of a texture pack exactly as it was of a paint — the pack loads
 * its images ONCE per (hull, skin), not once per ship.
 *
 * WHAT a cosmetic does to the materials it reaches depends on its kind:
 *
 *  - `kind: "skin"` (CURRENT) — swap the owner's authored albedo onto the
 *    element's materials, and the emissive light map onto the emissive
 *    element's. See {@link skinnedMaterial} and `./skinTexture.ts`.
 *  - `kind: "paint"` (LEGACY) — the procedural colour/pattern/finish recipe.
 *    See {@link applyElementStyle} and `./paintPattern.ts`. Unchanged, because
 *    32 shipped paints and the whole shop run on it.
 *
 * WHICH plates either one reaches is decided by the SHIP, not the cosmetic.
 * `ship.skin` wires each element (body / canopy / wings / emissive) to that
 * model's own material names. A material the hull wires to no element is never
 * touched — roughness, metallic, clearcoat and all — which is what lets a
 * livery cover the Interceptor's shell plates while its canopy glass, dark tech
 * recesses and engine bloom stay exactly as the artist shipped them.
 *
 * Nothing here mutates a master or its materials: an absent/unknown cosmetic id
 * hands the base master straight back, an unwired slot keeps the ORIGINAL
 * material object rather than a clone of it, a texture file that does not exist
 * yet leaves the shipped material alone, and disposal only ever frees clones
 * this bank made.
 */

/** Glow strength used when a material carries no authored emissive of its own. */
const DEFAULT_GLOW = 0.15;

/** Neutral plate under a texture that authors no colour of its own. */
const NEUTRAL_BASE = "#ffffff";

/** The material properties a LEGACY paint style touches — duck-typed so tests can mock them. */
interface StyleTarget extends TextureSlot {
  specularColor?: Color3;
  bumpTexture?: BaseTexture | null;
  metallicTexture?: BaseTexture | null;
  useRoughnessFromMetallicTextureAlpha?: boolean;
  useRoughnessFromMetallicTextureGreen?: boolean;
  useMetallnessFromMetallicTextureBlue?: boolean;
  /** PBR (glTF hulls). */
  roughness?: number | null;
  metallic?: number | null;
  clearCoat?: { isEnabled: boolean; intensity: number; roughness: number };
  /** StandardMaterial (procedural recipes). */
  specularPower?: number;
}

/** Extra maps a library texture brings with it. Built once per (skin, element). */
export interface ElementMaps {
  albedo?: BaseTexture | null;
  normal?: BaseTexture | null;
  metallicRoughness?: BaseTexture | null;
}

/**
 * Paint one material with one element's style. Only ever called on a CLONE, and
 * only for a material the hull actually wired to that element.
 *
 * Order matters: the albedo map goes on first (so its colour multiplier can be
 * set to the style's tint or to white), then the surface, then the glow.
 */
export function applyElementStyle(
  material: Material | StyleTarget,
  style: SkinElementStyle,
  maps: ElementMaps = {},
): void {
  const target = material as StyleTarget;
  const color = safeColor(style.color);

  if (maps.albedo) {
    if ("albedoTexture" in target) target.albedoTexture = maps.albedo;
    if ("diffuseTexture" in target) target.diffuseTexture = maps.albedo;
    // The map already carries the colour it was composited with, so the tint
    // under it must be neutral or the plate comes out doubled and muddy.
    if (target.albedoColor) target.albedoColor = new Color3(1, 1, 1);
    if (target.diffuseColor) target.diffuseColor = new Color3(1, 1, 1);
  } else if (color) {
    if (target.albedoColor) target.albedoColor = color;
    if (target.diffuseColor) target.diffuseColor = color;
  }

  if (maps.normal && "bumpTexture" in target) target.bumpTexture = maps.normal;
  if (maps.metallicRoughness && "metallicTexture" in target) {
    target.metallicTexture = maps.metallicRoughness;
    // glTF convention: roughness in green, metalness in blue.
    target.useRoughnessFromMetallicTextureAlpha = false;
    target.useRoughnessFromMetallicTextureGreen = true;
    target.useMetallnessFromMetallicTextureBlue = true;
  }

  applyFinish(target, style.finish);

  const glow = style.finish?.glow;
  if (glow !== undefined && target.emissiveColor) {
    // Self-illumination in the element's own hue. SETS the strength rather than
    // preserving it: the glow belongs to the paint, and the plates that wear a
    // livery are the ones the artist left with no emissive at all.
    target.emissiveColor = (color ?? new Color3(1, 1, 1)).scale(glow);
  }
}

/**
 * Give the painted plate its surface behaviour. Each field is independently
 * optional: an absent one leaves the artist's own value, so a colour-only style
 * cannot flatten a hull's authored material work just by being applied.
 *
 * `gloss` is authored the way a designer thinks (1 = shiny) and inverted into
 * PBR roughness here. A StandardMaterial has no roughness at all, so it gets
 * the equivalent specular exponent instead — the procedural recipes are the
 * only hulls that path serves, and a flat-shaded box with no highlight would
 * read as a bug next to a glossy GLB.
 */
function applyFinish(target: StyleTarget, finish: PaintFinish | undefined): void {
  if (!finish) return;
  if (finish.gloss !== undefined) {
    if (target.roughness !== undefined) {
      target.roughness = 1 - finish.gloss;
    } else if (target.specularPower !== undefined) {
      target.specularPower = 2 + finish.gloss * finish.gloss * 254;
      if (target.specularColor) target.specularColor = new Color3(1, 1, 1).scale(0.15 + finish.gloss * 0.85);
    }
  }
  if (finish.metallic !== undefined && target.metallic !== undefined) target.metallic = finish.metallic;
  if (finish.clearcoat !== undefined && target.clearCoat) {
    target.clearCoat.isEnabled = finish.clearcoat > 0;
    target.clearCoat.intensity = finish.clearcoat;
    // A lacquer coat is glass: its own roughness is near zero whatever the
    // colour under it does, which is what puts the sharp white streak on top.
    target.clearCoat.roughness = 0.04;
  }
}

function safeColor(hex: string | undefined): Color3 | null {
  if (!hex || !/^#[0-9a-f]{6}$/i.test(hex)) return null;
  return Color3.FromHexString(hex);
}

/**
 * A readable second colour when a pattern authors none: black on a light plate,
 * white on a dark one. A stripe the same colour as the plate is not a pattern.
 */
function defaultMark(base: Color3 | null): string {
  if (!base) return "#16171b";
  return base.r + base.g + base.b > 1.5 ? "#16171b" : "#f2f2f0";
}

/**
 * One authored image, and every material slot waiting for it.
 *
 * A texture pack is loaded ONCE per (variant, path): a hull that wires four
 * plates to `body` shares one Texture across all four, and so do the painted
 * LOD clones built in the same pass. `applied` is what makes that safe against
 * ordering — a slot registered after the image has already landed is served
 * immediately instead of waiting for a load that will never fire again.
 */
class SharedSkinTexture {
  readonly texture: Texture;
  private readonly albedoSlots: TextureSlot[] = [];
  private readonly emissiveSlots: TextureSlot[] = [];
  private loaded: Texture | null = null;

  constructor(scene: Scene, path: string, alive: () => boolean) {
    this.texture = loadSkinTexture(scene, path, (image) => {
      // The variant can be freed before a slow image lands (a skin re-edited in
      // the F10 tool re-stages its preview); assigning onto materials that have
      // been disposed is how that turns into a crash.
      if (!alive()) return;
      this.loaded = image;
      for (const slot of this.albedoSlots) applySkinAlbedo(slot, image);
      for (const slot of this.emissiveSlots) applySkinEmissive(slot, image);
    });
  }

  /** Register one material slot for one channel of this image. */
  want(slot: TextureSlot, channel: "albedo" | "emissive"): void {
    const slots = channel === "albedo" ? this.albedoSlots : this.emissiveSlots;
    slots.push(slot);
    if (!this.loaded) return;
    if (channel === "albedo") applySkinAlbedo(slot, this.loaded);
    else applySkinEmissive(slot, this.loaded);
  }
}

interface PaintVariant {
  master: Mesh;
  materials: Material[];
  textures: BaseTexture[];
  lodMeshes: Mesh[];
  /** LEGACY paint: one built map-set per element, so a four-material body composites once. */
  maps: Partial<Record<SurfaceElement, ElementMaps>>;
  /** Texture skin: one loader per authored image path, shared by every slot that wants it. */
  skinTextures: Map<string, SharedSkinTexture>;
  /** Freed. Async image loads check this before touching a disposed material. */
  disposed: boolean;
}

/**
 * Whether this (hull, cosmetic) pair changes any SURFACE at all — both sides
 * have to agree: the hull wires the element to at least one material AND the
 * cosmetic says something about it. Neither alone changes a pixel.
 *
 * Checked before the clone, not after: a hull that wires nothing must hand back
 * the base master, or every skin in the shop would silently cost an extra draw
 * batch and a material tree to render pixels identical to the unpainted hull.
 * Propulsion is excluded — it swaps particles, never a material.
 *
 * A MISSING FILE deliberately does not disqualify a texture skin here: whether
 * the owner has painted it yet is not knowable synchronously, and a livery that
 * silently fell back to "no clone at all" the first time it was staged would
 * still be unpainted after the file appeared.
 */
function changesAnySurface(ship: Pick<ShipConfig, "skin"> | undefined, cosmetic: CosmeticConfig): boolean {
  if (cosmetic.kind === "skin") return skinSwapsAnyTexture(ship?.skin, cosmetic);
  return SURFACE_ELEMENTS.some(
    (element) => wiringFor(ship?.skin, element).length > 0 && !styleIsEmpty(cosmetic.elements?.[element]),
  );
}

/**
 * Painted masters, cached per (base master, cosmetic) and owned by whoever
 * constructed the bank. Shared by the match view, the Hangar preview and the
 * F10 Skins tool so none of the three can disagree about what a skin looks like.
 */
export class ShipPaintBank {
  private readonly variants = new Map<string, PaintVariant>();

  constructor(
    private readonly scene: Scene,
    private readonly configs: Pick<ConfigService, "getAll" | "get">,
  ) {}

  /**
   * The master to instance this hull from. Returns `base` untouched for an
   * absent, unknown or empty cosmetic id, and for a hull that wires no elements
   * at all.
   *
   * The `-standard` shortcut is LEGACY-PAINT ONLY, and the kind check has to
   * come first: `cosmetic.paint-<hull>-standard` is the shipped look by
   * definition ({@link baseCosmeticIdFor}), so cloning a master to repaint it in
   * the colour it already is would cost a draw batch for nothing. A texture
   * skin called `skin-<hull>-standard` is an ordinary skin that happens to be
   * named that, and it has real images to swap in.
   */
  masterFor(base: Mesh, ship: Pick<ShipConfig, "skin"> | undefined, cosmeticId: string | null): Mesh {
    if (!cosmeticId) return base;
    const cosmetic = cosmeticById(this.configs, cosmeticId);
    if (!cosmetic) return base;
    if (cosmetic.kind === "paint" && cosmeticId.endsWith("-standard")) return base;
    if (!changesAnySurface(ship, cosmetic)) return base;
    const key = `${base.uniqueId}|${cosmetic.id}`;
    const cached = this.variants.get(key);
    if (cached && !cached.master.isDisposed()) return cached.master;

    const clone = base.clone(`${base.name}.paint.${cosmetic.id}`, null, true);
    if (!clone) return base;
    clone.setParent(null);
    clone.position.setAll(0);
    clone.isPickable = false;
    clone.setEnabled(false);

    const variant: PaintVariant = {
      master: clone,
      materials: [],
      textures: [],
      lodMeshes: [],
      maps: {},
      skinTextures: new Map(),
      disposed: false,
    };
    clone.material = this.paintedMaterial(base.material, ship, cosmetic, variant);
    for (const child of clone.getChildMeshes(false)) {
      child.material = this.paintedMaterial(child.material, ship, cosmetic, variant);
    }
    // Signal-driven emissive light (render.emissiveGlow): the material clones
    // above copied the wired emissive values but not the plugin, and Mesh.clone
    // never copies instanced-buffer storage.
    mirrorThrustGlow(clone, base);

    // Mesh.clone intentionally drops Babylon LOD levels. Rebuild the authored
    // ladder with painted clones so a cosmetic does not silently force LOD0.
    for (const level of base.getLODLevels()) {
      if (!level.mesh) continue;
      const lod = level.mesh.clone(`${level.mesh.name}.paint.${cosmetic.id}`, null, true);
      if (!lod) continue;
      lod.setParent(null);
      lod.material = this.paintedMaterial(level.mesh.material, ship, cosmetic, variant);
      for (const child of lod.getChildMeshes(false)) {
        const source = level.mesh.getChildMeshes(false).find((candidate) => candidate.name === child.name);
        child.material = this.paintedMaterial(source?.material ?? child.material, ship, cosmetic, variant);
      }
      lod.setEnabled(true);
      lod.isVisible = false;
      mirrorThrustGlow(lod, level.mesh);
      clone.addLODLevel(level.distanceOrScreenCoverage, lod);
      variant.lodMeshes.push(lod);
    }

    this.variants.set(key, variant);
    return clone;
  }

  /**
   * Clone + restyle a material tree, recording every clone for disposal. A slot
   * the hull wires to no element keeps the ORIGINAL material object — an
   * unwired canopy is bit-identical to the unpainted hull's, not a copy of it.
   *
   * Kind-agnostic on purpose: {@link changeForMaterial} resolves "what does this
   * cosmetic do to a material called X" once, and everything about cloning,
   * MultiMaterial sub-slots and disposal is shared by paints and texture packs.
   */
  private paintedMaterial(
    source: Material | null,
    ship: Pick<ShipConfig, "skin"> | undefined,
    cosmetic: CosmeticConfig,
    variant: PaintVariant,
  ): Material | null {
    if (!source) return null;
    const changeOf = (name: string): ((material: Material) => void) | null =>
      this.changeForMaterial(ship, cosmetic, name, variant);

    // A MultiMaterial's clone still points at the ORIGINAL sub-materials; each
    // restyled one has to be cloned in turn or the livery would leak onto every
    // unpainted hull.
    if (source instanceof MultiMaterial) {
      const changes = source.subMaterials.map((sub) => (sub ? changeOf(sub.name) : null));
      if (changes.every((change) => change === null)) return source;
      const clone = source.clone(`${source.name}.${cosmetic.id}`);
      if (!clone) return source;
      variant.materials.push(clone);
      (clone as MultiMaterial).subMaterials = source.subMaterials.map((sub, index) => {
        const change = changes[index];
        if (!sub || !change) return sub;
        const subClone = sub.clone(`${sub.name}.${cosmetic.id}`) ?? sub;
        if (subClone !== sub) variant.materials.push(subClone);
        change(subClone);
        return subClone;
      });
      return clone;
    }

    const change = changeOf(source.name);
    if (!change) return source;
    const clone = source.clone(`${source.name}.${cosmetic.id}`);
    if (!clone) return source;
    variant.materials.push(clone);
    change(clone);
    return clone;
  }

  /**
   * What this cosmetic does to a material called `materialName` on this hull,
   * or `null` for "leave it exactly as the artist shipped it" — which is both
   * the answer for an unwired material and the answer for an element the
   * cosmetic says nothing about.
   *
   * Returning a CLOSURE rather than applying in place is what lets the caller
   * decide whether a clone is needed before it makes one: a MultiMaterial whose
   * every slot answers `null` is handed back untouched.
   */
  private changeForMaterial(
    ship: Pick<ShipConfig, "skin"> | undefined,
    cosmetic: CosmeticConfig,
    materialName: string,
    variant: PaintVariant,
  ): ((material: Material) => void) | null {
    const element = elementOfMaterial(ship?.skin, materialName);
    if (!element) return null;

    if (cosmetic.kind === "skin") {
      const albedo = cosmetic.textures?.[element];
      // The emissive LIGHT map lands on the emissive element's materials only —
      // those ARE the lit plates, by the hull's own declaration. It comes from
      // the skin when the skin relights the ship, and from the hull otherwise.
      const emissive = element === "emissive" ? skinEmissiveFor(ship?.skin, cosmetic) : undefined;
      if (albedo === undefined && emissive === undefined) return null;
      return (material) => {
        const slot = material as unknown as TextureSlot;
        if (albedo !== undefined) this.skinTexture(albedo, variant).want(slot, "albedo");
        if (emissive !== undefined) this.skinTexture(emissive, variant).want(slot, "emissive");
      };
    }

    const style = cosmetic.elements?.[element];
    if (!style || styleIsEmpty(style)) return null;
    return (material) => applyElementStyle(material, style, this.mapsFor(ship, cosmetic, materialName, variant));
  }

  /** The shared loader for one authored image inside this variant, made on first want. */
  private skinTexture(path: string, variant: PaintVariant): SharedSkinTexture {
    const cached = variant.skinTextures.get(path);
    if (cached) return cached;
    const shared = new SharedSkinTexture(this.scene, path, () => !variant.disposed);
    variant.skinTextures.set(path, shared);
    variant.textures.push(shared.texture);
    return shared;
  }

  /**
   * The albedo/normal/roughness maps for the element this material belongs to,
   * built once per element and shared by every material wired to it — a body
   * made of four plates composites its tiger stripes once, not four times.
   */
  private mapsFor(
    ship: Pick<ShipConfig, "skin"> | undefined,
    cosmetic: CosmeticConfig,
    materialName: string,
    variant: PaintVariant,
  ): ElementMaps {
    const element = elementOfMaterial(ship?.skin, materialName);
    if (!element) return {};
    const cached = variant.maps[element];
    if (cached) return cached;
    const built = this.buildMaps(cosmetic, element, variant);
    variant.maps[element] = built;
    return built;
  }

  private buildMaps(cosmetic: CosmeticConfig, element: SurfaceElement, variant: PaintVariant): ElementMaps {
    const style = cosmetic.elements?.[element];
    if (!style) return {};
    const library = style.texture ? this.configs.get<TextureConfig>("texture", style.texture) : undefined;
    if (!library && !style.pattern) return {};

    const base = safeColor(style.color);
    const maps: ElementMaps = {};
    const albedo = albedoTexture(this.scene, `skin.${cosmetic.id}.${element}`, {
      imageUrl: library ? contentUrl(library.source) : undefined,
      pattern: style.pattern,
      base: style.color ?? NEUTRAL_BASE,
      mark: style.patternColor ?? defaultMark(base),
      scale: style.patternScale ?? library?.scale ?? DEFAULT_PATTERN_SCALE,
    });
    if (albedo) {
      maps.albedo = albedo;
      variant.textures.push(albedo);
    }
    // Companion maps ride straight through — nothing composites into them, so
    // they are plain Textures at the library's own tiling.
    const tiling = style.patternScale ?? library?.scale ?? 1;
    for (const [key, path] of [
      ["normal", library?.normal],
      ["metallicRoughness", library?.metallicRoughness],
    ] as const) {
      if (!path) continue;
      const map = new Texture(contentUrl(path), this.scene);
      map.uScale = tiling;
      map.vScale = tiling;
      maps[key] = map;
      variant.textures.push(map);
    }
    return maps;
  }

  /** Frees every painted clone. Base masters and their materials are untouched. */
  dispose(): void {
    for (const variant of this.variants.values()) this.freeVariant(variant);
    this.variants.clear();
  }

  /**
   * Drop the cached master(s) for one cosmetic so the next {@link masterFor}
   * rebuilds them. The F10 Skins tool edits a skin in place; without this the
   * preview would show the look the skin had when it was first staged.
   */
  invalidate(cosmeticId?: string): void {
    for (const [key, variant] of [...this.variants]) {
      if (cosmeticId !== undefined && !key.endsWith(`|${cosmeticId}`)) continue;
      this.freeVariant(variant);
      this.variants.delete(key);
    }
  }

  private freeVariant(variant: PaintVariant): void {
    // Set FIRST: an authored image still in flight resolves onto materials that
    // are about to stop existing, and the flag is what it checks.
    variant.disposed = true;
    for (const material of variant.materials) material.dispose();
    for (const texture of variant.textures) texture.dispose();
    for (const lod of variant.lodMeshes) if (!lod.isDisposed()) lod.dispose(false, false);
    if (!variant.master.isDisposed()) variant.master.dispose(false, false);
  }

  /** Live painted-master count — the dispose/leak assertion in tests. */
  get size(): number {
    return this.variants.size;
  }

  /** The scene these clones belong to; kept so a bank cannot be reused across scenes. */
  get owningScene(): Scene {
    return this.scene;
  }
}

/**
 * The cosmetic a replicated ship is wearing. An absent or blank id is the
 * authored look — a snapshot from an older pack must render, not throw.
 */
export function cosmeticIdOf(ship: Pick<ShipSnapshot, "cosmeticId">): string | null {
  const id = ship.cosmeticId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/**
 * The effect a wired propulsion socket should emit, or `null` to keep the one
 * the ship authored. Propulsion is the one element that is not a surface: it
 * swaps the whole particle system, and it can name any effect in the project.
 */
export function propulsionEffectFor(
  ship: Pick<ShipConfig, "skin"> | undefined,
  cosmetic: Pick<CosmeticConfig, "elements"> | undefined,
  socketId: string,
): string | null {
  const effect = cosmetic?.elements?.propulsion?.effect;
  if (!effect) return null;
  return isPropulsionSocket(ship?.skin, socketId) ? effect : null;
}

export { DEFAULT_GLOW };
