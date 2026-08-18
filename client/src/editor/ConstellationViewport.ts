import {
  Color3, MeshBuilder, StandardMaterial, TransformNode, Vector3,
  type AbstractMesh, type Mesh, type Scene,
} from "@babylonjs/core";
import type {
  AnyConfig, ArenaConfig, AsteroidConfig, ConfigType, ModuleConfig, PropConfig, ShipConfig,
} from "@space-arena/shared";
import { AssetRegistry, moduleRenderRecipe } from "../core/AssetRegistry.js";
import { pinCloneHierarchyLod0 } from "../core/modelLod.js";
import { EditorStage } from "./EditorStage.js";
import type { Layer, PlacementKind } from "./arenaEditOps.js";

/**
 * The slice of the running client Constellation needs to own the canvas as a
 * viewport. Declared as its own narrow interface so the editor depends only on
 * what it actually uses, and so `main.ts` can satisfy it with a handful of
 * scene/camera hooks rather than exposing the whole bootstrap.
 */
export interface ConstellationHost {
  scene: Scene;
  /** Hide/show the live match (HUD, entity views) while the editor owns the canvas. */
  setGameVisible(visible: boolean): void;
  /** Hide/show the static arena — off for staged subjects, on for arena editing. */
  setArenaVisible(visible: boolean): void;
  /** Freeze the sim and put the camera in orbit/pan editor mode. */
  pauseSim(): void;
  resumeSim(): void;
  /**
   * Build the scene's static arena (floor, skybox, terrain, prop instances)
   * from the DRAFT config the editor is holding — not from the live registry,
   * which never sees an unpublished edit. `null` hands the scene back to the
   * arena the game itself is on.
   */
  stageArena(arena: ArenaConfig | null): void;
  /**
   * Force the team spawn gizmos on while the editor owns the canvas. Every
   * shipped quality tier turns them off (they are an authoring aid, not match
   * furniture), but arena work places spawns against this very scene.
   */
  setSpawnMarkersForced(forced: boolean): void;
  /** Make the arena's real prop instances selectable, for the editor session only. */
  setPropPickingForced(forced: boolean): void;
  /** Freeze the editor camera's pointer gestures (used during gizmo drags). */
  suspendCameraGestures(suspended: boolean): void;
}

/** Resolve a referenced config out of the draft pack (placements, fittings…). */
export type ConfigLookup = (type: ConfigType, id: string) => AnyConfig | undefined;

/**
 * What the editing session (if any) wants of each authoring marker.
 *
 * The viewport builds the same furniture either way; this only decides which of
 * it is drawn and which of it answers to a pointer pick. With no policy the
 * viewport is exactly what it has always been: everything visible, nothing
 * pickable, read-only.
 */
export interface ViewportEditPolicy {
  /** Draw the marker for this arena placement at all? (Layer visibility.) */
  showsPlacement(kind: PlacementKind, index: number): boolean;
  /** Draw this arena layer's non-placement furniture (bounds outline, nav links)? */
  showsLayer(layer: Layer): boolean;
  /** Accept pointer picks on this arena placement? (Layer visible AND unlocked.) */
  selectsPlacement(kind: PlacementKind, index: number): boolean;
  /** Accept pointer picks on ship socket markers? */
  selectsSockets(): boolean;
}

/** Metadata every pickable authoring marker carries, as the old Map tool wrote it. */
export interface EditorMarkerTag { editorKind?: PlacementKind; editorIndex?: number; socketIndex?: number }

/**
 * Config types with a 3D subject worth staging. Everything else keeps the
 * opaque form chrome — there is nothing for a viewport to show.
 */
export const VIEWPORT_TYPES = ["ship", "module", "arena", "asteroid", "prop"] as const;
export type ViewportType = (typeof VIEWPORT_TYPES)[number];

export function isViewportType(type: string): type is ViewportType {
  return (VIEWPORT_TYPES as readonly string[]).includes(type);
}

