import {
  Color3,
  FresnelParameters,
  Mesh,
  MeshBuilder,
  PointLight,
  Quaternion,
  StandardMaterial,
  TransformNode,
  Vector3,
  VertexBuffer,
  VertexData,
  type InstancedMesh,
  type LinesMesh,
  type Scene,
} from "@babylonjs/core";
import {
  bodyYawDelta,
  createLogger,
  facingVec,
  hardpointsOf,
  interpolateFrame,
  type AsteroidConfig,
  type AsteroidSnapshot,
  type ConfigService,
  type DecoySnapshot,
  type EffectConfig,
  type EntityId,
  type FlagSnapshot,
  type ModuleConfig,
  type ProjectileSnapshot,
  type ShipConfig,
  type ShipSnapshot,
  type SimEvent,
  type QualityConfig,
  type Snapshot,
  type ThemeConfig,
  type TuningConfig,
  type FrameAttitude,
} from "@space-arena/shared";
import { AssetRegistry } from "../core/AssetRegistry.js";
import { ShipSocketRig } from "./ShipSocketRig.js";
import { resampleTrail, trailAlphas, TRAIL_POINTS, type TrailPoint } from "./flagTrail.js";
import { advanceBeaconClock, beaconPhase, beaconPulse, beaconRadius } from "./flagBeacon.js";
import { resolveSoundId } from "../audio/soundIds.js";
import { ExplosionFx } from "./juice/ExplosionFx.js";
import { HitFlashPool } from "./juice/HitFlash.js";
import { explosionEffectIdFor, juiceSettingsOf, type JuiceSettings } from "./juice/juiceSettings.js";
import {
  approachRoll,
  bankRollFor,
  meshYawFor,
  pitchForDirection,
  yawForDirection,
} from "./shipOrientation.js";
import {
  advanceAsteroidSpin,
  asteroidSpinFor,
  type AsteroidSpin,
} from "./asteroidSpin.js";
import { mvpPresentationSettings } from "./hud/matchPresentation.js";

const log = createLogger("ViewManager");

const ASTEROID_DEATH_MS = 260;
const FLAG_BANNER_COLUMNS = 9;
const FLAG_BANNER_ROWS = 4;
const FLAG_BANNER_WIDTH = 5.8;
const FLAG_BANNER_HEIGHT = 3.2;
const FLAG_BANNER_BASE_Y = 0.2;
const FLAG_BANNER_WAVE_MS = 34;
const FLAG_TRANSITION_MS = 130;

/** Resolves a sim ship entity to its ship-config id (owned by GameSession). */
export type ShipConfigResolver = (id: EntityId) => string | undefined;

/** Fire-and-forget sound playback by content sound id (see `audio/AudioManager`). */
export type PlaySound = (id: string, volume?: number) => void;

const THEME_ID = "theme.default";

/** Additive construction options (§10 5.7 juice wiring). */
export interface ViewManagerOptions {
  /** Theme `juice` knobs; re-read from the theme config when omitted. */
  juice?: JuiceSettings;
  /** Where explosion sounds go. Omitted = silent (editor/hangar previews). */
  playSound?: PlaySound;
}

interface ShipView {
  node: InstancedMesh;
  /** Hardpoint module meshes + emitter particle systems (§9 4.6); null if the ship config had none. */
  rig: ShipSocketRig | null;
  /** Drawn visual bank (radians), smoothed toward `rollTarget` (BUBBLE.md §C). */
  roll: number;
  /**
   * Bank the current turn rate asks for. Kept across frames so a render frame
   * that lands between two identical snapshots (or a paused sim) HOLDS the lean
   * instead of letting it decay to level.
   */
  rollTarget: number;
  /** The node's rotation quaternion (assigning once; updated in place per frame). */
  quat: Quaternion;
  /** Retained after despawn so destruction debris inherits the ship's last motion. */
  velocity: Vector3;
}

interface AsteroidView {
  instance: InstancedMesh;
  /** Instance scaling at full size — NOT the collider radius, see `getAsteroidMaster`. */
  baseScale: number;
  /** Stable id-derived axis, pace, and direction; allocated once with the view. */
  spin: AsteroidSpin;
  dying: boolean;
  dyingMs: number;
}

/** A jettisoned heatsink: deliberately not pickable or target-bracketable. */
interface DecoyView {
  root: TransformNode;
  canister: Mesh;
  collar: Mesh;
  canisterMaterial: StandardMaterial;
  collarMaterial: StandardMaterial;
  tumblePhase: number;
}

/**
 * One capture-the-flag flag in the scene: a physical pole and cloth pennant,
 * plus the fading breadcrumb wake. The pennant's small fixed vertex grid is
 * updated at 30 Hz, which gives it a stately ripple without shader/material
 * lifetime complexity or per-frame allocations.
 *
 * It also owns the BASE BEACON (owner 2026-08-01) — the shell standing on the
 * flag's home, which is what tells a carrier where to deliver. The beacon is
 * tied to the flag view purely for lifetime: it never follows the flag, and it
 * stays lit whether the flag is home, dropped or carried.
 */
interface FlagView {
  root: TransformNode;
  pole: Mesh;
  stand: Mesh;
  banner: Mesh;
  /** Bright free-edge hem shares the cloth material, making the silhouette read at range. */
  bannerEdge: Mesh;
  bannerPositions: Float32Array;
  poleMaterial: StandardMaterial;
  bannerMaterial: StandardMaterial;
  /** State is smoothed into these values so a pickup/drop never snaps. */
  scale: number;
  tilt: number;
  standScale: number;
  bannerClockMs: number;
  bannerUpdateMs: number;
  trail: LinesMesh;
  /** Base beacon shell, parked on `flag.home` for the life of the view. */
  beacon: Mesh;
  beaconMaterial: StandardMaterial;
  /** Where this beacon sits in the shared breath, so bases don't pulse as one. */
  beaconPhase: number;
  team: number;
}

interface BeamSlot {
  mesh: Mesh;
  life: number; // ms remaining
  maxLife: number;
}

/** Everything ViewManager reads off the active quality tier (§10 5.6). */
export type ViewQuality = Pick<QualityConfig, "projectiles" | "particles" | "asteroids">;

const DEFAULT_VIEW_QUALITY: ViewQuality = {
  projectiles: { useInstances: true },
  particles: { enabled: true, budgetMultiplier: 1, maxEmitterCapacity: 80 },
  asteroids: { lodMediumDistance: 0, lodLowDistance: 0, lodCullDistance: 0, thinInstances: false },
};

/**
 * Multiplier packing `(shipId, hardpointIndex)` into one integer key for the
 * channel-beam map. 256 is well past the wire's `uint8` hardpoint index, so the
 * pair is unambiguous.
 */
const CHANNEL_KEY_STRIDE = 256;

/** Newly spawned beams use the current tuning registry, including editor replacement. */
export function beamFadeMsOf(configs: Pick<ConfigService, "getAll">): number {
  return configs.getAll<TuningConfig>("tuning")[0]?.beamFadeMs ?? 120;
}

/**
 * A pooled projectile node: an `InstancedMesh` (batched — one draw call for the
 * whole pool) or a cloned `Mesh` (one draw call each) depending on the tier.
 * Both expose the position/rotation/enable surface the sync path uses.
 */
type ProjectileNode = Mesh | InstancedMesh;

/**
 * Maps authoritative sim entity ids to Babylon nodes and keeps them in sync with
 * the interpolated snapshot each frame. Ships/asteroids/projectiles are all
 * dynamic views here; {@link import("../core/SceneBuilder").SceneBuilder} only
 * builds the static arena (bounds/skybox/ground/lighting).
 *
 * Hot-path discipline (§ perf): projectiles and beams draw from fixed mesh pools
 * with zero per-shot allocations; materials are shared; scratch vectors are
 * reused; interpolation matches ids by linear scan over the (tiny) snapshot lists.
 */
