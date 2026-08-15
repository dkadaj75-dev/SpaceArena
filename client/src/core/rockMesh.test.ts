import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NullEngine, PBRMaterial, Scene, Texture, VertexBuffer } from "@babylonjs/core";
import {
  asteroidSchema,
  resolveRockShape,
  rockRadius,
  type AsteroidConfig,
} from "@space-arena/shared";
import { AssetRegistry, type AsteroidLod } from "./AssetRegistry.js";
import { applyRockRelief, buildRockGeometry, buildRockMaterial } from "./rockMesh.js";

const CONTENT_DIR = path.resolve(import.meta.dirname, "../../../content");
const LOD: AsteroidLod = { lodMediumDistance: 85, lodLowDistance: 200, lodCullDistance: 620 };

const shipped: AsteroidConfig[] = readdirSync(`${CONTENT_DIR}/asteroids`, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
  .map((entry) => asteroidSchema.parse(JSON.parse(readFileSync(`${CONTENT_DIR}/asteroids/${entry.name}`, "utf8"))))
  .sort((a, b) => (a.id < b.id ? -1 : 1));

let engine: NullEngine;
let scene: Scene;

beforeEach(() => {
  engine = new NullEngine();
  scene = new Scene(engine);
});

afterEach(() => {
  scene.dispose();
  engine.dispose();
});

describe("buildRockGeometry", () => {
  it("puts every vertex exactly on the surface the sim collides against", () => {
    // The whole point of the shared shape: the drawn mesh is not APPROXIMATELY
    // the collision body, it is a sample of the identical field. If this drifts,
    // shots start missing visible rock again.
    //
    // This is ALSO the guard on the surface-relief work: the rocks get their
    // rock-ness from normal/parallax mapping and from tessellating the field more
    // finely, never from displacing a vertex off it. A displacement map applied
    // here — however small — would break this, and that is the intended reading:
    // the contract is "no geometric displacement", not "displacement under some
    // tolerance". Run at each config's SHIPPED detail so raising `render.detail`
    // is covered by the same assertion.
    for (const config of shipped) {
      const resolved = resolveRockShape(config.shape!);
      const mesh = buildRockGeometry(scene, `test.${config.id}`, config.shape!, config.render.detail ?? 3, 1);
      const positions = mesh.getVerticesData(VertexBuffer.PositionKind)!;
      expect(positions.length).toBeGreaterThan(0);
      for (let i = 0; i < positions.length; i += 3) {
        const x = positions[i]!, y = positions[i + 1]!, z = positions[i + 2]!;
        const length = Math.hypot(x, y, z);
        const expected = rockRadius(resolved, x / length, y / length, z / length);
        expect(length, `${config.id} vertex ${i / 3}`).toBeCloseTo(expected, 4);
        expect(length).toBeLessThanOrEqual(resolved.maxRadius);
      }
      mesh.dispose();
    }
  });

  it("gives one SMOOTH normal per surface point, not a face normal per corner", () => {
    // `CreateIcoSphere` hands back a triangle soup (three vertices per triangle)
    // regardless of its `flat` option, so normals have to be computed on a
    // re-welded topology. Computed on the soup instead, every corner gets its own
    // face normal and a body built from a smooth radial field renders as a bag of
    // flat facets — which is what "the asteroids look flat" was.
    for (const config of shipped) {
      const mesh = buildRockGeometry(scene, `test.${config.id}`, config.shape!, 3, 1);
      const positions = mesh.getVerticesData(VertexBuffer.PositionKind)!;
      const normals = mesh.getVerticesData(VertexBuffer.NormalKind)!;
      const byPoint = new Map<string, [number, number, number]>();
      for (let i = 0; i < positions.length; i += 3) {
        const key = `${positions[i]!.toFixed(4)},${positions[i + 1]!.toFixed(4)},${positions[i + 2]!.toFixed(4)}`;
        const first = byPoint.get(key);
        const normal: [number, number, number] = [normals[i]!, normals[i + 1]!, normals[i + 2]!];
        if (!first) {
          byPoint.set(key, normal);
          continue;
        }
        // Every triangle meeting at a point agrees on the normal there.
        const dot = first[0] * normal[0] + first[1] * normal[1] + first[2] * normal[2];
        expect(dot, `${config.id} normal at ${key}`).toBeCloseTo(1, 5);
      }
      // Sanity: the soup really did collapse (a subdivisions-3 icosphere has 92
      // distinct points behind its 540 corners).
      expect(byPoint.size).toBeLessThan(positions.length / 3 / 2);
      mesh.dispose();
    }
  });

  it("gives each corner the exact tangent frame its box projection implies", () => {
    // Without a TANGENT attribute Babylon rebuilds the frame per pixel from
    // screen-space derivatives — which on per-face UVs is discontinuous at every
    // projection break and unstable under camera motion, so the normal map reads
    // as crawling noise instead of relief. The UVs here are two world axes, so
    // the correct frame is known exactly.
    const uvScale = 2.5;
    const mesh = buildRockGeometry(scene, "test.tangents", shipped[0]!.shape!, 3, uvScale);
    const normals = mesh.getVerticesData(VertexBuffer.NormalKind)!;
    const tangents = mesh.getVerticesData(VertexBuffer.TangentKind)!;
    const positions = mesh.getVerticesData(VertexBuffer.PositionKind)!;
    const uvs = mesh.getVerticesData(VertexBuffer.UVKind)!;
    expect(tangents.length / 4).toBe(positions.length / 3);

    const AXES = [[1, 0, 0], [0, 1, 0], [0, 0, 1]] as const;
    for (let t = 0; t < positions.length / 9; t++) {
      // Recover which world axes this triangle's projection used, straight from
      // the data: u and v are a world coordinate times uvScale, so exactly one
      // axis reproduces each of them at all three corners.
      const axisFor = (channel: 0 | 1): readonly number[] =>
        AXES.find((axis) =>
          [0, 1, 2].every((k) => {
            const p = (t * 3 + k) * 3;
            const expected = (positions[p]! * axis[0]! + positions[p + 1]! * axis[1]! + positions[p + 2]! * axis[2]!) * uvScale;
            return Math.abs(uvs[(t * 3 + k) * 2 + channel]! - expected) < 1e-5;
          }),
        )!;
      const uAxis = axisFor(0);
      const vAxis = axisFor(1);
      expect(uAxis, `triangle ${t} u axis`).toBeDefined();
      expect(vAxis, `triangle ${t} v axis`).toBeDefined();

      for (let k = 0; k < 3; k++) {
        const i = (t * 3 + k) * 3;
        const j = (t * 3 + k) * 4;
        const n = [normals[i]!, normals[i + 1]!, normals[i + 2]!];
        const tan = [tangents[j]!, tangents[j + 1]!, tangents[j + 2]!];
        const w = tangents[j + 3]!;
        expect(Math.hypot(tan[0]!, tan[1]!, tan[2]!)).toBeCloseTo(1, 5);
        expect(Math.abs(w)).toBe(1);
        // Orthonormal against the smooth normal, or the frame is not a rotation.
        expect(n[0]! * tan[0]! + n[1]! * tan[1]! + n[2]! * tan[2]!).toBeCloseTo(0, 5);
        // The tangent is the u axis flattened into the tangent plane, so it still
        // leans that way.
        expect(tan[0]! * uAxis[0]! + tan[1]! * uAxis[1]! + tan[2]! * uAxis[2]!, `triangle ${t} tangent`).toBeGreaterThan(0);
        // Babylon builds the bitangent as cross(N, T) * w, and it has to come out
        // on the +v side. Get `w` wrong and the normal map's green channel fights
        // the frame: every bump lights as a dent.
        const bitangent = [
          (n[1]! * tan[2]! - n[2]! * tan[1]!) * w,
          (n[2]! * tan[0]! - n[0]! * tan[2]!) * w,
          (n[0]! * tan[1]! - n[1]! * tan[0]!) * w,
        ];
        const alongV = bitangent[0]! * vAxis[0]! + bitangent[1]! * vAxis[1]! + bitangent[2]! * vAxis[2]!;
        expect(alongV, `triangle ${t} bitangent handedness`).toBeGreaterThan(0);
      }
    }
    mesh.dispose();
  });

  it("unwelds triangles and gives each one a box-projected UV", () => {
    const mesh = buildRockGeometry(scene, "test.uv", shipped[0]!.shape!, 2, 4);
    const positions = mesh.getVerticesData(VertexBuffer.PositionKind)!;
    const uvs = mesh.getVerticesData(VertexBuffer.UVKind)!;
    const indices = mesh.getIndices()!;
    // One vertex per triangle corner: the UV break has to fall on an edge, not
    // smear across a face.
    expect(positions.length / 3).toBe(indices.length);
    expect(uvs.length / 2).toBe(indices.length);
    for (let i = 0; i < indices.length; i++) expect(indices[i]).toBe(i);

    // Each triangle's UVs are a rigid copy of two of its world axes, so a UV
    // edge is the same length as the geometric edge it came from (times scale).
    for (let t = 0; t < indices.length / 3; t++) {
      const edges: number[] = [];
      for (const [a, b] of [[0, 1], [1, 2], [2, 0]] as const) {
        const ia = (t * 3 + a) * 3;
        const ib = (t * 3 + b) * 3;
        const geometric = Math.hypot(positions[ia]! - positions[ib]!, positions[ia + 1]! - positions[ib + 1]!, positions[ia + 2]! - positions[ib + 2]!);
        const ua = (t * 3 + a) * 2;
        const ub = (t * 3 + b) * 2;
        const textured = Math.hypot(uvs[ua]! - uvs[ub]!, uvs[ua + 1]! - uvs[ub + 1]!);
        edges.push(textured / (geometric * 4));
      }
      // Never stretched beyond the projection's own foreshortening, and never
      // collapsed to a point (which is what a spherical unwrap does at a pole).
      for (const ratio of edges) expect(ratio).toBeLessThanOrEqual(1.0001);
      expect(Math.max(...edges)).toBeGreaterThan(0.3);
    }
    mesh.dispose();
  });

  it("scales UVs so tiling is a world size, not a per-rock accident", () => {
    // Two rocks of very different sizes, each asked for the same tile size,
    // must end up with the same texels per world unit.
    const spec = shipped[0]!.shape!;
    const small = buildRockGeometry(scene, "test.small", spec, 2, 3.5 / 3.2);
    const large = buildRockGeometry(scene, "test.large", spec, 2, 18 / 3.2);
    const uvSpan = (mesh: ReturnType<typeof buildRockGeometry>) => {
      const uvs = mesh.getVerticesData(VertexBuffer.UVKind)!;
      let span = 0;
      for (let i = 0; i < uvs.length; i += 2) span = Math.max(span, Math.abs(uvs[i]!));
      return span;
    };
    // Local coordinates are identical; only the scale differs, so the tile count
    // grows exactly with the rock's world radius.
    expect(uvSpan(large) / uvSpan(small)).toBeCloseTo(18 / 3.5, 4);
    small.dispose();
    large.dispose();
  });
});

describe("buildRockMaterial", () => {
  it("wires albedo, normal, roughness and AO off one in-repo scan set", () => {
    const config = shipped.find((c) => c.render.surface)!;
    const material = buildRockMaterial(scene, "test.mat", config.render.surface!, config.render.palette ?? {}, "/");
    expect(material.albedoTexture?.name).toContain(`${config.render.surface!.textureSet}_diff_1k.jpg`);
    expect(material.bumpTexture?.name).toContain(`${config.render.surface!.textureSet}_nor_1k.jpg`);
    expect(material.metallicTexture?.name).toContain(`${config.render.surface!.textureSet}_rough_1k.jpg`);
    expect(material.ambientTexture?.name).toContain(`${config.render.surface!.textureSet}_ao_1k.jpg`);
    // Roughness off the map's green channel; metalness NEVER off a grayscale
    // roughness scan, which would turn every rock into a mirror.
    expect(material.useRoughnessFromMetallicTextureGreen).toBe(true);
    expect(material.useMetallnessFromMetallicTextureBlue).toBe(false);
    expect(material.metallic).toBe(0);
    material.dispose();
  });

  it("binds the non-colour maps as linear data and at the authored strength", () => {
    const config = shipped.find((c) => c.render.surface)!;
    const surface = config.render.surface!;
    const material = buildRockMaterial(scene, "test.mat.linear", surface, config.render.palette ?? {}, "/");
    // Normal/roughness/AO are measurements. Decoded through the sRGB curve they
    // would bend every slope and every occlusion value; the albedo, which IS
    // colour, must stay in gamma space.
    expect(material.bumpTexture!.gammaSpace).toBe(false);
    expect(material.ambientTexture!.gammaSpace).toBe(false);
    expect(material.metallicTexture!.gammaSpace).toBe(false);
    expect(material.albedoTexture!.gammaSpace).toBe(true);
    // These are OpenGL-convention scans: uploaded unflipped, +green fights the
    // bitangent and the relief cancels itself out.
    expect((material.bumpTexture as Texture).invertY).toBe(true);
    // A normal map at level ~0 is the other classic way rock reads as plastic.
    expect(material.bumpTexture!.level).toBe(surface.normalStrength);
    expect(material.bumpTexture!.level).toBeGreaterThan(0.5);
    material.dispose();
  });

  it("lets the AO scan reach the only lights a match scene has", () => {
    // Babylon's default for this is 0, and the AO map's other two routes into the
    // frame are both shut in an arena: `finalAmbient` is scene.ambientColor times
    // material.ambientColor and no arena sets a scene ambient, and the irradiance
    // term needs an IBL there is none of. At 0 the scan is fetched, uploaded and
    // sampled every frame while changing not one pixel.
    const config = shipped.find((c) => c.render.surface)!;
    const material = buildRockMaterial(scene, "test.mat.ao", config.render.surface!, {}, "/");
    expect(material.ambientTextureImpactOnAnalyticalLights).toBeGreaterThan(0.5);
    expect(material.ambientTextureStrength).toBe(1);
    material.dispose();
  });

  it("keeps parallax off unless the tier asks for it, and never breaks without a canvas", () => {
    const config = shipped.find((c) => c.render.surface)!;
    const surface = config.render.surface!;
    const off = buildRockMaterial(scene, "test.mat.off", surface, {}, "/");
    expect(off.useParallax).toBe(false);
    expect(off.useParallaxOcclusion).toBe(false);

    // The height field parallax needs lives in the bump texture's ALPHA channel,
    // which a JPEG has none of — it is composited at runtime from `_nor` + `_ao`.
    // On a host with no canvas pixel access (this one) that composite resolves to
    // nothing and the plain normal map must simply stay put.
    const pom = buildRockMaterial(scene, "test.mat.pom", surface, {}, "/", "occlusion");
    expect(pom.parallaxScaleBias).toBeGreaterThan(0);
    expect(pom.bumpTexture?.name).toContain(`${surface.textureSet}_nor_1k.jpg`);

    // Turning it back off is a plain flag flip, so a quality-tier switch does not
    // have to rebuild a single master.
    applyRockRelief(scene, pom, surface, "/", "off");
    expect(pom.useParallax).toBe(false);
    off.dispose();
    pom.dispose();
  });

  it("shares one texture instance across every rock that uses the same scan", () => {
    const bySet = new Map<string, PBRMaterial[]>();
    for (const config of shipped) {
      const surface = config.render.surface!;
      const material = buildRockMaterial(scene, `test.${config.id}`, surface, config.render.palette ?? {}, "/");
      const list = bySet.get(surface.textureSet) ?? [];
      list.push(material);
      bySet.set(surface.textureSet, list);
    }
    for (const [set, materials] of bySet) {
      if (materials.length < 2) continue;
      expect(materials[0]!.albedoTexture, `${set} albedo is shared`).toBe(materials[1]!.albedoTexture);
    }
    // ...but the tints differ, so two rocks on one scan do not read as clones.
    const gray = shipped.filter((c) => c.render.surface!.textureSet === "gray_rocks");
    if (gray.length >= 2) {
      const a = bySet.get("gray_rocks")![0]!.albedoColor;
      const b = bySet.get("gray_rocks")![1]!.albedoColor;
      expect(a.equals(b)).toBe(false);
    }
  });
});

describe("AssetRegistry shaped rock masters", () => {
  it("builds one master per config and reuses it", () => {
    const assets = new AssetRegistry(scene);
    const config = shipped[0]!;
    const first = assets.getShapedAsteroidMaster(config)!;
    expect(first.radiusScale).toBe(1);
    expect(assets.getShapedAsteroidMaster(config)!.mesh).toBe(first.mesh);
    assets.dispose();
  });

  it("returns null for a config with no shape, so the model path still applies", () => {
    const assets = new AssetRegistry(scene);
    const shapeless: AsteroidConfig = { ...shipped[0]!, shape: undefined };
    expect(assets.getShapedAsteroidMaster(shapeless)).toBeNull();
    assets.dispose();
  });

  it("hangs LOD levels that are the SAME body at lower detail", () => {
    const assets = new AssetRegistry(scene);
    assets.setAsteroidLod(LOD);
    const config = shipped.find((c) => (c.render.detail ?? 0) >= 4)!;
    const { mesh } = assets.getShapedAsteroidMaster(config)!;
    const levels = mesh.getLODLevels();
    expect(levels.length).toBeGreaterThanOrEqual(2);
    const resolved = resolveRockShape(config.shape!);
    for (const level of levels) {
      if (!level.mesh) continue;
      // Fewer triangles, same material, and still on the collision surface.
      expect(level.mesh.getTotalVertices()).toBeLessThan(mesh.getTotalVertices());
      expect(level.mesh.material).toBe(mesh.material);
      const positions = level.mesh.getVerticesData(VertexBuffer.PositionKind)!;
      for (let i = 0; i < positions.length; i += 3) {
        const length = Math.hypot(positions[i]!, positions[i + 1]!, positions[i + 2]!);
        expect(length).toBeLessThanOrEqual(resolved.maxRadius);
      }
    }
    // The tier distances are authored for a radius-4 rock; a colossal holds its
    // detail proportionally further out.
    const scale = config.radius / 4;
    const distances = levels.map((level) => level.distanceOrScreenCoverage).sort((a, b) => a - b);
    expect(distances).toEqual([LOD.lodMediumDistance * scale, LOD.lodLowDistance * scale, LOD.lodCullDistance * scale]);
    assets.dispose();
  });
});
