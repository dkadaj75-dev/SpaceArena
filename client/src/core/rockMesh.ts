import {
  Color3,
  Mesh,
  MeshBuilder,
  PBRMaterial,
  Texture,
  VertexBuffer,
  VertexData,
  type Scene,
} from "@babylonjs/core";
import {
  createLogger,
  resolveRockShape,
  rockRadius,
  type Palette,
  type RockShapeConfig,
  type RockSurfaceConfig,
} from "@space-arena/shared";

const log = createLogger("rockMesh");

/**
 * ROCK MESH — the renderer's half of the shared asteroid shape.
 *
 * The sim collides against `shared/src/collision/rockShape.ts`; this
 * tessellates the SAME field into geometry. There is no export step and no
 * baked mesh: a vertex sits exactly where `rockRadius` says the surface is, so
 * "what you see" and "what you hit" cannot drift apart. Change the shape spec
 * and both move together.
 */

/** Where the shipped 1k rock scans live, relative to the content root. */
const TEXTURE_DIR = "content/props/textures/game/";

/**
 * UV projection: which axis pair a triangle takes its texture coordinates from,
 * chosen per FACE by the dominant component of its normal.
 *
 * A rock has no sensible unwrap and a spherical one smears badly at the poles
 * and pinches at the seam — exactly the "big rock looks stretched" failure. Box
 * projection has neither problem: every face is textured at true world scale in
 * the plane it most nearly lies in. Its cost is a hard UV break where the
 * dominant axis flips, which is why the geometry is built with UNSHARED
 * vertices (each triangle owns its three) — the break then falls on an edge
 * rather than smearing a triangle. Smooth normals are computed on the shared
 * topology first and copied across, so faceting is not the price.
 */
function projectUv(
  axis: 0 | 1 | 2,
  x: number,
  y: number,
  z: number,
  scale: number,
  out: { u: number; v: number },
): void {
  if (axis === 0) {
    out.u = z * scale;
    out.v = y * scale;
  } else if (axis === 1) {
    out.u = x * scale;
    out.v = z * scale;
  } else {
    out.u = x * scale;
    out.v = y * scale;
  }
}

/**
 * Tessellate a shape into a unit-radius mesh (local coordinates are in units of
 * the asteroid's nominal radius, so one instance scaling of `radius` puts it in
 * world space).
 *
 * `uvScale` converts local units to texture tiles: pass `radius / tileMeters`
 * and every rock, colossal or pebble, ends up with the same real-world grain.
 */
