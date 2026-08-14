import { NullEngine, Scene, VertexBuffer } from "@babylonjs/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  MISSILE_BODY_DIAMETER,
  MISSILE_FIN_COUNT,
  MISSILE_HALF_LENGTH,
  MISSILE_LENGTH,
  buildMissileMaster,
} from "./missileMesh.js";

const engines: NullEngine[] = [];

function makeScene(): Scene {
  const engine = new NullEngine();
  engines.push(engine);
  return new Scene(engine);
}

afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose();
});

describe("missile master geometry", () => {
  it("merges every part into one instanceable mesh with one material", () => {
    const scene = makeScene();
    const master = buildMissileMaster(scene);

    // The whole point of the merge: `ViewManager.fillPool` instances this, and a
    // pool only collapses into one draw call while the master is a single mesh.
    expect(master.name).toBe("master.proj.missile");
    expect(master.getChildMeshes()).toHaveLength(0);
    expect(master.subMeshes).toHaveLength(1);
    expect(master.material?.name).toBe("mat.proj.missile");
    expect(master.isEnabled()).toBe(false);
    expect(master.isPickable).toBe(false);
    // No stray part meshes left behind in the scene by the merge.
    expect(scene.meshes.filter((m) => m.name.startsWith("missile."))).toHaveLength(0);
  });

  it("points its nose down +Z with the exhaust plume trailing aft", () => {
    const scene = makeScene();
    const master = buildMissileMaster(scene);
    const bounds = master.getBoundingInfo().boundingBox;

    // Nose tip exactly on the advertised half-length: `syncProjectiles` aims the
    // pooled node's +Z at the travel direction, so this is what makes a missile
    // fly nose-first rather than sideways.
    expect(bounds.maximum.z).toBeCloseTo(MISSILE_HALF_LENGTH, 5);
    // The hull ends at the tail plate; only the plume is allowed past it.
    expect(bounds.minimum.z).toBeLessThan(-MISSILE_HALF_LENGTH);
    expect(bounds.maximum.z - bounds.minimum.z).toBeGreaterThan(MISSILE_LENGTH);

    // Slender: the fin span is the widest thing on it, and it is well under the
    // length, so the silhouette reads as a dart and not as a lump.
    const span = Math.max(bounds.maximum.x - bounds.minimum.x, bounds.maximum.y - bounds.minimum.y);
    expect(span).toBeGreaterThan(MISSILE_BODY_DIAMETER * 2); // fins clear the casing
    expect(span).toBeLessThan(MISSILE_LENGTH * 0.75);
    // Cruciform, so the same silhouette reads from every roll angle.
    expect(bounds.maximum.x).toBeCloseTo(bounds.maximum.y, 5);
  });

  it("carries its part tints as vertex colours instead of extra materials", () => {
    const scene = makeScene();
    const master = buildMissileMaster(scene);
    const colors = master.getVerticesData(VertexBuffer.ColorKind);

    expect(colors).not.toBeNull();
    expect(colors!.length).toBe(master.getTotalVertices() * 4);
    // Opaque throughout: a vertex alpha below 1 would drop the whole pool into
    // the transparent pass.
    for (let i = 3; i < colors!.length; i += 4) expect(colors![i]).toBe(1);
    expect(master.hasVertexAlpha).toBe(false);

    // The hottest vertex is the exhaust, and it sits behind the tail — that is
    // the thrust read, and it is the only reason one material is enough.
    const positions = master.getVerticesData(VertexBuffer.PositionKind)!;
    let hottest = -1;
    let hottestZ = 0;
    for (let v = 0; v < master.getTotalVertices(); v++) {
      const warmth = colors![v * 4]! - colors![v * 4 + 2]!; // red over blue
      if (warmth > hottest) {
        hottest = warmth;
        hottestZ = positions[v * 3 + 2]!;
      }
    }
    expect(hottest).toBeGreaterThan(0.5);
    expect(hottestZ).toBeLessThan(-MISSILE_HALF_LENGTH * 0.8);
  });

  it("stays inside a mobile triangle budget", () => {
    const scene = makeScene();
    const master = buildMissileMaster(scene);
    const triangles = master.getIndices()!.length / 3;

    // Body + nose + four fins + plume, at low tessellation. The cap is what makes
    // 64 of these in flight affordable on the phones this ships to.
    expect(MISSILE_FIN_COUNT).toBe(4);
    expect(triangles).toBeGreaterThan(60);
    expect(triangles).toBeLessThan(160);
  });

  it("disposes its mesh and material together, leaving nothing in the scene", () => {
    const scene = makeScene();
    const master = buildMissileMaster(scene);
    const material = master.material!;

    material.dispose();
    master.dispose();

    expect(scene.meshes).toHaveLength(0);
    expect(scene.materials).toHaveLength(0);
  });
});
