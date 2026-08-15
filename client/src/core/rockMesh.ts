import {
  Color3,
  Mesh,
  MeshBuilder,
  PBRMaterial,
  RawTexture,
  Texture,
  VertexBuffer,
  VertexData,
  type Scene,
} from "@babylonjs/core";
import {
  resolveRockShape,
  rockRadius,
  type Palette,
  type RockShapeConfig,
  type RockSurfaceConfig,
} from "@space-arena/shared";

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
 * The two LOCAL axes each box projection takes its `u` and `v` from, in the same
 * order {@link projectUv} writes them. These are the exact tangent/bitangent of
 * the projection: `u` and `v` are rigid copies of two world axes, so
 * `d(position)/du` and `d(position)/dv` are constant unit vectors per face
 * rather than something that has to be fitted from the triangle.
 */
const PROJECTION_BASIS: readonly (readonly [readonly [number, number, number], readonly [number, number, number]])[] = [
  [[0, 0, 1], [0, 1, 0]], // axis 0 (x dominant): u = z, v = y
  [[1, 0, 0], [0, 0, 1]], // axis 1 (y dominant): u = x, v = z
  [[1, 0, 0], [0, 1, 0]], // axis 2 (z dominant): u = x, v = y
];

/**
 * Grid the unit sphere is snapped to when welding the icosphere's corners back
 * together. The finest icosphere this code builds (subdivisions 6) still has
 * ~0.1 rad between neighbouring vertices, five orders of magnitude coarser than
 * this, so the quantisation can only ever merge corners that ARE the same point.
 */
const WELD_QUANTUM = 1e5;

