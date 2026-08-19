import { Color3, Mesh, MultiMaterial, type Material, type Scene } from "@babylonjs/core";
import type { ConfigService, ShipSnapshot } from "@space-arena/shared";
import { mirrorThrustGlow } from "../core/thrustGlow.js";
import { cosmeticById, type CosmeticPaint } from "./cosmetics.js";

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
 * Slot roles come from the material's own name, so a GLB that authors trim and
 * engine sub-materials gets all three channels while a single-material
 * procedural recipe still reads as painted:
 *  - `hull`  — the base albedo/diffuse tint,
 *  - `trim`  — secondary material slots take the accent,
 *  - `glow`  — engine/emissive slots take `emissive`, falling back to `accent`.
 *
 * Nothing here mutates a master or its materials: an absent/unknown cosmetic id
 * hands the base master straight back, and disposal only ever frees clones.
 */

export type PaintSlot = "hull" | "trim" | "glow";

/** Glow strength used when a material carries no authored emissive of its own. */
const DEFAULT_GLOW = 0.15;

const GLOW_NAME = /engine|thrust|exhaust|glow|emissive|light/i;
const TRIM_NAME = /trim|accent|detail|stripe|decal|secondary|panel/i;

/**
 * Which channel of a paint a material slot wears. Sub-material INDEX is the
 * fallback signal: a merged hull's first slot is its body, anything after it is
 * detail geometry.
 */
export function paintSlotOf(name: string, index: number): PaintSlot {
  if (GLOW_NAME.test(name)) return "glow";
  if (TRIM_NAME.test(name)) return "trim";
  return index > 0 ? "trim" : "hull";
}

/** The material properties a tint touches — duck-typed so tests can mock them. */
interface TintTarget {
  name?: string;
  diffuseColor?: Color3;
  albedoColor?: Color3;
  emissiveColor?: Color3;
}

/**
 * Tint one material slot in place. Only ever called on a CLONE.
 *
 * The hull slot also takes the glow hue, because a single-material recipe bakes
 * its engine nubs into the same emissive channel as the body — dropping the
 * accent there is what makes a one-slot hull read as painted at all.
 */
export function tintMaterial(material: Material | TintTarget, slot: PaintSlot, paint: CosmeticPaint): void {
  const target = material as TintTarget;
  const glow = paint.emissive ?? paint.accent;
  if (slot === "glow") {
    tintEmissive(target, glow);
    return;
  }
  const base = slot === "hull" ? paint.primary : paint.accent;
  const color = safeColor(base);
  if (!color) return;
  if (target.albedoColor) target.albedoColor = color;
  if (target.diffuseColor) target.diffuseColor = color;
  if (slot === "hull") tintEmissive(target, glow);
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

/** The flat list of material slots on a mesh, MultiMaterial expanded. */
function slotsOf(material: Material | null): Material[] {
  if (!material) return [];
  if (material instanceof MultiMaterial) {
    return material.subMaterials.filter((m): m is Material => m !== null);
  }
  return [material];
}

interface PaintVariant {
  master: Mesh;
  materials: Material[];
  lodMeshes: Mesh[];
}

/**
 * Painted masters, cached per (base master, cosmetic) and owned by whoever
 * constructed the bank. Shared by the match view and the Hangar preview so the
 * two cannot disagree about what a paint looks like.
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

    const materials: Material[] = [];
    clone.material = this.paintedMaterial(base.material, cosmetic.id, cosmetic.paint, materials);
    for (const child of clone.getChildMeshes(false)) {
      child.material = this.paintedMaterial(child.material, cosmetic.id, cosmetic.paint, materials);
    }
    // Signal-driven emissive light (render.emissiveGlow): the material clones
    // above copied the wired emissive values but not the plugin, and Mesh.clone
    // never copies instanced-buffer storage.
    mirrorThrustGlow(clone, base);

    // Mesh.clone intentionally drops Babylon LOD levels. Rebuild the authored
    // ladder with painted clones so a cosmetic does not silently force LOD0.
    const lodMeshes: Mesh[] = [];
    for (const level of base.getLODLevels()) {
      if (!level.mesh) continue;
      const lod = level.mesh.clone(`${level.mesh.name}.paint.${cosmetic.id}`, null, true);
      if (!lod) continue;
      lod.setParent(null);
      lod.material = this.paintedMaterial(level.mesh.material, cosmetic.id, cosmetic.paint, materials);
      for (const child of lod.getChildMeshes(false)) {
        const source = level.mesh.getChildMeshes(false).find((candidate) => candidate.name === child.name);
        child.material = this.paintedMaterial(source?.material ?? child.material, cosmetic.id, cosmetic.paint, materials);
      }
      lod.setEnabled(true);
      lod.isVisible = false;
      mirrorThrustGlow(lod, level.mesh);
      clone.addLODLevel(level.distanceOrScreenCoverage, lod);
      lodMeshes.push(lod);
    }

    this.variants.set(key, { master: clone, materials, lodMeshes });
    return clone;
  }

  /** Clone + tint a material tree, recording every clone for disposal. */
  private paintedMaterial(
    source: Material | null,
    cosmeticId: string,
    paint: CosmeticPaint,
    owned: Material[],
  ): Material | null {
    if (!source) return null;
    const clone = source.clone(`${source.name}.${cosmeticId}`);
    if (!clone) return source;
    owned.push(clone);
    const slots = slotsOf(clone);
    // A MultiMaterial's clone still points at the ORIGINAL sub-materials; each
    // has to be cloned in turn or the tint would leak onto every unpainted hull.
    if (clone instanceof MultiMaterial) {
      clone.subMaterials = clone.subMaterials.map((sub) => {
        if (!sub) return sub;
        const subClone = sub.clone(`${sub.name}.${cosmeticId}`) ?? sub;
        if (subClone !== sub) owned.push(subClone);
        return subClone;
      });
      slots.length = 0;
      for (const sub of clone.subMaterials) if (sub) slots.push(sub);
    }
    slots.forEach((slot, index) => tintMaterial(slot, paintSlotOf(slot.name, index), paint));
    return clone;
  }

  /** Frees every painted clone. Base masters and their materials are untouched. */
  dispose(): void {
    for (const variant of this.variants.values()) {
      for (const material of variant.materials) material.dispose();
      for (const lod of variant.lodMeshes) if (!lod.isDisposed()) lod.dispose(false, false);
      if (!variant.master.isDisposed()) variant.master.dispose(false, false);
    }
    this.variants.clear();
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
