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
  type Material,
  type Node,
  type Scene,
} from "@babylonjs/core";
import {
  createLogger,
  type ArenaConfig,
  type ConfigService,
  type EventBus,
  type ConfigEvents,
  type QualityConfig,
} from "@space-arena/shared";

const log = createLogger("SceneBuilder");

/**
 * The arena's playable radius — the bubble's radius (BUBBLE.md), or a rect
 * arena's half-diagonal, matching the minimap's rule. The one place scene
 * geometry learns how big the world is, so nothing downstream needs an
 * arena-sized literal.
 */
function boundsRadiusOf(arena: ArenaConfig): number {
  const b = arena.bounds;
  return b.shape === "sphere" ? b.radius : Math.hypot(b.width, b.height) / 2;
}

function colorFromHex(hex: string | undefined, fallback: Color3): Color3 {
  if (!hex) return fallback;
  try {
    return Color3.FromHexString(hex);
  } catch {
    return fallback;
  }
}

const TEAM_COLORS = [new Color3(0.2, 0.55, 1.0), new Color3(1.0, 0.35, 0.25)];

/** Everything SceneBuilder reads off the active quality tier (§10 5.6). */
export type SceneQuality = Pick<QualityConfig, "glow" | "scene" | "render">;

/** Conservative defaults for callers that predate the quality system. */
const DEFAULT_QUALITY: SceneQuality = {
  glow: { enabled: true, intensity: 0.5 },
  scene: { starfieldPoints: 400, boundsGrid: true, spawnMarkers: true },
  render: { hardwareScalingMultiplier: 1, maxDevicePixelRatio: 2, freezeStatics: false },
};

/**
 * Builds (and rebuilds, on hot-reload) the arena scene: the bounds shell,
 * skybox, light rig, spawn markers and the editor's pick plane. Every
 * node/material it creates is tracked so a rebuild leaves nothing behind.
 *
 * Perf (§10 5.6): the arena is entirely static, so once built its meshes get
 * `freezeWorldMatrix()` and their materials `freeze()`. Both are correctly
 * reversed whenever the arena is hidden (the dev editor stages its own content
 * and adds its own lights — a frozen StandardMaterial would never recompile for
 * the new light count) and on every rebuild.
 *
 * Note on `scene.freezeActiveMeshes()`: deliberately **not** used. It freezes
 * the scene-wide active-mesh list, and this scene also holds ships, projectiles
 * and asteroids that appear and disappear every frame — freezing it would
 * strand them. Per-mesh freezing gets the static-arena win without that.
 */
export class SceneBuilder {
  private root: TransformNode | null = null;
  private visible = true;
  private glowLayer: GlowLayer | null = null;
  private unsubscribers: Array<() => void> = [];
  private generation = 0;
  private quality: SceneQuality;
  private frozen = false;
  private arenaId: string | null = null;

  constructor(
    private readonly scene: Scene,
    private readonly configService: ConfigService,
    private readonly bus: EventBus<ConfigEvents>,
    quality: SceneQuality = DEFAULT_QUALITY,
  ) {
    this.quality = quality;
  }

  /**
   * Swap the active quality tier. Cheap knobs (glow intensity/enabled) apply in
   * place; anything baked into geometry (starfield density, decoration meshes)
   * needs the rebuild this triggers.
   */
  setQuality(quality: SceneQuality): void {
    const previous = this.quality;
    this.quality = quality;
    if (!this.root) return;
    const needsRebuild =
      previous.scene.starfieldPoints !== quality.scene.starfieldPoints ||
      previous.scene.boundsGrid !== quality.scene.boundsGrid ||
      previous.scene.spawnMarkers !== quality.scene.spawnMarkers;
    if (needsRebuild && this.arenaId) {
      const arena = this.configService.get<ArenaConfig>("arena", this.arenaId);
      if (arena) {
        this.rebuild(arena);
        return;
      }
    }
    this.applyGlowQuality();
    if (previous.render.freezeStatics !== quality.render.freezeStatics) {
      if (quality.render.freezeStatics) this.freezeStatics();
      else this.unfreezeStatics();
    }
  }

  /** Builds the arena named by `arenaId`, subscribing to hot-reload for arena/asteroid types. */
  buildArena(arenaId: string): void {
    const arena = this.configService.get<ArenaConfig>("arena", arenaId);
    if (!arena) {
      log.error(`arena config not found: ${arenaId}`);
      return;
    }
    this.arenaId = arenaId;

    this.rebuild(arena);

    // Rebuild cleanly on any relevant hot-reload — arena layout or the
    // asteroid/ship types it references may have changed shape/params.
    this.clearSubscriptions();
    this.unsubscribers.push(
      this.bus.on("config:changed", (evt) => {
        if (evt.type === "arena") {
          log.info(`rebuilding arena after ${evt.type} change: ${evt.id}`);
          const fresh = this.configService.get<ArenaConfig>("arena", arenaId);
          if (fresh) this.rebuild(fresh);
        }
      }),
    );
  }