export class ViewManager {
  private readonly assets: AssetRegistry;
  private readonly root: TransformNode;
  private readonly heroRoot: TransformNode;
  private heroShip: InstancedMesh | null = null;
  private heroKeyLight: PointLight | null = null;
  private heroRimLight: PointLight | null = null;
  private heroPedestal: Mesh | null = null;
  private heroPedestalMaterial: StandardMaterial | null = null;
  private heroElapsedMs = 0;
  private heroSettleMs = 1050;

  private readonly ships = new Map<EntityId, ShipView>();
  private readonly asteroids = new Map<EntityId, AsteroidView>();
  /** Visible hot heatsinks. The sim already replicates their full lifetime. */
  private readonly decoys = new Map<EntityId, DecoyView>();
  /** Capture-the-flag flags and their wakes (owner 2026-07-31). */
  private readonly flags = new Map<EntityId, FlagView>();
  /** Kept for the public view API; physical flag colours are team-stable. */
  private playerTeam: number | null = null;
  /** Shared beacon breath clock, wrapped to one period (see `flagBeacon.ts`). */
  private beaconClockMs = 0;
  /** Scratch trail ladder — resampled in place every frame, never reallocated. */
  private readonly sTrail: TrailPoint[] = [];
  private readonly sTrailVectors: Vector3[] = [];

  // Projectile pools (shown/hidden, never reallocated).
  private readonly kineticPool: ProjectileNode[] = [];
  private readonly missilePool: ProjectileNode[] = [];
  private readonly beamPool: BeamSlot[] = [];
  /**
   * Beam slots PINNED to a live continuous channel, keyed by
   * `shipId * CHANNEL_KEY_STRIDE + hardpointIndex` (a number, so the hot path
   * allocates no key strings). A pinned slot has its life refreshed every frame,
   * which both keeps it lit and keeps `firstFreeBeam` from stealing it; dropping
   * it from this map is all a channel-stop needs to do — the slot then decays
   * through the normal `beamFadeMs` fade, so a released trigger reuses the
   * existing beam fade rather than snapping off.
   */
  private readonly channelBeams = new Map<number, BeamSlot>();
  /** Reused mark-set for the channel sweep — no per-frame allocation. */
  private readonly liveChannels = new Set<number>();
  /** Pool masters, kept so a quality change can rebuild the pools in place. */
  private readonly poolMasters: Mesh[] = [];

  private readonly poolSize: number;
  private quality: ViewQuality;

  // --- juice (§10 5.7) ---
  private juice: JuiceSettings;
  private readonly hitFlash: HitFlashPool;
  private readonly explosions: ExplosionFx;
  private readonly playSound: PlaySound | null;

  // Reused scratch — no per-frame allocation.
  private readonly sFrom = new Vector3();
  private readonly sTo = new Vector3();
  /** Scratch orientation frame + vectors for the ship pose (BUBBLE.md §C, full-frame). */
  private readonly sFrame: FrameAttitude = { heading: 0, pitch: 0, up: { x: 0, y: 1, z: 0 } };
  private readonly sNose = { x: 0, y: 0, z: 0 };
  private readonly sForward = new Vector3();
  private readonly sBankedUp = new Vector3();

  constructor(
    private readonly scene: Scene,
    private readonly configs: ConfigService,
    private readonly resolveShipConfig: ShipConfigResolver,
    quality: ViewQuality = DEFAULT_VIEW_QUALITY,
    options: ViewManagerOptions = {},
  ) {
    this.assets = new AssetRegistry(scene);
    this.root = new TransformNode("viewRoot", scene);
    this.heroRoot = new TransformNode("mvpHeroRoot", scene);
    this.heroRoot.setEnabled(false);
    this.quality = quality;

    const tuning = configs.getAll<TuningConfig>("tuning")[0];
    this.poolSize = tuning?.projectilePoolSize ?? 64;

    this.juice = options.juice ?? juiceSettingsOf(configs.get<ThemeConfig>("theme", THEME_ID));
    this.playSound = options.playSound ?? null;
    this.hitFlash = new HitFlashPool(scene, this.root, this.juice.hitFlash);
    this.explosions = new ExplosionFx(scene, this.juice.explosions, quality.particles, this.root);

    this.assets.setAsteroidLod(quality.asteroids);
    this.buildPools();
  }

  /** Cheap tuning knob: each newly fired beam reads the live offline registry. */
  private get beamFadeMs(): number {
    return beamFadeMsOf(this.configs);
  }

  /**
   * Re-read the theme's `juice` block (hot-reload / Theme editor) and push it at
   * every live juice consumer, including each ship's socket rig.
   */
  refreshJuice(): void {
    this.juice = juiceSettingsOf(this.configs.get<ThemeConfig>("theme", THEME_ID));
    this.hitFlash.setSettings(this.juice.hitFlash);
    this.explosions.setSettings(this.juice.explosions);
    for (const view of this.ships.values()) view.rig?.setJuice(this.juice);
  }

  /**
   * Apply a new quality tier. Only the projectile pools depend on it
   * structurally, so they are rebuilt; live ships keep their rigs (the emitter
   * budget applies to ships spawned from here on, which is every ship next
   * match — rebuilding mid-match would pop every trail).
   */
  setQuality(quality: ViewQuality): void {
    const wasInstanced = this.quality.projectiles.useInstances;
    this.quality = quality;
    this.assets.setAsteroidLod(quality.asteroids);
    // Explosion pools are one-shot, so unlike ship emitters they CAN be rebuilt
    // mid-match at the new particle budget with nothing visibly popping.
    this.explosions.setQuality(quality.particles);
    if (wasInstanced !== quality.projectiles.useInstances) this.rebuildPools();
  }

  /** The emitter budget live rigs are built against. */
  get particleQuality(): ViewQuality["particles"] {
    return this.quality.particles;
  }

  /**
   * Show/hide every dynamic match view at once. Everything this manager creates
   * is parented to `viewRoot`, so disabling the root hides ships, asteroids,
   * projectiles and beams in one call — used by the dev editor, which takes
   * over the canvas and must not show the live match behind its own stage.
   */
  setVisible(visible: boolean): void {
    this.root.setEnabled(visible);
  }

  /** Replace all combat views with one cheap, disposable MVP hull at centre stage. */
  setMvpCenter(center: Vector3): void {
    this.heroRoot.position.copyFrom(center);
  }

