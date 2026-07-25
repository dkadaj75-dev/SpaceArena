import {
  Color3,
  Mesh,
  MeshBuilder,
  MultiMaterial,
  PBRMaterial,
  SceneLoader,
  StandardMaterial,
  VertexBuffer,
  type AbstractMesh,
  type Scene,
} from "@babylonjs/core";
import { createLogger, type Palette, type RenderRecipe } from "@space-arena/shared";

const log = createLogger("AssetRegistry");

/**
 * The glTF importer registers itself with `SceneLoader` as a side effect of
 * being evaluated, so it only has to exist by the time a model is actually
 * loaded. Importing it dynamically (ROADMAP §11 6.3) keeps ~1 MB of loader code
 * out of the initial payload — it lands in the `babylon-loaders` chunk and is
 * fetched on the first {@link AssetRegistry.ensureModel} call. Memoized: the
 * promise is created once and every later load awaits the same one.
 */
let glTFLoaderReady: Promise<unknown> | null = null;
function ensureGlTFLoader(): Promise<unknown> {
  glTFLoaderReady ??= import("@babylonjs/loaders/glTF");
  return glTFLoaderReady;
}

/** Builds a disabled master mesh for a given palette. Never called per-instance. */
type RecipeBuilder = (scene: Scene, palette: Palette) => Mesh;

/** Deterministic pseudo-random, seeded per-vertex so a recipe looks stable across rebuilds. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function colorFromHex(hex: string | undefined, fallback: Color3): Color3 {
  if (!hex) return fallback;
  try {
    return Color3.FromHexString(hex);
  } catch {
    return fallback;
  }
}

function paletteKey(palette: Palette): string {
  return Object.entries(palette)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("|");
}

/**
 * `procedural.arrowhead` — the ship recipe. Reads well from directly above
 * (the only camera angle that matters in Phase 0): elongated hull, swept
 * wings, a small cockpit bump, and two engine nubs at the rear.
 */
function buildArrowhead(scene: Scene, palette: Palette): Mesh {
  const primary = colorFromHex(palette.primary, new Color3(0.18, 0.44, 0.72));
  const accent = colorFromHex(palette.accent, new Color3(0.34, 0.85, 1.0));

  const hullMat = new StandardMaterial(`mat.arrowhead.${paletteKey(palette)}`, scene);
  hullMat.diffuseColor = primary;
  hullMat.specularColor = Color3.Black();
  hullMat.emissiveColor = accent.scale(0.15);

  // Hull: a stretched, tapered box-ish cylinder standing in for a fuselage.
  const hull = MeshBuilder.CreateCylinder(
    "arrowhead.hull",
    { diameterTop: 0.1, diameterBottom: 1.1, height: 3.2, tessellation: 6 },
    scene,
  );
  hull.rotation.x = Math.PI / 2; // nose points +Z
  hull.bakeCurrentTransformIntoVertices();

  // Wings: two flattened, swept-back triangular boxes.
  const wingL = MeshBuilder.CreateBox("arrowhead.wingL", { width: 2.4, height: 0.12, depth: 1.0 }, scene);
  wingL.position.set(-1.1, 0, -0.6);
  wingL.rotation.y = -0.35;
  wingL.bakeCurrentTransformIntoVertices();

  const wingR = wingL.clone("arrowhead.wingR");
  wingR.position.set(1.1, 0, -0.6);
  wingR.rotation.y = 0.35;
  wingR.bakeCurrentTransformIntoVertices();

  // Cockpit bump: small sphere forward of center, emissive accent.
  const cockpit = MeshBuilder.CreateSphere("arrowhead.cockpit", { diameter: 0.5, segments: 8 }, scene);
  cockpit.position.set(0, 0.2, 0.6);
  cockpit.scaling.set(1, 0.6, 1.3);
  cockpit.bakeCurrentTransformIntoVertices();

  // Two engine nubs at the rear.
  const engineL = MeshBuilder.CreateCylinder(
    "arrowhead.engineL",
    { diameter: 0.32, height: 0.5, tessellation: 8 },
    scene,
  );
  engineL.rotation.x = Math.PI / 2;
  engineL.position.set(-0.4, 0, -1.6);
  engineL.bakeCurrentTransformIntoVertices();

  const engineR = engineL.clone("arrowhead.engineR");
  engineR.position.set(0.4, 0, -1.6);
  engineR.bakeCurrentTransformIntoVertices();

  const merged = Mesh.MergeMeshes(
    [hull, wingL, wingR, cockpit, engineL, engineR],
    true,
    true,
    undefined,
    false,
    true,
  )!;
  merged.name = "master.procedural.arrowhead";
  merged.material = hullMat;
  merged.setEnabled(false);
  return merged;
}

