import {
  Color3,
  Mesh,
  MeshBuilder,
  PointLight,
  Quaternion,
  StandardMaterial,
  TransformNode,
  Vector3,
  type InstancedMesh,
  type Scene,
} from "@babylonjs/core";
import {
  bodyYawDelta,
  createLogger,
  evalSignal,
  facingVec,
  hardpointsOf,
  interpolateFrame,
  type SignalId,
  type AsteroidConfig,
  type AsteroidSnapshot,
  type ConfigService,
  type DecoySnapshot,
  type EffectConfig,
  type EntityId,
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
import { setThrustGlow } from "../core/thrustGlow.js";
import { pinInstanceLod0 } from "../core/modelLod.js";
import { cosmeticById } from "./cosmetics.js";
import { cosmeticIdOf, ShipPaintBank } from "./shipPaint.js";
import { ShipSocketRig } from "./ShipSocketRig.js";
import { createFlagViews, type FlagViews } from "./flagView.js";
import { resolveSoundId } from "../audio/soundIds.js";
import { ExplosionFx } from "./juice/ExplosionFx.js";
import { SparkFx } from "./juice/SparkFx.js";
import { GeometryProbe } from "./juice/geometryImpact.js";
import { HitFlashPool } from "./juice/HitFlash.js";
import {
  MISSILE_IMPACT_SCALE,
  explosionEffectIdFor,
  juiceSettingsOf,
  missileImpactEffectIdsFor,
  sparkEffectIdFor,
  viewRelationOf,
  type JuiceSettings,
} from "./juice/juiceSettings.js";
import { buildMissileMaster } from "./missileMesh.js";
import {
  approachRoll,
  bankRollFor,
  meshYawFor,
  pitchForDirection,
  yawForDirection,
} from "./shipOrientation.js";
import {
  rockOrientationAt,
  rockSpinFor,
  type RockSpin,
} from "./asteroidSpin.js";
import { mvpPresentationSettings } from "./hud/matchPresentation.js";

const log = createLogger("ViewManager");

const ASTEROID_DEATH_MS = 260;

/**
 * How long a hull stays flagged as "the sim just reported a hit here" while the
 * view looks for the missile that caused it (see {@link ViewManager.detonateMissile}).
 *
 * It exists because the two halves of the story arrive on independent streams:
 * the `damage` / `shieldAbsorb` EVENT and the state patch that removes the
 * missile are separate messages online, and either can land a frame or two
 * before the other. A window of a few frames absorbs that skew; making it much
 * longer would start pairing a missile that expired on its own with an unrelated
 * gun hit on a hull it happened to drift past.
 */
const MISSILE_HIT_WINDOW_MS = 260;

/** Collider radius the sim gives travelling ordnance (`shared/src/sim/spawn.ts`). */
const PROJECTILE_RADIUS = 0.4;

/**
 * How far AHEAD of its last flying position a shot is searched for the floor.
 *
 * The regolith disc is a client-side mesh: the sim has no collider for it, so a
 * round fired at the ground keeps flying until it is a full
 * `tuning.projectileBoundsMargin` BELOW the floor (20 units, shipped) or its
 * lifetime runs out — its despawn point says nothing about where it went in.
 * The view therefore looks ahead once, on the frame the shot drops below the
 * terrain's ceiling, and remembers the crossing until the shot reaches it.
 *
 * 48 units is about ten ticks of cannon travel and covers any descent steeper
 * than roughly 5°. A shot skimming the surface flatter than that keeps its
 * round silent rather than paying for a second cast.
 */
const GROUND_PROBE_AHEAD = 48;

/** Hull radius assumed when the session cannot resolve a ship's config. */
const FALLBACK_SHIP_RADIUS = 1.5;

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
  /** Local entity keeps full ship effects and LOD0. */
  playerId?: EntityId;
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
  /**
   * The cosmetic this instance was built for (contract §5). A paint changes the
   * MASTER an instance comes from, so a snapshot that reports a different one
   * has to rebuild the view rather than restyle it — which is also why online
   * paint arriving a tick after the ship does still lands.
   */
  cosmeticId: string | null;
  /** Signal driving the hull's emissive light (render.emissiveGlow); null = none. */
  glowSource: SignalId | null;
}

interface AsteroidView {
  instance: InstancedMesh;
  /** Instance scaling at full size — NOT the collider radius, see `getAsteroidMaster`. */
  baseScale: number;
  /** Stable id-derived axis, pace, and direction; allocated once with the view. */
  spin: RockSpin;
  /** Authored placement yaw, held under the tumble. */
  baseRotationY: number;
  dying: boolean;
  dyingMs: number;
}

/** A jettisoned countermeasure pod: deliberately not pickable or target-bracketable. */
interface DecoyView {
  root: TransformNode;
  canister: Mesh;
  collar: Mesh;
  canisterMaterial: StandardMaterial;
  collarMaterial: StandardMaterial;
  tumblePhase: number;
}

interface BeamSlot {
  mesh: Mesh;
  life: number; // ms remaining
  maxLife: number;
  /**
   * Milliseconds until this beam may throw its next spark. Only a CHANNELLING
   * beam uses it (a discrete shot sparks once, on its own fire event); it is
   * zeroed when a channel pins the slot so the burn starts sparking at once.
   */
  sparkMs: number;
}