  showMvp(entityId: EntityId): boolean {
    const config = this.shipConfigFor(entityId);
    if (!config) return false;
    this.root.setEnabled(false);
    this.heroShip?.dispose();
    this.heroShip = this.assets.getShipMaster(config.render).createInstance("mvp.hero");
    this.heroShip.parent = this.heroRoot;
    this.heroShip.position.set(0, -0.65, 2.8);
    this.heroShip.rotation.set(0.08, Math.PI, 0);
    this.heroShip.scaling.setAll(0.58);
    this.heroShip.isPickable = false;
    const presentation = mvpPresentationSettings(this.configs.get<ThemeConfig>("theme", THEME_ID));
    // The arena sun is authored for combat, not a camera-facing beauty shot.
    // A warm key and cool rear rim separate dark hulls from every arena skybox.
    this.heroKeyLight?.dispose();
    this.heroKeyLight = new PointLight("mvp.key", new Vector3(-4, 5, -6), this.scene);
    this.heroKeyLight.parent = this.heroRoot;
    this.heroKeyLight.diffuse = Color3.FromHexString(presentation.keyColor);
    this.heroKeyLight.specular.copyFrom(this.heroKeyLight.diffuse);
    this.heroKeyLight.intensity = presentation.keyIntensity;
    this.heroKeyLight.range = 28;
    this.heroRimLight?.dispose();
    this.heroRimLight = new PointLight("mvp.rim", new Vector3(4, 2.5, 5), this.scene);
    this.heroRimLight.parent = this.heroRoot;
    this.heroRimLight.diffuse = Color3.FromHexString(presentation.rimColor);
    this.heroRimLight.specular.copyFrom(this.heroRimLight.diffuse);
    this.heroRimLight.intensity = presentation.rimIntensity;
    this.heroRimLight.range = 24;

    this.heroPedestal?.dispose();
    this.heroPedestalMaterial?.dispose();
    this.heroPedestal = MeshBuilder.CreateDisc("mvp.pedestal", {
      radius: presentation.pedestalDiameter / 2,
      tessellation: 48,
    }, this.scene);
    this.heroPedestal.parent = this.heroRoot;
    this.heroPedestal.position.y = -1.15;
    this.heroPedestal.rotation.x = Math.PI / 2;
    this.heroPedestal.isPickable = false;
    this.heroPedestalMaterial = new StandardMaterial("mvp.pedestal.material", this.scene);
    this.heroPedestalMaterial.disableLighting = true;
    this.heroPedestalMaterial.emissiveColor = Color3.FromHexString(presentation.pedestalColor);
    this.heroPedestalMaterial.alpha = 0.16;
    this.heroPedestalMaterial.backFaceCulling = false;
    this.heroPedestal.material = this.heroPedestalMaterial;
    this.heroSettleMs = presentation.hullSettleMs;
    this.heroElapsedMs = 0;
    this.heroRoot.setEnabled(true);
    return true;
  }

  /** Cinematic update; mutates existing vectors only and allocates nothing per frame. */
  updateMvp(dtMs: number): void {
    const ship = this.heroShip;
    if (!ship) return;
    this.heroElapsedMs += Number.isFinite(dtMs) ? dtMs : 0;
    const progress = Math.min(1, this.heroElapsedMs / this.heroSettleMs);
    const eased = progress * progress * (3 - 2 * progress);
    ship.position.z = 2.8 * (1 - eased);
    ship.position.y = -0.65 * (1 - eased);
    const scale = 0.58 + 0.42 * eased;
    ship.scaling.setAll(scale);
    ship.rotation.y += Math.min(32, Math.max(0, dtMs)) * 0.00005;
    if (this.heroPedestalMaterial) {
      this.heroPedestalMaterial.alpha = 0.1 + 0.06 * (0.5 + 0.5 * Math.sin(this.heroElapsedMs * 0.0024));
    }
  }

  /**
   * Populate a projectile pool from a master.
   *
   * Instancing is the whole point (§10 5.6): measured on the practice arena,
   * every *cloned* projectile mesh costs **2 draw calls** (base pass + glow
   * pass) — 16 in flight took the frame from 37 to 69 draw calls, 48 to 133.
   * Hardware instances collapse the entire pool into one batch instead.
   */
  private fillPool(master: Mesh, prefix: string, out: ProjectileNode[]): void {
    const useInstances = this.quality.projectiles.useInstances;
    for (let i = 0; i < this.poolSize; i++) {
      const node: ProjectileNode = useInstances
        ? master.createInstance(`${prefix}.${i}`)
        : master.clone(`${prefix}.${i}`);
      if (!useInstances) (node as Mesh).material = master.material;
      node.isPickable = false;
      node.setEnabled(false);
      node.parent = this.root;
      out.push(node);
    }
  }

  private buildPools(): void {
    // Kinetic: small elongated glowing box, nose +Z.
    const kMat = new StandardMaterial("mat.proj.kinetic", this.scene);
    kMat.diffuseColor = Color3.Black();
    kMat.emissiveColor = new Color3(1.0, 0.85, 0.3);
    kMat.specularColor = Color3.Black();
    const kMaster = MeshBuilder.CreateBox("master.proj.kinetic", { width: 0.18, height: 0.18, depth: 0.9 }, this.scene);
    kMaster.material = kMat;
    kMaster.isPickable = false;
    kMaster.setEnabled(false);
    this.poolMasters.push(kMaster);
    this.fillPool(kMaster, "proj.kinetic", this.kineticPool);

    // Missile: small cone (cylinder w/ zero top), nose +Z.
    const mMat = new StandardMaterial("mat.proj.missile", this.scene);
    mMat.diffuseColor = Color3.Black();
    mMat.emissiveColor = new Color3(1.0, 0.4, 0.2);
    mMat.specularColor = Color3.Black();
    const mMaster = MeshBuilder.CreateCylinder(
      "master.proj.missile",
      { diameterTop: 0, diameterBottom: 0.32, height: 1.0, tessellation: 6 },
      this.scene,
    );
    mMaster.rotation.x = Math.PI / 2; // nose +Z
    mMaster.bakeCurrentTransformIntoVertices();
    mMaster.material = mMat;
    mMaster.isPickable = false;
    mMaster.setEnabled(false);
    this.poolMasters.push(mMaster);
    this.fillPool(mMaster, "proj.missile", this.missilePool);

    // Beams: thin emissive boxes stretched shooter→target, faded over beamFadeMs.
    const bMat = new StandardMaterial("mat.beam", this.scene);
    bMat.diffuseColor = Color3.Black();
    bMat.emissiveColor = new Color3(0.35, 0.9, 1.0);
    bMat.specularColor = Color3.Black();
    bMat.alpha = 1;
    bMat.backFaceCulling = false;
    const beamCount = Math.max(8, Math.floor(this.poolSize / 4));
    for (let i = 0; i < beamCount; i++) {
      const m = MeshBuilder.CreateBox(`beam.${i}`, { width: 0.12, height: 0.12, depth: 1 }, this.scene);
      // Per-beam material clone so alpha fades independently.
      const inst = bMat.clone(`mat.beam.${i}`)!;
      m.material = inst;
      m.isPickable = false;
      m.setEnabled(false);
      m.parent = this.root;
      this.beamPool.push({ mesh: m, life: 0, maxLife: this.beamFadeMs });
    }
  }

  /**
   * Consume this frame's drained sim events: spawn beams, puff destroyed
   * asteroids. Projectile spawn/despawn is derived from the snapshot lists
   * directly (no event needed) so the pools stay allocation-free.
   */
  consumeEvents(events: readonly SimEvent[], cur: Snapshot): void {
    for (let i = 0; i < events.length; i++) {
      const ev = events[i]!;
      if (ev.type === "projectileFired" && ev.kind === "beam") {
        this.spawnBeam(ev.ownerId, ev.targetId, ev.moduleId, cur);
      } else if (ev.type === "damage") {
        this.flashHit(ev.targetId, ev.isAsteroid);
      } else if (ev.type === "entityDestroyed") {
        if (ev.isAsteroid) {
          const v = this.asteroids.get(ev.entityId);
          if (v && !v.dying) {
            v.dying = true;
            v.dyingMs = ASTEROID_DEATH_MS;
          }
        }
        this.explode(ev.entityId, ev.isAsteroid, cur);
      }
    }
  }

  /** Pop a hit flash on the damaged entity's view (§10 5.7). */
  private flashHit(targetId: EntityId, isAsteroid: boolean): void {
    if (isAsteroid) return; // asteroid hits already read through the death puff
    const view = this.ships.get(targetId);
    if (!view) return;
    const radius = this.shipConfigFor(targetId)?.collider.radius ?? 1.5;
    // The live view node already carries the ship's altitude (BUBBLE.md §C).
    this.hitFlash.flash(view.node.position.x, view.node.position.y, view.node.position.z, radius);
  }