/**
 * `procedural.brawler` — chunky twin-hull ship recipe (ROADMAP 4 task 1). Two
 * short, wide tapered hulls side by side joined by a wide spine/nose plate and
 * a single broad rear engine block: reads wide and tanky from directly above,
 * distinct from the arrowhead's single tapered fuselage.
 */
function buildBrawler(scene: Scene, palette: Palette): Mesh {
  const primary = colorFromHex(palette.primary, new Color3(0.72, 0.33, 0.18));
  const accent = colorFromHex(palette.accent, new Color3(1.0, 0.7, 0.34));

  const hullMat = new StandardMaterial(`mat.brawler.${paletteKey(palette)}`, scene);
  hullMat.diffuseColor = primary;
  hullMat.specularColor = Color3.Black();
  hullMat.emissiveColor = accent.scale(0.12);

  // Twin hulls: two short, wide tapered cylinders side by side.
  const hullL = MeshBuilder.CreateCylinder(
    "brawler.hullL",
    { diameterTop: 0.5, diameterBottom: 1.3, height: 3.0, tessellation: 8 },
    scene,
  );
  hullL.rotation.x = Math.PI / 2;
  hullL.position.set(-0.9, 0, 0);
  hullL.bakeCurrentTransformIntoVertices();

  const hullR = hullL.clone("brawler.hullR");
  hullR.position.set(0.9, 0, 0);
  hullR.bakeCurrentTransformIntoVertices();

  // Central spine plate binding the two hulls together — reinforces the wide read.
  const spine = MeshBuilder.CreateBox("brawler.spine", { width: 2.2, height: 0.35, depth: 1.6 }, scene);
  spine.position.set(0, 0, -0.1);
  spine.bakeCurrentTransformIntoVertices();

  // Forward armor bridge.
  const nose = MeshBuilder.CreateBox("brawler.nose", { width: 1.6, height: 0.3, depth: 0.9 }, scene);
  nose.position.set(0, 0, 1.6);
  nose.bakeCurrentTransformIntoVertices();

  // One broad rear engine block spanning both hulls, plus two engine nubs.
  const engineBlock = MeshBuilder.CreateBox("brawler.engineBlock", { width: 2.4, height: 0.4, depth: 0.6 }, scene);
  engineBlock.position.set(0, 0, -1.9);
  engineBlock.bakeCurrentTransformIntoVertices();

  const engineL = MeshBuilder.CreateCylinder(
    "brawler.engineL",
    { diameter: 0.5, height: 0.4, tessellation: 8 },
    scene,
  );
  engineL.rotation.x = Math.PI / 2;
  engineL.position.set(-0.9, 0, -2.15);
  engineL.bakeCurrentTransformIntoVertices();

  const engineR = engineL.clone("brawler.engineR");
  engineR.position.set(0.9, 0, -2.15);
  engineR.bakeCurrentTransformIntoVertices();

  const merged = Mesh.MergeMeshes(
    [hullL, hullR, spine, nose, engineBlock, engineL, engineR],
    true,
    true,
    undefined,
    false,
    true,
  )!;
  merged.name = "master.procedural.brawler";
  merged.material = hullMat;
  merged.setEnabled(false);
  return merged;
}

