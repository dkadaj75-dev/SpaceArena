import {
  Color3,
  Color4,
  DirectionalLight,
  GlowLayer,
  HemisphericLight,
  Mesh,
  MeshBuilder,
  PointsCloudSystem,
  StandardMaterial,
  TransformNode,
  Vector3,
  type CloudPoint,
  type Node,
  type Scene,
} from "@babylonjs/core";
import {
  createLogger,
  type ArenaConfig,
  type AsteroidConfig,
  type ConfigService,
  type EventBus,
  type ConfigEvents,
  type ShipConfig,
} from "@space-arena/shared";
import { AssetRegistry } from "./AssetRegistry.js";

const log = createLogger("SceneBuilder");

/** Dev-only: show colored team spawn-point gizmos. Flip off to declutter. */
const SHOW_SPAWN_MARKERS = true;

function colorFromHex(hex: string | undefined, fallback: Color3): Color3 {
  if (!hex) return fallback;
  try {
    return Color3.FromHexString(hex);
  } catch {
    return fallback;
  }
}

const TEAM_COLORS = [new Color3(0.2, 0.55, 1.0), new Color3(1.0, 0.35, 0.25)];

/**
 * Builds (and rebuilds, on hot-reload) the arena scene: bounds, ground plane,
 * skybox, light rig, asteroid placements, spawn markers, and the player ship.
 * Every node/material it creates is tracked so a rebuild leaves nothing behind.
 */
export class SceneBuilder {
  private readonly assets: AssetRegistry;
  private root: TransformNode | null = null;
  private glowLayer: GlowLayer | null = null;
  private unsubscribers: Array<() => void> = [];
  private generation = 0;

  /** The ship mesh placed at team 0's spawn, exposed for TacticalCamera to follow. */
  shipNode: TransformNode | null = null;

  constructor(
    private readonly scene: Scene,
    private readonly configService: ConfigService,
    private readonly bus: EventBus<ConfigEvents>,
  ) {
    this.assets = new AssetRegistry(scene);
  }

  /** Builds the arena named by `arenaId`, subscribing to hot-reload for arena/asteroid types. */
  buildArena(arenaId: string): void {
    const arena = this.configService.get<ArenaConfig>("arena", arenaId);
    if (!arena) {
      log.error(`arena config not found: ${arenaId}`);
      return;
    }

    this.rebuild(arena);

    // Rebuild cleanly on any relevant hot-reload — arena layout or the
    // asteroid/ship types it references may have changed shape/params.
    this.clearSubscriptions();
    this.unsubscribers.push(
      this.bus.on("config:changed", (evt) => {
        if (evt.type === "arena" || evt.type === "asteroid" || evt.type === "ship") {
          log.info(`rebuilding arena after ${evt.type} change: ${evt.id}`);
          const fresh = this.configService.get<ArenaConfig>("arena", arenaId);
          if (fresh) this.rebuild(fresh);
        }
      }),
    );
  }

  private rebuild(arena: ArenaConfig): void {
    this.disposeSceneNodes();
    const generation = ++this.generation;

    const root = new TransformNode("arenaRoot", this.scene);
    this.root = root;

    this.buildLighting(arena, root);
    this.buildSkybox(arena, root, generation);
    this.buildBounds(arena, root);
    this.buildGroundPlane(arena, root);
    this.buildAsteroids(arena, root);
    if (SHOW_SPAWN_MARKERS) this.buildSpawnMarkers(arena, root);
    this.buildShip(arena, root);
  }

  private buildLighting(arena: ArenaConfig, root: TransformNode): void {
    const hemi = new HemisphericLight("arenaHemiLight", new Vector3(0, 1, 0), this.scene);
    hemi.intensity = arena.lighting?.ambientIntensity ?? 0.4;
    hemi.diffuse = colorFromHex(arena.lighting?.ambientColor, new Color3(0.6, 0.65, 0.8));
    hemi.parent = root;

    const dir = new DirectionalLight("arenaDirLight", new Vector3(-0.4, -1, -0.3), this.scene);
    dir.intensity = arena.lighting?.directionalIntensity ?? 0.9;
    dir.parent = root;
  }

