import {
  BoundingInfo,
  Color3,
  FresnelParameters,
  Matrix,
  Mesh,
  MeshBuilder,
  StandardMaterial,
  Vector3,
  type Scene,
  type TransformNode,
} from "@babylonjs/core";
import {
  shieldBubbleColorOf,
  shieldImpactFlare,
  shieldRipplePose,
  type ShieldRippleSettings,
  type ViewRelation,
} from "./juiceSettings.js";
import {
  advanceShieldAnim,
  initialShieldAnim,
  panelBounceWeight,
  panelPose,
  phaseAlphaScale,
  shieldAnimMoving,
  shieldAnimVisible,
  shieldBounce,
  type PanelPose,
  type ShieldAnimState,
} from "./shieldAnim.js";
import { layoutFor, panelBasis, type ShieldPanel } from "./shieldPanels.js";

/**
 * ROADMAP §10 5.7 — the shield shell: a bubble of HEXAGONAL PANELS that flies
 * out of a ship to raise, flies back to lower, and blows apart when the
 * reservoir is shot flat (owner rework 2026-08-23; it used to be one plain
 * translucent sphere). Equipped is not running: see
 * {@link import("@space-arena/shared").shieldShellUp}, which the rig calls, for
 * why the module's state is half the test.
 *
 * One mesh per ship, owned by that ship's
 * {@link import("../ShipSocketRig.js").ShipSocketRig}, built lazily on the first
 * shield-up so ships that never run a shield never pay for it. All ~120 panels
 * of that shell are THIN INSTANCES of a single hexagon: one draw call per
 * shield, one shared vertex buffer, and — because a shell sitting at rest is
 * geometrically static ({@link shieldAnimMoving}) — no per-frame vertex traffic
 * at all except while it is assembling, shattering or ringing from a hit.
 *
 * What drives how it reads is unchanged: WHOSE it is ({@link setRelation}) and
 * WHETHER IT IS BEING SHOT ({@link impact}). The colours, the alpha band and
 * the breathing ripple are the same numbers as before — the panels are a new
 * skin on the same tuned feel, not a new palette.
 */
export class ShieldBubble {
  private mesh: Mesh | null = null;
  private material: StandardMaterial | null = null;
  private settings: ShieldRippleSettings;
  private panels: ShieldPanel[];
  /** Thin-instance matrices, `panels.length * 16` floats, rewritten in place. */
  private matrices: Float32Array;
  private elapsedMs = 0;
  private readonly anim: ShieldAnimState = initialShieldAnim();
  private relation: ViewRelation = "friendly";
  /**
   * Render time since the last absorb, or `Infinity` for "no impact on record"
   * — the state a bubble starts in and returns to whenever its shield drops.
   */
  private msSinceImpact = Number.POSITIVE_INFINITY;
  /** Ship-local unit direction the last absorb came in on; zero = unknown. */
  private readonly impactDir = new Vector3();
  /** Scratch, reused every panel of every frame. */
  private readonly pose: PanelPose = { radial: 0, scale: 0, spinRad: 0 };
  private readonly basis = { tx: 0, ty: 0, tz: 0, bx: 0, by: 0, bz: 0 };
  private readonly invWorld = new Matrix();
  /**
   * The material's own emissive instance, written in place. The tint moves
   * every frame an absorb is decaying, and a fresh `Color3` per shield per
   * frame is exactly the kind of garbage a ten-ship firefight does not need.
   */
  private readonly emissive = new Color3();
  private readonly baseTint = new Color3();

  constructor(
    private readonly scene: Scene,
    private readonly parent: TransformNode,
    /** Ship collider radius — the bubble is a multiple of this. */
    private readonly radius: number,
    settings: ShieldRippleSettings,
    private readonly name = "shield",
    /**
     * The active tier's particle budget, reused as the shell's panel budget —
     * one dial for "how much decoration is this machine willing to draw" (see
     * {@link import("./shieldPanels.js").shieldPanelCount}).
     */
    private readonly budgetMultiplier = 1,
  ) {
    this.settings = settings;
    this.panels = layoutFor(settings, budgetMultiplier);
    this.matrices = new Float32Array(this.panels.length * 16);
  }

