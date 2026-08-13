import { describe, expect, it } from "vitest";
import { encodeFloat32Array, encodeUint32Array } from "../collision/base64.js";
import { arenaSchema, arenaWireBoundsIssues, arenaWireEnvelopeIssues } from "./arena.js";
import { collectReferences } from "./index.js";
import { propSchema } from "./prop.js";

function prop(collision: Record<string, unknown>) {
  return { id: "prop.mesh", type: "prop", version: 1, category: "rock", render: { recipe: "model.static" }, collision };
}

function mesh(positions: number[], indices: number[]) {
  return {
    positions: encodeFloat32Array(new Float32Array(positions)),
    indices: encodeUint32Array(new Uint32Array(indices)),
    bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
  };
}

describe("prop collision schema", () => {
  it("accepts a decoded triangle mesh and optional LOD ladder", () => {
    const value = { ...prop(mesh([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2])), render: { recipe: "model.static", lods: [{ model: "props/mid.glb", distance: 80 }] } };
    expect(propSchema.safeParse(value).success).toBe(true);
  });

  it("rejects malformed triplets, out-of-range indices, inverted bounds, and too many triangles", () => {
    expect(propSchema.safeParse(prop(mesh([0, 0, 0, 1], [0, 0, 0]))).success).toBe(false);
    expect(propSchema.safeParse(prop(mesh([0, 0, 0], [0, 1, 0]))).success).toBe(false);
    const badBounds = mesh([0, 0, 0], [0, 0, 0]);
    badBounds.bounds.min.x = 2;
    expect(propSchema.safeParse(prop(badBounds)).success).toBe(false);
    const indices = new Uint32Array(150_001 * 3);
    expect(propSchema.safeParse(prop({ ...mesh([0, 0, 0], [0, 0, 0]), indices: encodeUint32Array(indices) })).success).toBe(false);
  });

  it("rejects oversized encoded indices before mesh decode", () => {
    const indices = new Uint32Array(150_001 * 3);
    expect(propSchema.safeParse(prop({ ...mesh([0, 0, 0], [0, 0, 0]), indices: encodeUint32Array(indices) })).success).toBe(false);
  });

  it("rejects non-finite decoded positions and bounds that exclude the mesh AABB", () => {
    expect(propSchema.safeParse(prop(mesh([0, 0, 0, Number.NaN, 1, 1, 0, 1, 0], [0, 1, 2]))).success).toBe(false);
    const undersized = mesh([0, 0, 0, 2, 0, 0, 0, 2, 0], [0, 1, 2]);
    undersized.bounds.max.x = 1;
    expect(propSchema.safeParse(prop(undersized)).success).toBe(false);
  });
});

describe("box bounds and nav graph schema", () => {
  const base = {
    id: "arena.box", type: "arena", version: 1,
    bounds: { shape: "box", width: 100, height: 80, floorY: -20, ceilingY: 30 },
    asteroidPlacements: [],
    propPlacements: [{ propId: "prop.mesh", position: { x: 0, z: 0 } }],
    spawnPoints: [{ id: "s", team: 0, position: { x: 0, y: 0, z: 0 }, heading: 0 }],
    navGraph: { nodes: [{ id: "a", position: { x: 0, z: 0 } }, { id: "b", position: { x: 1, z: 0 } }], links: [["a", "b"]] },
  };

  it("accepts valid box spawns and links", () => expect(arenaSchema.safeParse(base).success).toBe(true));

  it("collects prop references and checks every box wire extent", () => {
    const parsed = arenaSchema.parse(base);
    expect(collectReferences(parsed)).toContainEqual({ path: "propPlacements[0].propId", id: "prop.mesh", expects: "prop" });
    expect(arenaWireBoundsIssues({ shape: "box", width: 100, height: 80, floorY: -4000, ceilingY: 30 })).toEqual([
      expect.objectContaining({ path: ["bounds", "floorY"] }),
    ]);
    expect(arenaWireEnvelopeIssues({ shape: "box", width: 6500, height: 80, floorY: -20, ceilingY: 30 }, 30)).toEqual([
      expect.objectContaining({ path: ["bounds", "width"] }),
    ]);
  });

  it("rejects inverted floors, outside spawns, duplicate nodes, self-links, and dangling links", () => {
    expect(arenaSchema.safeParse({ ...base, bounds: { ...base.bounds, ceilingY: -20 } }).success).toBe(false);
    expect(arenaSchema.safeParse({ ...base, spawnPoints: [{ ...base.spawnPoints[0], position: { x: 51, y: 0, z: 0 } }] }).success).toBe(false);
    expect(arenaSchema.safeParse({ ...base, navGraph: { nodes: [{ id: "a", position: { x: 0, z: 0 } }, { id: "a", position: { x: 1, z: 0 } }], links: [] } }).success).toBe(false);
    expect(arenaSchema.safeParse({ ...base, navGraph: { ...base.navGraph, links: [["a", "a"]] } }).success).toBe(false);
    expect(arenaSchema.safeParse({ ...base, navGraph: { ...base.navGraph, links: [["a", "missing"]] } }).success).toBe(false);
  });
});
