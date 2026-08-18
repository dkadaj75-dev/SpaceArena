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

/**
 * The slice of the running client Constellation needs to own the canvas as a
 * viewport. It is the same contract the F10 shell's `EditorHost` satisfies —
 * declared separately so the standalone editor depends only on what it uses,
 * and so `main.ts` can hand it over outside the DEV-only shell wiring.
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
}

/** Resolve a referenced config out of the draft pack (placements, fittings…). */
export type ConfigLookup = (type: ConfigType, id: string) => AnyConfig | undefined;

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
 * `[data-viewport="on"]`), exactly like the F10 shell — so the canvas the game
 * already renders to *is* the viewport, with no second engine or render target.
 *
 * Subjects are built with the same machinery the bespoke panels use:
 * `AssetRegistry` masters for ships/modules/asteroids/props, and MapEditor-style
 * marker meshes for arena placements.
 */
export class ConstellationViewport {
  private readonly assets: AssetRegistry;
  private readonly stage: EditorStage;
  private root: TransformNode;
  /** Guards async model loads against a selection change landing first. */
  private revision = 0;
  private statusText = "";
  private onStatus: ((text: string) => void) | null = null;

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

  /** Tear the subject down and hand the canvas back to the opaque chrome. */
  clear(): void {
    this.revision++;
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

    ship.sockets.forEach((socket, index) => {
      const marker = MeshBuilder.CreateSphere(`constellationSocket.${index}`, { diameter: 0.35, segments: 8 }, this.host.scene);
      marker.parent = this.root;
      const [x, y, z] = socket.transform.pos;
      marker.position.set(x, y, z);
      marker.isPickable = false;
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
   * Arena overview: bounds, spawn/flag markers and one marker per asteroid/prop
   * placement — the MapEditor layer vocabulary, read-only. The real arena is
   * visible behind it (`setArenaVisible(true)`), so this adds the authoring aids
   * a shipped match hides rather than re-simulating the scene.
   */
  private showArena(arena: ArenaConfig, lookup: ConfigLookup): void {
    for (const spawn of arena.spawnPoints) {
      this.marker(`spawn.${spawn.id}`, spawn.position, 1.5, spawn.team === 0 ? new Color3(0.2, 0.5, 1) : new Color3(1, 0.3, 0.3), "cylinder", 0.2);
    }
    for (const flag of arena.flagBases ?? []) {
      const colour = flag.team === 0 ? new Color3(0.2, 0.5, 1) : new Color3(1, 0.3, 0.3);
      this.marker(`flag.${flag.id}`, flag.position, 1, colour, "cylinder", 0.2);
      this.ring(`flagRing.${flag.id}`, flag.position, flag.radius, colour);
    }
    arena.asteroidPlacements.forEach((placement, index) => {
      this.marker(`asteroid.${index}`, placement.position, 2.2 * (placement.scale ?? 1), new Color3(0.55, 0.44, 0.28), "ico");
    });
    (arena.propPlacements ?? []).forEach((placement, index) => {
      const prop = lookup("prop", placement.propId) as PropConfig | undefined;
      const colour = prop?.category === "terrain" ? new Color3(0.28, 0.34, 0.38) : new Color3(0.28, 0.72, 0.56);
      this.marker(`prop.${index}`, placement.position, 2.5 * (placement.scale ?? 1), colour, "ico");
    });
    this.showBounds(arena);

    const camera = this.host.scene.activeCamera as OrbitLike | null;
    camera?.setTarget?.(Vector3.Zero());
    if (camera && typeof camera.radius === "number") {
      camera.radius = Math.min(700, Math.max(40, boundsRadius(arena) * 2.2));
      camera.beta = 0.9;
    }
    this.report(`${arena.id} · ${arena.spawnPoints.length} spawns · ${arena.asteroidPlacements.length} asteroids · ${arena.propPlacements?.length ?? 0} props`);
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
    name: string,
    position: { x: number; y?: number; z: number },
    radius: number,
    colour: Color3,
    shape: "ico" | "cylinder",
    defaultY = 0,
  ): Mesh {
    const mesh = shape === "cylinder"
      ? MeshBuilder.CreateCylinder(`constellation.${name}`, { diameter: radius * 2, height: 0.3 }, this.host.scene)
      : MeshBuilder.CreateIcoSphere(`constellation.${name}`, { radius, subdivisions: 1 }, this.host.scene);
    mesh.position.set(position.x, position.y ?? defaultY, position.z);
    mesh.parent = this.root;
    mesh.isPickable = false;
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
  }

  private report(text: string): void {
    this.statusText = text;
    this.onStatus?.(text);
  }

  dispose(): void {
    this.revision++;
    this.root.dispose(false, true);
    this.stage.dispose();
    this.assets.dispose();
    this.host.setArenaVisible(true);
    this.host.setGameVisible(true);
    this.host.resumeSim();
  }
}

/** The orbit-camera surface every editor tool pokes at; the tactical rig satisfies it. */
interface OrbitLike { setTarget?: (target: Vector3) => void; radius?: number; beta?: number }

function socketColor(kind: string): Color3 {
  if (kind === "hardpoint") return new Color3(1, 0.72, 0.27);
  if (kind === "emitter") return new Color3(0.34, 0.85, 1);
  return new Color3(0.55, 0.95, 0.6);
}

/** Half-span of an arena's bounds, whatever shape it authors — the camera framing radius. */
export function boundsRadius(arena: ArenaConfig): number {
  const bounds = arena.bounds;
  return bounds.shape === "sphere" ? bounds.radius : Math.max(bounds.width, bounds.height) / 2;
}