/** Arena tools want the real arena behind them; staged subjects want a clean grid. */
function wantsArena(type: ViewportType): boolean {
  return type === "arena";
}

/**
 * Constellation's centre cell, staged into the game's own Babylon scene.
 *
 * The editor chrome is a transparent grid around this cell (see `editor.css`
 * `[data-viewport="on"]`) — so the canvas the game already renders to *is* the
 * viewport, with no second engine or render target.
 *
 * Subjects are built from the game's own machinery: `AssetRegistry` masters for
 * ships/modules/asteroids/props, and plain marker meshes for arena placements.
 * When an editing session installs a {@link ViewportEditPolicy}, those markers
 * become pickable and carry the (kind, index) tag the session selects on.
 */
export class ConstellationViewport {
  private readonly assets: AssetRegistry;
  private readonly stage: EditorStage;
  private root: TransformNode;
  /** Guards async model loads against a selection change landing first. */
  private revision = 0;
  private statusText = "";
  private onStatus: ((text: string) => void) | null = null;
  private policy: ViewportEditPolicy | null = null;
  /** The subject currently staged, so an edit can restage without a re-select. */
  private current: { config: AnyConfig; lookup: ConfigLookup } | null = null;
  /** "Game view": the authoring furniture is hidden, the free camera stays. */
  private furniture = true;

  constructor(private readonly host: ConstellationHost) {
    this.assets = new AssetRegistry(host.scene);
    this.stage = new EditorStage(host.scene);
    this.root = new TransformNode("constellationViewport", host.scene);
    host.pauseSim();
    host.setGameVisible(false);
    host.setArenaVisible(false);
  }

  /** Latest one-line description of what is staged (model vs placeholder…). */
  get status(): string { return this.statusText; }
  watchStatus(listener: (text: string) => void): void { this.onStatus = listener; }
  /** The config currently staged, if any — the session's restage source. */
  get staged(): AnyConfig | null { return this.current?.config ?? null; }

  /** Install (or remove) the editing session's marker policy. */
  setEditPolicy(policy: ViewportEditPolicy | null): void { this.policy = policy; }

  /**
   * Game view: every piece of authoring furniture off, the free editor camera
   * kept. The real arena behind it is untouched, so what remains on screen is
   * the arena exactly as a match shows it.
   */
  setFurnitureVisible(visible: boolean): void {
    this.furniture = visible;
    this.root.setEnabled(visible);
  }

  /** Tear the subject down and hand the canvas back to the opaque chrome. */
  clear(): void {
    this.revision++;
    this.current = null;
    this.resetRoot();
    this.stage.setEnabled(false);
    this.host.setArenaVisible(false);
    this.report("");
  }

  /**
   * Stage `config`. Returns true when something was built — the caller uses that
   * to switch the chrome between transparent (viewport) and opaque (forms only).
   */
  async show(config: AnyConfig, lookup: ConfigLookup): Promise<boolean> {
    if (!isViewportType(config.type)) { this.clear(); return false; }
    const revision = ++this.revision;
    this.current = { config, lookup };
    this.resetRoot();
    this.stage.setEnabled(!wantsArena(config.type));
    this.host.setArenaVisible(wantsArena(config.type));

    switch (config.type) {
      case "ship": await this.showShip(config as ShipConfig, revision); break;
      case "module": await this.showModule(config as ModuleConfig, revision); break;
      case "asteroid": await this.showAsteroid(config as AsteroidConfig, revision); break;
      case "prop": await this.showProp(config as PropConfig, revision); break;
      case "arena": this.showArena(config as ArenaConfig, lookup); break;
    }
    return revision === this.revision;
  }

  /** Rebuild the current subject in place — what every committed edit needs. */
  async restage(config?: AnyConfig): Promise<boolean> {
    const current = this.current;
    if (!current) return false;
    return this.show(config ?? current.config, current.lookup);
  }