  private buildSkybox(arena: ArenaConfig, root: TransformNode, generation: number): void {
    const palette = arena.skybox?.palette ?? {};
    const primary = colorFromHex(palette.primary, new Color3(0.02, 0.03, 0.06));

    const skybox = MeshBuilder.CreateSphere("skybox", { diameter: 900, segments: 8, sideOrientation: Mesh.BACKSIDE }, this.scene);
    const skyMat = new StandardMaterial("mat.skybox", this.scene);
    skyMat.diffuseColor = Color3.Black();
    skyMat.specularColor = Color3.Black();
    skyMat.emissiveColor = primary;
    skyMat.disableLighting = true;
    skybox.material = skyMat;
    skybox.infiniteDistance = true;
    skybox.isPickable = false;
    skybox.parent = root;

    // Cheap starfield: a couple hundred points via PointsCloudSystem.
    const pcs = new PointsCloudSystem("stars", 1, this.scene);
    pcs.addPoints(400, (particle: CloudPoint) => {
      const radius = 300 + Math.random() * 250;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      particle.position = new Vector3(
        radius * Math.sin(phi) * Math.cos(theta),
        Math.abs(radius * Math.cos(phi)) * 0.6 + 20,
        radius * Math.sin(phi) * Math.sin(theta),
      );
      const b = 0.5 + Math.random() * 0.5;
      particle.color = new Color4(b, b, b * 1.05, 1);
    });
    void pcs.buildMeshAsync().then((mesh) => {
      // Guard against a rebuild happening while the async mesh build was in flight.
      if (generation !== this.generation) {
        mesh.dispose();
        return;
      }
      mesh.isPickable = false;
      mesh.parent = root;
    });
  }

  private buildBounds(arena: ArenaConfig, root: TransformNode): void {
    if (!this.glowLayer) {
      this.glowLayer = new GlowLayer("arenaGlow", this.scene);
      this.glowLayer.intensity = 0.5;
    }

    if (arena.bounds.shape === "circle") {
      const ring = MeshBuilder.CreateTorus(
        "boundsRing",
        { diameter: arena.bounds.radius * 2, thickness: 0.6, tessellation: 96 },
        this.scene,
      );
      ring.isPickable = false;
      const mat = new StandardMaterial("mat.boundsRing", this.scene);
      mat.diffuseColor = Color3.Black();
      mat.specularColor = Color3.Black();
      mat.emissiveColor = new Color3(0.2, 0.85, 1.0);
      ring.material = mat;
      ring.parent = root;
    } else {
      // Rect stub: four thin boxes forming the perimeter.
      const { width, height } = arena.bounds;
      const mat = new StandardMaterial("mat.boundsRect", this.scene);
      mat.diffuseColor = Color3.Black();
      mat.emissiveColor = new Color3(1.0, 0.5, 0.2);
      const thickness = 0.6;
      const edges: Array<[number, number, number, number]> = [
        [0, height / 2, width, thickness],
        [0, -height / 2, width, thickness],
        [width / 2, 0, thickness, height],
        [-width / 2, 0, thickness, height],
      ];
      for (const [x, z, w, d] of edges) {
        const seg = MeshBuilder.CreateBox("boundsRectSeg", { width: w, height: 1, depth: d }, this.scene);
        seg.position.set(x, 0, z);
        seg.material = mat;
        seg.isPickable = false;
        seg.parent = root;
      }
    }
  }