/**
 * Tessellate a shape into a unit-radius mesh (local coordinates are in units of
 * the asteroid's nominal radius, so one instance scaling of `radius` puts it in
 * world space).
 *
 * `uvScale` converts local units to texture tiles: pass `radius / tileMeters`
 * and every rock, colossal or pebble, ends up with the same real-world grain.
 *
 * Detail is bought purely by SAMPLING THE FIELD MORE FINELY — `subdivisions` is
 * the icosphere's, and every vertex still lands exactly on `rockRadius`. Nothing
 * here displaces the surface, so raising detail moves the drawn mesh CLOSER to
 * the body the sim collides against, never away from it.
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

  // WELD FIRST. `CreateIcoSphere` emits three vertices per triangle whatever
  // `flat` is set to (it controls the normals it computes, not the topology), so
  // the buffer it hands back is a triangle soup: 540 corners for the 92 distinct
  // points of a subdivisions-3 sphere. Running ComputeNormals straight on that
  // gives every corner its own FACE normal — which is precisely how a body built
  // from a smooth radial field ends up drawn as a bag of flat facets. Rebuilding
  // the shared topology here is what makes the smooth normals below meaningful.
  const cornerToVertex = new Uint32Array(spherePositions.length / 3);
  const weld = new Map<string, number>();
  const shared: number[] = [];
  for (let i = 0; i < spherePositions.length; i += 3) {
    const x = spherePositions[i]!;
    const y = spherePositions[i + 1]!;
    const z = spherePositions[i + 2]!;
    const length = Math.hypot(x, y, z) || 1;
    const dx = x / length;
    const dy = y / length;
    const dz = z / length;
    const key = `${Math.round(dx * WELD_QUANTUM)},${Math.round(dy * WELD_QUANTUM)},${Math.round(dz * WELD_QUANTUM)}`;
    let vertex = weld.get(key);
    if (vertex === undefined) {
      vertex = shared.length / 3;
      weld.set(key, vertex);
      const r = rockRadius(resolved, dx, dy, dz);
      shared.push(dx * r, dy * r, dz * r);
    }
    cornerToVertex[i / 3] = vertex;
  }
  const sharedPositions = new Float32Array(shared);
  const sharedIndices = new Uint32Array(indices.length);
  for (let i = 0; i < indices.length; i++) sharedIndices[i] = cornerToVertex[indices[i]!]!;

  // Smooth normals on the SHARED topology: this is what keeps a lumpy body
  // reading as a surface rather than a bag of triangles once it is unwelded.
  const sharedNormals = new Float32Array(sharedPositions.length);
  VertexData.ComputeNormals(sharedPositions, sharedIndices, sharedNormals);

  const triangles = indices.length / 3;
  const positions = new Float32Array(triangles * 9);
  const normals = new Float32Array(triangles * 9);
  const tangents = new Float32Array(triangles * 12);
  const uvs = new Float32Array(triangles * 6);
  const flatIndices = new Uint32Array(triangles * 3);
  const uv = { u: 0, v: 0 };

  for (let t = 0; t < triangles; t++) {
    const i0 = sharedIndices[t * 3]! * 3;
    const i1 = sharedIndices[t * 3 + 1]! * 3;
    const i2 = sharedIndices[t * 3 + 2]! * 3;
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
    const [tangentAxis, bitangentAxis] = PROJECTION_BASIS[axis]!;

    for (let k = 0; k < 3; k++) {
      const source = sharedIndices[t * 3 + k]! * 3;
      const target = (t * 3 + k) * 3;
      const px = sharedPositions[source]!;
      const py = sharedPositions[source + 1]!;
      const pz = sharedPositions[source + 2]!;
      positions[target] = px;
      positions[target + 1] = py;
      positions[target + 2] = pz;
      const nx = sharedNormals[source]!;
      const ny = sharedNormals[source + 1]!;
      const nz = sharedNormals[source + 2]!;
      normals[target] = nx;
      normals[target + 1] = ny;
      normals[target + 2] = nz;
      writeTangent(tangents, (t * 3 + k) * 4, nx, ny, nz, tangentAxis, bitangentAxis);
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
  data.tangents = tangents as unknown as number[];
  data.uvs = uvs as unknown as number[];
  data.indices = flatIndices as unknown as number[];
  data.applyToMesh(mesh, false);
  mesh.setEnabled(false);
  return mesh;
}

/**
 * Per-vertex TANGENT (xyz + handedness w) for a box-projected corner.
 *
 * Without this attribute Babylon falls back to `cotangent_frame()`, which
 * rebuilds a tangent basis per PIXEL out of screen-space derivatives of position
 * and UV. On box-projected rock that fallback is at its worst: the derivative of
 * a UV that was chosen per-face is discontinuous at every projection break, and
 * the frame it produces flickers under the camera motion of a dogfight — so the
 * normal map reads as noise rather than relief, which is one of the ways a
 * perfectly good scan ends up looking flat.
 *
 * The exact basis is known here: the UVs ARE two world axes, so `d(p)/du` and
 * `d(p)/dv` are the constant vectors in {@link PROJECTION_BASIS}. Gram-Schmidt
 * the tangent against the (smooth, interpolated) vertex normal so the frame is
 * orthonormal, then pick `w` so Babylon's `cross(N, T) * w` reproduces the
 * projection's own `v` direction. Getting `w` wrong flips the normal map's green
 * channel and turns every bump into a dent.
 */
function writeTangent(
  out: Float32Array,
  offset: number,
  nx: number,
  ny: number,
  nz: number,
  tangentAxis: readonly [number, number, number],
  bitangentAxis: readonly [number, number, number],
): void {
  const [gx, gy, gz] = tangentAxis;
  const [bx, by, bz] = bitangentAxis;
  const projection = nx * gx + ny * gy + nz * gz;
  let tx = gx - nx * projection;
  let ty = gy - ny * projection;
  let tz = gz - nz * projection;
  let length = Math.hypot(tx, ty, tz);
  if (length < 1e-4) {
    // The smooth normal has swung all the way onto the projection's u axis
    // (possible near a projection break on a steep lobe). Derive the tangent
    // from the bitangent instead, which is still a full axis away.
    tx = by * nz - bz * ny;
    ty = bz * nx - bx * nz;
    tz = bx * ny - by * nx;
    length = Math.hypot(tx, ty, tz) || 1;
  }
  tx /= length;
  ty /= length;
  tz /= length;
  // Babylon builds the bitangent as cross(N, T) * w; choose w so that lands on
  // the projection's v axis rather than against it.
  const handedness = (ny * tz - nz * ty) * bx + (nz * tx - nx * tz) * by + (nx * ty - ny * tx) * bz;
  out[offset] = tx;
  out[offset + 1] = ty;
  out[offset + 2] = tz;
  out[offset + 3] = handedness < 0 ? -1 : 1;
}

/** Per-scene texture cache, so fourteen rock configs share four texture sets. */
const textureCache = new WeakMap<Scene, Map<string, Texture>>();