  /**
   * The mesh a selection of (kind, index) should attach handles to. Props prefer
   * the real SceneBuilder instance — its authored hierarchy root is what a
   * designer expects to grab — and fall back to the marker.
   */
  markerFor(kind: PlacementKind, index: number): AbstractMesh | null {
    if (kind === "prop") {
      const real = this.host.scene.meshes.find((mesh) => {
        const tag = mesh.metadata as EditorMarkerTag | null;
        return tag?.editorKind === "prop" && tag.editorIndex === index && !mesh.name.startsWith("constellation.");
      });
      if (real) return real;
    }
    return this.host.scene.meshes.find((mesh) => {
      const tag = mesh.metadata as EditorMarkerTag | null;
      return tag?.editorKind === kind && tag.editorIndex === index;
    }) ?? null;
  }

  /** The socket marker for a ship socket array index. */
  socketMarkerFor(index: number): AbstractMesh | null {
    return this.host.scene.meshes.find((mesh) => (mesh.metadata as EditorMarkerTag | null)?.socketIndex === index) ?? null;
  }

  /** Every socket marker built by the last ship staging, by array index. */
  socketMarkers(): Map<number, AbstractMesh> {
    const markers = new Map<number, AbstractMesh>();
    for (const mesh of this.host.scene.meshes) {
      const tag = mesh.metadata as EditorMarkerTag | null;
      if (tag?.socketIndex !== undefined) markers.set(tag.socketIndex, mesh);
    }
    return markers;
  }

  /**
   * Show or hide the arena's real prop instances per layer. The markers answer
   * to `showsPlacement`, but a terrain chunk is drawn by SceneBuilder, not by
   * this viewport — hiding the Terrain layer has to reach those meshes.
   */
  applyScenePropVisibility(): void {
    const policy = this.policy;
    for (const mesh of this.host.scene.meshes) {
      const tag = mesh.metadata as EditorMarkerTag | null;
      if (tag?.editorKind !== "prop" || tag.editorIndex === undefined) continue;
      if (mesh.name.startsWith("constellation.")) continue;
      const visible = this.furniture && (!policy || policy.showsPlacement("prop", tag.editorIndex));
      mesh.setEnabled(visible);
      mesh.isPickable = !!policy && this.furniture && policy.selectsPlacement("prop", tag.editorIndex);
    }
  }

  /** Release every editor-only override on the arena's real prop instances. */
  releaseSceneProps(): void {
    for (const mesh of this.host.scene.meshes) {
      const tag = mesh.metadata as EditorMarkerTag | null;
      if (tag?.editorKind === "prop" && !mesh.name.startsWith("constellation.")) mesh.setEnabled(true);
    }
  }

  // ------------------------------------------------------------- subjects ----

  private async showShip(ship: ShipConfig, revision: number): Promise<void> {
    if (ship.render.model) await this.assets.ensureModel(ship.render);
    if (revision !== this.revision) return;
    const master = this.assets.getShipMaster(ship.render);
    const hull = master.clone(`constellationHull.${ship.id}`);
    pinCloneHierarchyLod0(hull);
    hull.setEnabled(true);
    hull.parent = this.root;
    hull.isPickable = false;

    const pickable = this.policy?.selectsSockets() ?? false;
    ship.sockets.forEach((socket, index) => {
      const marker = MeshBuilder.CreateSphere(`constellationSocket.${index}`, { diameter: 0.35, segments: 8 }, this.host.scene);
      marker.parent = this.root;
      const [x, y, z] = socket.transform.pos;
      marker.position.set(x, y, z);
      const [rx, ry, rz] = socket.transform.rot ?? [0, 0, 0];
      marker.rotation.set(rx, ry, rz);
      marker.scaling.setAll(socket.transform.scale ?? 1);
      marker.isPickable = pickable;
      marker.metadata = { socketIndex: index } satisfies EditorMarkerTag;
      marker.material = this.emissive(`constellationSocketMat.${index}`, socketColor(socket.kind));
    });

    this.frame(hull, 3.5, 8);
    this.report(`${ship.id} · ${ship.render.model ? `GLB ${ship.render.model}` : `recipe ${ship.render.recipe}`} · ${ship.sockets.length} sockets`);
  }