  /**
   * Explosion variant for a destroyed entity (§10 5.7): the effect id comes from
   * the theme's `juice.explosions` map (asteroid / per ship class), the particle
   * budget from the active quality tier, and the SOUND from that same effect
   * config's `sound` field — so a new variant is one content file, not code.
   *
   * The position comes from the live view node, not the snapshot: a destroyed
   * ship is already gone from `cur.ships` by the time the event is drained.
   */
  private explode(entityId: EntityId, isAsteroid: boolean, cur: Snapshot): void {
    const shipClass = isAsteroid ? null : (this.shipConfigFor(entityId)?.class ?? null);
    const effectId = explosionEffectIdFor({ isAsteroid, shipClass }, this.juice.explosions);
    if (!effectId) return;
    const effect = this.configs.get<EffectConfig>("effect", effectId);
    if (!effect) {
      log.warn(`explosion effect not found: ${effectId}`);
      return;
    }
    const pos = this.deathPosition(entityId, isAsteroid, cur);
    if (!pos) return;
    const shipVelocity = !isAsteroid ? this.ships.get(entityId)?.velocity : undefined;
    this.explosions.burst(effect, pos.x, pos.z, pos.y, shipVelocity);
    // Audio is not a quality-tier concern: a low tier drops particles, never the bang.
    const soundId = resolveSoundId(effect.sound);
    if (soundId) this.playSound?.(soundId);
  }

  /** Last known world position of a (possibly already removed) entity. */
  private deathPosition(
    entityId: EntityId,
    isAsteroid: boolean,
    cur: Snapshot,
  ): { x: number; y: number; z: number } | null {
    if (isAsteroid) {
      const view = this.asteroids.get(entityId);
      if (view) return view.instance.position;
      const snap = findAsteroid(cur, entityId);
      return snap ? snap.pos : null;
    }
    const view = this.ships.get(entityId);
    if (view) return view.node.position;
    const snap = findShip(cur, entityId);
    return snap ? snap.pos : null;
  }

  /** Ship config behind a sim entity id, if the session still knows it. */
  private shipConfigFor(id: EntityId): ShipConfig | undefined {
    const configId = this.resolveShipConfig(id);
    return configId ? this.configs.get<ShipConfig>("ship", configId) : undefined;
  }

  private spawnBeam(ownerId: EntityId, targetId: EntityId | null, moduleId: string, cur: Snapshot): void {
    const from = findShip(cur, ownerId);
    if (!from) return;
    if (targetId !== null) {
      const to = findShip(cur, targetId) ?? findAsteroid(cur, targetId);
      if (!to) return;
      this.sTo.set(to.pos.x, to.pos.y, to.pos.z);
    } else {
      // A no-lock straight shot that hit nothing: draw the beam down the
      // shooter's nose out to the module's range, so the miss reads as a shot
      // into space rather than nothing happening.
      const range = this.configs.get<ModuleConfig>("module", moduleId)?.fire?.range ?? 60;
      const cosPitch = Math.cos(from.pitch);
      this.sTo.set(
        from.pos.x + cosPitch * Math.cos(from.heading) * range,
        from.pos.y + Math.sin(from.pitch) * range,
        from.pos.z + cosPitch * Math.sin(from.heading) * range,
      );
    }
    const slot = firstFreeBeam(this.beamPool);
    if (!slot) return; // pool exhausted this frame — acceptable, no alloc
    this.sFrom.set(from.pos.x, from.pos.y, from.pos.z);
    this.orientBeam(slot.mesh, this.sFrom, this.sTo);
    slot.life = slot.maxLife;
    slot.mesh.setEnabled(true);
    (slot.mesh.material as StandardMaterial).alpha = 1;
  }

  /**
   * Stretch a pooled beam box (nose +Z, unit depth) between two world points.
   * Fully 3D since the bubble: shooter and target sit at their own altitudes, so
   * a planar beam would visibly miss whatever it just damaged.
   */
  private orientBeam(mesh: Mesh, from: Vector3, to: Vector3): void {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const len = Math.hypot(dx, dy, dz);
    mesh.position.set((from.x + to.x) / 2, (from.y + to.y) / 2, (from.z + to.z) / 2);
    mesh.rotation.y = yawForDirection(dx, dz);
    mesh.rotation.x = pitchForDirection(dx, dy, dz);
    mesh.scaling.z = Math.max(0.01, len);
  }

  /**
   * Sync all dynamic views to the interpolated state between `prev` and `cur`.
   * `frameDtMs` drives beam fade and asteroid-puff timers.
   */
  render(prev: Snapshot, cur: Snapshot, alpha: number, frameDtMs: number): void {
    this.syncShips(prev, cur, alpha, frameDtMs);
    this.syncAsteroids(cur, frameDtMs);
    this.syncDecoys(prev, cur, alpha);
    this.syncFlags(cur, frameDtMs);
    this.syncProjectiles(prev, cur, alpha);
    // Before updateBeams: a still-channelling slot gets its life refreshed here
    // and so never reaches the fade path below.
    this.syncChannelBeams(cur);
    this.updateBeams(frameDtMs);
    this.hitFlash.update(frameDtMs);
    this.explosions.update(frameDtMs);
  }

  private syncShips(prev: Snapshot, cur: Snapshot, alpha: number, frameDtMs: number): void {
    // Sim seconds between the two snapshots — the honest basis for a turn RATE.
    // `frameDtMs` is render time and would report a wildly different rate at 30
    // vs 144 fps for the very same manoeuvre.
    const snapDt = cur.elapsed - prev.elapsed;
    const frameDt = frameDtMs / 1000;
    // Remove views whose ship no longer exists. Both the map walk and the
    // membership test are allocation-free — `Array.some(cb)` here would build a
    // closure per live view per frame.
    for (const [id, view] of this.ships) {
      if (findShip(cur, id) === undefined) {
        view.rig?.dispose();
        view.node.dispose();
        this.ships.delete(id);
      }
    }
    const nowMs = performance.now();
    for (let i = 0; i < cur.ships.length; i++) {
      const s = cur.ships[i]!;
      let view = this.ships.get(s.id);
      if (!view) {
        view = this.createShipView(s);
        if (!view) continue;
        this.ships.set(s.id, view);
      }
      // One prev-snapshot lookup, reused for interpolation and the emitter
      // signals (which want the real `undefined` when the ship is brand new).
      const prevShip = findShip(prev, s.id);
      const p = prevShip ?? s;
      const x = p.pos.x + (s.pos.x - p.pos.x) * alpha;
      // The hull sits at its own altitude — there is no arena floor to lift it
      // off any more (BUBBLE.md §C retires the old constant y).
      const y = p.pos.y + (s.pos.y - p.pos.y) * alpha;
      const z = p.pos.z + (s.pos.z - p.pos.z) * alpha;
      view.node.position.set(x, y, z);
      view.velocity.set(s.velocity?.x ?? 0, s.velocity?.y ?? 0, s.velocity?.z ?? 0);
      // The hull is posed from the interpolated forward/up FRAME, not from
      // heading/pitch angles: near the poles the heading coordinate's scale is
      // unbounded, so lerping the two Euler angles independently swept the hull
      // through rotations it never made (the steep-pitch barrel roll). The
      // replicated up carries the authoritative roll; the client's cosmetic bank
      // is applied around the nose on top of it.
      interpolateFrame(p.heading, p.pitch, p.up, s.heading, s.pitch, s.up, alpha, this.sFrame);
      facingVec(this.sFrame.heading, this.sFrame.pitch, this.sNose);
      if (snapDt > 0) {
        // Bank from the SIGNED BODY YAW between the two snapshots — bounded by
        // the yaw the ship actually commanded at every attitude, where the raw
        // heading-coordinate rate blows up near vertical and flipped the bank
        // across the pole.
        view.rollTarget = bankRollFor(
          bodyYawDelta(p.heading, p.pitch, p.up, s.heading, s.pitch) / snapDt,
          this.juice.bank.maxRad,
          this.juice.bank.referenceRateRadPerSec,
        );
      }
      view.roll = approachRoll(view.roll, view.rollTarget, this.juice.bank.lag, frameDt);
      // Positive roll lifts the right wing (a left bank): tilt the up vector
      // toward the LEFT wing `N × U` by the drawn bank, then build the pose from
      // look direction + banked up. Model nose is +Z, model up +Y (BUBBLE.md §C).
      const n = this.sNose;
      const u = this.sFrame.up;
      const cr = Math.cos(view.roll);
      const sr = Math.sin(view.roll);
      const lx = n.y * u.z - n.z * u.y;
      const ly = n.z * u.x - n.x * u.z;
      const lz = n.x * u.y - n.y * u.x;
      this.sForward.set(n.x, n.y, n.z);
      this.sBankedUp.set(u.x * cr + lx * sr, u.y * cr + ly * sr, u.z * cr + lz * sr);
      // RH, not LH, despite the engine being left-handed: Babylon's LH variant
      // aims the model's −Z at the direction under the row-vector convention
      // node.rotationQuaternion actually uses; RH lands +Z on the nose.
      // `shipOrientation.test.ts` pins this against the legacy Euler pose.
      Quaternion.FromLookDirectionRHToRef(this.sForward, this.sBankedUp, view.quat);

      view.rig?.updateModules(s.modules);
      view.rig?.updateShield(s, frameDtMs);
      view.rig?.updateEmitters(s, prevShip, nowMs);
    }
  }