function rockTexture(scene: Scene, baseUrl: string, file: string, srgb: boolean): Texture {
  let perScene = textureCache.get(scene);
  if (!perScene) {
    perScene = new Map();
    textureCache.set(scene, perScene);
  }
  const key = `${file}::${srgb ? "srgb" : "linear"}`;
  const cached = perScene.get(key);
  if (cached) return cached;
  const texture = new Texture(
    `${baseUrl}${TEXTURE_DIR}${file}`,
    scene,
    // invertY is Babylon's DEFAULT (true) on purpose, and it is load-bearing for
    // the normal map: these are Poly Haven scans in the OpenGL convention, where
    // +green points up the image as displayed. Babylon flips at upload so that
    // v = 0 samples the bottom row, which is what makes "up the image" and "+v"
    // — and therefore +green and the bitangent — the same direction. Uploading
    // them unflipped (the old setting) inverts green against the tangent frame,
    // which lights every pit as a pimple and cancels the relief the scan has.
    { noMipmap: false, samplingMode: Texture.TRILINEAR_SAMPLINGMODE },
  );
  // Box projection is a real tiling UV — both axes must wrap or the rock shows
  // a stretched border where the coordinate leaves 0..1.
  texture.wrapU = Texture.WRAP_ADDRESSMODE;
  texture.wrapV = Texture.WRAP_ADDRESSMODE;
  // Normal/roughness/AO carry measurements, not colour: decoding them through
  // the sRGB curve would bend every slope and every occlusion value.
  if (!srgb) texture.gammaSpace = false;
  perScene.set(key, texture);
  return texture;
}

/**
 * How much of the AO map is allowed to darken the DIRECT lights.
 *
 * Babylon's default for `ambientTextureImpactOnAnalyticalLights` is 0, and the
 * two other routes an AO map has into the picture are both shut in a match
 * scene: `finalAmbient` is `scene.ambientColor * material.ambientColor` and the
 * arena never sets a scene ambient, and the irradiance term needs an IBL there
 * is none of. With all three at zero the AO scan was being fetched, uploaded and
 * sampled every frame while contributing exactly nothing — a large part of why
 * the rock read as an evenly-lit ball. Letting it bite most of the way into the
 * analytic lights is not strictly physical, but it is the only channel it has,
 * and crevice shading is what sells rock.
 */
const AO_IMPACT_ON_LIGHTS = 0.85;

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
 *
 * The `_nor` JPEG bound here is a STAND-IN. {@link applyRockRelief} swaps in a
 * composited replacement as soon as it is decoded: same normals with their DC
 * tilt removed, plus a height field in the alpha channel. `relief` then decides
 * whether that height drives parallax — a quality-tier knob rather than content,
 * because it is a per-pixel cost.
 */
export function buildRockMaterial(
  scene: Scene,
  name: string,
  surface: RockSurfaceConfig,
  palette: Palette,
  baseUrl: string,
  relief: RockRelief = "off",
): PBRMaterial {
  const material = new PBRMaterial(name, scene);
  const set = surface.textureSet;
  material.albedoTexture = rockTexture(scene, baseUrl, `${set}_diff_1k.jpg`, true);
  material.bumpTexture = rockTexture(scene, baseUrl, `${set}_nor_1k.jpg`, false);
  material.ambientTexture = rockTexture(scene, baseUrl, `${set}_ao_1k.jpg`, false);
  material.useAmbientInGrayScale = true;
  material.ambientTextureStrength = 1;
  material.ambientTextureImpactOnAnalyticalLights = AO_IMPACT_ON_LIGHTS;
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
  // Only bites when the arena gives the scene an ambient colour of its own
  // (`vAmbientColor` is the product of the two); harmless, and the floor it
  // provides for such an arena is the reason it is kept.
  material.ambientColor = new Color3(0.35, 0.35, 0.35);
  applyRockRelief(scene, material, surface, baseUrl, relief);
  return material;
}

/* ------------------------------------------------------------------ */
/* Surface composite + parallax relief                                 */
/* ------------------------------------------------------------------ */