  private async showModule(config: ModuleConfig, revision: number): Promise<void> {
    const render = moduleRenderRecipe(config);
    if (render.model) await this.assets.ensureModel(render);
    if (revision !== this.revision) return;
    const master = this.assets.getModuleMaster(config);
    const mesh = master.createInstance(`constellationModule.${config.id}`);
    mesh.parent = this.root;
    mesh.position.setAll(0);
    mesh.isPickable = false;
    this.frame(mesh, 4, 2.5);
    this.report(`${config.id} · ${render.model ? `GLB ${render.model}` : `placeholder ${render.recipe}`}`);
  }

  private async showAsteroid(config: AsteroidConfig, revision: number): Promise<void> {
    if (config.render.model) await this.assets.ensureModel(config.render);
    if (revision !== this.revision) return;
    const master = this.assets.getShapedAsteroidMaster(config) ?? this.assets.getAsteroidMaster(config.render);
    const mesh = master.mesh.clone(`constellationAsteroid.${config.id}`);
    pinCloneHierarchyLod0(mesh);
    mesh.setEnabled(true);
    mesh.parent = this.root;
    mesh.isPickable = false;
    this.frame(mesh, 3.5, 6);
    this.report(`${config.id} · ${config.shape ? "authored shape" : config.render.model ? `GLB ${config.render.model}` : `recipe ${config.render.recipe}`}`);
  }

  private async showProp(config: PropConfig, revision: number): Promise<void> {
    if (config.render.model) await this.assets.ensureModel(config.render);
    if (revision !== this.revision) return;
    const master = this.assets.getShipMaster(config.render);
    const mesh = master.clone(`constellationProp.${config.id}`);
    pinCloneHierarchyLod0(mesh);
    mesh.setEnabled(true);
    mesh.parent = this.root;
    mesh.isPickable = false;
    this.frame(mesh, 3, 6);
    this.report(`${config.id} · ${config.category} · ${config.render.model ? `GLB ${config.render.model}` : `recipe ${config.render.recipe}`}`);
  }

  /**
   * Arena overview: bounds, spawn/flag markers, nav graph and one marker per
   * asteroid/prop placement — the arena layer vocabulary. The real arena is
   * visible behind it (`setArenaVisible(true)`), so this adds the authoring aids
   * a shipped match hides rather than re-simulating the scene.
   *
   * Read-only until a session installs a policy; with one, each marker becomes
   * the pick target for its placement.
   */
  private showArena(arena: ArenaConfig, lookup: ConfigLookup): void {
    const policy = this.policy;
    const shows = (kind: PlacementKind, index: number): boolean => !policy || policy.showsPlacement(kind, index);
    const showsLayer = (layer: Layer): boolean => !policy || policy.showsLayer(layer);

    arena.spawnPoints.forEach((spawn, index) => {
      if (!shows("spawn", index)) return;
      this.marker("spawn", index, `spawn.${spawn.id}`, spawn.position, 1.5, spawn.team === 0 ? new Color3(0.2, 0.5, 1) : new Color3(1, 0.3, 0.3), "cylinder", 0.2, spawn.heading);
    });
    (arena.flagBases ?? []).forEach((flag, index) => {
      if (!shows("flag", index)) return;
      const colour = flag.team === 0 ? new Color3(0.2, 0.5, 1) : new Color3(1, 0.3, 0.3);
      this.marker("flag", index, `flag.${flag.id}`, flag.position, 1, colour, "cylinder", 0.2);
      this.ring(`flagRing.${flag.id}`, flag.position, flag.radius, colour);
    });
    arena.asteroidPlacements.forEach((placement, index) => {
      if (!shows("asteroid", index)) return;
      this.marker("asteroid", index, `asteroid.${index}`, placement.position, 2.2 * (placement.scale ?? 1), new Color3(0.55, 0.44, 0.28), "ico", 0, typeof placement.rotation === "number" ? placement.rotation : 0);
    });
    (arena.propPlacements ?? []).forEach((placement, index) => {
      if (!shows("prop", index)) return;
      const prop = lookup("prop", placement.propId) as PropConfig | undefined;
      const colour = prop?.category === "terrain" ? new Color3(0.28, 0.34, 0.38) : new Color3(0.28, 0.72, 0.56);
      // The marker stays drawn even though SceneBuilder renders the real prop
      // behind it: a placement whose model failed to load, or whose prop config
      // has no model at all, would otherwise be invisible AND unselectable.
      this.marker("prop", index, `prop.${index}`, placement.position, 2.5 * (placement.scale ?? 1), colour, "ico", 0, placement.rotation?.y ?? 0);
    });
    if (showsLayer("nav")) this.showNavGraph(arena);
    if (showsLayer("bounds")) this.showBounds(arena);
    this.applyScenePropVisibility();

    const camera = this.host.scene.activeCamera as OrbitLike | null;
    camera?.setTarget?.(Vector3.Zero());
    if (camera && typeof camera.radius === "number") {
      camera.radius = Math.min(700, Math.max(40, boundsRadius(arena) * 2.2));
      camera.beta = 0.9;
    }
    this.report(`${arena.id} · ${arena.spawnPoints.length} spawns · ${arena.asteroidPlacements.length} asteroids · ${arena.propPlacements?.length ?? 0} props`);
  }