  private createShipView(s: ShipSnapshot): ShipView | undefined {
    const configId = this.resolveShipConfig(s.id);
    const ship = configId ? this.configs.get<ShipConfig>("ship", configId) : undefined;
    if (!ship) {
      log.warn(`no ship config for entity ${s.id} (configId=${configId ?? "?"})`);
      return undefined;
    }
    const master = this.assets.getShipMaster(ship.render);
    const node = master.createInstance(`ship.${s.id}`);
    // Frame-based pose: the quaternion owns the rotation from here on (once
    // assigned, Babylon ignores `node.rotation`). Updated in place per frame.
    const quat = Quaternion.Identity();
    node.rotationQuaternion = quat;
    node.isPickable = true;
    node.metadata = { entityId: s.id, kind: "ship", team: s.team };
    node.parent = this.root;

    // Fitted module ids in hardpoint order (sparse-safe: an unfitted hardpoint stays null).
    const fittedModuleIds: (string | null)[] = new Array(hardpointsOf(ship).length).fill(null);
    for (const m of s.modules) {
      if (m.hardpointIndex < fittedModuleIds.length) fittedModuleIds[m.hardpointIndex] = m.moduleId;
    }
    const rig = new ShipSocketRig(
      this.scene,
      this.configs,
      this.assets,
      ship,
      node,
      fittedModuleIds,
      this.quality.particles,
      this.juice,
    );

    return { node, rig, roll: 0, rollTarget: 0, quat, velocity: new Vector3() };
  }

  private syncAsteroids(cur: Snapshot, frameDtMs: number): void {
    for (let i = 0; i < cur.asteroids.length; i++) {
      const a = cur.asteroids[i]!;
      let view = this.asteroids.get(a.id);
      if (!view) {
        view = this.createAsteroidView(a);
        if (!view) continue;
        this.asteroids.set(a.id, view);
      }
      // Robustness: catch a destroyed state even if the event was missed.
      if (a.state === "destroyed" && !view.dying) {
        view.dying = true;
        view.dyingMs = ASTEROID_DEATH_MS;
      }
      // Destruction owns the pose once the shrink/debris puff begins, so spin
      // stops at that transition. All values here are mutated in place.
      if (!view.dying) {
        advanceAsteroidSpin(view.instance.rotationQuaternion!, view.spin, frameDtMs / 1000);
      }
    }
    // Advance death puffs; dispose when finished.
    for (const [id, view] of this.asteroids) {
      if (!view.dying) continue;
      view.dyingMs -= frameDtMs;
      const t = Math.max(0, view.dyingMs / ASTEROID_DEATH_MS);
      const s = view.baseScale * t;
      view.instance.scaling.set(s, s, s);
      if (view.dyingMs <= 0) {
        view.instance.dispose();
        this.asteroids.delete(id);
      }
    }
  }

  /**
   * Render every replicated heatsink for exactly its authoritative lifetime.
   * Its orange emissive materials are intentionally included by SceneBuilder's
   * arena GlowLayer, giving the canister a cheap hot-air halo without a second
   * particle system. It has no metadata and is not pickable, so HUD reticles
   * never present it as a normal combat contact.
   */
  private syncDecoys(prev: Snapshot, cur: Snapshot, alpha: number): void {
    for (const [id, view] of this.decoys) {
      if (findDecoy(cur, id) === undefined) {
        disposeDecoyView(view);
        this.decoys.delete(id);
      }
    }
    for (let i = 0; i < cur.decoys.length; i++) {
      const decoy = cur.decoys[i]!;
      let view = this.decoys.get(decoy.id);
      if (!view) {
        view = this.createDecoyView(decoy);
        this.decoys.set(decoy.id, view);
      }
      const p = findDecoy(prev, decoy.id) ?? decoy;
      view.root.position.set(
        p.pos.x + (decoy.pos.x - p.pos.x) * alpha,
        p.pos.y + (decoy.pos.y - p.pos.y) * alpha,
        p.pos.z + (decoy.pos.z - p.pos.z) * alpha,
      );
      const life = Math.max(0, Math.min(1, decoy.lifeFraction));
      const tumble = cur.elapsed * 2.4 + view.tumblePhase;
      view.root.rotation.set(Math.sin(tumble * 0.7) * 0.3, tumble, Math.cos(tumble) * 0.22);
      // The thermal bloom breathes while the authoritative burn-out fade keeps
      // it from popping away on the final snapshot.
      const heat = 0.82 + 0.18 * Math.sin(tumble * 3.1);
      view.canisterMaterial.alpha = 0.35 + life * 0.6;
      view.canisterMaterial.emissiveColor.set(1, 0.18 + heat * 0.25, 0.015);
      view.collarMaterial.alpha = 0.25 + life * 0.7;
      view.collarMaterial.emissiveColor.set(1, 0.5 + heat * 0.3, 0.08);
    }
  }

  private createDecoyView(decoy: DecoySnapshot): DecoyView {
    const root = new TransformNode(`decoy.${decoy.id}`, this.scene);
    root.parent = this.root;
    const size = Math.max(0.65, decoy.radius * 0.62);
    const canisterMaterial = new StandardMaterial(`mat.decoy.hot.${decoy.id}`, this.scene);
    canisterMaterial.diffuseColor = Color3.Black();
    canisterMaterial.emissiveColor = new Color3(1, 0.4, 0.03);
    canisterMaterial.specularColor = Color3.Black();
    canisterMaterial.backFaceCulling = false;
    const canister = MeshBuilder.CreateCapsule(
      `decoy.canister.${decoy.id}`,
      { height: size * 1.8, radius: size * 0.36, tessellation: 8, subdivisions: 2 },
      this.scene,
    );
    canister.rotation.z = Math.PI / 2;
    canister.material = canisterMaterial;
    canister.isPickable = false;
    canister.parent = root;

    const collarMaterial = new StandardMaterial(`mat.decoy.collar.${decoy.id}`, this.scene);
    collarMaterial.diffuseColor = Color3.Black();
    collarMaterial.emissiveColor = new Color3(1, 0.76, 0.18);
    collarMaterial.specularColor = Color3.Black();
    collarMaterial.backFaceCulling = false;
    const collar = MeshBuilder.CreateCylinder(
      `decoy.collar.${decoy.id}`,
      { height: size * 0.16, diameter: size * 0.82, tessellation: 8 },
      this.scene,
    );
    collar.rotation.z = Math.PI / 2;
    collar.material = collarMaterial;
    collar.isPickable = false;
    collar.parent = root;
    return { root, canister, collar, canisterMaterial, collarMaterial, tumblePhase: decoy.id * 0.73 };
  }