/**
 * One shot the view is currently drawing, kept so that its DISAPPEARANCE can be
 * read as an impact. The sim has no projectile-impact event — ordnance that
 * lands is simply `applyDamageToShip` (or nothing at all, for a static prop)
 * followed by `destroyEntity` — so the view pairs the things it does get: a
 * hull the sim says was just hit, a shot that stopped existing next to it, and
 * the arena geometry along the line it was travelling.
 *
 * Warheads detonate ({@link MISSILE_IMPACT_SCALE}); gun rounds spark.
 */
interface ProjectileTrack {
  /** Last authoritative snapshot position — the impact point, to within a tick. */
  x: number;
  y: number;
  z: number;
  /** Unit travel direction over the last snapshot pair; zero before it moves. */
  dx: number;
  dy: number;
  dz: number;
  /**
   * Distance covered between the last two snapshots. The sim destroys a shot on
   * the tick it hits, so the tracked position trails the hull by up to one tick
   * of travel; this is exactly that slack, measured rather than guessed.
   */
  step: number;
  /** Sweep counter this track was last seen in — see `projectileSweep`. */
  seen: number;
  /** A warhead rather than a gun round. */
  missile: boolean;
  /**
   * Floor crossing found by the one look-ahead this shot gets
   * ({@link GROUND_PROBE_AHEAD}), drawn only once the shot has actually
   * travelled that far — a spark must never appear ahead of the round making it.
   */
  hasGround: boolean;
  groundX: number;
  groundY: number;
  groundZ: number;
  /** The look-ahead is spent (hit or miss), so it is never cast twice. */
  probedGround: boolean;
  /** An impact was already drawn for this shot; its despawn draws nothing more. */
  spent: boolean;
}

/**
 * An entity the sim reported taking a hit, and what hit it. The window is the
 * "was that a hit or did it just run out of fuel?" answer for a shot that
 * vanished nearby; the damage type is what decides which spark it throws —
 * straight from `module.fire.damageType`, via the event the sim already emits.
 */
interface HitWindow {
  /** Milliseconds left on {@link MISSILE_HIT_WINDOW_MS}. */
  ms: number;
  damageType: string;
}

/** Everything ViewManager reads off the active quality tier (§10 5.6). */
export type ViewQuality = Pick<QualityConfig, "projectiles" | "particles" | "asteroids"> & {
  scene?: QualityConfig["scene"];
};