/**
 * `procedural.support` — rounded medium hull with side pods (ROADMAP 4 task
 * 1). An elongated ellipsoid core with two small rounded pods on thin arms:
 * reads rounded/utility-leaning from above, distinct from both the pointed
 * arrowhead and the wide brawler.
 */
function buildSupport(scene: Scene, palette: Palette): Mesh {
  const primary = colorFromHex(palette.primary, new Color3(0.18, 0.72, 0.48));
  const accent = colorFromHex(palette.accent, new Color3(0.48, 1.0, 0.82));

  const hullMat = new StandardMaterial(`mat.support.${paletteKey(palette)}`, scene);
  hullMat.diffuseColor = primary;
  hullMat.specularColor = Color3.Black();
  hullMat.emissiveColor = accent.scale(0.15);

  // Central rounded hull: elongated ellipsoid via a non-uniformly scaled sphere.
  const core = MeshBuilder.CreateSphere(
    "support.core",
    { diameterX: 1.3, diameterY: 0.6, diameterZ: 2.6, segments: 10 },
    scene,
  );
  core.bakeCurrentTransformIntoVertices();

  // Two thin connecting arms out to rounded side pods.
  const armL = MeshBuilder.CreateBox("support.armL", { width: 1.0, height: 0.14, depth: 0.28 }, scene);
  armL.position.set(-0.8, 0, -0.1);
  armL.bakeCurrentTransformIntoVertices();
  const armR = armL.clone("support.armR");
  armR.position.set(0.8, 0, -0.1);
  armR.bakeCurrentTransformIntoVertices();

  const podL = MeshBuilder.CreateSphere("support.podL", { diameter: 0.7, segments: 8 }, scene);
  podL.scaling.set(1, 0.7, 1.4);
  podL.position.set(-1.35, 0, -0.1);
  podL.bakeCurrentTransformIntoVertices();
  const podR = podL.clone("support.podR");
  podR.position.set(1.35, 0, -0.1);
  podR.bakeCurrentTransformIntoVertices();

  // Small forward sensor bump.
  const nose = MeshBuilder.CreateSphere("support.nose", { diameter: 0.35, segments: 8 }, scene);
  nose.scaling.set(1, 0.7, 1.1);
  nose.position.set(0, 0.1, 1.4);
  nose.bakeCurrentTransformIntoVertices();

  const merged = Mesh.MergeMeshes([core, armL, armR, podL, podR, nose], true, true, undefined, false, true)!;
  merged.name = "master.procedural.support";
  merged.material = hullMat;
  merged.setEnabled(false);
  return merged;
}

/**
 * `procedural.module.<family>` — small per-family hardpoint module meshes
 * (ROADMAP §9 4.6/socket rendering). Attached at a hardpoint socket transform
 * by {@link import("../game/ShipSocketRig.js").ShipSocketRig}; shape alone
 * should read the family at a glance: laser = thin barrel, kinetic = boxy
 * cannon, missile = tube rack, shield = dome nub, boost = thruster cone,
 * utility = small box. `palette.primary` is the ship's accent color so the
 * module reads as part of that ship (see ShipSocketRig).
 */