  /** Which team the viewer flies for; retained for callers that set it on match join. */
  setPlayerTeam(team: number | null): void {
    this.playerTeam = team;
  }

  /**
   * Capture-the-flag flags and their wakes (owner 2026-07-31).
   *
   * The physical flag changes pose by state: upright on its stand at home,
   * compact when carried, and tilted loose when dropped. Its wake still fades
   * from nothing at its oldest end to bright at the runner.
   *
   * The base beacon (owner 2026-08-01) breathes off a single shared clock. It
   * is recomputed from that clock every frame rather than nudged, so a frame
   * hitch cannot leave a base permanently the wrong size or opacity.
   */
  private syncFlags(cur: Snapshot, frameDtMs: number): void {
    this.beaconClockMs = advanceBeaconClock(this.beaconClockMs, frameDtMs);

    for (const flag of cur.flags) {
      let view = this.flags.get(flag.id);
      if (!view) {
        view = this.createFlagView(flag);
        this.flags.set(flag.id, view);
      }

      // The beacon marks the BASE, so it ignores everything the flag is doing.
      const pulse = beaconPulse(this.beaconClockMs, view.beaconPhase);
      view.beacon.scaling.setAll(pulse.scale);
      view.beaconMaterial.alpha = pulse.alpha;

      view.root.position.set(flag.pos.x, flag.pos.y, flag.pos.z);
      // The replicated flag position follows the carrier. Put the mast above
      // its hull while keeping home/drop exactly at the sim position.
      if (flag.state === "carried") view.root.position.y += 3.6;
      const blend = 1 - Math.exp(-Math.max(0, frameDtMs) / FLAG_TRANSITION_MS);
      const targetScale = flag.state === "carried" ? 0.68 : 1;
      const targetTilt = flag.state === "dropped" ? 1.08 : 0;
      view.scale += (targetScale - view.scale) * blend;
      view.tilt += (targetTilt - view.tilt) * blend;
      view.standScale += ((flag.state === "home" ? 1 : 0) - view.standScale) * blend;
      view.root.scaling.setAll(view.scale);
      view.root.rotation.z = view.tilt;
      // Flip the second team's silhouette; colour is team-stable too.
      view.root.rotation.y = view.team === 1 ? Math.PI : 0;
      view.stand.scaling.set(1, view.standScale, 1);
      view.stand.setEnabled(view.standScale > 0.01);
      view.bannerClockMs += Math.max(0, frameDtMs);
      view.bannerUpdateMs += Math.max(0, frameDtMs);
      if (view.bannerUpdateMs >= FLAG_BANNER_WAVE_MS) {
        updateFlagBanner(view);
        view.bannerUpdateMs %= FLAG_BANNER_WAVE_MS;
      }

      if (resampleTrail(flag.trail, this.sTrail, TRAIL_POINTS)) {
        for (let i = 0; i < TRAIL_POINTS; i++) {
          this.sTrailVectors[i]!.set(this.sTrail[i]!.x, this.sTrail[i]!.y, this.sTrail[i]!.z);
        }
        MeshBuilder.CreateLines(view.trail.name, { points: this.sTrailVectors, instance: view.trail }, this.scene);
        view.trail.setEnabled(true);
      } else {
        view.trail.setEnabled(false);
      }
    }

    // A mode change or match reset can drop flags entirely.
    for (const [id, view] of this.flags) {
      if (cur.flags.some((f) => f.id === id)) continue;
      disposeFlagView(view);
      this.flags.delete(id);
    }
  }

  private createFlagView(flag: FlagSnapshot): FlagView {
    const id: EntityId = flag.id;
    // Team identity (not viewer allegiance) keeps both physical banners
    // consistently blue/red in replays, spectators and split-screen.
    const colour = flag.team === 1 ? new Color3(1.0, 0.18, 0.28) : new Color3(0.12, 0.62, 1.0);
    const root = new TransformNode(`flag.${id}`, this.scene);
    root.parent = this.root;

    const poleMaterial = new StandardMaterial(`mat.flagPole.${id}`, this.scene);
    poleMaterial.diffuseColor = new Color3(0.16, 0.2, 0.27);
    poleMaterial.specularColor = new Color3(0.72, 0.8, 0.92);
    poleMaterial.specularPower = 96;
    const pole = MeshBuilder.CreateCylinder(`flagPole.${id}`, { diameter: 0.22, height: 7.2, tessellation: 8 }, this.scene);
    pole.material = poleMaterial;
    pole.position.y = 0.1;
    pole.isPickable = false;
    pole.parent = root;

    const stand = MeshBuilder.CreateCylinder(`flagStand.${id}`, { diameter: 2.5, height: 0.32, tessellation: 12 }, this.scene);
    stand.material = poleMaterial;
    stand.position.y = -3.65;
    stand.isPickable = false;
    stand.parent = root;

    const bannerMaterial = new StandardMaterial(`mat.flagBanner.${id}`, this.scene);
    bannerMaterial.diffuseColor = colour.scale(0.34);
    bannerMaterial.emissiveColor = colour.scale(0.72);
    bannerMaterial.specularColor = colour.scale(0.4);
    bannerMaterial.specularPower = 72;
    bannerMaterial.backFaceCulling = false;
    const { banner, positions } = createFlagBanner(id, bannerMaterial, this.scene, root);
    const bannerEdge = MeshBuilder.CreateBox(
      `flagBannerEdge.${id}`,
      { width: 0.13, height: FLAG_BANNER_HEIGHT, depth: 0.1 },
      this.scene,
    );
    bannerEdge.material = bannerMaterial;
    bannerEdge.position.set(FLAG_BANNER_WIDTH, FLAG_BANNER_BASE_Y + FLAG_BANNER_HEIGHT / 2, 0);
    bannerEdge.isPickable = false;
    bannerEdge.parent = root;

    for (let i = this.sTrailVectors.length; i < TRAIL_POINTS; i++) this.sTrailVectors.push(new Vector3());
    const seed = this.sTrailVectors.slice(0, TRAIL_POINTS);
    const trail = MeshBuilder.CreateLines(
      `flagTrail.${id}`,
      { points: seed, colors: trailAlphas().map(() => colour.toColor4(1)), updatable: true },
      this.scene,
    );
    trail.color = colour;
    trail.isPickable = false;
    trail.parent = this.root;
    trail.setEnabled(false);
    // The fade lives in the VERTEX COLOURS, written once: the ribbon's shape
    // changes every frame but its gradient never does, so there is nothing to
    // recompute on the hot path.
    if (trail.getVerticesData("color")) {
      trail.setVerticesData(
        "color",
        trailAlphas().flatMap((a) => [colour.r, colour.g, colour.b, a]),
        true,
      );
    }

    const radius = beaconRadius(flag.baseRadius);
    const beaconMat = new StandardMaterial(`mat.flagBeacon.${id}`, this.scene);
    beaconMat.diffuseColor = Color3.Black();
    // A little specular is what sells "shiny" rather than "coloured fog".
    beaconMat.specularColor = colour.scale(0.35);
    beaconMat.specularPower = 96;
    beaconMat.emissiveColor = colour;
    beaconMat.alpha = beaconPulse(0, beaconPhase(id)).alpha;
    // Rim glow, clear middle — the objective-beacon look. The fresnel ramps
    // emission and opacity toward grazing angles, so the shell reads as a hard
    // bubble from outside while the fight inside it stays legible.
    beaconMat.emissiveFresnelParameters = fresnel(colour, colour.scale(0.12), 0.2, 2.6);
    beaconMat.opacityFresnelParameters = fresnel(
      new Color3(1, 1, 1),
      new Color3(0.3, 0.3, 0.3),
      0.1,
      2.2,
    );
    // Both faces, because a shell you can fly INTO must not vanish from inside.
    beaconMat.backFaceCulling = false;
    // Never write depth: this thing is bigger than the fight it contains, and a
    // depth-writing transparent shell would punch holes in the trails and
    // particles drawn inside it.
    beaconMat.disableDepthWrite = true;

    const beacon = MeshBuilder.CreateSphere(
      `flagBeacon.${id}`,
      { diameter: radius * 2, segments: 20 },
      this.scene,
    );
    beacon.material = beaconMat;
    beacon.isPickable = false;
    beacon.parent = this.root;
    // The base never moves, so this is the only position write it ever needs.
    beacon.position.set(flag.home.x, flag.home.y, flag.home.z);

    return {
      root,
      pole,
      stand,
      banner,
      bannerEdge,
      bannerPositions: positions,
      poleMaterial,
      bannerMaterial,
      scale: flag.state === "carried" ? 0.68 : 1,
      tilt: flag.state === "dropped" ? 1.08 : 0,
      standScale: flag.state === "home" ? 1 : 0,
      bannerClockMs: 0,
      bannerUpdateMs: FLAG_BANNER_WAVE_MS,
      trail,
      beacon,
      beaconMaterial: beaconMat,
      beaconPhase: beaconPhase(id),
      team: flag.team,
    };
  }

