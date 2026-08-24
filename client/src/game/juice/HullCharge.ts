import {
  Color3,
  Constants,
  FresnelParameters,
  StandardMaterial,
  type AbstractMesh,
  type Mesh,
  type Scene,
} from "@babylonjs/core";
import { hullChargeLevel, type EnergyChargeSettings } from "./juiceSettings.js";

/**
 * ENERGY-weapon impact feedback (owner 2026-08-23) — the struck ship's own hull
 * flickers with charge for a couple of hundred milliseconds. This replaces the
 * red bubble that used to pop around ANY damaged ship: a bubble said "something
 * hurt this", which the floating damage number already said better, and said
 * nothing about what hit it.
 *
 * WHY A CLONED SHELL RATHER THAN A MATERIAL TINT. Ships render as
 * `InstancedMesh`es sharing one master material (contract §5), so tinting the
 * material would electrify every ship of that hull at once — the same trap the
 * old flash pool was written to avoid. The per-instance route (a material
 * plugin with an instanced attribute, as `core/thrustGlow.ts` does for engine
 * glow) is the scalable answer, but it only reaches PBR GLB hulls and costs a
 * shader variant. So instead each ship that is ever hit by energy gets ONE
 * lazily-cloned copy of its own hull — sharing the master's geometry, wearing
 * an additive emissive material of its own — enabled for the length of the
 * flicker and hidden the rest of the match. Ten ships is ten clones worst case,
 * each drawn only while it is actually arcing.
 *
 * The flicker's SHAPE is {@link hullChargeLevel} and lives with the other feel
 * numbers; this class only moves Babylon state.
 */
export class HullChargeShell {
  private mesh: Mesh | null = null;
  private material: StandardMaterial | null = null;
  private settings: EnergyChargeSettings;
  /** Render time since the last energy hit; `Infinity` = never hit. */
  private ageMs = Number.POSITIVE_INFINITY;
  private readonly tint = new Color3();

  constructor(
    private readonly scene: Scene,
    /** The ship's hull master — the shell is a clone of exactly this. */
    private readonly master: Mesh,
    /** The live ship instance the shell rides on. */
    private readonly parent: AbstractMesh,
    settings: EnergyChargeSettings,
    private readonly name = "hull",
  ) {
    this.settings = settings;
  }

  /** Re-apply theme knobs (hot-reload). */
  setSettings(settings: EnergyChargeSettings): void {
    this.settings = settings;
    if (!settings.enabled) {
      this.ageMs = Number.POSITIVE_INFINITY;
      this.mesh?.setEnabled(false);
      return;
    }
    if (this.material) {
      writeHexColor(settings.color, this.tint);
      this.mesh?.scaling.setAll(settings.scale);
    }
  }

  /**
   * An energy weapon landed on this hull — restart the flicker. Repeated hits
   * restart rather than stack: a ship under sustained laser fire should read as
   * continuously charged, not as progressively brighter until it is a white
   * blob.
   */
  hit(): void {
    if (!this.settings.enabled) return;
    this.ageMs = 0;
    this.ensureMesh().setEnabled(true);
  }

  /** Age the flicker one frame. No-op (and no Babylon writes) while dark. */
  update(dtMs: number): void {
    if (!Number.isFinite(this.ageMs)) return;
    this.ageMs += Math.max(0, Number.isFinite(dtMs) ? dtMs : 0);
    const level = hullChargeLevel(this.ageMs, this.settings);
    if (level <= 0) {
      this.ageMs = Number.POSITIVE_INFINITY;
      this.mesh?.setEnabled(false);
      return;
    }
    if (this.material) this.material.alpha = level;
  }

  /** Whether the hull is arcing this frame (dev probe / tests). */
  get isCharged(): boolean {
    return Number.isFinite(this.ageMs);
  }

  dispose(): void {
    this.material?.dispose();
    // `dispose(false, false)`: the geometry is the hull master's, shared with
    // every other ship of this type, and must outlive this one shell.
    this.mesh?.dispose(false, false);
    this.material = null;
    this.mesh = null;
  }

  private ensureMesh(): Mesh {
    if (this.mesh) return this.mesh;
    const material = new StandardMaterial(`mat.hullcharge.${this.name}`, this.scene);
    writeHexColor(this.settings.color, this.tint);
    material.diffuseColor = Color3.Black();
    material.specularColor = Color3.Black();
    material.emissiveColor = this.tint;
    material.disableLighting = true;
    material.alpha = 0;
    // Additive, and no depth WRITE: the shell sits a few percent proud of the
    // hull, so it must brighten what is behind it rather than replace it, and
    // must never occlude the hardpoint meshes or the shield panels around it.
    material.alphaMode = Constants.ALPHA_ADD;
    material.disableDepthWrite = true;
    // Rim-weighted emissive: the charge crawls around the silhouette and only
    // washes the faces lightly, which is what reads as arcing over plating
    // rather than as the ship being repainted.
    const fresnel = new FresnelParameters();
    fresnel.isEnabled = true;
    fresnel.leftColor = Color3.White();
    fresnel.rightColor = new Color3(0.3, 0.3, 0.3);
    fresnel.bias = 0.2;
    fresnel.power = 2;
    material.emissiveFresnelParameters = fresnel;

    // Geometry is SHARED with the master by Babylon's clone; only the node and
    // the material are new. `doNotCloneChildren` because a hull master's
    // children (if a recipe ever leaves any unmerged) belong to the hull.
    const mesh = this.master.clone(`hullcharge.${this.name}`, null, true);
    // A clone can inherit the master's LOD ladder, whose substitute meshes wear
    // the HULL's materials — at distance the shell would quietly turn back into
    // a second opaque ship. Strip it: the shell is a two-frame effect and never
    // needs one.
    for (const level of mesh.getLODLevels().slice()) {
      if (level.mesh) mesh.removeLODLevel(level.mesh);
    }
    mesh.material = material;
    mesh.isPickable = false;
    mesh.parent = this.parent;
    mesh.position.setAll(0);
    mesh.rotationQuaternion = null;
    mesh.rotation.setAll(0);
    mesh.scaling.setAll(this.settings.scale);
    mesh.setEnabled(false);
    this.mesh = mesh;
    this.material = material;
    return mesh;
  }
}

/** Parse `#rrggbb` into an existing colour, falling back to an electric blue. */
function writeHexColor(hex: string, out: Color3): void {
  try {
    const parsed = Color3.FromHexString(hex);
    out.set(parsed.r, parsed.g, parsed.b);
  } catch {
    out.set(0.56, 0.9, 1);
  }
}
