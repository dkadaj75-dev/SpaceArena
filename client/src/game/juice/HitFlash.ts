import { Color3, Mesh, MeshBuilder, StandardMaterial, type Scene, type TransformNode } from "@babylonjs/core";
import type { HitFlashSettings } from "./juiceSettings.js";

interface FlashSlot {
  mesh: Mesh;
  material: StandardMaterial;
  /** ms remaining; <= 0 means the slot is free. */
  life: number;
}

/**
 * ROADMAP §10 5.7 — the hit flash: a short emissive shell popped around a ship
 * view the instant it takes damage.
 *
 * Why a shell and not a material tint: ships render as `InstancedMesh`es
 * sharing one master material (and GLB hulls share a PBR material), so tinting
 * the material would flash *every* ship of that type at once. A pooled additive
 * shell is per-hit, works for procedural and GLB hulls alike, and costs nothing
 * while idle.
 *
 * Pool discipline matches the projectile/beam pools: `maxConcurrent` meshes are
 * built once and shown/hidden — a flash arriving with every slot busy is
 * dropped, never allocated. Slots are positioned in world space rather than
 * parented to the ship, so a ship dying mid-flash can't take a pooled mesh with
 * it (Babylon's `dispose()` recurses into children).
 */
export class HitFlashPool {
  private readonly slots: FlashSlot[] = [];
  private settings: HitFlashSettings;

  constructor(
    scene: Scene,
    parent: TransformNode,
    settings: HitFlashSettings,
  ) {
    this.settings = settings;
    const count = settings.enabled ? Math.max(1, Math.floor(settings.maxConcurrent)) : 0;
    for (let i = 0; i < count; i++) {
      const material = new StandardMaterial(`mat.hitflash.${i}`, scene);
      material.diffuseColor = Color3.Black();
      material.specularColor = Color3.Black();
      material.emissiveColor = colorFromHex(settings.color);
      material.disableLighting = true;
      material.backFaceCulling = false;
      material.alpha = 0;

      const mesh = MeshBuilder.CreateSphere(`hitflash.${i}`, { diameter: 2, segments: 8 }, scene);
      mesh.material = material;
      mesh.isPickable = false;
      mesh.setEnabled(false);
      mesh.parent = parent;
      this.slots.push({ mesh, material, life: 0 });
    }
  }

  /** Re-apply theme colors/intensity (hot-reload). Pool size is fixed at construction. */
  setSettings(settings: HitFlashSettings): void {
    this.settings = settings;
    const color = colorFromHex(settings.color);
    for (const slot of this.slots) slot.material.emissiveColor = color;
  }

  /**
   * Pop a flash of world radius `radius` (the ship's collider radius) at
   * (`x`, `y`, `z`). No-op when disabled or the pool is saturated.
   */
  flash(x: number, y: number, z: number, radius: number): void {
    if (!this.settings.enabled || this.settings.durationMs <= 0) return;
    const slot = this.freeSlot();
    if (!slot) return;
    const scale = Math.max(0.01, radius * this.settings.scale);
    slot.mesh.position.set(x, y, z);
    slot.mesh.scaling.setAll(scale);
    slot.material.alpha = this.settings.intensity;
    slot.mesh.setEnabled(true);
    slot.life = this.settings.durationMs;
  }

  /** Fade live flashes. Call once per render frame with the frame delta. */
  update(dtMs: number): void {
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i]!;
      if (slot.life <= 0) continue;
      slot.life -= dtMs;
      if (slot.life <= 0) {
        slot.material.alpha = 0;
        slot.mesh.setEnabled(false);
        continue;
      }
      slot.material.alpha = this.settings.intensity * (slot.life / this.settings.durationMs);
    }
  }

  /** Live flash count — dev probe / tests. */
  get activeCount(): number {
    let n = 0;
    for (const slot of this.slots) if (slot.life > 0) n++;
    return n;
  }

  dispose(): void {
    for (const slot of this.slots) {
      slot.material.dispose();
      slot.mesh.dispose();
    }
    this.slots.length = 0;
  }

  private freeSlot(): FlashSlot | undefined {
    for (let i = 0; i < this.slots.length; i++) if (this.slots[i]!.life <= 0) return this.slots[i];
    return undefined;
  }
}

function colorFromHex(hex: string): Color3 {
  try {
    return Color3.FromHexString(hex);
  } catch {
    return new Color3(1, 1, 1);
  }
}
