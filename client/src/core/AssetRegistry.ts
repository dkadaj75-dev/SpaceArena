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
  "procedural.rock-small": (scene, palette) =>
    buildRock(scene, palette, "procedural.rock-small", 2, 0.18, 1337),
  "procedural.rock-large": (scene, palette) =>
    buildRock(scene, palette, "procedural.rock-large", 3, 0.28, 9001),
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