  /** Re-apply theme knobs (hot-reload). Hides the bubble if it was turned off. */
  setSettings(settings: ShieldRippleSettings): void {
    const relaid = settings.panelCount !== this.settings.panelCount || settings.panelOverlap !== this.settings.panelOverlap;
    this.settings = settings;
    if (!settings.enabled && this.mesh) {
      this.anim.phase = "down";
      this.anim.elapsedMs = 0;
      this.mesh.setEnabled(false);
      return;
    }
    if (relaid) {
      // A retuned panel count is a different shell: drop the mesh so the next
      // shield-up rebuilds it, rather than trying to grow a buffer under a live
      // animation.
      this.panels = layoutFor(settings, this.budgetMultiplier);
      this.matrices = new Float32Array(this.panels.length * 16);
      this.disposeMesh();
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
   * An absorb landed on this ship — flash the shell's colour and kick its
   * elastic wobble. This is what makes a shield visible at all: the idle pose is
   * deliberately near-transparent, so without impacts the bubble is felt only as
   * a faint limb on the silhouette.
   *
   * Pass the WORLD point the hit landed on when the event carried one
   * (`damage`/`shieldAbsorb` do since 2026-08-23) and the wobble concentrates
   * there; without it the whole shell rings evenly, which is the honest reading
   * for a hit whose direction nobody knows.
   *
   * Safe to call while the shield is down or the bubble disabled; the flare is
   * only ever read by a frame that is already drawing.
   */
  impact(worldX?: number, worldY?: number, worldZ?: number): void {
    this.msSinceImpact = 0;
    if (worldX === undefined || worldY === undefined || worldZ === undefined || !this.mesh) {
      this.impactDir.setAll(0);
      return;
    }
    // Panel normals live in the shell's local frame, so the incoming direction
    // has to be brought into it — the ship is turning under the hit.
    this.mesh.computeWorldMatrix(true);
    this.mesh.getWorldMatrix().invertToRef(this.invWorld);
    Vector3.TransformCoordinatesFromFloatsToRef(worldX, worldY, worldZ, this.invWorld, this.impactDir);
    const len = this.impactDir.length();
    if (len > 1e-4) this.impactDir.scaleInPlace(1 / len);
    else this.impactDir.setAll(0);
  }

  /**
   * Drive the shell for one frame. `shieldUp` comes from the ship snapshot (a
   * DEPLOYED shield module with a live absorb reservoir) and `broken` says which
   * way a shield that just went down went out — see
   * {@link import("./shieldAnim.js").shieldBrokenBy}. The ripple clock resets on
   * each rise so every shield-up starts from the same point in the cycle.
   */
  update(shieldUp: boolean, dtMs: number, broken = false): void {
    if (!this.settings.enabled) return;
    const wasDown = this.anim.phase === "down";
    advanceShieldAnim(this.anim, shieldUp, broken, dtMs, this.settings);
    if (!shieldAnimVisible(this.anim)) {
      if (!wasDown) {
        this.elapsedMs = 0;
        // A collapsed shield forgets its last hit, so the bubble that comes
        // back when the reservoir recharges starts dark instead of inheriting
        // a flare from the volley that broke it.
        this.msSinceImpact = Number.POSITIVE_INFINITY;
        this.impactDir.setAll(0);
        this.mesh?.setEnabled(false);
      }
      return;
    }
    const mesh = this.ensureMesh();
    if (wasDown) {
      this.elapsedMs = 0;
      mesh.setEnabled(true);
    }
    this.elapsedMs += dtMs;
    // Note the ordering against `impact()`: events drain before the frame
    // renders, so a hit registered this frame is already `dtMs` old here. That
    // is honest — it IS one frame of render time old — and keeps the flare
    // monotonically decaying rather than holding its peak for two frames.
    this.msSinceImpact += dtMs;
    const ripple = shieldRipplePose(this.elapsedMs, this.settings, this.msSinceImpact);
    mesh.scaling.setAll(this.radius * ripple.scale);
    const bounce = shieldBounce(this.msSinceImpact, this.settings);
    if (this.material) this.material.alpha = ripple.alpha * phaseAlphaScale(this.anim, this.settings);
    this.applyTint();
    if (shieldAnimMoving(this.anim, Math.abs(bounce))) this.writePanels(mesh, bounce);
  }

  /** Whether the bubble is currently shown (dev probe / tests). */
  get isVisible(): boolean {
    return shieldAnimVisible(this.anim);
  }

  /** Which beat of raise/hold/lower/shatter the shell is on (dev probe / tests). */
  get phase(): ShieldAnimState["phase"] {
    return this.anim.phase;
  }

  /** Which side this bubble is painted for (dev probe / tests). */
  get shownRelation(): ViewRelation {
    return this.relation;
  }

  /** Panels in this shell after the quality tier had its say (dev probe / tests). */
  get panelCount(): number {
    return this.panels.length;
  }

  dispose(): void {
    this.disposeMesh();
  }

  /**
   * Rewrite every panel's thin-instance matrix. Local space is the UNIT sphere —
   * the mesh node carries the bubble radius — so a panel is `basis × scale`
   * placed at `normal × radial`, spun about its own normal by the animation.
   */
  private writePanels(mesh: Mesh, bounce: number): void {
    const m = this.matrices;
    const focused = this.impactDir.lengthSquared() > 0.5;
    for (let i = 0; i < this.panels.length; i++) {
      const panel = this.panels[i]!;
      // Weight the wobble toward the shot: a hit on the nose must not visibly
      // move the panels behind the engines.
      const dot = focused
        ? panel.nx * this.impactDir.x + panel.ny * this.impactDir.y + panel.nz * this.impactDir.z
        : 1;
      panelPose(panel, this.anim, this.settings, bounce * panelBounceWeight(dot, this.settings), this.pose);
      const o = i * 16;
      if (this.pose.scale <= 0) {
        // Collapsed to nothing rather than branch-free-skipped: a stale matrix
        // would leave last frame's panel hanging in space.
        m[o + 0] = 0; m[o + 1] = 0; m[o + 2] = 0; m[o + 3] = 0;
        m[o + 4] = 0; m[o + 5] = 0; m[o + 6] = 0; m[o + 7] = 0;
        m[o + 8] = 0; m[o + 9] = 0; m[o + 10] = 0; m[o + 11] = 0;
        m[o + 12] = 0; m[o + 13] = 0; m[o + 14] = 0; m[o + 15] = 1;
        continue;
      }
      panelBasis(panel, this.basis);
      const s = panel.radius * this.pose.scale;
      const cos = Math.cos(this.pose.spinRad) * s;
      const sin = Math.sin(this.pose.spinRad) * s;
      // Row-major world matrix (Babylon transforms row vectors): rows 0/1 are
      // the hexagon's in-plane axes, row 2 its outward normal.
      m[o + 0] = this.basis.tx * cos + this.basis.bx * sin;
      m[o + 1] = this.basis.ty * cos + this.basis.by * sin;
      m[o + 2] = this.basis.tz * cos + this.basis.bz * sin;
      m[o + 3] = 0;
      m[o + 4] = -this.basis.tx * sin + this.basis.bx * cos;
      m[o + 5] = -this.basis.ty * sin + this.basis.by * cos;
      m[o + 6] = -this.basis.tz * sin + this.basis.bz * cos;
      m[o + 7] = 0;
      m[o + 8] = panel.nx * s;
      m[o + 9] = panel.ny * s;
      m[o + 10] = panel.nz * s;
      m[o + 11] = 0;
      m[o + 12] = panel.nx * this.pose.radial;
      m[o + 13] = panel.ny * this.pose.radial;
      m[o + 14] = panel.nz * this.pose.radial;
      m[o + 15] = 1;
    }
    mesh.thinInstanceBufferUpdated("matrix");
  }

  private ensureMesh(): Mesh {
    if (this.mesh) return this.mesh;
    const material = new StandardMaterial(`mat.shieldbubble.${this.name}`, this.scene);
    material.diffuseColor = Color3.Black();
    this.applyTint();
    material.emissiveColor = this.emissive;
    material.alpha = this.settings.minAlpha;
    material.backFaceCulling = false;
    // REFLECTIVITY (owner 2026-08-23): the old shell was `disableLighting`, so
    // it caught nothing — a flat wash of colour. The panels are lit, which
    // costs them nothing (their diffuse is black) but lets a specular highlight
    // and the arena's environment slide across them as the ship turns, which is
    // what makes them read as glass plates rather than as painted decal.
    material.disableLighting = false;
    material.specularColor = Color3.White().scale(this.settings.reflectivity);
    material.specularPower = 48;
    if (this.scene.environmentTexture) {
      material.reflectionTexture = this.scene.environmentTexture;
      const reflect = new FresnelParameters();
      reflect.isEnabled = true;
      reflect.bias = 0.1;
      reflect.power = 2;
      material.reflectionFresnelParameters = reflect;
    }
    // Rim-weighted opacity (owner presentation note 2026-07-31, kept): the
    // shell's face-on panels fade and its limb stays, so the bubble reads as a
    // curved surface instead of as a bag of stickers over the hull. Theme
    // alphas still scale the whole thing.
    const fresnel = new FresnelParameters();
    fresnel.isEnabled = true;
    fresnel.leftColor = Color3.White(); // grazing angles: full themed alpha
    fresnel.rightColor = Color3.Black(); // face-on centre: fades out
    fresnel.bias = 0.15;
    fresnel.power = 2.2;
    material.opacityFresnelParameters = fresnel;

    // ONE hexagon, instanced ~120 times. `tessellation: 6` is literally a
    // hexagon; double-sided because a shattered panel tumbles through its own
    // back face on the way out.
    const mesh = MeshBuilder.CreateDisc(
      `shieldbubble.${this.name}`,
      { radius: 1, tessellation: 6, sideOrientation: Mesh.DOUBLESIDE },
      this.scene,
    );
    mesh.material = material;
    mesh.isPickable = false;
    mesh.parent = this.parent;
    mesh.thinInstanceSetBuffer("matrix", this.matrices, 16, false);
    mesh.thinInstanceCount = this.panels.length;
    // Fixed bounds covering the widest the shell ever gets (a full shatter),
    // set once: refreshing per frame would walk every matrix again for nothing.
    const reach = 1 + this.settings.shatterSpeed * 1.4;
    mesh.setBoundingInfo(new BoundingInfo(new Vector3(-reach, -reach, -reach), new Vector3(reach, reach, reach)));
    mesh.doNotSyncBoundingInfo = true;
    mesh.setEnabled(false);
    this.mesh = mesh;
    this.material = material;
    return mesh;
  }

  /**
   * Re-emit the current relation's tint, flashed toward white by however hot the
   * last absorb still is. The flash is the shell's half of the "that shot was
   * stopped" beat — the bounce below it is the other half.
   */
  private applyTint(): void {
    writeHexColor(shieldBubbleColorOf(this.relation, this.settings), this.baseTint);
    const flare = shieldImpactFlare(this.msSinceImpact, this.settings.impactDecayMs);
    const base = this.baseTint;
    this.emissive.set(
      base.r + (1 - base.r) * flare,
      base.g + (1 - base.g) * flare,
      base.b + (1 - base.b) * flare,
    );
  }

  private disposeMesh(): void {
    this.material?.dispose();
    this.mesh?.dispose();
    this.material = null;
    this.mesh = null;
  }
}

/** Parse `#rrggbb` into an existing colour, falling back to the shield blue. */
function writeHexColor(hex: string, out: Color3): void {
  try {
    const parsed = Color3.FromHexString(hex);
    out.set(parsed.r, parsed.g, parsed.b);
  } catch {
    out.set(0.34, 0.85, 1);
  }
}