function buildModuleFamily(scene: Scene, palette: Palette, family: string): Mesh {
  const tint = colorFromHex(palette.primary, new Color3(0.6, 0.65, 0.72));

  const mat = new StandardMaterial(`mat.module.${family}.${paletteKey(palette)}`, scene);
  mat.diffuseColor = Color3.Black();
  mat.specularColor = Color3.Black();
  mat.emissiveColor = tint;

  let mesh: Mesh;
  switch (family) {
    case "laser": {
      mesh = MeshBuilder.CreateCylinder("module.laser", { diameter: 0.12, height: 0.8, tessellation: 8 }, scene);
      mesh.rotation.x = Math.PI / 2;
      mesh.bakeCurrentTransformIntoVertices();
      break;
    }
    case "kinetic": {
      const body = MeshBuilder.CreateBox("module.kinetic.body", { width: 0.34, height: 0.28, depth: 0.5 }, scene);
      const barrel = MeshBuilder.CreateCylinder(
        "module.kinetic.barrel",
        { diameter: 0.14, height: 0.5, tessellation: 8 },
        scene,
      );
      barrel.rotation.x = Math.PI / 2;
      barrel.position.set(0, 0, 0.4);
      barrel.bakeCurrentTransformIntoVertices();
      mesh = Mesh.MergeMeshes([body, barrel], true, true, undefined, false, true)!;
      break;
    }
    case "missile": {
      const rack = MeshBuilder.CreateBox("module.missile.rack", { width: 0.4, height: 0.22, depth: 0.5 }, scene);
      const tubeL = MeshBuilder.CreateCylinder(
        "module.missile.tubeL",
        { diameter: 0.12, height: 0.6, tessellation: 6 },
        scene,
      );
      tubeL.rotation.x = Math.PI / 2;
      tubeL.position.set(-0.11, 0.12, 0.05);
      tubeL.bakeCurrentTransformIntoVertices();
      const tubeR = tubeL.clone("module.missile.tubeR");
      tubeR.position.set(0.11, 0.12, 0.05);
      tubeR.bakeCurrentTransformIntoVertices();
      mesh = Mesh.MergeMeshes([rack, tubeL, tubeR], true, true, undefined, false, true)!;
      break;
    }
    case "shield": {
      mesh = MeshBuilder.CreateSphere("module.shield.dome", { diameter: 0.5, segments: 8, slice: 0.5 }, scene);
      break;
    }
    case "boost": {
      mesh = MeshBuilder.CreateCylinder(
        "module.boost.cone",
        { diameterTop: 0.08, diameterBottom: 0.32, height: 0.5, tessellation: 8 },
        scene,
      );
      mesh.rotation.x = -Math.PI / 2; // flare points aft (-Z)
      mesh.bakeCurrentTransformIntoVertices();
      break;
    }
    case "utility":
    default: {
      mesh = MeshBuilder.CreateBox("module.utility.box", { width: 0.3, height: 0.24, depth: 0.3 }, scene);
      break;
    }
  }
  mesh.name = `master.procedural.module.${family}`;
  mesh.material = mat;
  mesh.setEnabled(false);
  return mesh;
}

/**
 * Icosphere + per-vertex noise displacement, shared by both asteroid recipes.
 * `subdivisions` and `displacement` let small-rock/large-hazard reuse one
 * builder with different roughness while keeping materials shared per palette.
 */
function buildRock(
  scene: Scene,
  palette: Palette,
  name: string,
  subdivisions: number,
  displacement: number,
  seed: number,
): Mesh {
  const primary = colorFromHex(palette.primary, new Color3(0.35, 0.32, 0.29));
  const accent = colorFromHex(palette.accent, new Color3(0.49, 0.45, 0.4));

  const mat = new StandardMaterial(`mat.${name}.${paletteKey(palette)}`, scene);
  mat.diffuseColor = primary;
  mat.emissiveColor = accent.scale(0.05);
  mat.specularColor = Color3.Black();

  const mesh = MeshBuilder.CreateIcoSphere(
    `master.${name}`,
    { radius: 1, subdivisions, flat: true },
    scene,
  );

  const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
  if (positions) {
    const rand = mulberry32(seed);
    for (let i = 0; i < positions.length; i += 3) {
      const nx = positions[i] ?? 0;
      const ny = positions[i + 1] ?? 0;
      const nz = positions[i + 2] ?? 0;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      const noise = 1 + (rand() - 0.5) * 2 * displacement;
      positions[i] = (nx / len) * len * noise;
      positions[i + 1] = (ny / len) * len * noise;
      positions[i + 2] = (nz / len) * len * noise;
    }
    mesh.updateVerticesData(VertexBuffer.PositionKind, positions);
    mesh.createNormals(false);
  }

  mesh.material = mat;
  mesh.setEnabled(false);
  return mesh;
}