  /** Nav nodes (hubs drawn larger) plus one line per authored link. */
  private showNavGraph(arena: ArenaConfig): void {
    const graph = arena.navGraph;
    if (!graph) return;
    graph.nodes.forEach((node, index) => {
      if (this.policy && !this.policy.showsPlacement("nav", index)) return;
      this.marker("nav", index, `nav.${index}`, node.position, node.hub ? 1.4 : 0.8, new Color3(0.25, 0.9, 1), "ico");
    });
    for (const [a, b] of graph.links) {
      const from = graph.nodes.find((node) => node.id === a);
      const to = graph.nodes.find((node) => node.id === b);
      if (!from || !to) continue;
      const line = MeshBuilder.CreateLines(`constellation.navLink.${a}.${b}`, {
        points: [
          new Vector3(from.position.x, from.position.y ?? 0, from.position.z),
          new Vector3(to.position.x, to.position.y ?? 0, to.position.z),
        ],
      }, this.host.scene);
      line.parent = this.root;
      line.color = new Color3(0.2, 0.7, 1);
      line.isPickable = false;
    }
  }

  /** Bounds outline for each authored shape: a ring for the bubble, floor + ceiling loops otherwise. */
  private showBounds(arena: ArenaConfig): void {
    const bounds = arena.bounds;
    const colour = new Color3(0.15, 0.65, 1);
    if (bounds.shape === "sphere") {
      this.ring("bounds", { x: 0, y: bounds.floorY ?? 0, z: 0 }, bounds.radius, colour);
      return;
    }
    const [bottom, top] = bounds.shape === "box"
      ? [bounds.floorY, bounds.ceilingY]
      : [-bounds.verticalExtent / 2, bounds.verticalExtent / 2];
    this.rectangle("bounds.floor", bounds.width, bounds.height, bottom, colour);
    this.rectangle("bounds.ceiling", bounds.width, bounds.height, top, colour);
  }

  // -------------------------------------------------------------- helpers ----

  private marker(
    kind: PlacementKind,
    index: number,
    name: string,
    position: { x: number; y?: number; z: number },
    radius: number,
    colour: Color3,
    shape: "ico" | "cylinder",
    defaultY = 0,
    rotationY = 0,
  ): Mesh {
    const mesh = shape === "cylinder"
      ? MeshBuilder.CreateCylinder(`constellation.${name}`, { diameter: radius * 2, height: 0.3 }, this.host.scene)
      : MeshBuilder.CreateIcoSphere(`constellation.${name}`, { radius, subdivisions: 1 }, this.host.scene);
    mesh.position.set(position.x, position.y ?? defaultY, position.z);
    mesh.rotation.y = rotationY;
    mesh.parent = this.root;
    mesh.metadata = { editorKind: kind, editorIndex: index } satisfies EditorMarkerTag;
    mesh.isPickable = this.policy?.selectsPlacement(kind, index) ?? false;
    mesh.material = this.emissive(`constellationMat.${name}`, colour);
    return mesh;
  }

