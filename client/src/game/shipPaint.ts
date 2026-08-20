import { Color3, Mesh, MultiMaterial, type BaseTexture, type Material, type Scene } from "@babylonjs/core";
import type { ConfigService, CosmeticConfig, ShipSnapshot } from "@space-arena/shared";
import { paintTargetFor } from "@space-arena/shared";
import { mirrorThrustGlow } from "../core/thrustGlow.js";
import { cosmeticById, type CosmeticPaint } from "./cosmetics.js";
import { DEFAULT_PATTERN_SCALE, paintPatternTexture } from "./paintPattern.js";

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
 * WHICH materials a paint reaches is authored, not guessed: `cosmetic.materials`
 * names GLB material slots and the channel each one wears, and a slot the list
 * does not name is left completely alone. That is what makes a skin read as a
 * real finish — the Interceptor's white shell plates take the colour while its
 * canopy glass, dark tech recesses and engine bloom stay exactly as the artist
 * shipped them. Roughness, metallic and clearcoat are never touched either, so
 * a painted plate reflects the arena like the plate underneath it did.
 *
 * A paint with NO `materials` list falls back to reading roles off the
 * material's own name — the pre-targeting behaviour, and still the right answer
 * for the single-material procedural recipes:
 *  - `hull`  — the base albedo/diffuse tint,
 *  - `trim`  — secondary material slots take the accent,
 *  - `glow`  — engine/emissive slots take `emissive`, falling back to `accent`.
 *
 * Nothing here mutates a master or its materials: an absent/unknown cosmetic id
 * hands the base master straight back, an untargeted slot keeps the ORIGINAL
 * material object rather than a clone of it, and disposal only ever frees
 * clones this bank made.
 */

/** `none` = this material is not part of the paint and must not be touched. */
export type PaintSlot = "hull" | "trim" | "glow" | "none";

/** Glow strength used when a material carries no authored emissive of its own. */
const DEFAULT_GLOW = 0.15;

const GLOW_NAME = /engine|thrust|exhaust|glow|emissive|light/i;
const TRIM_NAME = /trim|accent|detail|stripe|decal|secondary|panel/i;

/** Channel → slot. The channels are the paint's authored names; slots are render roles. */
const CHANNEL_SLOT = { primary: "hull", accent: "trim", emissive: "glow" } as const;

/**
 * Which channel of a paint a material slot wears when the paint names no
 * materials of its own. Sub-material INDEX is the fallback signal: a merged
 * hull's first slot is its body, anything after it is detail geometry.
 */
export function paintSlotOf(name: string, index: number): PaintSlot {
  if (GLOW_NAME.test(name)) return "glow";
  if (TRIM_NAME.test(name)) return "trim";
  return index > 0 ? "trim" : "hull";
}

/** What one material slot gets: which channel, and whether the pattern is drawn into it. */
export interface SlotPlan {
  slot: PaintSlot;
  patterned: boolean;
}

/**
 * The plan for one material of a painted hull.
 *
 * An authored `materials` list is EXHAUSTIVE — a slot it does not name resolves
 * to `none` and is skipped entirely, which is the whole point of authoring one.
 * Absent list ⇒ the name heuristics above.
 */
export function slotPlanFor(
  cosmetic: Pick<CosmeticConfig, "materials">,
  name: string,
  index: number,
): SlotPlan {
  if (!cosmetic.materials) return { slot: paintSlotOf(name, index), patterned: false };
  const target = paintTargetFor(cosmetic, name);
  if (!target) return { slot: "none", patterned: false };
  return { slot: CHANNEL_SLOT[target.channel], patterned: target.patterned === true };
}

/** The material properties a tint touches — duck-typed so tests can mock them. */
interface TintTarget {
  name?: string;
  diffuseColor?: Color3;
  albedoColor?: Color3;
  emissiveColor?: Color3;
  diffuseTexture?: BaseTexture | null;
  albedoTexture?: BaseTexture | null;
}

export interface TintOptions {
  /**
   * Let the hull slot recolour the emissive channel too. TRUE only on the
   * heuristic path, where a single-material recipe bakes its engine nubs into
   * the same emissive channel as the body and dropping the accent there is what
   * makes a one-slot hull read as painted at all. An AUTHORED target must never
   * do it: naming a material means "this plate, this colour, nothing else".
   */
  bleedGlow?: boolean;
  /** Pattern albedo to hang on the slot. The drawn colours replace the flat tint. */
  texture?: BaseTexture | null;
}