/**
 * LOD distances for asteroid masters (§10 5.6). Set by the active quality tier;
 * `0` on a level disables it. Distances are camera→mesh in world units and the
 * tactical camera radius is clamped to 30-90 (the dev editor goes to 300), so
 * the band is known up front — which is what makes LOD a cheap win here.
 */
export interface AsteroidLod {
  lodMediumDistance: number;
  lodLowDistance: number;
  lodCullDistance: number;
}

/**
 * Recipes that get asteroid LOD levels attached, mapped to the icosphere
 * subdivision counts used for their medium/low variants. Keyed by recipe id so
 * a content pack adding a rock recipe opts in by name, not by code change.
 */
const ASTEROID_LOD_SUBDIVISIONS: Record<string, { medium: number; low: number }> = {
  "procedural.rock-small": { medium: 1, low: 1 },
  "procedural.rock-large": { medium: 2, low: 1 },
};

const RECIPES: Record<string, RecipeBuilder> = {
  "procedural.arrowhead": buildArrowhead,
  "procedural.brawler": buildBrawler,
  "procedural.support": buildSupport,
  "procedural.rock-small": (scene, palette) =>
    buildRock(scene, palette, "procedural.rock-small", 2, 0.18, 1337),
  "procedural.rock-large": (scene, palette) =>
    buildRock(scene, palette, "procedural.rock-large", 3, 0.28, 9001),
  "procedural.module.laser": (scene, palette) => buildModuleFamily(scene, palette, "laser"),
  "procedural.module.kinetic": (scene, palette) => buildModuleFamily(scene, palette, "kinetic"),
  "procedural.module.missile": (scene, palette) => buildModuleFamily(scene, palette, "missile"),
  "procedural.module.shield": (scene, palette) => buildModuleFamily(scene, palette, "shield"),
  "procedural.module.boost": (scene, palette) => buildModuleFamily(scene, palette, "boost"),
  "procedural.module.utility": (scene, palette) => buildModuleFamily(scene, palette, "utility"),
};

/**
 * Maps render-recipe ids to procedural builder functions. Master meshes are
 * cached per (recipe, palette) key — disabled, never rendered directly —
 * so callers clone/instance/thin-instance from them and materials are never
 * duplicated per game-object instance.
 */
export class AssetRegistry {
  private readonly cache = new Map<string, Mesh>();
  /** LOD variants built alongside a master, disposed with it. */
  private readonly lodMeshes = new Map<string, Mesh[]>();
  private asteroidLod: AsteroidLod | null = null;

  /**
   * GLB master meshes, shared across every AssetRegistry on the same scene
   * (ViewManager, ShipManager, Hangar each construct their own registry —
   * a model must load once, not once per consumer). `null` marks a failed
   * load so we don't retry every frame.
   */
  private static readonly modelMasters = new WeakMap<Scene, Map<string, Mesh | null>>();
  private static readonly modelLoads = new WeakMap<Scene, Map<string, Promise<Mesh | null>>>();

  constructor(private readonly scene: Scene) {}

  private static sceneMap<T>(store: WeakMap<Scene, Map<string, T>>, scene: Scene): Map<string, T> {
    let m = store.get(scene);
    if (!m) {
      m = new Map();
      store.set(scene, m);
    }
    return m;
  }