  private buildGroundPlane(arena: ArenaConfig, root: TransformNode): void {
    const size =
      arena.bounds.shape === "circle" ? arena.bounds.radius * 2.1 : Math.max(arena.bounds.width, arena.bounds.height) * 1.1;

    const ground = MeshBuilder.CreateGround("groundPlane", { width: size, height: size }, this.scene);
    ground.isVisible = false;
    ground.isPickable = true;
    ground.parent = root;

    // Faint polar grid disc so depth reads without being visually loud.
    const disc = MeshBuilder.CreateDisc("groundDisc", { radius: size / 2, tessellation: 64 }, this.scene);
    disc.rotation.x = Math.PI / 2;
    disc.isPickable = false;
    const discMat = new StandardMaterial("mat.groundDisc", this.scene);
    discMat.diffuseColor = new Color3(0.15, 0.25, 0.35);
    discMat.emissiveColor = new Color3(0.05, 0.09, 0.13);
    discMat.alpha = 0.06;
    discMat.specularColor = Color3.Black();
    disc.material = discMat;
    disc.parent = root;
  }

  private buildAsteroids(arena: ArenaConfig, root: TransformNode): void {
    for (const placement of arena.asteroidPlacements) {
      const asteroid = this.configService.get<AsteroidConfig>("asteroid", placement.asteroidId);
      if (!asteroid) {
        log.warn(`unknown asteroid placement id: ${placement.asteroidId}`);
        continue;
      }
      const master = this.assets.getMesh(asteroid.render.recipe, asteroid.render.palette ?? {});
      const instance = master.createInstance(`asteroid.${placement.asteroidId}.${placement.position.x}.${placement.position.z}`);
      const scale = (placement.scale ?? 1) * asteroid.radius;
      instance.scaling.set(scale, scale, scale);
      instance.position.set(placement.position.x, 0, placement.position.z);
      if (placement.rotation) instance.rotation.y = placement.rotation;
      instance.isPickable = false;
      instance.parent = root;
    }
  }

  private buildSpawnMarkers(arena: ArenaConfig, root: TransformNode): void {
    const material0 = new StandardMaterial("mat.spawnTeam0", this.scene);
    material0.emissiveColor = TEAM_COLORS[0] ?? Color3.Blue();
    material0.diffuseColor = Color3.Black();
    const material1 = new StandardMaterial("mat.spawnTeam1", this.scene);
    material1.emissiveColor = TEAM_COLORS[1] ?? Color3.Red();
    material1.diffuseColor = Color3.Black();

    for (const sp of arena.spawnPoints) {
      const disc = MeshBuilder.CreateDisc(`spawnMarker.${sp.id}`, { radius: 2, tessellation: 24 }, this.scene);
      disc.rotation.x = Math.PI / 2;
      disc.position.set(sp.position.x, 0.05, sp.position.z);
      disc.material = sp.team === 0 ? material0 : material1;
      disc.isPickable = false;
      disc.parent = root;
    }
  }

  private buildShip(arena: ArenaConfig, root: TransformNode): void {
    const ship = this.configService.get<ShipConfig>("ship", "ship.interceptor");
    const spawn = arena.spawnPoints.find((sp) => sp.team === 0) ?? arena.spawnPoints[0];
    if (!ship || !spawn) {
      log.warn("no ship or spawn point available; skipping ship placement");
      return;
    }

    const master = this.assets.getMesh(ship.render.recipe, ship.render.palette ?? {});
    const instance = master.createInstance("ship.player");
    instance.position.set(spawn.position.x, 0.3, spawn.position.z);
    instance.rotation.y = spawn.heading;
    instance.isPickable = false;
    instance.parent = root;

    this.shipNode = instance;
  }

  private clearSubscriptions(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
  }

  private disposeSceneNodes(): void {
    this.shipNode = null;
    if (this.root) {
      disposeRecursive(this.root);
      this.root = null;
    }
  }

  /** Full teardown: subscriptions, scene nodes, glow layer, and cached asset masters. */
  dispose(): void {
    this.generation++;
    this.clearSubscriptions();
    this.disposeSceneNodes();
    this.glowLayer?.dispose();
    this.glowLayer = null;
    this.assets.dispose();
  }
}

function disposeRecursive(node: Node): void {
  for (const child of [...node.getChildren()]) {
    disposeRecursive(child);
  }
  if (node instanceof Mesh) {
    node.material?.dispose();
  }
  node.dispose();
}
