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
  type Material,
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
  /**
   * Ignore `render.model` and draw the procedural recipe (quality tier knob —
   * see `quality.asteroids.proceduralOnly`). Omitted = models are used.
   */
  proceduralOnly?: boolean;
}

/**
 * A master to instance an asteroid from, plus the factor turning the sim's
 * world-unit collider radius into instance scaling. Procedural rock masters are
 * unit-radius (`radiusScale` 1); a GLB master has its `modelScale` already baked
 * into its vertices, so it scales by `radius / modelScale` — with the authored
 * convention that a model is normalized to max radial extent 1 and `modelScale`
 * equals the config's collider radius, that lands at 1 for an unscaled placement.
 */
export interface AsteroidMaster {
  mesh: Mesh;
  radiusScale: number;
}

/**
 * The rock recipes, and everything needed to rebuild one at a lower
 * subdivision count for an LOD level. Keyed by recipe id, so a content pack
 * adding a rock recipe opts into asteroid LOD by NAME — and an asteroid
 * config with a `render.model` opts in through its own fallback `recipe`,
 * which is exactly the palette-matched stand-in we want at distance.
 */
interface RockRecipe {
  subdivisions: number;
  displacement: number;
  seed: number;
  /** Subdivision counts for the lodMedium / lodLow stand-ins. */
  lodMedium: number;
  lodLow: number;
}

const ROCK_RECIPES: Record<string, RockRecipe> = {
  "procedural.rock-small": { subdivisions: 2, displacement: 0.18, seed: 1337, lodMedium: 1, lodLow: 1 },
  "procedural.rock-large": { subdivisions: 3, displacement: 0.28, seed: 9001, lodMedium: 2, lodLow: 1 },
};

/** A shared GLB master this registry hung asteroid LOD levels on. */
interface ModelLodTarget {
  master: Mesh;
  /** The config's fallback rock recipe — the source of the LOD stand-ins. */
  recipeId: string;
  palette: Palette;
  /** The master's baked `modelScale`. */
  unitRadius: number;
}

/** Cache key for a GLB master: one entry per (path, baked scale, baked yaw). */
function modelKey(render: RenderRecipe): string {
  return `${render.model}::s${render.modelScale ?? 1}::r${render.modelRotationY ?? 0}`;
}

/** Builds a rock recipe at its authored detail, or at an explicit LOD subdivision count. */
function buildRockRecipe(scene: Scene, palette: Palette, recipeId: string, subdivisions?: number): Mesh {
  const rock = ROCK_RECIPES[recipeId]!;
  return buildRock(scene, palette, recipeId, subdivisions ?? rock.subdivisions, rock.displacement, rock.seed);
}