  private createAsteroidView(a: AsteroidSnapshot): AsteroidView | undefined {
    const cfg = this.configs.get<AsteroidConfig>("asteroid", a.configId);
    if (!cfg) {
      log.warn(`unknown asteroid config ${a.configId}`);
      return undefined;
    }
    // GLB master when the model has landed, procedural rock otherwise; the
    // registry hands back the factor that turns the sim's collider radius into
    // instance scaling either way, because a model master already has its
    // authored `modelScale` baked into its vertices.
    const { mesh: master, radiusScale } = this.assets.getAsteroidMaster(cfg.render);
    const scale = a.radius * radiusScale;
    const instance = master.createInstance(`asteroid.${a.id}`);
    instance.scaling.setAll(scale);
    instance.rotationQuaternion = Quaternion.Identity();
    // Authored altitude (BUBBLE.md §E gives placements a `y`); asteroids never
    // move, so this is the one and only time it is written.
    instance.position.set(a.pos.x, a.pos.y, a.pos.z);
    instance.isPickable = false;
    instance.parent = this.root;
    return {
      instance,
      baseScale: scale,
      spin: asteroidSpinFor(a.id, cfg.render.spin),
      dying: false,
      dyingMs: 0,
    };
  }

  private syncProjectiles(prev: Snapshot, cur: Snapshot, alpha: number): void {
    let k = 0;
    let m = 0;
    for (let i = 0; i < cur.projectiles.length; i++) {
      const pr = cur.projectiles[i]!;
      const pool = pr.kind === "missile" ? this.missilePool : this.kineticPool;
      const idx = pr.kind === "missile" ? m++ : k++;
      const mesh = pool[idx];
      if (!mesh) continue; // pool exhausted; skip extras
      const p = findProjectile(prev, pr.id) ?? pr;
      const x = p.pos.x + (pr.pos.x - p.pos.x) * alpha;
      const y = p.pos.y + (pr.pos.y - p.pos.y) * alpha;
      const z = p.pos.z + (pr.pos.z - p.pos.z) * alpha;
      mesh.position.set(x, y, z);
      // Oriented along the 3D VELOCITY, not the replicated heading (BUBBLE.md
      // §C): a projectile's snapshot carries a scalar heading, which says nothing
      // about the vertical component a shot fired in a climb — or a homing
      // missile steering in 3D — actually has. The displacement between the two
      // snapshots does. A projectile that has not moved yet (its very first
      // snapshot) keeps the pool node's last pose for one frame, which is
      // invisible at muzzle speed and cheaper than a special case.
      const dx = pr.pos.x - p.pos.x;
      const dy = pr.pos.y - p.pos.y;
      const dz = pr.pos.z - p.pos.z;
      if (dx !== 0 || dy !== 0 || dz !== 0) {
        mesh.rotation.y = yawForDirection(dx, dz);
        mesh.rotation.x = pitchForDirection(dx, dy, dz);
      } else {
        mesh.rotation.y = meshYawFor(pr.heading);
        mesh.rotation.x = 0;
      }
      mesh.setEnabled(true);
    }
    for (let i = k; i < this.kineticPool.length; i++) this.kineticPool[i]!.setEnabled(false);
    for (let i = m; i < this.missilePool.length; i++) this.missilePool[i]!.setEnabled(false);
  }

  /**
   * Draw a persistent beam for every module currently CHANNELLING (a
   * `fire.mode: "continuous"` weapon). Unlike a discrete shot there is no fire
   * event per tick to react to — the sim replicates a single `channeling` flag
   * per module and the beam lives for exactly as long as that flag is set, which
   * is what makes release / lock-loss look instant.
   */
  private syncChannelBeams(cur: Snapshot): void {
    this.liveChannels.clear();
    for (let s = 0; s < cur.ships.length; s++) {
      const ship = cur.ships[s]!;
      // The channel's endpoint: the ship's target when it has one, else (a
      // no-lock straight channel) a point down the nose at the module's range.
      const to =
        ship.targetId !== null ? (findShip(cur, ship.targetId) ?? findAsteroid(cur, ship.targetId) ?? null) : null;
      for (let i = 0; i < ship.modules.length; i++) {
        const m = ship.modules[i]!;
        if (!m.channeling) continue;
        if (to !== null) {
          this.sTo.set(to.pos.x, to.pos.y, to.pos.z);
        } else {
          const range = this.configs.get<ModuleConfig>("module", m.moduleId)?.fire?.range ?? 60;
          const cosPitch = Math.cos(ship.pitch);
          this.sTo.set(
            ship.pos.x + cosPitch * Math.cos(ship.heading) * range,
            ship.pos.y + Math.sin(ship.pitch) * range,
            ship.pos.z + cosPitch * Math.sin(ship.heading) * range,
          );
        }
        const key = ship.id * CHANNEL_KEY_STRIDE + m.hardpointIndex;
        let slot = this.channelBeams.get(key);
        if (!slot) {
          slot = firstFreeBeam(this.beamPool);
          if (!slot) continue; // pool exhausted this frame — acceptable, no alloc
          this.channelBeams.set(key, slot);
        }
        this.sFrom.set(ship.pos.x, ship.pos.y, ship.pos.z);
        this.orientBeam(slot.mesh, this.sFrom, this.sTo);
        slot.life = slot.maxLife;
        slot.mesh.setEnabled(true);
        (slot.mesh.material as StandardMaterial).alpha = 1;
        this.liveChannels.add(key);
      }
    }
    if (this.channelBeams.size === this.liveChannels.size) return;
    for (const key of [...this.channelBeams.keys()]) {
      // Unpin only: the slot keeps its remaining life and fades out normally.
      if (!this.liveChannels.has(key)) this.channelBeams.delete(key);
    }
  }

  private updateBeams(frameDtMs: number): void {
    for (let i = 0; i < this.beamPool.length; i++) {
      const b = this.beamPool[i]!;
      if (b.life <= 0) continue;
      b.life -= frameDtMs;
      if (b.life <= 0) {
        b.mesh.setEnabled(false);
        continue;
      }
      (b.mesh.material as StandardMaterial).alpha = b.life / b.maxLife;
    }
  }

  /** Pooled explosion bursts — exposed for the dev probe and quality checks. */
  get explosionFx(): ExplosionFx {
    return this.explosions;
  }

  /** Live juice state for `window.__debug.viewManager` (dev verification). */
  get juiceDebug(): { hitFlashActive: number; explosionParticles: boolean; shieldsUp: number } {
    let shieldsUp = 0;
    for (const view of this.ships.values()) if (view.rig?.shieldVisible) shieldsUp++;
    return {
      hitFlashActive: this.hitFlash.activeCount,
      explosionParticles: this.explosions.particlesEnabled,
      shieldsUp,
    };
  }

