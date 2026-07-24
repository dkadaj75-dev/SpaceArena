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
  type EntityId,
  type ProjectileSnapshot,
  type ShipConfig,
  type ShipSnapshot,
  type SimEvent,
  type Snapshot,
  type TuningConfig,
} from "@space-arena/shared";
import { AssetRegistry } from "../core/AssetRegistry.js";
import { ShipSocketRig } from "./ShipSocketRig.js";

const log = createLogger("ViewManager");

const SHIP_Y = 0.3;
const PROJECTILE_Y = 0.3;
const BEAM_Y = 0.35;
const ASTEROID_DEATH_MS = 260;

/** Resolves a sim ship entity to its ship-config id (owned by GameSession). */
export type ShipConfigResolver = (id: EntityId) => string | undefined;

interface ShipView {
  node: InstancedMesh;
  /** Hardpoint module meshes + emitter particle systems (§9 4.6); null if the ship config had none. */
  rig: ShipSocketRig | null;
}

interface AsteroidView {
  instance: InstancedMesh;
  baseRadius: number;
  dying: boolean;
  dyingMs: number;
}

interface BeamSlot {
  mesh: Mesh;
  life: number; // ms remaining
  maxLife: number;
}

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
  private readonly kineticPool: Mesh[] = [];
  private readonly missilePool: Mesh[] = [];
  private readonly beamPool: BeamSlot[] = [];

  private readonly beamFadeMs: number;
  private readonly poolSize: number;

  // Reused scratch — no per-frame allocation.
  private readonly sFrom = new Vector3();
  private readonly sTo = new Vector3();

  constructor(
    private readonly scene: Scene,
    private readonly configs: ConfigService,
    private readonly resolveShipConfig: ShipConfigResolver,
  ) {
    this.assets = new AssetRegistry(scene);
    this.root = new TransformNode("viewRoot", scene);

    const tuning = configs.getAll<TuningConfig>("tuning")[0];
    this.beamFadeMs = tuning?.beamFadeMs ?? 120;
    this.poolSize = tuning?.projectilePoolSize ?? 64;

    this.buildPools();
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
    for (let i = 0; i < this.poolSize; i++) {
      const m = kMaster.clone(`proj.kinetic.${i}`);
      m.material = kMat;
      m.isPickable = false;
      m.setEnabled(false);
      m.parent = this.root;
      this.kineticPool.push(m);
    }

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
    for (let i = 0; i < this.poolSize; i++) {
      const m = mMaster.clone(`proj.missile.${i}`);
      m.material = mMat;
      m.isPickable = false;
      m.setEnabled(false);
      m.parent = this.root;
      this.missilePool.push(m);
    }

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
      } else if (ev.type === "entityDestroyed" && ev.isAsteroid) {
        const v = this.asteroids.get(ev.entityId);
        if (v && !v.dying) {
          v.dying = true;
          v.dyingMs = ASTEROID_DEATH_MS;
        }
      }
    }
  }

  private spawnBeam(ownerId: EntityId, targetId: EntityId | null, cur: Snapshot): void {
    if (targetId === null) return;
    const from = cur.ships.find((s) => s.id === ownerId);
    const to =
      cur.ships.find((s) => s.id === targetId) ?? cur.asteroids.find((a) => a.id === targetId);
    if (!from || !to) return;
    const slot = this.beamPool.find((b) => b.life <= 0);
    if (!slot) return; // pool exhausted this frame — acceptable, no alloc
    this.sFrom.set(from.pos.x, BEAM_Y, from.pos.z);
    this.sTo.set(to.pos.x, BEAM_Y, to.pos.z);
    this.orientBeam(slot.mesh, this.sFrom, this.sTo);
    slot.life = slot.maxLife;
    slot.mesh.setEnabled(true);
    (slot.mesh.material as StandardMaterial).alpha = 1;
  }

  private orientBeam(mesh: Mesh, from: Vector3, to: Vector3): void {
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const len = Math.hypot(dx, dz);
    mesh.position.set((from.x + to.x) / 2, BEAM_Y, (from.z + to.z) / 2);
    mesh.rotation.y = Math.atan2(dx, dz);
    mesh.scaling.z = Math.max(0.01, len);
  }

  /**
   * Sync all dynamic views to the interpolated state between `prev` and `cur`.
   * `frameDtMs` drives beam fade and asteroid-puff timers.
   */
  render(prev: Snapshot, cur: Snapshot, alpha: number, frameDtMs: number): void {
    this.syncShips(prev, cur, alpha);
    this.syncAsteroids(cur, frameDtMs);
    this.syncProjectiles(prev, cur, alpha);
    this.updateBeams(frameDtMs);
  }

  private syncShips(prev: Snapshot, cur: Snapshot, alpha: number): void {
    // Remove views whose ship no longer exists.
    for (const [id, view] of this.ships) {
      if (!cur.ships.some((s) => s.id === id)) {
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
      const p = findShip(prev, s.id) ?? s;
      const x = p.pos.x + (s.pos.x - p.pos.x) * alpha;
      const z = p.pos.z + (s.pos.z - p.pos.z) * alpha;
      view.node.position.set(x, SHIP_Y, z);
      view.node.rotation.y = lerpAngle(p.heading, s.heading, alpha);

      view.rig?.updateModules(s.modules);
      view.rig?.updateEmitters(s, findShip(prev, s.id), nowMs);
    }
  }

  private createShipView(s: ShipSnapshot): ShipView | undefined {
    const configId = this.resolveShipConfig(s.id);
    const ship = configId ? this.configs.get<ShipConfig>("ship", configId) : undefined;
    if (!ship) {
      log.warn(`no ship config for entity ${s.id} (configId=${configId ?? "?"})`);
      return undefined;
    }
    const master = this.assets.getMesh(ship.render.recipe, ship.render.palette ?? {});
    const node = master.createInstance(`ship.${s.id}`);
    node.isPickable = true;
    node.metadata = { entityId: s.id, kind: "ship", team: s.team };
    node.parent = this.root;

    // Fitted module ids in hardpoint order (sparse-safe: an unfitted hardpoint stays null).
    const fittedModuleIds: (string | null)[] = new Array(hardpointsOf(ship).length).fill(null);
    for (const m of s.modules) {
      if (m.hardpointIndex < fittedModuleIds.length) fittedModuleIds[m.hardpointIndex] = m.moduleId;
    }
    const rig = new ShipSocketRig(this.scene, this.configs, this.assets, ship, node, fittedModuleIds);

    return { node, rig };
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
      const s = view.baseRadius * t;
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
    const master = this.assets.getMesh(cfg.render.recipe, cfg.render.palette ?? {});
    const instance = master.createInstance(`asteroid.${a.id}`);
    instance.scaling.set(a.radius, a.radius, a.radius);
    instance.position.set(a.pos.x, 0, a.pos.z);
    instance.isPickable = false;
    instance.parent = this.root;
    return { instance, baseRadius: a.radius, dying: false, dyingMs: 0 };
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
      const z = p.pos.z + (pr.pos.z - p.pos.z) * alpha;
      mesh.position.set(x, PROJECTILE_Y, z);
      mesh.rotation.y = lerpAngle(p.heading, pr.heading, alpha);
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
    this.assets.dispose();
    this.root.dispose();
  }
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