const RECIPES: Record<string, RecipeBuilder> = {
  "procedural.arrowhead": buildArrowhead,
  "procedural.brawler": buildBrawler,
  "procedural.support": buildSupport,
  "procedural.rock-small": (scene, palette) => buildRockRecipe(scene, palette, "procedural.rock-small"),
  "procedural.rock-large": (scene, palette) => buildRockRecipe(scene, palette, "procedural.rock-large"),
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
  /**
   * GLB asteroid masters this registry has attached LOD levels to. They are NOT
   * in `cache` — model masters are shared per-scene across every registry — so
   * they need their own list for re-applying on a tier switch and for detaching
   * on dispose (a dangling LOD level would outlive us on a mesh we don't own).
   */
  private readonly modelLodTargets = new Map<string, ModelLodTarget>();
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
    const key = modelKey(render);
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
    const master = this.loadedModel(render);
    if (master) return master;
    return this.getMesh(render.recipe, render.palette ?? {});
  }

  /**
   * Master mesh for an asteroid render config, on the same "model when loaded,
   * procedural otherwise" rule as {@link getShipMaster} — kick the load off
   * early via {@link ensureModel} (see `core/assetPreload`) so a match never
   * starts on the fallback. The active quality tier can opt out of models
   * entirely (`asteroids.proceduralOnly`).
   *
   * A model master picks up the same LOD ladder the procedural masters get,
   * with the config's fallback recipe supplying the palette-matched
   * medium/low stand-ins — see {@link applyAsteroidLod}.
   */
  getAsteroidMaster(render: RenderRecipe): AsteroidMaster {
    const model = this.asteroidLod?.proceduralOnly === true ? null : this.loadedModel(render);
    if (model) {
      const unitRadius = render.modelScale ?? 1;
      const key = `model::${modelKey(render)}`;
      if (!this.modelLodTargets.has(key)) {
        const target: ModelLodTarget = {
          master: model,
          recipeId: render.recipe,
          palette: render.palette ?? {},
          unitRadius,
        };
        this.modelLodTargets.set(key, target);
        this.applyAsteroidLod(key, target.recipeId, target.palette, model, unitRadius, false);
      }
      return { mesh: model, radiusScale: 1 / unitRadius };
    }
    return { mesh: this.getMesh(render.recipe, render.palette ?? {}), radiusScale: 1 };
  }

  /** The already-loaded GLB master for a render config, if it has one and it landed. */
  private loadedModel(render: RenderRecipe): Mesh | null {
    if (!render.model) return null;
    return AssetRegistry.sceneMap(AssetRegistry.modelMasters, this.scene).get(modelKey(render)) ?? null;
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
    for (const [key, target] of this.modelLodTargets) {
      this.clearLod(key, target.master);
      this.applyAsteroidLod(key, target.recipeId, target.palette, target.master, target.unitRadius, false);
    }
  }

  /**
   * `addLODLevel` on an asteroid master: a mid-detail icosphere, a low-detail
   * one, then (optionally) `null` to stop drawing entirely past the cull
   * distance. `InstancedMesh.getLOD` defers to its source mesh, so every
   * asteroid instance picks up these levels for free.
   *
   * This is also the whole LOD story for MODEL asteroids (§10 5.6): the GLB is
   * the near master and the config's fallback rock recipe — same palette —
   * supplies the medium/low stand-ins, so a 7.7k-tri rock collapses to a
   * ~80-tri icosphere at `lodMediumDistance` and stops drawing at
   * `lodCullDistance`. Two things differ from the procedural case, both passed
   * in rather than sniffed: `unitRadius` bakes the master's `modelScale` into
   * the stand-in so one instance scaling fits both, and `shareMasterMaterial`
   * is false because the model's PBR material is textured against the GLB's own
   * UVs and would map as noise onto an icosphere.
   */
  private applyAsteroidLod(
    key: string,
    recipeId: string,
    palette: Palette,
    master: Mesh,
    unitRadius = 1,
    shareMasterMaterial = true,
  ): void {
    const lod = this.asteroidLod;
    const rock = ROCK_RECIPES[recipeId];
    if (!lod || !rock) return;

    const levels: Mesh[] = [];
    // Both stand-ins run on ONE material: the master's when it is a procedural
    // rock, otherwise the palette material the first stand-in built. Either way
    // an LOD swap cannot change the look, and no level adds a material.
    let standIn: Material | null = shareMasterMaterial ? master.material : null;
    const addLevel = (distance: number, subs: number, suffix: string): void => {
      if (distance <= 0) return;
      const variant = buildRockRecipe(this.scene, palette, recipeId, subs);
      variant.name = `master.${recipeId}.lod-${suffix}`;
      if (standIn) {
        variant.material?.dispose();
        variant.material = standIn;
      } else {
        standIn = variant.material;
      }
      if (unitRadius !== 1) {
        // The stand-in is unit-radius; the model master has its modelScale
        // baked in. Bake the same factor here so both answer to one scaling.
        variant.scaling.setAll(unitRadius);
        variant.bakeCurrentTransformIntoVertices();
      }
      master.addLODLevel(distance, variant);
      levels.push(variant);
    };
    addLevel(lod.lodMediumDistance, rock.lodMedium, "med");
    addLevel(lod.lodLowDistance, rock.lodLow, "low");
    if (lod.lodCullDistance > 0) master.addLODLevel(lod.lodCullDistance, null);
    this.lodMeshes.set(key, levels);
  }

  private clearLod(key: string, master: Mesh): void {
    const levels = this.lodMeshes.get(key);
    if (!levels) return;
    // Stand-ins for a MODEL master own the one palette material they share; ones
    // for a procedural master borrow the master's and must not dispose it.
    const owned = new Set<Material>();
    for (const level of levels) {
      master.removeLODLevel(level);
      if (level.material && level.material !== master.material) owned.add(level.material);
      level.dispose();
    }
    for (const material of owned) material.dispose();
    // The cull level has no mesh of its own; `removeLODLevel(null)` matches it.
    // Without this a tier switch would stack a second cull level on the master.
    master.removeLODLevel(null);
    this.lodMeshes.delete(key);
  }

  /** Disposes every cached master mesh, its LOD variants, and its material. */
  dispose(): void {
    // Model masters are shared per-scene and outlive this registry — detach the
    // LOD levels we hung on them before dropping the variant meshes.
    for (const [key, target] of this.modelLodTargets) this.clearLod(key, target.master);
    this.modelLodTargets.clear();
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
