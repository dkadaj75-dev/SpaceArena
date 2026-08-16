import {
  Color3,
  FresnelParameters,
  MeshBuilder,
  StandardMaterial,
  type Mesh,
  type Scene,
  type TransformNode,
} from "@babylonjs/core";
import {
  shieldBubbleColorOf,
  shieldRipplePose,
  type ShieldRippleSettings,
  type ViewRelation,
} from "./juiceSettings.js";

/**
 * ROADMAP §10 5.7 — the shield bubble: a translucent shell that ripples while a
 * ship is RUNNING a shield, and vanishes the moment the shield drops. Equipped
 * is not running: see {@link import("@space-arena/shared").shieldShellUp}, which
 * the rig calls, for why the module's state is half the test.
 *
 * One mesh per ship, owned by that ship's
 * {@link import("../ShipSocketRig.js").ShipSocketRig} (which already owns the
 * per-ship socket graph), built lazily on the first shield-up so ships that
 * never run a shield never pay for it. The ripple math is pure and lives in
 * {@link shieldRipplePose}; this class only moves Babylon state.
 *
 * Two things drive how it reads: WHOSE it is — {@link setRelation} paints an
 * enemy shell in the theme's danger red and my own side's in shield blue — and
 * WHETHER IT IS BEING SHOT: {@link impact} is what actually lights it, the idle
 * pose being near-invisible by design.
 */
export class ShieldBubble {
  private mesh: Mesh | null = null;
  private material: StandardMaterial | null = null;
  private settings: ShieldRippleSettings;
  private elapsedMs = 0;
  private active = false;
  private relation: ViewRelation = "friendly";
  /**
   * Render time since the last absorb, or `Infinity` for "no impact on record"
   * — the state a bubble starts in and returns to whenever its shield drops.
   */
  private msSinceImpact = Number.POSITIVE_INFINITY;

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
    this.applyTint();
  }

  /**
   * Paint this bubble for the side its ship flies for. Cheap to call every
   * frame: a relation that did not change touches no Babylon state, so the
   * caller can simply re-assert it rather than track team changes itself.
   */
  setRelation(relation: ViewRelation): void {
    if (relation === this.relation) return;
    this.relation = relation;
    this.applyTint();
  }

  /**
   * An absorb landed on this ship — flare the shell. This is what makes a
   * shield visible at all: the idle pose is deliberately near-transparent, so
   * without impacts the bubble is felt only as a faint limb on the silhouette.
   *
   * Safe to call while the shield is down or the bubble disabled; the flare is
   * only ever read by a frame that is already drawing.
   */
  impact(): void {
    this.msSinceImpact = 0;
  }

  /**
   * Drive the bubble for one frame. `shieldUp` comes from the ship snapshot
   * (a DEPLOYED shield module with a live absorb reservoir); the ripple clock
   * resets on each rise so every shield-up starts from the same point in the
   * cycle.
   */
  update(shieldUp: boolean, dtMs: number): void {
    if (!this.settings.enabled) return;
    if (!shieldUp) {
      if (this.active) {
        this.active = false;
        this.elapsedMs = 0;
        // A collapsed shield forgets its last hit, so the bubble that comes
        // back when the reservoir recharges starts dark instead of inheriting
        // a flare from the volley that broke it.
        this.msSinceImpact = Number.POSITIVE_INFINITY;
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
    // Note the ordering against `impact()`: events drain before the frame
    // renders, so a hit registered this frame is already `dtMs` old here. That
    // is honest — it IS one frame of render time old — and keeps the flare
    // monotonically decaying rather than holding its peak for two frames.
    this.msSinceImpact += dtMs;
    const pose = shieldRipplePose(this.elapsedMs, this.settings, this.msSinceImpact);
    mesh.scaling.setAll(this.radius * pose.scale);
    if (this.material) this.material.alpha = pose.alpha;
  }

  /** Whether the bubble is currently shown (dev probe / tests). */
  get isVisible(): boolean {
    return this.active;
  }

  /** Which side this bubble is painted for (dev probe / tests). */
  get shownRelation(): ViewRelation {
    return this.relation;
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
    material.emissiveColor = colorFromHex(shieldBubbleColorOf(this.relation, this.settings));
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

  /** Re-emit the current relation's tint onto a material that already exists. */
  private applyTint(): void {
    if (!this.material) return;
    this.material.emissiveColor = colorFromHex(shieldBubbleColorOf(this.relation, this.settings));
  }
}

function colorFromHex(hex: string): Color3 {
  try {
    return Color3.FromHexString(hex);
  } catch {
    return new Color3(0.34, 0.85, 1);
  }
}