  /** The Babylon node a picked mesh belongs to → sim entity id, if it's a ship. */
  entityIdForMesh(meshName: string): EntityId | null {
    for (const [id, view] of this.ships) {
      if (view.node.name === meshName) return id;
    }
    return null;
  }

  dispose(): void {
    for (const v of this.ships.values()) {
      v.rig?.dispose();
      v.node.dispose();
    }
    this.ships.clear();
    for (const v of this.asteroids.values()) v.instance.dispose();
    this.asteroids.clear();
    for (const v of this.decoys.values()) disposeDecoyView(v);
    this.decoys.clear();
    for (const v of this.flags.values()) disposeFlagView(v);
    this.flags.clear();
    for (const m of this.kineticPool) m.dispose();
    for (const m of this.missilePool) m.dispose();
    for (const b of this.beamPool) {
      b.mesh.material?.dispose();
      b.mesh.dispose();
    }
    this.kineticPool.length = 0;
    this.missilePool.length = 0;
    this.beamPool.length = 0;
    this.channelBeams.clear();
    this.liveChannels.clear();
    for (const master of this.poolMasters) {
      master.material?.dispose();
      master.dispose();
    }
    this.poolMasters.length = 0;
    this.hitFlash.dispose();
    this.explosions.dispose();
    this.heroShip?.dispose();
    this.heroKeyLight?.dispose();
    this.heroRimLight?.dispose();
    this.heroPedestal?.dispose();
    this.heroPedestalMaterial?.dispose();
    this.heroRoot.dispose();
    this.assets.dispose();
    this.root.dispose();
  }

  /** Drop and re-create both projectile pools in the current instancing mode. */
  private rebuildPools(): void {
    for (const m of this.kineticPool) m.dispose();
    for (const m of this.missilePool) m.dispose();
    this.kineticPool.length = 0;
    this.missilePool.length = 0;
    const [kMaster, mMaster] = this.poolMasters;
    if (kMaster) this.fillPool(kMaster, "proj.kinetic", this.kineticPool);
    if (mMaster) this.fillPool(mMaster, "proj.missile", this.missilePool);
  }
}

/**
 * The single place a flag view is torn down — both exit routes (a flag leaving
 * the snapshot, and view teardown) go through here so a material can never be
 * leaked by one of them drifting out of step with the other.
 */
function disposeFlagView(view: FlagView): void {
  view.bannerMaterial.dispose();
  view.poleMaterial.dispose();
  view.banner.dispose();
  view.bannerEdge.dispose();
  view.pole.dispose();
  view.stand.dispose();
  view.trail.dispose();
  view.beaconMaterial.dispose();
  view.beacon.dispose();
  view.root.dispose();
}

function disposeDecoyView(view: DecoyView): void {
  view.canister.dispose();
  view.collar.dispose();
  view.canisterMaterial.dispose();
  view.collarMaterial.dispose();
  view.root.dispose();
}

/** Build one small, updatable cloth grid. It is deliberately not shared: each
 * flag needs its own wave phase and colour, while there are only two flags. */
function createFlagBanner(
  id: EntityId,
  material: StandardMaterial,
  scene: Scene,
  parent: TransformNode,
): { banner: Mesh; positions: Float32Array } {
  const vertexCount = FLAG_BANNER_COLUMNS * FLAG_BANNER_ROWS;
  const positions = new Float32Array(vertexCount * 3);
  const indices: number[] = [];
  for (let row = 0; row < FLAG_BANNER_ROWS - 1; row++) {
    for (let column = 0; column < FLAG_BANNER_COLUMNS - 1; column++) {
      const a = row * FLAG_BANNER_COLUMNS + column;
      const b = a + 1;
      const c = a + FLAG_BANNER_COLUMNS;
      indices.push(a, c, b, b, c, c + 1);
    }
  }
  const normals = new Float32Array(positions.length);
  writeFlagBanner(positions, 0, id);
  VertexData.ComputeNormals(positions, indices, normals);
  const data = new VertexData();
  data.positions = positions;
  data.indices = indices;
  data.normals = normals;
  const banner = new Mesh(`flagBanner.${id}`, scene);
  data.applyToMesh(banner, true);
  banner.material = material;
  banner.isPickable = false;
  banner.parent = parent;
  // Seed vertices before the first render, so a just-created flag never shows
  // as a single point for one frame.
  banner.updateVerticesData(VertexBuffer.PositionKind, positions, false, false);
  return { banner, positions };
}

function updateFlagBanner(view: FlagView): void {
  writeFlagBanner(view.bannerPositions, view.bannerClockMs, view.team);
  view.banner.updateVerticesData(VertexBuffer.PositionKind, view.bannerPositions, false, false);
  // The hem follows the outer edge's average displacement. It shares the
  // banner's emissive material, giving the waving silhouette a small readable
  // glow without a second material or texture.
  const top = ((FLAG_BANNER_ROWS - 1) * FLAG_BANNER_COLUMNS + FLAG_BANNER_COLUMNS - 1) * 3 + 2;
  const bottom = (FLAG_BANNER_COLUMNS - 1) * 3 + 2;
  view.bannerEdge.position.z = (view.bannerPositions[top]! + view.bannerPositions[bottom]!) * 0.5;
}

/** Writes a gently travelling ripple into the preallocated position buffer. */
function writeFlagBanner(positions: Float32Array, clockMs: number, phaseSeed: number): void {
  const time = clockMs * 0.001;
  let offset = 0;
  for (let row = 0; row < FLAG_BANNER_ROWS; row++) {
    const y = FLAG_BANNER_BASE_Y + (row / (FLAG_BANNER_ROWS - 1)) * FLAG_BANNER_HEIGHT;
    for (let column = 0; column < FLAG_BANNER_COLUMNS; column++) {
      const along = column / (FLAG_BANNER_COLUMNS - 1);
      positions[offset++] = along * FLAG_BANNER_WIDTH;
      positions[offset++] = y;
      // Fixed at the pole; the free edge has the most motion. The phase seed
      // prevents blue and red fabric folding in exact unison.
      positions[offset++] = Math.sin(time * 2.1 + along * 4.8 + row * 0.42 + phaseSeed) * 0.42 * along;
    }
  }
}

/** A `FresnelParameters` with `left` at grazing angles and `right` head-on. */
function fresnel(left: Color3, right: Color3, bias: number, power: number): FresnelParameters {
  const f = new FresnelParameters();
  f.isEnabled = true;
  f.leftColor = left;
  f.rightColor = right;
  f.bias = bias;
  f.power = power;
  return f;
}

function findAsteroid(snap: Snapshot, id: EntityId): AsteroidSnapshot | undefined {
  for (let i = 0; i < snap.asteroids.length; i++) if (snap.asteroids[i]!.id === id) return snap.asteroids[i];
  return undefined;
}

function findDecoy(snap: Snapshot, id: EntityId): DecoySnapshot | undefined {
  for (let i = 0; i < snap.decoys.length; i++) if (snap.decoys[i]!.id === id) return snap.decoys[i];
  return undefined;
}

function firstFreeBeam(pool: readonly BeamSlot[]): BeamSlot | undefined {
  for (let i = 0; i < pool.length; i++) if (pool[i]!.life <= 0) return pool[i];
  return undefined;
}

function findShip(snap: Snapshot, id: EntityId): ShipSnapshot | undefined {
  for (let i = 0; i < snap.ships.length; i++) if (snap.ships[i]!.id === id) return snap.ships[i];
  return undefined;
}

function findProjectile(snap: Snapshot, id: EntityId): ProjectileSnapshot | undefined {
  for (let i = 0; i < snap.projectiles.length; i++)
    if (snap.projectiles[i]!.id === id) return snap.projectiles[i];
  return undefined;
}