/**
 * Per-pixel surface relief on a rock material.
 *
 * Every mode gets the composited normal map (see {@link composeSurface}); this
 * only decides what happens with the height packed alongside it.
 *
 *  - `off`        — normals only.
 *  - `parallax`   — one extra tap; shifts the UV by the local height. Cheap
 *                   enough for a phone, and enough to stop the grain sliding
 *                   across the surface like a decal.
 *  - `occlusion`  — parallax OCCLUSION mapping: Babylon marches up to 15 taps
 *                   along the view ray, so ridges genuinely hide what is behind
 *                   them and the silhouette of a crater rim moves with the eye.
 *
 * This is purely a shading trick — no vertex moves, so the collision surface is
 * untouched.
 */
export type RockRelief = "off" | "parallax" | "occlusion";

/**
 * How far, as a fraction of one texture tile, the parallax march may shift a UV.
 * With the shipped `tileMeters` (1.6 m on a pebble to 12 m on a colossal) this
 * is roughly 4 cm to 30 cm of apparent depth — the scale of the pits and grain
 * these scans actually contain. Pushed much past this, parallax stops reading as
 * depth and starts reading as the texture swimming.
 */
const PARALLAX_DEPTH = 0.055;
/**
 * The single-tap offset approximation has no march to hide its error, so it
 * smears at grazing angles well before the occlusion version does. Half depth.
 */
const PARALLAX_OFFSET_DEPTH = 0.025;

/**
 * Bind the composited surface map and set the parallax mode.
 *
 * Two jobs, because they need the same texture. Separate from
 * {@link buildRockMaterial} so a quality-tier switch mid-session can retune the
 * rocks already in the scene instead of rebuilding every master.
 */
export function applyRockRelief(
  scene: Scene,
  material: PBRMaterial,
  surface: RockSurfaceConfig,
  baseUrl: string,
  relief: RockRelief,
): void {
  const parallax = relief !== "off";
  material.parallaxScaleBias = relief === "occlusion" ? PARALLAX_DEPTH : PARALLAX_OFFSET_DEPTH;
  material.useParallax = false;
  material.useParallaxOcclusion = false;
  reliefRequest.set(material, relief);
  void surfaceTexture(scene, baseUrl, surface.textureSet).then((texture) => {
    if (!texture) return;
    if (material.bumpTexture !== texture) {
      // `level` rides the TEXTURE, which every config on this scan set shares —
      // see the note on `normalStrength` in `shared/src/schemas/asteroid.ts`.
      texture.level = surface.normalStrength;
      material.bumpTexture = texture;
    }
    // The tier may have moved on while the composite was decoding; the mode the
    // material was LAST asked for is the one that wins.
    if (reliefRequest.get(material) !== relief) return;
    material.useParallax = parallax;
    material.useParallaxOcclusion = relief === "occlusion";
  });
}

/** Last relief mode each material was asked for, so a stale composite can't win. */
const reliefRequest = new WeakMap<PBRMaterial, RockRelief>();

/** In-flight/finished surface composites, one per (scene, texture set). */
const surfaceCache = new WeakMap<Scene, Map<string, Promise<Texture | null>>>();

function surfaceTexture(scene: Scene, baseUrl: string, set: string): Promise<Texture | null> {
  let perScene = surfaceCache.get(scene);
  if (!perScene) {
    perScene = new Map();
    surfaceCache.set(scene, perScene);
  }
  const cached = perScene.get(set);
  if (cached) return cached;
  // A host without canvas pixel access, a 404, a decode failure: all mean "keep
  // the plain scan", never "no rock".
  const pending = composeSurface(scene, baseUrl, set).catch(() => null);
  perScene.set(set, pending);
  return pending;
}