/**
 * Tint one material slot in place. Only ever called on a CLONE, and never on a
 * `none` slot.
 */
export function tintMaterial(
  material: Material | TintTarget,
  slot: PaintSlot,
  paint: CosmeticPaint,
  options: TintOptions = {},
): void {
  if (slot === "none") return;
  const target = material as TintTarget;
  const glow = paint.emissive ?? paint.accent;
  if (slot === "glow") {
    tintEmissive(target, glow);
    return;
  }
  // A pattern texture already carries both of its colours, so the tint under it
  // must be neutral white or the drawn stripes come out multiplied and muddy.
  if (options.texture) {
    if ("albedoTexture" in target) target.albedoTexture = options.texture;
    if ("diffuseTexture" in target) target.diffuseTexture = options.texture;
    if (target.albedoColor) target.albedoColor = new Color3(1, 1, 1);
    if (target.diffuseColor) target.diffuseColor = new Color3(1, 1, 1);
    if (slot === "hull" && options.bleedGlow !== false) tintEmissive(target, glow);
    return;
  }
  const base = slot === "hull" ? paint.primary : paint.accent;
  const color = safeColor(base);
  if (!color) return;
  if (target.albedoColor) target.albedoColor = color;
  if (target.diffuseColor) target.diffuseColor = color;
  if (slot === "hull" && options.bleedGlow !== false) tintEmissive(target, glow);
}

/**
 * Recolour an emissive channel while KEEPING its authored strength — a hull
 * that barely glows must not blaze because a paint named a bright hue.
 */
function tintEmissive(target: TintTarget, hex: string): void {
  const current = target.emissiveColor;
  if (!current) return;
  const color = safeColor(hex);
  if (!color) return;
  const strength = Math.max(current.r, current.g, current.b);
  target.emissiveColor = color.scale(strength > 0 ? strength : DEFAULT_GLOW);
}

function safeColor(hex: string): Color3 | null {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return null;
  return Color3.FromHexString(hex);
}

interface PaintVariant {
  master: Mesh;
  materials: Material[];
  textures: BaseTexture[];
  lodMeshes: Mesh[];
}

/** The two colours a pattern is drawn from, for a slot wearing `slot`'s channel. */
function patternColorsFor(paint: CosmeticPaint, slot: PaintSlot): { base: string; mark: string } {
  const base = slot === "trim" ? paint.accent : paint.primary;
  return { base, mark: paint.patternColor ?? paint.accent };
}

/**
 * Painted masters, cached per (base master, cosmetic) and owned by whoever
 * constructed the bank. Shared by the match view, the Hangar preview and the
 * F10 Skins tool so none of the three can disagree about what a paint looks like.
 */
export class ShipPaintBank {
  private readonly variants = new Map<string, PaintVariant>();

  constructor(
    private readonly scene: Scene,
    private readonly configs: Pick<ConfigService, "getAll">,
  ) {}

