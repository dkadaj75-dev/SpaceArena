import {
  Color3,
  Mesh,
  MeshBuilder,
  StandardMaterial,
  VertexBuffer,
  type Scene,
} from "@babylonjs/core";
import { createLogger, type Palette } from "@space-arena/shared";

const log = createLogger("AssetRegistry");

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

  constructor(private readonly scene: Scene) {}

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
    return mesh;
  }

  /** Disposes every cached master mesh and its material. */
  dispose(): void {
    for (const mesh of this.cache.values()) {
      mesh.material?.dispose();
      mesh.dispose();
    }
    this.cache.clear();
  }
}
