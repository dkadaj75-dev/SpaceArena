import {
  Color3,
  FresnelParameters,
  MeshBuilder,
  StandardMaterial,
  type Mesh,
  type Scene,
  type TransformNode,
} from "@babylonjs/core";
import { shieldRipplePose, type ShieldRippleSettings } from "./juiceSettings.js";

/**
 * ROADMAP §10 5.7 — the shield bubble: a translucent shell that ripples while a
 * ship's shield module holds a reservoir, and vanishes the moment it drops.
 *
 * One mesh per ship, owned by that ship's
 * {@link import("../ShipSocketRig.js").ShipSocketRig} (which already owns the
 * per-ship socket graph), built lazily on the first shield-up so ships that
 * never run a shield never pay for it. The ripple math is pure and lives in
 * {@link shieldRipplePose}; this class only moves Babylon state.
 */
export class ShieldBubble {
  private mesh: Mesh | null = null;
  private material: StandardMaterial | null = null;
  private settings: ShieldRippleSettings;
  private elapsedMs = 0;
  private active = false;

  constructor(
    private readonly scene: Scene,
    private readonly parent: TransformNode,
    /** Ship collider radius — the bubble is a multiple of this. */
    private readonly radius: number,
    settings: ShieldRippleSettings,
    private readonly name = "shield",
  ) {
    this.settings = settings;
  }

  /** Re-apply theme knobs (hot-reload). Hides the bubble if it was turned off. */
  setSettings(settings: ShieldRippleSettings): void {
    this.settings = settings;
    if (!settings.enabled && this.mesh) {
      this.active = false;
      this.mesh.setEnabled(false);
      return;
    }
    if (this.material) this.material.emissiveColor = colorFromHex(settings.color);
  }

  /**
   * Drive the bubble for one frame. `shieldUp` comes from the ship snapshot
   * (any shield module with a live absorb reservoir); the ripple clock resets
   * on each rise so every shield-up starts from the same point in the cycle.
   */
  update(shieldUp: boolean, dtMs: number): void {
    if (!this.settings.enabled) return;
    if (!shieldUp) {
      if (this.active) {
        this.active = false;
        this.elapsedMs = 0;
        this.mesh?.setEnabled(false);
      }
      return;
    }
    const mesh = this.ensureMesh();
    if (!this.active) {
      this.active = true;
      this.elapsedMs = 0;
      mesh.setEnabled(true);
    }
    this.elapsedMs += dtMs;
    const pose = shieldRipplePose(this.elapsedMs, this.settings);
    mesh.scaling.setAll(this.radius * pose.scale);
    if (this.material) this.material.alpha = pose.alpha;
  }

  /** Whether the bubble is currently shown (dev probe / tests). */
  get isVisible(): boolean {
    return this.active;
  }

  dispose(): void {
    this.material?.dispose();
    this.mesh?.dispose();
    this.material = null;
    this.mesh = null;
  }

  private ensureMesh(): Mesh {
    if (this.mesh) return this.mesh;
    const material = new StandardMaterial(`mat.shieldbubble.${this.name}`, this.scene);
    material.diffuseColor = Color3.Black();
    material.specularColor = Color3.Black();
    material.emissiveColor = colorFromHex(this.settings.color);
    material.disableLighting = true;
    material.backFaceCulling = false;
    material.alpha = this.settings.minAlpha;
    // Rim-only shell (owner presentation note 2026-07-31): a fresnel on the
    // opacity keeps the bubble's CENTRE near-transparent and draws only a soft
    // limb where the shell curves away — the flat solid ball read as an ugly
    // balloon over the hull. Theme alphas still scale the whole thing.
    const fresnel = new FresnelParameters();
    fresnel.isEnabled = true;
    fresnel.leftColor = Color3.White(); // grazing angles: full themed alpha
    fresnel.rightColor = Color3.Black(); // face-on centre: fades out
    fresnel.bias = 0.15;
    fresnel.power = 2.2;
    material.opacityFresnelParameters = fresnel;

    const mesh = MeshBuilder.CreateSphere(`shieldbubble.${this.name}`, { diameter: 2, segments: 12 }, this.scene);
    mesh.material = material;
    mesh.isPickable = false;
    mesh.parent = this.parent;
    mesh.setEnabled(false);
    this.mesh = mesh;
    this.material = material;
    return mesh;
  }
}

function colorFromHex(hex: string): Color3 {
  try {
    return Color3.FromHexString(hex);
  } catch {
    return new Color3(0.34, 0.85, 1);
  }
}