export function buildRockGeometry(
  scene: Scene,
  name: string,
  shape: RockShapeConfig,
  subdivisions: number,
  uvScale: number,
): Mesh {
  const resolved = resolveRockShape(shape);

  // Babylon owns the icosphere topology; we only move the vertices onto the
  // field. Built once and discarded — the master below carries the real data.
  const template = MeshBuilder.CreateIcoSphere(`${name}.template`, { radius: 1, subdivisions, flat: false }, scene);
  const spherePositions = template.getVerticesData(VertexBuffer.PositionKind);
  const indices = template.getIndices();
  template.dispose();
  if (!spherePositions || !indices) throw new Error(`icosphere template produced no geometry for ${name}`);

  const sharedPositions = new Float32Array(spherePositions.length);
  for (let i = 0; i < spherePositions.length; i += 3) {
    const x = spherePositions[i]!;
    const y = spherePositions[i + 1]!;
    const z = spherePositions[i + 2]!;
    const length = Math.hypot(x, y, z) || 1;
    const dx = x / length;
    const dy = y / length;
    const dz = z / length;
    const r = rockRadius(resolved, dx, dy, dz);
    sharedPositions[i] = dx * r;
    sharedPositions[i + 1] = dy * r;
    sharedPositions[i + 2] = dz * r;
  }

  // Smooth normals on the SHARED topology: this is what keeps a lumpy body
  // reading as a surface rather than a bag of triangles once it is unwelded.
  const sharedNormals = new Float32Array(sharedPositions.length);
  VertexData.ComputeNormals(sharedPositions, indices, sharedNormals);

  const triangles = indices.length / 3;
  const positions = new Float32Array(triangles * 9);
  const normals = new Float32Array(triangles * 9);
  const uvs = new Float32Array(triangles * 6);
  const flatIndices = new Uint32Array(triangles * 3);
  const uv = { u: 0, v: 0 };

  for (let t = 0; t < triangles; t++) {
    const i0 = indices[t * 3]! * 3;
    const i1 = indices[t * 3 + 1]! * 3;
    const i2 = indices[t * 3 + 2]! * 3;
    const ax = sharedPositions[i0]!, ay = sharedPositions[i0 + 1]!, az = sharedPositions[i0 + 2]!;
    const bx = sharedPositions[i1]!, by = sharedPositions[i1 + 1]!, bz = sharedPositions[i1 + 2]!;
    const cx = sharedPositions[i2]!, cy = sharedPositions[i2 + 1]!, cz = sharedPositions[i2 + 2]!;
    // Face normal picks the projection plane for the whole triangle.
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const fx = Math.abs(uy * vz - uz * vy);
    const fy = Math.abs(uz * vx - ux * vz);
    const fz = Math.abs(ux * vy - uy * vx);
    const axis: 0 | 1 | 2 = fx >= fy && fx >= fz ? 0 : fy >= fz ? 1 : 2;

    for (let k = 0; k < 3; k++) {
      const source = indices[t * 3 + k]! * 3;
      const target = (t * 3 + k) * 3;
      const px = sharedPositions[source]!;
      const py = sharedPositions[source + 1]!;
      const pz = sharedPositions[source + 2]!;
      positions[target] = px;
      positions[target + 1] = py;
      positions[target + 2] = pz;
      normals[target] = sharedNormals[source]!;
      normals[target + 1] = sharedNormals[source + 1]!;
      normals[target + 2] = sharedNormals[source + 2]!;
      projectUv(axis, px, py, pz, uvScale, uv);
      uvs[(t * 3 + k) * 2] = uv.u;
      uvs[(t * 3 + k) * 2 + 1] = uv.v;
      flatIndices[t * 3 + k] = t * 3 + k;
    }
  }

  const mesh = new Mesh(name, scene);
  const data = new VertexData();
  data.positions = positions as unknown as number[];
  data.normals = normals as unknown as number[];
  data.uvs = uvs as unknown as number[];
  data.indices = flatIndices as unknown as number[];
  data.applyToMesh(mesh, false);
  mesh.setEnabled(false);
  return mesh;
}

/** A cached scan plus the handle a preloader needs to know it has decoded. */
interface CachedRockTexture {
  readonly texture: Texture;
  /** Settles — never rejects — once the image has decoded OR failed to. */
  readonly ready: Promise<void>;
}

/** Per-scene texture cache, so fourteen rock configs share four texture sets. */
const textureCache = new WeakMap<Scene, Map<string, CachedRockTexture>>();

function rockTextureEntry(scene: Scene, baseUrl: string, file: string, srgb: boolean): CachedRockTexture {
  let perScene = textureCache.get(scene);
  if (!perScene) {
    perScene = new Map();
    textureCache.set(scene, perScene);
  }
  // The colour space is part of the key, not just the file: the same JPEG read
  // as sRGB and as linear are two different GPU textures.
  const key = `${file}::${srgb ? "srgb" : "linear"}`;
  const cached = perScene.get(key);
  if (cached) return cached;
  let settle!: () => void;
  const ready = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const texture = new Texture(
    `${baseUrl}${TEXTURE_DIR}${file}`,
    scene,
    {
      noMipmap: false,
      invertY: false,
      samplingMode: Texture.TRILINEAR_SAMPLINGMODE,
      onLoad: () => settle(),
      // A scan that 404s already leaves the rock on Babylon's placeholder, which
      // is a cosmetic fault. It must not also be able to strand a match behind
      // the launch screen, so a failure settles the wait rather than hanging it.
      onError: (message) => {
        log.warn(`rock scan failed to load: ${file}${message ? ` — ${message}` : ""}`);
        settle();
      },
    },
  );
  // Box projection is a real tiling UV — both axes must wrap or the rock shows
  // a stretched border where the coordinate leaves 0..1.
  texture.wrapU = Texture.WRAP_ADDRESSMODE;
  texture.wrapV = Texture.WRAP_ADDRESSMODE;
  if (!srgb) texture.gammaSpace = false;
  const entry: CachedRockTexture = { texture, ready };
  perScene.set(key, entry);
  return entry;
}

function rockTexture(scene: Scene, baseUrl: string, file: string, srgb: boolean): Texture {
  return rockTextureEntry(scene, baseUrl, file, srgb).texture;
}

/**
 * The four maps one scan set contributes and the colour space each is read in.
 *
 * ONE list, so {@link preloadRockTextures} warms exactly the cache entries
 * {@link buildRockMaterial} goes on to ask for. A mismatched sRGB flag would be
 * a different key and would quietly fetch the same JPEG twice — keep this in
 * step with the four `rockTexture` calls below.
 */
