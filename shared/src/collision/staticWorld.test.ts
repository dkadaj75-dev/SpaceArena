import { describe, expect, it } from "vitest";
import type { ArenaConfig, PropConfig } from "../schemas/index.js";
import { encodeFloat32Array, encodeUint32Array } from "./base64.js";
import { StaticWorld } from "./staticWorld.js";

const plane: PropConfig = {
  id: "prop.plane", type: "prop", version: 1, category: "structure", impactDamage: 0,
  render: { recipe: "model.static" },
  collision: {
    positions: encodeFloat32Array(new Float32Array([0, -2, -2, 0, 2, -2, 0, 2, 2, 0, -2, 2])),
    indices: encodeUint32Array(new Uint32Array([0, 1, 2, 0, 2, 3])),
    bounds: { min: { x: 0, y: -2, z: -2 }, max: { x: 0, y: 2, z: 2 } },
  },
};

describe("StaticWorld transforms", () => {
  it("applies position, Babylon YXZ rotation, and uniform scale", () => {
    const placements = [{ propId: plane.id, position: { x: 10, y: 3, z: -4 }, rotation: { y: Math.PI / 2 }, scale: 2 } satisfies NonNullable<ArenaConfig["propPlacements"]>[number]];
    const world = new StaticWorld(placements, () => plane);
    const hit = world.raycast({ x: 10, y: 3, z: -10 }, { x: 10, y: 3, z: 2 });
    expect(hit).not.toBeNull();
    expect(hit!.point).toMatchObject({ x: 10, y: 3, z: -4 });
    expect(hit!.t).toBeCloseTo(0.5);
    expect(Math.abs(hit!.normal.z)).toBeCloseTo(1);
  });

  it("scales sphere depth and provides heightBelow", () => {
    const floor: PropConfig = {
      ...plane,
      id: "prop.floor",
      collision: {
        ...plane.collision!,
        positions: encodeFloat32Array(new Float32Array([-2, 0, -2, 2, 0, 2, 2, 0, -2, -2, 0, 2])),
        bounds: { min: { x: -2, y: 0, z: -2 }, max: { x: 2, y: 0, z: 2 } },
      },
    };
    const world = new StaticWorld([{ propId: floor.id, position: { x: 0, z: 0 }, scale: 2 }], () => floor);
    // This mesh winds its solid side upward; a centre behind it needs radius
    // plus distance to reach the authored surface in one resolution pass.
    expect(world.sphereContact({ x: 0, y: 0.5, z: 0 }, 1)?.depth).toBeCloseTo(1.5);
    expect(world.heightBelow({ x: 0, y: 5, z: 0 }, 10)?.y).toBeCloseTo(0);
  });
});
