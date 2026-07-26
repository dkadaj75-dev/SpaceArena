import {
  Color3,
  Mesh,
  MeshBuilder,
  StandardMaterial,
  TransformNode,
  Vector3,
  type InstancedMesh,
  type Scene,
} from "@babylonjs/core";
import {
  createLogger,
  hardpointsOf,
  type AsteroidConfig,
  type AsteroidSnapshot,
  type ConfigService,
  type EffectConfig,
  type EntityId,
  type ProjectileSnapshot,
  type ShipConfig,
  type ShipSnapshot,
  type SimEvent,
  type QualityConfig,
  type Snapshot,
  type ThemeConfig,
  type TuningConfig,
} from "@space-arena/shared";
import { AssetRegistry } from "../core/AssetRegistry.js";
import { ShipSocketRig } from "./ShipSocketRig.js";
import { resolveSoundId } from "../audio/soundIds.js";
import { ExplosionFx } from "./juice/ExplosionFx.js";
import { HitFlashPool } from "./juice/HitFlash.js";
import { explosionEffectIdFor, juiceSettingsOf, type JuiceSettings } from "./juice/juiceSettings.js";
import {
  approachRoll,
  bankRollFor,
  headingRatePerSec,
  meshPitchFor,
  meshYawFor,
  pitchForDirection,
  yawForDirection,
} from "./shipOrientation.js";

const log = createLogger("ViewManager");

const ASTEROID_DEATH_MS = 260;

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
}

interface AsteroidView {
  instance: InstancedMesh;
  /** Instance scaling at full size — NOT the collider radius, see `getAsteroidMaster`. */
  baseScale: number;
  dying: boolean;
  dyingMs: number;
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
 * A pooled projectile node: an `InstancedMesh` (batched — one draw call for the
 * whole pool) or a cloned `Mesh` (one draw call each) depending on the tier.
 * Both expose the position/rotation/enable surface the sync path uses.
 */
type ProjectileNode = Mesh | InstancedMesh;

/** Shortest-path angular interpolation. */
function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

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

  private readonly ships = new Map<EntityId, ShipView>();
  private readonly asteroids = new Map<EntityId, AsteroidView>();

  // Projectile pools (shown/hidden, never reallocated).
  private readonly kineticPool: ProjectileNode[] = [];
  private readonly missilePool: ProjectileNode[] = [];
  private readonly beamPool: BeamSlot[] = [];
  /** Pool masters, kept so a quality change can rebuild the pools in place. */
  private readonly poolMasters: Mesh[] = [];

  private readonly beamFadeMs: number;
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

  constructor(
    private readonly scene: Scene,
    private readonly configs: ConfigService,
    private readonly resolveShipConfig: ShipConfigResolver,
    quality: ViewQuality = DEFAULT_VIEW_QUALITY,
    options: ViewManagerOptions = {},
  ) {
    this.assets = new AssetRegistry(scene);
    this.root = new TransformNode("viewRoot", scene);
    this.quality = quality;

    const tuning = configs.getAll<TuningConfig>("tuning")[0];
    this.beamFadeMs = tuning?.beamFadeMs ?? 120;
    this.poolSize = tuning?.projectilePoolSize ?? 64;

    this.juice = options.juice ?? juiceSettingsOf(configs.get<ThemeConfig>("theme", THEME_ID));
    this.playSound = options.playSound ?? null;
    this.hitFlash = new HitFlashPool(scene, this.root, this.juice.hitFlash);
    this.explosions = new ExplosionFx(scene, this.juice.explosions, quality.particles);

    this.assets.setAsteroidLod(quality.asteroids);
    this.buildPools();
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
        this.spawnBeam(ev.ownerId, ev.targetId, cur);
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
    this.explosions.burst(effect, pos.x, pos.z, pos.y);
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

  private spawnBeam(ownerId: EntityId, targetId: EntityId | null, cur: Snapshot): void {
    if (targetId === null) return;
    const from = findShip(cur, ownerId);
    const to = findShip(cur, targetId) ?? findAsteroid(cur, targetId);
    if (!from || !to) return;
    const slot = firstFreeBeam(this.beamPool);
    if (!slot) return; // pool exhausted this frame — acceptable, no alloc
    this.sFrom.set(from.pos.x, from.pos.y, from.pos.z);
    this.sTo.set(to.pos.x, to.pos.y, to.pos.z);
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
    this.syncProjectiles(prev, cur, alpha);
    this.updateBeams(frameDtMs);
    this.hitFlash.update(frameDtMs);
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
      // Yaw + pitch from the sim, roll from the client's own bank — all three
      // conventions live in `shipOrientation.ts`. Pitch interpolates LINEARLY
      // (it is clamped to ±maxPitchRad and never wraps); heading takes the short
      // way round.
      view.node.rotation.y = meshYawFor(lerpAngle(p.heading, s.heading, alpha));
      view.node.rotation.x = meshPitchFor(p.pitch + (s.pitch - p.pitch) * alpha);
      if (snapDt > 0) {
        view.rollTarget = bankRollFor(
          headingRatePerSec(p.heading, s.heading, snapDt),
          this.juice.bank.maxRad,
          this.juice.bank.referenceRateRadPerSec,
        );
      }
      view.roll = approachRoll(view.roll, view.rollTarget, this.juice.bank.lag, frameDt);
      view.node.rotation.z = view.roll;

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

    return { node, rig, roll: 0, rollTarget: 0 };
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
    // Authored altitude (BUBBLE.md §E gives placements a `y`); asteroids never
    // move, so this is the one and only time it is written.
    instance.position.set(a.pos.x, a.pos.y, a.pos.z);
    instance.isPickable = false;
    instance.parent = this.root;
    return { instance, baseScale: scale, dying: false, dyingMs: 0 };
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
    for (const m of this.kineticPool) m.dispose();
    for (const m of this.missilePool) m.dispose();
    for (const b of this.beamPool) {
      b.mesh.material?.dispose();
      b.mesh.dispose();
    }
    this.kineticPool.length = 0;
    this.missilePool.length = 0;
    this.beamPool.length = 0;
    for (const master of this.poolMasters) {
      master.material?.dispose();
      master.dispose();
    }
    this.poolMasters.length = 0;
    this.hitFlash.dispose();
    this.explosions.dispose();
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

function findAsteroid(snap: Snapshot, id: EntityId): AsteroidSnapshot | undefined {
  for (let i = 0; i < snap.asteroids.length; i++) if (snap.asteroids[i]!.id === id) return snap.asteroids[i];
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