  private rebuild(arena: ArenaConfig): void {
    // A rebuild disposes everything, so the frozen bookkeeping resets with it.
    this.disposeSceneNodes();
    this.frozen = false;
    const generation = ++this.generation;

    const root = new TransformNode("arenaRoot", this.scene);
    this.root = root;
    root.setEnabled(this.visible);

    this.buildLighting(arena, root);
    this.buildSkybox(arena, root, generation);
    this.buildBounds(arena, root);
    this.buildPickPlane(arena, root);
    if (this.quality.scene.spawnMarkers) this.buildSpawnMarkers(arena, root);

    if (this.visible) this.freezeStatics();
  }

  /**
   * Show/hide the whole static arena — bounds shell, skybox, spawn markers
   * AND the light rig, which is parented to the same root. Callers that hide it
   * to stage something else must supply their own lighting (see EditorStage).
   * Latched so a hot-reload rebuild keeps the current visibility.
   *
   * Hiding also unfreezes: the editor adds its own lights while the arena is
   * away, and a material frozen against the old light set would come back with
   * a stale shader. Showing re-freezes against whatever is in the scene then.
   */
  setVisible(visible: boolean): void {
    this.visible = visible;
    this.root?.setEnabled(visible);
    if (visible) this.freezeStatics();
    else this.unfreezeStatics();
  }

  /** Whether the static arena meshes/materials are currently frozen (test hook). */
  get staticsFrozen(): boolean {
    return this.frozen;
  }

  /**
   * `freezeWorldMatrix()` + `material.freeze()` across the arena, minus the
   * skybox: `infiniteDistance` re-derives its world matrix from the camera
   * every frame, so freezing it would pin the sky in place.
   */
  private freezeStatics(): void {
    if (this.frozen || !this.root || !this.quality.render.freezeStatics) return;
    this.frozen = true;
    const materials = new Set<Material>();
    forEachMesh(this.root, (mesh) => {
      if (mesh.infiniteDistance) return;
      mesh.freezeWorldMatrix();
      if (mesh.material) materials.add(mesh.material);
    });
    for (const material of materials) material.freeze();
  }