  /**
   * Load (once) a content-relative GLB/GLTF hull and cache a single merged,
   * disabled master mesh for instancing. Scale/yaw from the render config are
   * baked into the vertices so instances need no per-node correction.
   * Resolves null on failure — callers fall back to the procedural recipe.
   */
  ensureModel(render: RenderRecipe): Promise<Mesh | null> {
    const path = render.model;
    if (!path) return Promise.resolve(null);
    const key = `${path}::s${render.modelScale ?? 1}::r${render.modelRotationY ?? 0}`;
    const masters = AssetRegistry.sceneMap(AssetRegistry.modelMasters, this.scene);
    const existing = masters.get(key);
    if (existing !== undefined) return Promise.resolve(existing);
    const loads = AssetRegistry.sceneMap(AssetRegistry.modelLoads, this.scene);
    const pending = loads.get(key);
    if (pending) return pending;

    const dir = path.slice(0, path.lastIndexOf("/") + 1);
    const file = path.slice(path.lastIndexOf("/") + 1);
    const load = ensureGlTFLoader()
      .then(() => SceneLoader.ImportMeshAsync("", `/content/${dir}`, file, this.scene))
      .then((result) => {
        try {
          return this.finalizeModel(result.meshes, render, path, masters, loads, key);
        } catch (error) {
          // A failed finalize must not strand half-imported meshes in the scene.
          for (const m of result.meshes) if (!m.isDisposed()) m.dispose(false, true);
          throw error;
        }
      })
      .catch((error: unknown) => {
        const stack = error instanceof Error && error.stack ? `\n${error.stack}` : "";
        log.warn(`model load failed for "${path}": ${String(error)} — using procedural recipe${stack}`);
        masters.set(key, null);
        loads.delete(key);
        return null;
      });
    loads.set(key, load);
    return load;
  }

  /** Merge, orient and cache a freshly imported model's meshes into one disabled master. */
  private finalizeModel(
    meshes: readonly AbstractMesh[],
    render: RenderRecipe,
    path: string,
    masters: Map<string, Mesh | null>,
    loads: Map<string, Promise<Mesh | null>>,
    key: string,
  ): Mesh {
    const parts = meshes.filter((m): m is Mesh => m instanceof Mesh && m.getTotalVertices() > 0);
    if (parts.length === 0) throw new Error("no meshes with geometry in model");
    for (const p of parts) p.computeWorldMatrix(true);
    let merged: Mesh;
    if (parts.length === 1) {
      // Bake the full world matrix (includes the glTF root's RH→LH flip)
      // so detaching from __root__ can't mirror or re-orient the hull.
      merged = parts[0]!;
      merged.bakeTransformIntoVertices(merged.getWorldMatrix());
    } else {
      const m = Mesh.MergeMeshes(parts, true, true, undefined, false, true);
      if (!m) throw new Error("mesh merge failed");
      merged = m;
    }
    // Detach BEFORE dropping the glTF __root__: MergeMeshes parents the
    // result under it, and a recursive root dispose would take the merged
    // mesh with it.
    merged.setParent(null);
    for (const m of meshes) if (m !== merged && !m.isDisposed()) m.dispose(false, false);
    merged.position.setAll(0);
    merged.scaling.setAll(render.modelScale ?? 1);
    merged.rotation.setAll(0);
    merged.rotationQuaternion = null;
    merged.rotation.y = render.modelRotationY ?? 0;
    merged.bakeCurrentTransformIntoVertices();
    // The scene has no IBL/environment texture, so fully-metallic PBR
    // surfaces (common in generated GLBs) would render black under our
    // punctual lights. Clamp metalness so albedo responds to them.
    const flat = merged.material;
    const mats = flat instanceof MultiMaterial ? flat.subMaterials : [flat];
    for (const m of mats) {
      if (m instanceof PBRMaterial) {
        m.metallic = Math.min(m.metallic ?? 1, 0.25);
        m.roughness = Math.max(m.roughness ?? 0.4, 0.5);
      }
    }
    merged.name = `master.model.${path}`;
    merged.setEnabled(false);
    masters.set(key, merged);
    loads.delete(key);
    return merged;
  }

  /**
   * Master mesh for a ship render config: the GLB model when configured AND
   * already loaded (kick loads off early via {@link ensureModel} — bootstrap
   * preloads every ship model), otherwise the procedural recipe.
   */
  getShipMaster(render: RenderRecipe): Mesh {
    if (render.model) {
      const key = `${render.model}::s${render.modelScale ?? 1}::r${render.modelRotationY ?? 0}`;
      const master = AssetRegistry.sceneMap(AssetRegistry.modelMasters, this.scene).get(key);
      if (master) return master;
    }
    return this.getMesh(render.recipe, render.palette ?? {});
  }

