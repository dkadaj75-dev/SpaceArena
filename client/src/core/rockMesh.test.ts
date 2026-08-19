import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NullEngine, PBRMaterial, Scene, VertexBuffer } from "@babylonjs/core";
import {
  asteroidSchema,
  resolveRockShape,
  rockRadius,
  type AsteroidConfig,
} from "@space-arena/shared";
import { AssetRegistry, type AsteroidLod } from "./AssetRegistry.js";
import { buildRockGeometry, buildRockMaterial } from "./rockMesh.js";

const LOD: AsteroidLod = { lodMediumDistance: 85, lodLowDistance: 200, lodCullDistance: 620 };

/**
 * FIXTURE rocks, not the shipped pack.
 *
 * The shipped catalogue moved to sculpted GLBs with baked triangle collision
 * (2026-08-18), so no shipped config authors a `shape` any more. The radial-field
 * pipeline this file covers is still live code — `AssetRegistry` prefers it over
 * a model whenever a config does author one — so it keeps its tests, driven by
 * configs authored here.
 *
 * They deliberately span what the assertions below need: two rocks sharing one
 * texture set with different tints, a detail-4 body for the LOD ladder, and a
 * range of radii.
 */
const fixtures: AsteroidConfig[] = [
  {
    id: "asteroid.fixture-potato",
    radius: 3.5,
    shape: {
      seed: 1337,
      lobes: [{ radii: [0.86, 0.71, 0.78] }],
      noise: { amplitude: 0.19, frequency: 3.4, octaves: 3 },
      craters: { count: 3, radiusDeg: 32, depth: 0.15, rim: 0.4 },
    },
    palette: { primary: "#5b5148", accent: "#7d7266" },
    surface: "gray_rocks",
    tileMeters: 3.2,
    detail: 3,
  },
  {
    id: "asteroid.fixture-twin",
    radius: 18,
    shape: {
      seed: 40961,
      lobes: [
        { offset: [-0.34, 0.03, -0.02], radii: [0.6, 0.55, 0.56] },
        { offset: [0.38, -0.05, 0.04], radii: [0.5, 0.44, 0.46] },
      ],
      noise: { amplitude: 0.13, frequency: 3, octaves: 3 },
      craters: { count: 4, radiusDeg: 24, depth: 0.15, rim: 0.4 },
    },
    palette: { primary: "#463c33", accent: "#7a5c3f" },
    surface: "gray_rocks",
    tileMeters: 8,
    detail: 4,
  },
  {
    id: "asteroid.fixture-shard",
    radius: 7,
    shape: {
      seed: 5501,
      lobes: [{ radii: [0.9, 0.52, 0.66] }],
      noise: { amplitude: 0.16, frequency: 4.2, octaves: 3 },
      facets: { count: 8, depth: 0.24 },
    },
    palette: { primary: "#3f3831", accent: "#79654c" },
    surface: "cliff_side",
    tileMeters: 4,
    detail: 3,
  },
].map((spec) =>
  asteroidSchema.parse({
    id: spec.id,
    type: "asteroid",
    version: 1,
    name: spec.id,
    radius: spec.radius,
    shape: spec.shape,
    destructible: false,
    impactDamage: 10,
    render: {
      recipe: "procedural.rock-large",
      palette: spec.palette,
      detail: spec.detail,
      surface: { textureSet: spec.surface, tileMeters: spec.tileMeters, roughness: 1, metallic: 0, normalStrength: 1.25 },
      spin: { minDegPerSec: 1, maxDegPerSec: 6 },
    },
  }),
);

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
    for (const config of fixtures) {
      const resolved = resolveRockShape(config.shape!);
      const mesh = buildRockGeometry(scene, `test.${config.id}`, config.shape!, 2, 1);
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

  it("unwelds triangles and gives each one a box-projected UV", () => {
    const mesh = buildRockGeometry(scene, "test.uv", fixtures[0]!.shape!, 2, 4);
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
    const spec = fixtures[0]!.shape!;
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
    const config = fixtures.find((c) => c.render.surface)!;
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

  it("shares one texture instance across every rock that uses the same scan", () => {
    const bySet = new Map<string, PBRMaterial[]>();
    for (const config of fixtures) {
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
    const gray = fixtures.filter((c) => c.render.surface!.textureSet === "gray_rocks");
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
    const config = fixtures[0]!;
    const first = assets.getShapedAsteroidMaster(config)!;
    expect(first.radiusScale).toBe(1);
    expect(assets.getShapedAsteroidMaster(config)!.mesh).toBe(first.mesh);
    assets.dispose();
  });

  it("returns null for a config with no shape, so the model path still applies", () => {
    const assets = new AssetRegistry(scene);
    const shapeless: AsteroidConfig = { ...fixtures[0]!, shape: undefined };
    expect(assets.getShapedAsteroidMaster(shapeless)).toBeNull();
    assets.dispose();
  });

  it("hangs LOD levels that are the SAME body at lower detail", () => {
    const assets = new AssetRegistry(scene);
    assets.setAsteroidLod(LOD);
    const config = fixtures.find((c) => (c.render.detail ?? 0) >= 4)!;
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