/**
 * Build the texture the rock shader actually wants: the `<set>_nor` scan with its
 * DC TILT REMOVED in RGB, and a height field derived from `<set>_ao` in A.
 *
 * ## Why the normal map has to be recentred
 *
 * A tangent-space normal map is supposed to average to (0, 0, 1) — "no tilt".
 * These scans do not: `aerial_ground_rock` averages G = 139 against a neutral of
 * 128, which is a constant ~5 degree lean baked into every texel. On a flat wall
 * that is invisible. On a box-projected rock it is not, because the tangent frame
 * ROTATES between faces that picked different projection axes, so the same
 * constant lean points a different way on each side of a projection break — and
 * the whole region either side lights a different brightness. That is the
 * patchwork of hard-edged triangular facets these rocks showed, and it scales
 * with `normalStrength`, which is exactly why the scans could not simply be
 * turned up to compensate for how gentle they are.
 *
 * Subtracting the mean from R and G leaves the detail untouched and lets
 * `normalStrength` amplify relief instead of amplifying a lean.
 *
 * ## Why AO stands in for a displacement map
 *
 * These scans ship diff/nor/rough/ao and no `_disp`, and of the three non-colour
 * channels AO is the one that IS a depth cue — bright on what the sky can see,
 * dark down in the cracks, which is exactly the ordering the parallax march
 * wants. Babylon reads that march's height out of the bump texture's ALPHA
 * channel, which a JPEG cannot carry at all; hence this composite. The raw
 * contrast is often tiny (`moon_dusted_01` spans a fifth of the range), so it is
 * stretched to fill 0..1 with a CAPPED gain — enough to give the march something
 * to bite on without amplifying JPEG blocking into visible steps.
 *
 * Resolves `null` — leaving the plain scan in place — on any host without canvas
 * pixel access, which includes the headless test engine.
 */
async function composeSurface(scene: Scene, baseUrl: string, set: string): Promise<Texture | null> {
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") return null;
  const [normal, height] = await Promise.all([
    decode(`${baseUrl}${TEXTURE_DIR}${set}_nor_1k.jpg`),
    decode(`${baseUrl}${TEXTURE_DIR}${set}_ao_1k.jpg`),
  ]);
  if (!normal || !height || normal.width !== height.width || normal.height !== height.height) return null;

  const { width, height: rows } = normal;
  const pixels = width * rows;
  let sumX = 0;
  let sumY = 0;
  let min = 255;
  let max = 0;
  for (let i = 0; i < normal.data.length; i += 4) {
    sumX += normal.data[i]!;
    sumY += normal.data[i + 1]!;
    const value = height.data[i]!;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  // 127.5 is the encoding's zero: 0..255 maps to -1..1.
  const biasX = sumX / pixels - 127.5;
  const biasY = sumY / pixels - 127.5;
  // Capped so a genuinely flat scan stays flat rather than becoming banded noise.
  const gain = Math.min(4, 255 / Math.max(1, max - min));

  const data = new Uint8Array(pixels * 4);
  for (let y = 0; y < rows; y++) {
    // Row 0 of a raw upload is v = 0, and the colour maps beside it are uploaded
    // with invertY — so read the image bottom-up here and every channel lines up
    // on the same texel.
    const source = (rows - 1 - y) * width * 4;
    const target = y * width * 4;
    for (let x = 0; x < width; x++) {
      const s = source + x * 4;
      const t = target + x * 4;
      data[t] = clampByte(normal.data[s]! - biasX);
      data[t + 1] = clampByte(normal.data[s + 1]! - biasY);
      data[t + 2] = normal.data[s + 2]!;
      data[t + 3] = clampByte((height.data[s]! - min) * gain);
    }
  }

  const texture = RawTexture.CreateRGBATexture(
    data,
    width,
    rows,
    scene,
    true,
    false,
    Texture.TRILINEAR_SAMPLINGMODE,
  );
  texture.name = `${set}_nor-centred+height`;
  texture.wrapU = Texture.WRAP_ADDRESSMODE;
  texture.wrapV = Texture.WRAP_ADDRESSMODE;
  texture.gammaSpace = false;
  // The plain `_nor` upload was only ever the stand-in until this landed. Every
  // material awaiting this promise swaps in the same microtask drain, so the
  // JPEG is unreferenced by the next frame — and it is ~5 MB of VRAM per set.
  const perScene = textureCache.get(scene);
  const stale = perScene?.get(`${set}_nor_1k.jpg::linear`);
  if (perScene && stale) {
    perScene.delete(`${set}_nor_1k.jpg::linear`);
    scene.onAfterRenderObservable.addOnce(() => stale.dispose());
  }
  return texture;
}

function clampByte(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : value;
}

async function decode(url: string): Promise<ImageData | null> {
  const response = await fetch(url);
  if (!response.ok) return null;
  const bitmap = await createImageBitmap(await response.blob());
  // Read the dimensions BEFORE closing: `close()` releases the pixels and zeroes
  // width/height, which would make the getImageData below a zero-size read.
  const width = bitmap.width;
  const rows = bitmap.height;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = rows;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    bitmap.close();
    return null;
  }
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  return context.getImageData(0, 0, width, rows);
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