const DEFAULT_VIEW_QUALITY: ViewQuality = {
  projectiles: { useInstances: true },
  particles: { enabled: true, budgetMultiplier: 1, maxEmitterCapacity: 80 },
  asteroids: { lodMediumDistance: 0, lodLowDistance: 0, lodCullDistance: 0 },
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
  /** Painted hull masters for the cosmetics on screen (contract §5). */
  private readonly paint: ShipPaintBank;
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
  /** Visible burning countermeasure pods. The sim already replicates their full lifetime. */
  private readonly decoys = new Map<EntityId, DecoyView>();
  /**
   * Capture-the-flag flags, their wakes and their base beacons — a self-
   * contained family that shares nothing with the rest of the view but the
   * root node it hangs off (see `flagView.ts`).
   */
  private readonly flags: FlagViews;
  /**
   * The team the viewer flies for. Physical flag colours are team-stable and
   * ignore it, but the SHIELD BUBBLES do not: it is what decides whether a hull
   * on screen wears the friendly blue shell or the enemy red one. Callers may
   * set it on match join; {@link syncShips} also latches it off the local ship
   * whenever the snapshot carries one, so a session that never called the
   * setter still colours correctly — and a dead player keeps the last value
   * rather than watching the whole arena turn friendly mid-respawn.
   */
  private playerTeam: number | null = null;

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

  /** Live shots by entity id; a track that stops being seen has landed (or expired). */
  private readonly projectileTracks = new Map<EntityId, ProjectileTrack>();
  /**
   * Entities the sim reported taking a hit. Written by `consumeEvents`, read
   * when a shot vanishes — this is the "was that a hit or did it just run out
   * of fuel?" answer, taken from the sim rather than re-derived in the view.
   */
  private readonly recentHits = new Map<EntityId, HitWindow>();
  /** Monotonic per-frame counter used to mark projectile tracks as still present. */
  private projectileSweep = 0;
  /**
   * World Y of the arena floor's ceiling, refreshed once a frame while shots are
   * in the air. `-Infinity` in every arena with no floor mesh, which turns the
   * ground look-ahead into a single failed float comparison per shot.
   */
  private groundCeilingY = Number.NEGATIVE_INFINITY;
  /** Effect ids already reported missing, so a bad content pack warns once. */
  private readonly missingEffects = new Set<string>();

  private readonly poolSize: number;
  private quality: ViewQuality;

  // --- juice (§10 5.7) ---
  private juice: JuiceSettings;
  private readonly hitFlash: HitFlashPool;
  private readonly explosions: ExplosionFx;
  /** Weapon impact sprays — its own small ring, see {@link SparkFx}. */
  private readonly sparks: SparkFx;
  /** Ray casts against the arena's own scenery, rationed per frame. */
  private readonly geometry: GeometryProbe;
  private readonly playSound: PlaySound | null;
  private readonly localPlayerId: EntityId | null;

  // Reused scratch — no per-frame allocation.
  private readonly sFrom = new Vector3();
  private readonly sTo = new Vector3();
  /**
   * Where the last resolved shot hit an entity, and what hit it. A scratch
   * record rather than a returned object: rounds land several times a second
   * per gun, and none of them should cost an allocation.
   */
  private readonly sImpact: { x: number; y: number; z: number; damageType: string | null } = {
    x: 0,
    y: 0,
    z: 0,
    damageType: null,
  };
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
    this.paint = new ShipPaintBank(scene, configs);
    this.root = new TransformNode("viewRoot", scene);
    this.heroRoot = new TransformNode("mvpHeroRoot", scene);
    this.heroRoot.setEnabled(false);
    this.quality = quality;
    // Shares `viewRoot`, so `setVisible` hides the flags with everything else.
    this.flags = createFlagViews(scene, quality, this.root);

    const tuning = configs.getAll<TuningConfig>("tuning")[0];
    this.poolSize = tuning?.projectilePoolSize ?? 64;

    this.juice = options.juice ?? juiceSettingsOf(configs.get<ThemeConfig>("theme", THEME_ID));
    this.playSound = options.playSound ?? null;
    this.localPlayerId = options.playerId ?? null;
    this.hitFlash = new HitFlashPool(scene, this.root, this.juice.hitFlash);
    this.explosions = new ExplosionFx(scene, this.juice.explosions, quality.particles, this.root);
    this.sparks = new SparkFx(scene, quality.particles);
    this.geometry = new GeometryProbe(scene);

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
    // mid-match at the new particle budget with nothing visibly popping. The
    // spark ring is shorter-lived still, so the same holds twice over.
    this.explosions.setQuality(quality.particles);
    this.sparks.setQuality(quality.particles);
    // The beacon shells re-read their cull distance every frame, so this only
    // has to hand the family the new tier — nothing is rebuilt.
    this.flags.setQuality(quality);
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

    // Missile: a modelled warhead — body, nose cone, cruciform fins and an
    // exhaust plume, merged into one instanced mesh with its nose on +Z (see
    // `missileMesh.ts` for the geometry and the one-material rationale).
    const mMaster = buildMissileMaster(this.scene);
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
      this.beamPool.push({ mesh: m, life: 0, maxLife: this.beamFadeMs, sparkMs: 0 });
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
        this.markHit(ev.targetId, ev.damageType);
      } else if (ev.type === "shieldAbsorb") {
        // The absorb is the ONLY thing that lights a shield bubble: its idle
        // pose is near-transparent, so a shell only becomes legible while it is
        // actually stopping fire (§10 5.7, owner note 2026-08-14).
        this.ships.get(ev.targetId)?.rig?.shieldImpact();
        // A missile stopped by a shield still detonated: the warhead going off
        // on the bubble is exactly what tells the pilot the shield earned its
        // energy, so an absorb arms the detonation window like raw damage does.
        this.markHit(ev.targetId, ev.damageType);
      } else if (ev.type === "entityDestroyed") {
        if (ev.isAsteroid) {
          const v = this.asteroids.get(ev.entityId);
          if (v && !v.dying) {
            v.dying = true;
            v.dyingMs = ASTEROID_DEATH_MS;
          }
        }
        this.explode(ev, cur);
      }
    }
  }

  /** Pop a hit flash on the damaged entity's view (§10 5.7). */
  private flashHit(targetId: EntityId, isAsteroid: boolean): void {
    if (isAsteroid) return; // asteroid hits already read through the death puff
    const view = this.ships.get(targetId);
    if (!view) return;
    const radius = this.shipConfigFor(targetId)?.collider.radius ?? FALLBACK_SHIP_RADIUS;
    // The live view node already carries the ship's altitude (BUBBLE.md §C).
    this.hitFlash.flash(view.node.position.x, view.node.position.y, view.node.position.z, radius);
  }

  /**
   * Open (or reopen) an entity's impact-matching window — see `recentHits`. The
   * existing window is MUTATED when there is one, so a target under sustained
   * fire allocates once and not once per landing round.
   */
  private markHit(targetId: EntityId, damageType: string): void {
    const open = this.recentHits.get(targetId);
    if (open) {
      open.ms = MISSILE_HIT_WINDOW_MS;
      open.damageType = damageType;
      return;
    }
    this.recentHits.set(targetId, { ms: MISSILE_HIT_WINDOW_MS, damageType });
  }

  /**
   * Explosion variant for a destroyed entity (§10 5.7): the effect id comes from
   * the theme's `juice.explosions` map (asteroid / per ship class), the particle
   * budget from the active quality tier, and the SOUND from that same effect
   * config's `sound` field — so a new variant is one content file, not code.
   *
   * The authoritative position rides on the event because a destroyed ship may
   * already be gone from both `cur.ships` and the Babylon view when it drains.
   */
  private explode(ev: Extract<SimEvent, { type: "entityDestroyed" }>, cur: Snapshot): void {
    const { entityId, isAsteroid } = ev;
    const shipClass = isAsteroid ? null : (this.shipConfigFor(entityId)?.class ?? null);
    const effectId = explosionEffectIdFor({ isAsteroid, shipClass }, this.juice.explosions);
    if (!effectId) return;
    const effect = this.configs.get<EffectConfig>("effect", effectId);
    if (!effect) {
      log.warn(`explosion effect not found: ${effectId}`);
      return;
    }
    // The event owns the authoritative death point. Entity/view lookup is only a
    // compatibility fallback for old/offline producers: network messages and
    // state patches are independent streams, so either may remove a view first.
    const pos = ev.pos ?? this.deathPosition(entityId, isAsteroid, cur);
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
    // Radius of whatever this beam landed on, so the spark sits on its skin
    // rather than in its middle. Zero for a shot that hit nothing.
    let hitRadius = 0;
    if (targetId !== null) {
      const to = findShip(cur, targetId) ?? findAsteroid(cur, targetId);
      if (!to) return;
      this.sTo.set(to.pos.x, to.pos.y, to.pos.z);
      hitRadius = this.targetRadiusOf(targetId, cur);
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
    this.sFrom.set(from.pos.x, from.pos.y, from.pos.z);
    // A hit sparks whether or not a beam mesh was free to draw it: the spray is
    // the part that says "this shot landed on YOU".
    if (targetId !== null) this.sparkOnBeam(hitRadius, moduleId);
    const slot = firstFreeBeam(this.beamPool);
    if (!slot) return; // pool exhausted this frame — acceptable, no alloc
    this.orientBeam(slot.mesh, this.sFrom, this.sTo);
    slot.life = slot.maxLife;
    slot.mesh.setEnabled(true);
    (slot.mesh.material as StandardMaterial).alpha = 1;
  }

  /** Collider radius of a beam's target, ship or rock. */
  private targetRadiusOf(targetId: EntityId, cur: Snapshot): number {
    if (findShip(cur, targetId)) {
      return this.shipConfigFor(targetId)?.collider.radius ?? FALLBACK_SHIP_RADIUS;
    }
    return findAsteroid(cur, targetId)?.radius ?? 0;
  }

  /**
   * Spark where the beam currently spanning `sFrom` → `sTo` touches its target:
   * on the target's skin, facing the shooter, spraying back down the beam.
   *
   * The weapon's flavour comes from the MODULE that fired it
   * (`fire.damageType`), which is the honest source for a hitscan weapon — it
   * spawns no projectile the view could have watched, and a laser must read as
   * a laser even on the frame the sim reports no damage (a shield ate it).
   */
  private sparkOnBeam(hitRadius: number, moduleId: string): void {
    const dx = this.sTo.x - this.sFrom.x;
    const dy = this.sTo.y - this.sFrom.y;
    const dz = this.sTo.z - this.sFrom.z;
    const length = Math.hypot(dx, dy, dz);
    if (length <= 1e-4) return;
    const t = Math.max(0, length - hitRadius) / length;
    const damageType = this.configs.get<ModuleConfig>("module", moduleId)?.fire?.damageType;
    this.sparkAt(
      this.sFrom.x + dx * t,
      this.sFrom.y + dy * t,
      this.sFrom.z + dz * t,
      -dx / length,
      -dy / length,
      -dz / length,
      damageType,
    );
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
    // Refill the ray budget first: everything downstream that wants to know
    // where a shot met the scenery spends from this one frame's ration.
    this.geometry.beginFrame();
    this.syncShips(prev, cur, alpha, frameDtMs);
    this.syncAsteroids(cur, frameDtMs);
    this.syncDecoys(prev, cur, alpha);
    this.flags.sync(cur, frameDtMs);
    this.syncProjectiles(prev, cur, alpha, frameDtMs);
    // Before updateBeams: a still-channelling slot gets its life refreshed here
    // and so never reaches the fade path below.
    this.syncChannelBeams(cur, frameDtMs);
    this.updateBeams(frameDtMs);
    this.hitFlash.update(frameDtMs);
    this.explosions.update(frameDtMs);
    this.sparks.update(frameDtMs);
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
    // Latch the viewer's team off their own hull while it is on the board. One
    // scan, before the sync loop, so every ship this frame is coloured against
    // the same answer; the last known value survives death and spectating.
    if (this.localPlayerId !== null) {
      const self = findShip(cur, this.localPlayerId);
      if (self) this.playerTeam = self.team;
    }
    for (let i = 0; i < cur.ships.length; i++) {
      const s = cur.ships[i]!;
      let view = this.ships.get(s.id);
      if (view && view.cosmeticId !== cosmeticIdOf(s)) {
        view.rig?.dispose();
        view.node.dispose();
        this.ships.delete(s.id);
        view = undefined;
      }
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
      view.rig?.updateEmitters(s, prevShip, nowMs);
      // Per-instance emissive light (render.emissiveGlow): signal → 10%..100%.
      if (view.glowSource) setThrustGlow(view.node, evalSignal(view.glowSource, s, prevShip));
      // Re-asserted every frame rather than cached on the view: a ship can
      // change teams (mode swaps, rejoin) and the bubble ignores a relation it
      // is already wearing, so this costs a comparison and no Babylon writes.
      view.rig?.setShieldRelation(viewRelationOf(s.id, s.team, this.localPlayerId, this.playerTeam));
      view.rig?.updateShield(s, frameDtMs);
    }
  }

  private createShipView(s: ShipSnapshot): ShipView | undefined {
    const configId = this.resolveShipConfig(s.id);
    const ship = configId ? this.configs.get<ShipConfig>("ship", configId) : undefined;
    if (!ship) {
      log.warn(`no ship config for entity ${s.id} (configId=${configId ?? "?"})`);
      return undefined;
    }
    // A painted hull instances from its own tinted master, so every ship
    // wearing that paint still batches into one draw call (contract §5).
    const cosmeticId = cosmeticIdOf(s);
    const master = this.paint.masterFor(this.assets.getShipMaster(ship.render), ship, cosmeticId);
    const node = master.createInstance(`ship.${s.id}`);
    if (s.id === this.localPlayerId) pinInstanceLod0(node);
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
      { isLocal: s.id === this.localPlayerId },
      cosmeticId ? cosmeticById(this.configs, cosmeticId) : undefined,
    );

    const glowSource: SignalId | null = ship.render.emissiveGlow ? (ship.render.emissiveGlow.source ?? "throttle") : null;
    return { node, rig, roll: 0, rollTarget: 0, quat, velocity: new Vector3(), cosmeticId, glowSource };
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
      // stops at that transition. Pose is a CLOSED FORM of match time rather
      // than an accumulation, because the sim collides against the rock's real
      // surface and has to agree about which way that surface is facing — an
      // integration here would drift away from it (and, online, would have no
      // shared starting point at all). All values are written in place.
      if (!view.dying) {
        rockOrientationAt(view.spin, view.baseRotationY, cur.elapsed, view.instance.rotationQuaternion!);
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
   * Render every replicated countermeasure pod for exactly its authoritative lifetime.
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
      const burn = 0.82 + 0.18 * Math.sin(tumble * 3.1);
      view.canisterMaterial.alpha = 0.35 + life * 0.6;
      view.canisterMaterial.emissiveColor.set(1, 0.18 + burn * 0.25, 0.015);
      view.collarMaterial.alpha = 0.25 + life * 0.7;
      view.collarMaterial.emissiveColor.set(1, 0.5 + burn * 0.3, 0.08);
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

  /**
   * Which team the viewer flies for, for callers that know it at match join.
   * Optional: {@link syncShips} latches the same value off the local ship as
   * soon as it appears in a snapshot. Setting it early only means the very
   * first frames already colour enemy shield bubbles correctly.
   */
  setPlayerTeam(team: number | null): void {
    this.playerTeam = team;
  }

  private createAsteroidView(a: AsteroidSnapshot): AsteroidView | undefined {
    const cfg = this.configs.get<AsteroidConfig>("asteroid", a.configId);
    if (!cfg) {
      log.warn(`unknown asteroid config ${a.configId}`);
      return undefined;
    }
    // A rock that authors a `shape` is tessellated from the very field the sim
    // collides against, so the drawn surface IS the collision surface. The old
    // GLB/procedural rule survives underneath for a config without one.
    const { mesh: master, radiusScale } =
      this.assets.getShapedAsteroidMaster(cfg) ?? this.assets.getAsteroidMaster(cfg.render);
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
      // Tumble keys off the PLACEMENT index, which is the identity the sim uses
      // too (`shared/src/collision/rockPose.ts`) — an entity id would not agree,
      // because online this list is rebuilt straight from the arena config.
      spin: rockSpinFor(a.placementIndex ?? a.id, cfg.render.spin),
      baseRotationY: a.rotationY ?? 0,
      dying: false,
      dyingMs: 0,
    };
  }

  private syncProjectiles(prev: Snapshot, cur: Snapshot, alpha: number, frameDtMs: number): void {
    const sweep = ++this.projectileSweep;
    let k = 0;
    let m = 0;
    // One bounding-box read for the whole frame, and only while something is
    // actually flying: the ground look-ahead is a float comparison per shot.
    this.groundCeilingY =
      cur.projectiles.length > 0 ? this.geometry.groundCeilingY : Number.NEGATIVE_INFINITY;
    for (let i = 0; i < cur.projectiles.length; i++) {
      const pr = cur.projectiles[i]!;
      const p = findProjectile(prev, pr.id) ?? pr;
      // Displacement between the two snapshots. It is the pose basis below and,
      // for a missile, how far its last known position may trail the hull it
      // detonates on — so it is computed before anything can `continue`.
      const dx = pr.pos.x - p.pos.x;
      const dy = pr.pos.y - p.pos.y;
      const dz = pr.pos.z - p.pos.z;
      // Tracked ahead of the pool lookup on purpose: a shot that finds no free
      // pool node is invisible this frame, but it must not therefore read as
      // *landed* the moment the pool frees up again.
      this.trackProjectile(pr, dx, dy, dz, sweep);
      const pool = pr.kind === "missile" ? this.missilePool : this.kineticPool;
      const idx = pr.kind === "missile" ? m++ : k++;
      const mesh = pool[idx];
      if (!mesh) continue; // pool exhausted; skip extras
      const x = p.pos.x + dx * alpha;
      const y = p.pos.y + dy * alpha;
      const z = p.pos.z + dz * alpha;
      mesh.position.set(x, y, z);
      // Oriented along the 3D VELOCITY, not the replicated heading (BUBBLE.md
      // §C): a projectile's snapshot carries a scalar heading, which says nothing
      // about the vertical component a shot fired in a climb — or a homing
      // missile steering in 3D — actually has. The displacement between the two
      // snapshots does. A projectile that has not moved yet (its very first
      // snapshot) keeps the pool node's last pose for one frame, which is
      // invisible at muzzle speed and cheaper than a special case.
      //
      // Both masters model their nose on +Z, so this is all the missile needs to
      // fly nose-first with its fins and exhaust trailing (see `missileMesh.ts`).
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
    this.sweepProjectiles(sweep, cur);
    this.ageRecentHits(frameDtMs);
  }

  /**
   * Record (or refresh) a live shot's last authoritative position and heading,
   * then give it its one look at the ground beneath it.
   */
  private trackProjectile(
    pr: ProjectileSnapshot,
    dx: number,
    dy: number,
    dz: number,
    sweep: number,
  ): void {
    const step = Math.hypot(dx, dy, dz);
    // A shot that has not moved yet keeps the direction it last had rather than
    // a zero vector, so the very first frame of a track never divides by zero.
    const inv = step > 1e-6 ? 1 / step : 0;
    let track = this.projectileTracks.get(pr.id);
    if (!track) {
      track = {
        x: pr.pos.x,
        y: pr.pos.y,
        z: pr.pos.z,
        dx: 0,
        dy: 0,
        dz: 0,
        step: 0,
        seen: sweep,
        missile: pr.kind === "missile",
        hasGround: false,
        groundX: 0,
        groundY: 0,
        groundZ: 0,
        probedGround: false,
        spent: false,
      };
      this.projectileTracks.set(pr.id, track);
    }
    track.x = pr.pos.x;
    track.y = pr.pos.y;
    track.z = pr.pos.z;
    track.step = step;
    track.seen = sweep;
    if (inv !== 0) {
      track.dx = dx * inv;
      track.dy = dy * inv;
      track.dz = dz * inv;
    }
    this.trackGround(track);
  }

  /**
   * The floor is the one thing a shot can hit that the SIM never sees: the
   * regolith disc is a client mesh, so a round fired into it keeps flying (and
   * keeps being replicated) until it is far below the surface. Waiting for the
   * despawn would put the spark twenty units underground.
   *
   * So the view looks ahead ONCE, on the first frame the shot is below the
   * floor's ceiling and descending, remembers the crossing it finds, and draws
   * it only when the round has actually flown that far. A shot that dies before
   * reaching it — lifetime, or the arena limit — never touched the ground and
   * draws nothing.
   */
  private trackGround(track: ProjectileTrack): void {
    if (track.spent) return;
    if (track.hasGround) {
      // Reached (or passed) the crossing? Measured along its own travel, so a
      // homing missile curving away from the ground never trips it.
      const ahead =
        (track.groundX - track.x) * track.dx +
        (track.groundY - track.y) * track.dy +
        (track.groundZ - track.z) * track.dz;
      if (ahead > 0) return;
      track.spent = true;
      this.drawImpact(track, track.groundX, track.groundY, track.groundZ, null);
      return;
    }
    if (track.probedGround || track.step <= 0 || track.dy >= 0) return;
    if (!(track.y <= this.groundCeilingY)) return;
    track.probedGround = true;
    // Cast from where it was a tick ago: a shot already through the surface on
    // the frame it entered the band still gets its crossing found behind it.
    const point = this.geometry.probe(
      track.x - track.dx * track.step,
      track.y - track.dy * track.step,
      track.z - track.dz * track.step,
      track.dx,
      track.dy,
      track.dz,
      track.step + GROUND_PROBE_AHEAD,
    );
    if (!point) return;
    track.hasGround = true;
    track.groundX = point.x;
    track.groundY = point.y;
    track.groundZ = point.z;
    // The crossing may already be behind this frame's position — resolve it now
    // rather than a frame late.
    this.trackGround(track);
  }

  /** Retire shots that left this frame's snapshot, drawing the ones that landed. */
  private sweepProjectiles(sweep: number, cur: Snapshot): void {
    for (const [id, track] of this.projectileTracks) {
      if (track.seen === sweep) continue;
      this.projectileTracks.delete(id);
      if (track.spent) continue; // already drawn where it met the ground
      this.resolveDespawn(track, cur);
    }
  }

  /**
   * A shot left the snapshot. Ordnance despawns for four reasons — it hit
   * something the sim damages, it stopped against solid scenery, its lifetime
   * ran out, or it crossed the arena limit — and only the first two draw.
   *
   * The order is evidence-first: the sim's own damage report wins, because it
   * is authoritative about WHAT was hit and with what damage type. Failing
   * that, the view asks the scene whether the shot's last travel crossed any
   * arena geometry. Failing THAT, nothing is drawn: the arena boundary is not
   * in the geometry set at all (see {@link GeometryProbe}), so a round expiring
   * against the play-area limit is silent by construction rather than by a
   * special case that could drift out of step with the bounds shape.
   */
  private resolveDespawn(track: ProjectileTrack, cur: Snapshot): void {
    if (this.entityImpactPoint(track, cur)) {
      const hit = this.sImpact;
      this.drawImpact(track, hit.x, hit.y, hit.z, hit.damageType);
      return;
    }
    const point = this.probeSolid(track);
    if (point) this.drawImpact(track, point.x, point.y, point.z, null);
  }

  /**
   * Where the shot met solid arena scenery on the travel it was never seen
   * finishing, or null.
   *
   * The cast starts one observed tick BEHIND the last known position: the sim
   * destroys a round on the tick it lands, and starting behind means the first
   * crossing found is the face it went into rather than the far wall of the
   * rock it is now inside.
   */
  private probeSolid(track: ProjectileTrack): Vector3 | null {
    if (track.step <= 0) return null;
    return this.geometry.probe(
      track.x - track.dx * track.step,
      track.y - track.dy * track.step,
      track.z - track.dz * track.step,
      track.dx,
      track.dy,
      track.dz,
      track.step * 2.35 + PROJECTILE_RADIUS,
    );
  }

  /**
   * Draw what this shot landing looks like: a warhead detonates, a gun round
   * sparks in its weapon's colour, spraying back the way it came.
   *
   * `damageType` is the sim's own report when there is one (a hull or rock the
   * sim damaged); for scenery there is no event to read, so it is null and the
   * spark falls back to the kinetic spray — which is what a gun round is,
   * energy weapons in this game being hitscan beams that spawn no projectile.
   */
  private drawImpact(
    track: ProjectileTrack,
    x: number,
    y: number,
    z: number,
    damageType: string | null,
  ): void {
    if (track.missile) {
      this.detonateAt(x, y, z);
      return;
    }
    this.sparkAt(x, y, z, -track.dx, -track.dy, -track.dz, damageType ?? undefined);
  }

  /**
   * A warhead going off at a point.
   *
   * This reuses the pooled {@link ExplosionFx} the ship-death burst runs on —
   * same slots, same particle budget, same quality tier — at
   * {@link MISSILE_IMPACT_SCALE} and against the smaller `fx.missile-impact`
   * effect, so a warhead can never be mistaken for a hull coming apart.
   */
  private detonateAt(x: number, y: number, z: number): void {
    const effect = this.missileImpactEffect();
    if (!effect) return;
    this.explosions.burst(effect, x, z, y, undefined, MISSILE_IMPACT_SCALE);
    // Audio is not a quality-tier concern: a low tier drops particles, never the bang.
    const soundId = resolveSoundId(effect.sound);
    if (soundId) this.playSound?.(soundId);
  }

  /**
   * One weapon-impact spray at a world point, thrown along `ax/ay/az`.
   *
   * Which effect it is comes from the damage type
   * ({@link sparkEffectIdFor}) and everything about how it LOOKS comes from
   * that effect's content file, so telling a laser strike from a cannon strike
   * at a glance is a content decision, not a code one.
   */
  private sparkAt(
    x: number,
    y: number,
    z: number,
    ax: number,
    ay: number,
    az: number,
    damageType?: string,
  ): void {
    if (!this.sparks.particlesEnabled) return;
    if (!this.withinEffectRange(x, y, z)) return;
    const id = sparkEffectIdFor(damageType, this.juice.sparks);
    if (!id) return;
    const effect = this.configs.get<EffectConfig>("effect", id);
    if (!effect) {
      if (!this.missingEffects.has(id)) {
        this.missingEffects.add(id);
        log.warn(`impact spark effect not found: ${id}`);
      }
      return;
    }
    this.sparks.burst(effect, x, y, z, ax, ay, az);
  }

  /**
   * Whether a decorative burst at this point is close enough to be worth
   * drawing, against the SAME tier knob that stops distant ship emitters
   * (`quality.particles.shipEffectCullDistance`). It also gates the ray casts
   * behind it: a strike nobody can see is not worth a triangle test either.
   */
  private withinEffectRange(x: number, y: number, z: number): boolean {
    const cull = this.quality.particles.shipEffectCullDistance;
    if (!cull) return true;
    const camera = this.scene.activeCamera;
    if (!camera) return true;
    camera.computeWorldMatrix();
    const eye = camera.globalPosition;
    const dx = eye.x - x;
    const dy = eye.y - y;
    const dz = eye.z - z;
    return dx * dx + dy * dy + dz * dz <= cull * cull;
  }

  /**
   * Resolve where a vanished shot hit something the SIM damaged, writing the
   * point (and what hit it) into {@link sImpact}; returns whether it found one.
   *
   * The candidate set is exactly the entities the sim said were hit inside
   * {@link MISSILE_HIT_WINDOW_MS}; among those, the shot landed on the nearest
   * one it could physically have reached — its own last position plus a tick of
   * travel plus the two colliders. The point written is pulled back onto that
   * hull's surface facing the incoming shot, which is both the honest impact
   * point and the one that never buries the flash inside the mesh.
   */
  private entityImpactPoint(track: ProjectileTrack, cur: Snapshot): boolean {
    if (this.recentHits.size === 0) return false;
    let best: { pos: { x: number; y: number; z: number }; radius: number; distance: number } | null = null;
    let hit: HitWindow | undefined;
    for (let i = 0; i < cur.ships.length; i++) {
      const ship = cur.ships[i]!;
      const window = this.recentHits.get(ship.id);
      if (!window) continue;
      const radius = this.shipConfigFor(ship.id)?.collider.radius ?? FALLBACK_SHIP_RADIUS;
      const closer = closerImpact(best, track, ship.pos, radius);
      if (closer !== best) hit = window;
      best = closer;
    }
    for (let i = 0; i < cur.asteroids.length; i++) {
      const rock = cur.asteroids[i]!;
      const window = this.recentHits.get(rock.id);
      if (!window) continue;
      const closer = closerImpact(best, track, rock.pos, rock.radius);
      if (closer !== best) hit = window;
      best = closer;
    }
    if (!best) return false;
    this.sImpact.damageType = hit?.damageType ?? null;
    // Already inside the hull (the shot's last tick put it there): the track
    // itself is the better point, and normalizing a near-zero vector is not.
    if (best.distance <= best.radius || best.distance <= 1e-4) {
      this.sImpact.x = track.x;
      this.sImpact.y = track.y;
      this.sImpact.z = track.z;
      return true;
    }
    const t = best.radius / best.distance;
    this.sImpact.x = best.pos.x + (track.x - best.pos.x) * t;
    this.sImpact.y = best.pos.y + (track.y - best.pos.y) * t;
    this.sImpact.z = best.pos.z + (track.z - best.pos.z) * t;
    return true;
  }

  /** The best available missile-detonation effect config (see `missileImpactEffectIdsFor`). */
  private missileImpactEffect(): EffectConfig | undefined {
    const ids = missileImpactEffectIdsFor(this.juice.explosions);
    for (let i = 0; i < ids.length; i++) {
      const effect = this.configs.get<EffectConfig>("effect", ids[i]!);
      if (effect) return effect;
    }
    if (ids.length > 0) log.warn(`missile impact effect not found: ${ids.join(", ")}`);
    return undefined;
  }

  /** Age out impact-matching windows; keeps `recentHits` bounded by itself. */
  private ageRecentHits(frameDtMs: number): void {
    if (this.recentHits.size === 0) return;
    const dt = Math.max(0, Number.isFinite(frameDtMs) ? frameDtMs : 0);
    for (const [id, window] of this.recentHits) {
      window.ms -= dt;
      if (window.ms <= 0) this.recentHits.delete(id);
    }
  }

  /**
   * Draw a persistent beam for every module currently CHANNELLING (a
   * `fire.mode: "continuous"` weapon). Unlike a discrete shot there is no fire
   * event per tick to react to — the sim replicates a single `channeling` flag
   * per module and the beam lives for exactly as long as that flag is set, which
   * is what makes release / lock-loss look instant.
   *
   * The same absence of a per-shot beat is why a channel's SPARKS run on their
   * own clock ({@link ImpactSparkSettings.channelIntervalMs}) rather than on the
   * frame rate: a burn that sparked every frame would own the whole ring at
   * 60 fps and look different at 30.
   */
  private syncChannelBeams(cur: Snapshot, frameDtMs: number): void {
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
          // A fresh channel sparks on its very first frame; the interval only
          // governs the beats after that.
          slot.sparkMs = 0;
        }
        this.sFrom.set(ship.pos.x, ship.pos.y, ship.pos.z);
        this.orientBeam(slot.mesh, this.sFrom, this.sTo);
        slot.life = slot.maxLife;
        slot.mesh.setEnabled(true);
        (slot.mesh.material as StandardMaterial).alpha = 1;
        this.liveChannels.add(key);
        // Only a channel that is actually ON something sparks: a burn into
        // empty space has no hit point to throw anything off.
        slot.sparkMs -= Math.max(0, frameDtMs);
        if (to !== null && slot.sparkMs <= 0) {
          slot.sparkMs = this.juice.sparks.channelIntervalMs;
          this.sparkOnBeam(this.targetRadiusOf(ship.targetId!, cur), m.moduleId);
        }
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

  /** Pooled weapon-impact sprays — exposed for the dev probe and quality checks. */
  get sparkFx(): SparkFx {
    return this.sparks;
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
    // After the instances, never before: a painted master disposed while a
    // hull still instances it would take the hull with it.
    this.paint.dispose();
    for (const v of this.asteroids.values()) v.instance.dispose();
    this.asteroids.clear();
    for (const v of this.decoys.values()) disposeDecoyView(v);
    this.decoys.clear();
    this.flags.dispose();
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
    // Dropped rather than detonated: a view being torn down is not an impact.
    this.projectileTracks.clear();
    this.recentHits.clear();
    for (const master of this.poolMasters) {
      master.material?.dispose();
      master.dispose();
    }
    this.poolMasters.length = 0;
    this.hitFlash.dispose();
    this.explosions.dispose();
    this.sparks.dispose();
    this.heroShip?.dispose();
    this.heroKeyLight?.dispose();
    this.heroRimLight?.dispose();
    this.heroPedestal?.dispose();
    this.heroPedestalMaterial?.dispose();
    this.heroRoot.dispose();
    this.assets.dispose();
    this.root.dispose();
  }

  /**
   * Last-resort cleanup for the shared Scene, called after {@link dispose} by
   * `endMatch()` (main.ts). Everything this manager parents lives under one of
   * these two roots, so dropping them recursively guarantees no per-match node
   * survives into the next match even if `dispose()` threw partway through.
   * A no-op on the normal path — both roots are already disposed by then.
   */
  disposeRoots(): void {
    if (!this.root.isDisposed()) this.root.dispose(false, true);
    if (!this.heroRoot.isDisposed()) this.heroRoot.dispose(false, true);
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

function disposeDecoyView(view: DecoyView): void {
  view.canister.dispose();
  view.collar.dispose();
  view.canisterMaterial.dispose();
  view.collarMaterial.dispose();
  view.root.dispose();
}

function findAsteroid(snap: Snapshot, id: EntityId): AsteroidSnapshot | undefined {
  for (let i = 0; i < snap.asteroids.length; i++) if (snap.asteroids[i]!.id === id) return snap.asteroids[i];
  return undefined;
}

function findDecoy(snap: Snapshot, id: EntityId): DecoySnapshot | undefined {
  for (let i = 0; i < snap.decoys.length; i++) if (snap.decoys[i]!.id === id) return snap.decoys[i];
  return undefined;
}

/**
 * Keep whichever of `best` and the candidate hull is nearer to a vanished shot,
 * rejecting any the shot could not have reached: its last tracked position,
 * plus the tick of travel the sim ran before destroying it, plus both
 * colliders. Returns `best` untouched when the candidate is out of reach.
 */
function closerImpact(
  best: { pos: { x: number; y: number; z: number }; radius: number; distance: number } | null,
  track: ProjectileTrack,
  pos: { x: number; y: number; z: number },
  radius: number,
): { pos: { x: number; y: number; z: number }; radius: number; distance: number } | null {
  const distance = Math.hypot(track.x - pos.x, track.y - pos.y, track.z - pos.z);
  if (distance > radius + PROJECTILE_RADIUS + track.step) return best;
  if (best && best.distance <= distance) return best;
  return { pos, radius, distance };
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