  /**
   * The master to instance this hull from. Returns `base` untouched for an
   * absent, unknown or paintless cosmetic id — standard IS the base look.
   */
  masterFor(base: Mesh, cosmeticId: string | null): Mesh {
    if (!cosmeticId || cosmeticId.endsWith("-standard")) return base;
    const cosmetic = cosmeticById(this.configs, cosmeticId);
    if (!cosmetic?.paint) return base;
    const key = `${base.uniqueId}|${cosmetic.id}`;
    const cached = this.variants.get(key);
    if (cached && !cached.master.isDisposed()) return cached.master;

    const clone = base.clone(`${base.name}.paint.${cosmetic.id}`, null, true);
    if (!clone) return base;
    clone.setParent(null);
    clone.position.setAll(0);
    clone.isPickable = false;
    clone.setEnabled(false);

    const variant: PaintVariant = { master: clone, materials: [], textures: [], lodMeshes: [] };
    clone.material = this.paintedMaterial(base.material, cosmetic, variant);
    for (const child of clone.getChildMeshes(false)) {
      child.material = this.paintedMaterial(child.material, cosmetic, variant);
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
      lod.material = this.paintedMaterial(level.mesh.material, cosmetic, variant);
      for (const child of lod.getChildMeshes(false)) {
        const source = level.mesh.getChildMeshes(false).find((candidate) => candidate.name === child.name);
        child.material = this.paintedMaterial(source?.material ?? child.material, cosmetic, variant);
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
   * Clone + tint a material tree, recording every clone for disposal. A slot the
   * paint does not target keeps the ORIGINAL material object — an untargeted
   * canopy is bit-identical to the unpainted hull's, not a copy of it.
   */
  private paintedMaterial(
    source: Material | null,
    cosmetic: CosmeticConfig,
    variant: PaintVariant,
  ): Material | null {
    if (!source) return null;
    const paint = cosmetic.paint;
    // A MultiMaterial's clone still points at the ORIGINAL sub-materials; each
    // targeted one has to be cloned in turn or the tint would leak onto every
    // unpainted hull.
    if (source instanceof MultiMaterial) {
      const plans = source.subMaterials.map((sub, index) =>
        sub ? slotPlanFor(cosmetic, sub.name, index) : { slot: "none" as PaintSlot, patterned: false },
      );
      if (plans.every((plan) => plan.slot === "none")) return source;
      const clone = source.clone(`${source.name}.${cosmetic.id}`);
      if (!clone) return source;
      variant.materials.push(clone);
      (clone as MultiMaterial).subMaterials = source.subMaterials.map((sub, index) => {
        const plan = plans[index]!;
        if (!sub || plan.slot === "none") return sub;
        const subClone = sub.clone(`${sub.name}.${cosmetic.id}`) ?? sub;
        if (subClone !== sub) variant.materials.push(subClone);
        tintMaterial(subClone, plan.slot, paint, this.tintOptions(cosmetic, plan, variant));
        return subClone;
      });
      return clone;
    }

    const plan = slotPlanFor(cosmetic, source.name, 0);
    if (plan.slot === "none") return source;
    const clone = source.clone(`${source.name}.${cosmetic.id}`);
    if (!clone) return source;
    variant.materials.push(clone);
    tintMaterial(clone, plan.slot, paint, this.tintOptions(cosmetic, plan, variant));
    return clone;
  }

  /**
   * Pattern texture (when the target asked for one) plus the glow-bleed rule.
   * Textures are cached per (pattern, colours, scale) inside the variant so a
   * six-slot zebra hull draws its stripes once, not six times.
   */
  private tintOptions(cosmetic: CosmeticConfig, plan: SlotPlan, variant: PaintVariant): TintOptions {
    const bleedGlow = cosmetic.materials === undefined;
    const pattern = cosmetic.paint.pattern;
    if (!plan.patterned || !pattern || plan.slot === "glow") return { bleedGlow };
    const { base, mark } = patternColorsFor(cosmetic.paint, plan.slot);
    const scale = cosmetic.paint.patternScale ?? DEFAULT_PATTERN_SCALE;
    const name = `paint.${cosmetic.id}.${pattern}.${plan.slot}`;
    const cached = variant.textures.find((texture) => texture.name === name);
    if (cached) return { bleedGlow, texture: cached };
    const texture = paintPatternTexture(this.scene, name, pattern, base, mark, scale);
    if (!texture) return { bleedGlow };
    variant.textures.push(texture);
    return { bleedGlow, texture };
  }

  /** Frees every painted clone. Base masters and their materials are untouched. */
  dispose(): void {
    for (const variant of this.variants.values()) {
      for (const material of variant.materials) material.dispose();
      for (const texture of variant.textures) texture.dispose();
      for (const lod of variant.lodMeshes) if (!lod.isDisposed()) lod.dispose(false, false);
      if (!variant.master.isDisposed()) variant.master.dispose(false, false);
    }
    this.variants.clear();
  }

  /**
   * Drop the cached master(s) for one cosmetic so the next {@link masterFor}
   * rebuilds them. The F10 Skins tool edits a paint in place; without this the
   * preview would show the colours the paint had when it was first staged.
   */
  invalidate(cosmeticId: string): void {
    for (const [key, variant] of [...this.variants]) {
      if (!key.endsWith(`|${cosmeticId}`)) continue;
      for (const material of variant.materials) material.dispose();
      for (const texture of variant.textures) texture.dispose();
      for (const lod of variant.lodMeshes) if (!lod.isDisposed()) lod.dispose(false, false);
      if (!variant.master.isDisposed()) variant.master.dispose(false, false);
      this.variants.delete(key);
    }
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
