import { Color3, Mesh, MultiMaterial, Texture, type BaseTexture, type Material, type Scene } from "@babylonjs/core";
import {
  elementOfMaterial,
  isPropulsionSocket,
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

/**
 * Cosmetic paint on a hull (contract §5).
 *
 * Ships render as INSTANCES of a shared, disabled master mesh, and an instance
 * cannot own a material — so a paint cannot be a per-ship material tweak
 * without blacking out every hull in the match (the same trap the Hangar's
 * locked silhouette documents). A paint therefore produces its own painted
 * MASTER, cloned once per (hull, cosmetic) pair and instanced from like any
 * other: ten ships wearing one paint still cost one extra draw batch, not ten.
 *
 * WHICH plates a skin reaches is decided by the SHIP, not the skin. `ship.skin`
 * wires each element (body / canopy / wings / emissive) to that model's own
 * material names; the skin then says what body, canopy and wings LOOK like. A
 * material the hull wires to no element is never touched — roughness, metallic,
 * clearcoat and all — which is what lets a livery cover the Interceptor's shell
 * plates while its canopy glass, dark tech recesses and engine bloom stay
 * exactly as the artist shipped them.
 *
 * Nothing here mutates a master or its materials: an absent/unknown cosmetic id
 * hands the base master straight back, an unwired slot keeps the ORIGINAL
 * material object rather than a clone of it, and disposal only ever frees
 * clones this bank made.
 */

/** Glow strength used when a material carries no authored emissive of its own. */
const DEFAULT_GLOW = 0.15;

/** Neutral plate under a texture that authors no colour of its own. */
const NEUTRAL_BASE = "#ffffff";

/** The material properties a style touches — duck-typed so tests can mock them. */
interface StyleTarget {
  name?: string;
  diffuseColor?: Color3;
  albedoColor?: Color3;
  emissiveColor?: Color3;
  specularColor?: Color3;
  diffuseTexture?: BaseTexture | null;
  albedoTexture?: BaseTexture | null;
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

/** Content-relative asset path → the URL the dev server and the build both serve. */
function contentUrl(path: string): string {
  return `${import.meta.env.BASE_URL}content/${path}`;
}

/**
 * A readable second colour when a pattern authors none: black on a light plate,
 * white on a dark one. A stripe the same colour as the plate is not a pattern.
 */
function defaultMark(base: Color3 | null): string {
  if (!base) return "#16171b";
  return base.r + base.g + base.b > 1.5 ? "#16171b" : "#f2f2f0";
}

interface PaintVariant {
  master: Mesh;
  materials: Material[];
  textures: BaseTexture[];
  lodMeshes: Mesh[];
  /** One built map-set per element, so a four-material body composites once. */
  maps: Partial<Record<SurfaceElement, ElementMaps>>;
}

/**
 * Whether this (hull, skin) pair changes any SURFACE at all — both sides have
 * to agree: the hull wires the element to at least one material AND the skin
 * fills that element in. Neither alone paints anything.
 *
 * Checked before the clone, not after: a hull that wires nothing must hand back
 * the base master, or every skin in the shop would silently cost an extra draw
 * batch and a material tree to render pixels identical to the unpainted hull.
 * Propulsion is excluded — it swaps particles, never a material.
 */
function paintsAnything(ship: Pick<ShipConfig, "skin"> | undefined, cosmetic: CosmeticConfig): boolean {
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
   * absent, unknown or styleless cosmetic id — standard IS the base look — and
   * for a hull that wires no elements at all.
   */
  masterFor(base: Mesh, ship: Pick<ShipConfig, "skin"> | undefined, cosmeticId: string | null): Mesh {
    if (!cosmeticId || cosmeticId.endsWith("-standard")) return base;
    const cosmetic = cosmeticById(this.configs, cosmeticId);
    if (!cosmetic || !paintsAnything(ship, cosmetic)) return base;
    const key = `${base.uniqueId}|${cosmetic.id}`;
    const cached = this.variants.get(key);
    if (cached && !cached.master.isDisposed()) return cached.master;

    const clone = base.clone(`${base.name}.paint.${cosmetic.id}`, null, true);
    if (!clone) return base;
    clone.setParent(null);
    clone.position.setAll(0);
    clone.isPickable = false;
    clone.setEnabled(false);

    const variant: PaintVariant = { master: clone, materials: [], textures: [], lodMeshes: [], maps: {} };
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
   * Clone + paint a material tree, recording every clone for disposal. A slot
   * the hull wires to no element keeps the ORIGINAL material object — an
   * unwired canopy is bit-identical to the unpainted hull's, not a copy of it.
   */
  private paintedMaterial(
    source: Material | null,
    ship: Pick<ShipConfig, "skin"> | undefined,
    cosmetic: CosmeticConfig,
    variant: PaintVariant,
  ): Material | null {
    if (!source) return null;
    const styleOf = (name: string): SkinElementStyle | null => {
      const element = elementOfMaterial(ship?.skin, name);
      if (!element) return null;
      const style = cosmetic.elements?.[element];
      return style && !styleIsEmpty(style) ? style : null;
    };

    // A MultiMaterial's clone still points at the ORIGINAL sub-materials; each
    // painted one has to be cloned in turn or the style would leak onto every
    // unpainted hull.
    if (source instanceof MultiMaterial) {
      const styles = source.subMaterials.map((sub) => (sub ? styleOf(sub.name) : null));
      if (styles.every((style) => style === null)) return source;
      const clone = source.clone(`${source.name}.${cosmetic.id}`);
      if (!clone) return source;
      variant.materials.push(clone);
      (clone as MultiMaterial).subMaterials = source.subMaterials.map((sub, index) => {
        const style = styles[index];
        if (!sub || !style) return sub;
        const subClone = sub.clone(`${sub.name}.${cosmetic.id}`) ?? sub;
        if (subClone !== sub) variant.materials.push(subClone);
        applyElementStyle(subClone, style, this.mapsFor(ship, cosmetic, sub.name, variant));
        return subClone;
      });
      return clone;
    }

    const style = styleOf(source.name);
    if (!style) return source;
    const clone = source.clone(`${source.name}.${cosmetic.id}`);
    if (!clone) return source;
    variant.materials.push(clone);
    applyElementStyle(clone, style, this.mapsFor(ship, cosmetic, source.name, variant));
    return clone;
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