  /** Returns the cached master mesh for a recipe+palette, building it on first use. */
  getMesh(recipeId: string, palette: Palette = {}): Mesh {
    const key = `${recipeId}::${paletteKey(palette)}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    const builder = RECIPES[recipeId];
    if (!builder) {
      log.warn(`unknown render recipe "${recipeId}", falling back to a placeholder box`);
      const fallback = MeshBuilder.CreateBox(`master.placeholder.${recipeId}`, { size: 1 }, this.scene);
      fallback.setEnabled(false);
      this.cache.set(key, fallback);
      return fallback;
    }

    const mesh = builder(this.scene, palette);
    this.cache.set(key, mesh);
    this.applyAsteroidLod(key, recipeId, palette, mesh);
    return mesh;
  }

  /**
   * Set (or clear) the asteroid LOD distances. Applies to masters already built
   * and to any built later, so a quality-tier switch mid-session takes effect
   * without recreating the registry. `null` removes every LOD level.
   */
  setAsteroidLod(lod: AsteroidLod | null): void {
    this.asteroidLod = lod;
    for (const [key, master] of this.cache) {
      const recipeId = key.slice(0, key.indexOf("::"));
      this.clearLod(key, master);
      this.applyAsteroidLod(key, recipeId, paletteFromKey(key), master);
    }
  }

  /**
   * `addLODLevel` on an asteroid master: a mid-detail icosphere, a low-detail
   * one, then (optionally) `null` to stop drawing entirely past the cull
   * distance. `InstancedMesh.getLOD` defers to its source mesh, so every
   * asteroid instance picks up these levels for free.
   */
  private applyAsteroidLod(key: string, recipeId: string, palette: Palette, master: Mesh): void {
    const lod = this.asteroidLod;
    const subdivisions = ASTEROID_LOD_SUBDIVISIONS[recipeId];
    if (!lod || !subdivisions) return;

    const levels: Mesh[] = [];
    const addLevel = (distance: number, subs: number, suffix: string): void => {
      if (distance <= 0) return;
      const variant = buildRock(
        this.scene,
        palette,
        `${recipeId}.lod-${suffix}`,
        subs,
        recipeId === "procedural.rock-large" ? 0.28 : 0.18,
        recipeId === "procedural.rock-large" ? 9001 : 1337,
      );
      // Share the master's material so an LOD swap can't change the look or
      // add a second material to the scene.
      variant.material?.dispose();
      variant.material = master.material;
      master.addLODLevel(distance, variant);
      levels.push(variant);
    };
    addLevel(lod.lodMediumDistance, subdivisions.medium, "med");
    addLevel(lod.lodLowDistance, subdivisions.low, "low");
    if (lod.lodCullDistance > 0) master.addLODLevel(lod.lodCullDistance, null);
    if (levels.length > 0) this.lodMeshes.set(key, levels);
  }

  private clearLod(key: string, master: Mesh): void {
    const levels = this.lodMeshes.get(key);
    if (!levels) return;
    for (const level of levels) {
      master.removeLODLevel(level);
      level.dispose();
    }
    this.lodMeshes.delete(key);
  }

  /** Disposes every cached master mesh, its LOD variants, and its material. */
  dispose(): void {
    for (const levels of this.lodMeshes.values()) for (const level of levels) level.dispose();
    this.lodMeshes.clear();
    for (const mesh of this.cache.values()) {
      mesh.material?.dispose();
      mesh.dispose();
    }
    this.cache.clear();
  }
}

/** Inverse of {@link paletteKey} for the `recipe::k=v|k=v` cache-key format. */
function paletteFromKey(key: string): Palette {
  const encoded = key.slice(key.indexOf("::") + 2);
  if (encoded === "") return {};
  const palette: Record<string, string> = {};
  for (const pair of encoded.split("|")) {
    const eq = pair.indexOf("=");
    if (eq > 0) palette[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return palette;
}