const ROCK_MAPS: readonly (readonly [suffix: string, srgb: boolean])[] = [
  ["diff", true],
  ["nor", false],
  ["ao", false],
  ["rough", false],
];

/**
 * Fetch and decode the scans a set of rock surfaces needs, resolving only once
 * every image is actually on the GPU.
 *
 * Nothing here changes what a rock looks like — {@link buildRockMaterial} asks
 * for the same maps through the same per-scene cache. What changes is WHEN the
 * fetch happens. An asteroid arena declares no `render.model` anywhere, so the
 * match preload has historically had nothing to do for it: the launch bar hit
 * 100% on the ship hulls alone and the first rendered frame then kicked off
 * sixteen texture loads at once, with Babylon drawing every rock on its
 * placeholder until they landed. Counting these as preload work makes the bar
 * describe the real wait and puts the rocks on screen textured.
 */
export function preloadRockTextures(
  scene: Scene,
  baseUrl: string,
  textureSets: Iterable<string>,
): Promise<void> {
  const waits: Promise<void>[] = [];
  for (const set of new Set(textureSets)) {
    for (const [suffix, srgb] of ROCK_MAPS) {
      waits.push(rockTextureEntry(scene, baseUrl, `${set}_${suffix}_1k.jpg`, srgb).ready);
    }
  }
  return Promise.all(waits).then(() => undefined);
}

/**
 * PBR material for a rock: albedo + normal + roughness + AO from one of the
 * in-repo 1k scans, tinted by the config palette so two rocks sharing a scan
 * still read as different bodies.
 *
 * Match scenes are lit by a directional key plus a hemispheric fill and carry no
 * IBL, so the material leans on the normal and AO maps for its relief rather
 * than on reflections: `metallic` is 0 (rock is a dielectric), roughness comes
 * straight off the scan, and a small albedo tint from the palette separates the
 * types.
 */
export function buildRockMaterial(
  scene: Scene,
  name: string,
  surface: RockSurfaceConfig,
  palette: Palette,
  baseUrl: string,
): PBRMaterial {
  const material = new PBRMaterial(name, scene);
  const set = surface.textureSet;
  material.albedoTexture = rockTexture(scene, baseUrl, `${set}_diff_1k.jpg`, true);
  material.bumpTexture = rockTexture(scene, baseUrl, `${set}_nor_1k.jpg`, false);
  material.ambientTexture = rockTexture(scene, baseUrl, `${set}_ao_1k.jpg`, false);
  material.useAmbientInGrayScale = true;
  // Roughness is read out of the GREEN channel of the (grayscale) roughness
  // scan, which is the glTF metallic-roughness convention Babylon expects.
  // Metalness is NOT taken from the texture: these scans have no metal channel,
  // and reading a grayscale roughness map as metalness would turn every rock
  // into a mirror.
  material.metallicTexture = rockTexture(scene, baseUrl, `${set}_rough_1k.jpg`, false);
  material.useRoughnessFromMetallicTextureGreen = true;
  material.useRoughnessFromMetallicTextureAlpha = false;
  material.useMetallnessFromMetallicTextureBlue = false;
  material.metallic = surface.metallic;
  material.roughness = surface.roughness;
  material.bumpTexture.level = surface.normalStrength;
  // The scans are lit-from-above photographs; a mild tint pulls each config
  // toward its authored palette without repainting the rock.
  const tint = tintOf(palette);
  material.albedoColor = tint;
  material.backFaceCulling = true;
  // No IBL in a match scene: a floor of ambient keeps the unlit side of a rock
  // from going pure black the way a strict PBR response would.
  material.ambientColor = new Color3(0.35, 0.35, 0.35);
  return material;
}

function tintOf(palette: Palette): Color3 {
  const hex = palette["accent"] ?? palette["primary"];
  if (!hex) return new Color3(1, 1, 1);
  let base: Color3;
  try {
    base = Color3.FromHexString(hex);
  } catch {
    return new Color3(1, 1, 1);
  }
  // Pull only ~35% of the way toward the palette so the scan's own value range
  // survives — a full tint would flatten the albedo into a colored blob.
  const strength = 0.35;
  const level = Math.max(0.25, (base.r + base.g + base.b) / 3);
  return new Color3(
    1 + strength * (base.r / level - 1),
    1 + strength * (base.g / level - 1),
    1 + strength * (base.b / level - 1),
  );
}