  private unfreezeStatics(): void {
    if (!this.frozen || !this.root) return;
    this.frozen = false;
    const materials = new Set<Material>();
    forEachMesh(this.root, (mesh) => {
      mesh.unfreezeWorldMatrix();
      if (mesh.material) materials.add(mesh.material);
    });
    for (const material of materials) material.unfreeze();
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

    // Cheap starfield: a few hundred points via PointsCloudSystem, density per
    // quality tier (the point count is baked into the mesh at build time).
    const starCount = this.quality.scene.starfieldPoints;
    if (starCount <= 0) return;
    // The shell is sized off the ARENA, not a literal: at ring-nebula's radius
    // 90 the floor keeps the old 300-550 band, and on a radius-300 field
    // (FLIGHT.md §6) it opens out so the "distant stars" are not scattered
    // through the play space the player is flying in. 1.8× the bubble's radius
    // keeps every star outside it however far a ship climbs.
    const shellInner = Math.max(300, boundsRadiusOf(arena) * 1.8);
    const shellSpan = shellInner * 0.85;
    const pcs = new PointsCloudSystem("stars", 1, this.scene);
    pcs.addPoints(starCount, (particle: CloudPoint) => {
      const radius = shellInner + Math.random() * shellSpan;
      const theta = Math.random() * Math.PI * 2;
      // Uniform on the full sphere. This used to fold y to the upper hemisphere
      // and squash it — correct for a camera that only ever looked down at a
      // floor, a visible hole in the sky the moment a ship can dive and look up
      // from underneath (BUBBLE.md §C).
      const phi = Math.acos(2 * Math.random() - 1);
      particle.position = new Vector3(
        radius * Math.sin(phi) * Math.cos(theta),
        radius * Math.cos(phi),
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
      // The starfield lands after rebuild() froze everything else — freeze it
      // too, or it would be the one arena mesh recomputing its matrix forever.
      if (this.frozen) {
        mesh.freezeWorldMatrix();
        mesh.material?.freeze();
      }
    });
  }

  /**
   * The arena's edge. For a bubble that is a **shell**, not a ring (BUBBLE.md
   * §C): ships leave the play space in any direction, so the boundary has to read
   * as a surface the player can approach from the inside at any latitude.
   *
   * Two meshes, both seen from within:
   *
   *  - `boundsShell` — a barely-there translucent sphere. It is what makes the
   *    edge feel like a wall when you fly at it, and it is drawn BACKSIDE so the
   *    inside faces render and the far half never occludes the view forward.
   *  - `boundsGrid` — the same sphere as WIREFRAME, i.e. the latitude/longitude
   *    lines the segment count already implies. This is the spatial reference the
   *    retired ground grid used to provide, and the same quality switch turns it
   *    off (`scene.boundsGrid`): it is a pile of extra line geometry, which is why
   *    the cheapest tier drops it.
   */
  private buildBounds(arena: ArenaConfig, root: TransformNode): void {
    this.applyGlowQuality();

    if (arena.bounds.shape === "sphere") {
      const diameter = arena.bounds.radius * 2;
      const shell = MeshBuilder.CreateSphere(
        "boundsShell",
        { diameter, segments: 24, sideOrientation: Mesh.BACKSIDE },
        this.scene,
      );
      shell.isPickable = false;
      const shellMat = new StandardMaterial("mat.boundsShell", this.scene);
      shellMat.diffuseColor = Color3.Black();
      shellMat.specularColor = Color3.Black();
      shellMat.emissiveColor = new Color3(0.2, 0.85, 1.0);
      shellMat.disableLighting = true;
      shellMat.alpha = 0.05;
      shell.material = shellMat;
      shell.parent = root;

      if (this.quality.scene.boundsGrid) {
        const grid = MeshBuilder.CreateSphere("boundsGrid", { diameter, segments: 16 }, this.scene);
        grid.isPickable = false;
        const gridMat = new StandardMaterial("mat.boundsGrid", this.scene);
        gridMat.diffuseColor = Color3.Black();
        gridMat.specularColor = Color3.Black();
        gridMat.emissiveColor = new Color3(0.12, 0.45, 0.6);
        gridMat.disableLighting = true;
        gridMat.wireframe = true;
        gridMat.alpha = 0.16;
        grid.material = gridMat;
        grid.parent = root;
      }
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

  /**
   * The arena `GlowLayer`, created/disposed and tuned per quality tier. Measured
   * on the practice-bots arena: enabling it roughly **doubles** the frame's draw
   * calls (47 → 24 with it off), because every emissive submesh is re-rendered
   * into the blur target. It is the first thing the low tier drops.
   */
  private applyGlowQuality(): void {
    const glow = this.quality.glow;
    if (!glow.enabled) {
      this.glowLayer?.dispose();
      this.glowLayer = null;
      return;
    }
    if (!this.glowLayer) {
      this.glowLayer = new GlowLayer(
        "arenaGlow",
        this.scene,
        glow.blurKernelSize === undefined ? undefined : { blurKernelSize: glow.blurKernelSize },
      );
    }
    this.glowLayer.intensity = glow.intensity;
  }

  /**
   * The invisible `y = 0` plane the dev Map editor picks against when placing
   * asteroids (`MapEditor.ts` matches it by name). All that survives of the old
   * ground: the faint grid disc that used to sit on it retired with the floor
   * (BUBBLE.md §C — ships fly through the whole bubble, so a disc at y=0 was a
   * lie about the play space) and the spatial reference it gave moved onto the
   * bounds shell.
   *
   * It stays part of the arena rather than the editor's own stage because the
   * editor authors placements in ARENA coordinates and needs the plane sized to
   * whichever arena is loaded.
   */
  private buildPickPlane(arena: ArenaConfig, root: TransformNode): void {
    const size = boundsRadiusOf(arena) * 2.1;
    const ground = MeshBuilder.CreateGround("groundPlane", { width: size, height: size }, this.scene);
    ground.isVisible = false;
    ground.isPickable = true;
    ground.parent = root;
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
      // Authored altitude (BUBBLE.md §E gives spawns a `y`), nudged clear of the
      // exact spawn point so the marker never z-fights the hull sitting on it.
      disc.position.set(sp.position.x, (sp.position.y ?? 0) + 0.05, sp.position.z);
      disc.material = sp.team === 0 ? material0 : material1;
      disc.isPickable = false;
      disc.parent = root;
    }
  }

  private clearSubscriptions(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
  }

  private disposeSceneNodes(): void {
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
  }
}

function disposeRecursive(node: Node): void {
  for (const child of [...node.getChildren()]) {
    disposeRecursive(child);
  }
  if (node instanceof Mesh) {
    // A frozen material refuses to dispose its effect cleanly — thaw first.
    node.material?.unfreeze();
    node.material?.dispose();
  }
  node.dispose();
}

/** Depth-first walk over every `Mesh` under `node` (inclusive). */
function forEachMesh(node: Node, visit: (mesh: Mesh) => void): void {
  if (node instanceof Mesh) visit(node);
  for (const child of node.getChildren()) forEachMesh(child, visit);
}