  private ring(name: string, centre: { x: number; y?: number; z: number }, radius: number, colour: Color3): void {
    const y = centre.y ?? 0;
    const points = Array.from({ length: 49 }, (_, i) => {
      const angle = (i / 48) * Math.PI * 2;
      return new Vector3(centre.x + Math.cos(angle) * radius, y, centre.z + Math.sin(angle) * radius);
    });
    const ring = MeshBuilder.CreateLines(`constellation.${name}`, { points }, this.host.scene);
    ring.parent = this.root;
    ring.color = colour;
    ring.isPickable = false;
  }

  private rectangle(name: string, width: number, depth: number, y: number, colour: Color3): void {
    const [hw, hd] = [width / 2, depth / 2];
    const points = [
      new Vector3(-hw, y, -hd), new Vector3(hw, y, -hd),
      new Vector3(hw, y, hd), new Vector3(-hw, y, hd), new Vector3(-hw, y, -hd),
    ];
    const loop = MeshBuilder.CreateLines(`constellation.${name}`, { points }, this.host.scene);
    loop.parent = this.root;
    loop.color = colour;
    loop.isPickable = false;
  }

  private emissive(name: string, colour: Color3): StandardMaterial {
    const material = new StandardMaterial(name, this.host.scene);
    material.emissiveColor = colour;
    return material;
  }

  /** Frame a staged subject: orbit the origin at a radius that fits its bounds. */
  private frame(mesh: AbstractMesh, multiplier: number, minimum: number): void {
    const camera = this.host.scene.activeCamera as OrbitLike | null;
    camera?.setTarget?.(Vector3.Zero());
    if (!camera || typeof camera.radius !== "number") return;
    mesh.computeWorldMatrix(true);
    camera.radius = Math.max(minimum, mesh.getBoundingInfo().boundingSphere.radiusWorld * multiplier);
    camera.beta = 1.1;
  }

  private resetRoot(): void {
    this.root.dispose(false, true);
    this.root = new TransformNode("constellationViewport", this.host.scene);
    this.root.setEnabled(this.furniture);
  }

  private report(text: string): void {
    this.statusText = text;
    this.onStatus?.(text);
  }

  dispose(): void {
    this.revision++;
    this.current = null;
    this.root.dispose(false, true);
    this.stage.dispose();
    this.assets.dispose();
    this.releaseSceneProps();
    this.host.setArenaVisible(true);
    this.host.setGameVisible(true);
    this.host.resumeSim();
  }
}

/** The orbit-camera surface every editor tool pokes at; the tactical rig satisfies it. */
interface OrbitLike { setTarget?: (target: Vector3) => void; radius?: number; beta?: number }

/**
 * Socket marker colours, kept as the Ships tool shipped them — cyan hardpoints,
 * orange emitters — so a designer's muscle memory survives the port. `internal`
 * postdates that palette and takes the green the read-only viewport already
 * used; anything else is magenta, so a socket kind added later is loud rather
 * than invisible.
 */
export function socketColor(kind: string): Color3 {
  if (kind === "hardpoint") return new Color3(0.15, 0.85, 1);
  if (kind === "emitter") return new Color3(1, 0.55, 0.1);
  if (kind === "internal") return new Color3(0.55, 0.95, 0.6);
  return new Color3(1, 0.1, 0.85);
}

/** Half-span of an arena's bounds, whatever shape it authors — the camera framing radius. */
export function boundsRadius(arena: ArenaConfig): number {
  const bounds = arena.bounds;
  return bounds.shape === "sphere" ? bounds.radius : Math.max(bounds.width, bounds.height) / 2;
}
