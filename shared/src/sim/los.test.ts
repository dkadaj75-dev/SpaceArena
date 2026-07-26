import { beforeAll, describe, expect, it } from "vitest";

import type { ConfigService } from "../core/ConfigService.js";
import { hasLineOfSight, hasLineOfSightAmong, hasLineOfSightBetween } from "./los.js";
import { pointSegmentDistSq3, segmentIntersectsSphere } from "./math.js";
import { spawnAsteroid, spawnShipFromConfig } from "./spawn.js";
import { INTERCEPTOR_FITTING, loadTestConfigs, makeWorld, rebuildSpatial } from "./testutil.js";

/**
 * ROADMAP §11 6.1 — "LoS math". `systems/NavigationLos.test.ts` covers the one
 * headline case (a rock on the segment blocks, one beside it does not) and
 * `systems/Combat.test.ts` covers destroyed rocks no longer blocking. This file
 * covers the geometry itself and the broadphase/caching edges around it:
 * clamped projections, tangency, degenerate segments, blockers inside the query
 * AABB but off the line, ships not being blockers, and the per-tick pair cache.
 */

let configs: ConfigService;
beforeAll(async () => {
  configs = await loadTestConfigs();
});

const A = { x: 0, y: 0, z: 0 };
const B = { x: 10, y: 0, z: 0 };

describe("pointSegmentDistSq3", () => {
  it("measures perpendicular distance when the projection lands inside the segment", () => {
    expect(pointSegmentDistSq3({ x: 5, y: 0, z: 3 }, A, B)).toBeCloseTo(9, 10);
    expect(pointSegmentDistSq3({ x: 5, y: 0, z: 0 }, A, B)).toBeCloseTo(0, 10);
    // The vertical axis is just another component of the same perpendicular.
    expect(pointSegmentDistSq3({ x: 5, y: 3, z: 0 }, A, B)).toBeCloseTo(9, 10);
    expect(pointSegmentDistSq3({ x: 5, y: 3, z: 4 }, A, B)).toBeCloseTo(25, 10);
  });

  it("clamps to the endpoints when the projection falls outside the segment", () => {
    // Behind A (t < 0) → distance to A, not the infinite line.
    expect(pointSegmentDistSq3({ x: -4, y: 0, z: 3 }, A, B)).toBeCloseTo(25, 10);
    // Past B (t > 1) → distance to B.
    expect(pointSegmentDistSq3({ x: 14, y: 3, z: 0 }, A, B)).toBeCloseTo(25, 10);
  });

  it("degrades to point-to-point distance for a zero-length segment", () => {
    expect(pointSegmentDistSq3({ x: 3, y: 0, z: 4 }, A, A)).toBeCloseTo(25, 10);
    expect(pointSegmentDistSq3({ x: 0, y: 5, z: 0 }, A, A)).toBeCloseTo(25, 10);
    expect(pointSegmentDistSq3(A, A, A)).toBe(0);
  });
});

describe("segmentIntersectsSphere", () => {
  it("counts exact tangency as an intersection (closed test)", () => {
    expect(segmentIntersectsSphere(A, B, { x: 5, y: 0, z: 2 }, 2)).toBe(true);
    expect(segmentIntersectsSphere(A, B, { x: 5, y: 0, z: 2 }, 1.999999)).toBe(false);
    // Same tangency, taken vertically.
    expect(segmentIntersectsSphere(A, B, { x: 5, y: 2, z: 0 }, 2)).toBe(true);
    expect(segmentIntersectsSphere(A, B, { x: 5, y: 2, z: 0 }, 1.999999)).toBe(false);
  });

  it("does not intersect a sphere that is only near the infinite line, past the endpoint", () => {
    expect(segmentIntersectsSphere(A, B, { x: 20, y: 0, z: 0 }, 5)).toBe(false);
    expect(segmentIntersectsSphere(A, B, { x: 14, y: 0, z: 0 }, 5)).toBe(true); // reaches back to B
  });

  it("intersects when an endpoint is inside the sphere", () => {
    expect(segmentIntersectsSphere(A, B, { x: 0, y: 0, z: 0 }, 1)).toBe(true);
    expect(segmentIntersectsSphere(A, B, { x: 10, y: 0.5, z: 0 }, 1)).toBe(true);
  });

  it("is symmetric in its endpoints", () => {
    const c = { x: 5, y: 1.5, z: 0 };
    expect(segmentIntersectsSphere(A, B, c, 2)).toBe(segmentIntersectsSphere(B, A, c, 2));
  });
});

describe("hasLineOfSightAmong (world-free variant used by bots/overlays)", () => {
  it("is clear with no blockers at all", () => {
    expect(hasLineOfSightAmong(A, B, [])).toBe(true);
  });

  it("blocks on the first intersecting blocker and ignores the rest", () => {
    const blockers = [
      { pos: { x: 5, z: 20 }, radius: 3 },
      { pos: { x: 5, z: 0 }, radius: 1 },
      { pos: { x: 5, z: -20 }, radius: 3 },
    ];
    expect(hasLineOfSightAmong(A, B, blockers)).toBe(false);
    expect(hasLineOfSightAmong(A, B, [blockers[0]!, blockers[2]!])).toBe(true);
  });

  it("blocks when an endpoint sits inside a blocker (hiding *in* a rock is not LoS)", () => {
    expect(hasLineOfSightAmong(A, B, [{ pos: { x: 0, z: 0 }, radius: 2 }])).toBe(false);
  });

  it("agrees with the World variant for the same geometry", () => {
    const world = makeWorld(configs);
    spawnAsteroid(world, configs, "asteroid.large-hazard", { x: 0, z: 0 }); // radius 8
    rebuildSpatial(world);
    const blockers = [{ pos: { x: 0, z: 0 }, radius: 8 }];
    for (const [a, b] of [
      [{ x: -30, z: 0 }, { x: 30, z: 0 }],
      [{ x: -30, z: 20 }, { x: 30, z: 20 }],
      [{ x: -30, z: 8 }, { x: 30, z: 8 }],
      [{ x: -30, z: -30 }, { x: -20, z: -20 }],
    ] as const) {
      expect(hasLineOfSight(world, a, b)).toBe(hasLineOfSightAmong(a, b, blockers));
    }
  });
});

describe("hasLineOfSight (World + spatial broadphase)", () => {
  it("finds a blocker on an axis-aligned segment whose query AABB is degenerate", () => {
    const world = makeWorld(configs);
    spawnAsteroid(world, configs, "asteroid.small-rock", { x: 0, z: 0 }); // radius 3.5
    rebuildSpatial(world);
    // Vertical segment: minX === maxX. Horizontal: minZ === maxZ.
    expect(hasLineOfSight(world, { x: 0, z: -30 }, { x: 0, z: 30 })).toBe(false);
    expect(hasLineOfSight(world, { x: -30, z: 0 }, { x: 30, z: 0 })).toBe(false);
    expect(hasLineOfSight(world, { x: 10, z: -30 }, { x: 10, z: 30 })).toBe(true);
  });

  it("does not block on a rock that is inside the query AABB but off the segment", () => {
    const world = makeWorld(configs);
    spawnAsteroid(world, configs, "asteroid.small-rock", { x: 25, z: -25 }); // corner of the diagonal's AABB
    rebuildSpatial(world);
    expect(hasLineOfSight(world, { x: -30, z: -30 }, { x: 30, z: 30 })).toBe(true);
  });

  it("treats ships as transparent — only asteroids block", () => {
    const world = makeWorld(configs);
    spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 1, { x: 0, z: 0 }, 0);
    rebuildSpatial(world);
    expect(hasLineOfSight(world, { x: -20, z: 0 }, { x: 20, z: 0 })).toBe(true);
  });

  it("handles a zero-length segment (a point query)", () => {
    const world = makeWorld(configs);
    spawnAsteroid(world, configs, "asteroid.large-hazard", { x: 0, z: 0 }); // radius 8
    rebuildSpatial(world);
    expect(hasLineOfSight(world, { x: 0, z: 0 }, { x: 0, z: 0 })).toBe(false);
    expect(hasLineOfSight(world, { x: 20, z: 0 }, { x: 20, z: 0 })).toBe(true);
  });

  it("is symmetric and clear on an empty arena", () => {
    const empty = makeWorld(configs);
    rebuildSpatial(empty);
    expect(hasLineOfSight(empty, { x: -50, z: -50 }, { x: 50, z: 50 })).toBe(true);

    const world = makeWorld(configs);
    spawnAsteroid(world, configs, "asteroid.large-hazard", { x: 5, z: 5 });
    rebuildSpatial(world);
    const a = { x: -40, z: -12 };
    const b = { x: 40, z: 22 };
    expect(hasLineOfSight(world, a, b)).toBe(hasLineOfSight(world, b, a));
  });
});

describe("hasLineOfSight in the bubble (BUBBLE.md §A)", () => {
  it("does not block on a rock that is planar-aligned but far below the sight line", () => {
    const world = makeWorld(configs);
    const rock = spawnAsteroid(world, configs, "asteroid.large-hazard", { x: 0, z: 0 }); // radius 8
    world.transforms.get(rock)!.pos.y = -30;
    rebuildSpatial(world);

    // Planar LoS saw this rock dead on the segment; in 3D the shot passes over it.
    expect(hasLineOfSight(world, { x: -20, y: 0, z: 0 }, { x: 20, y: 0, z: 0 })).toBe(true);
    // A sight line that really does pass through it is still blocked.
    expect(hasLineOfSight(world, { x: -20, y: -30, z: 0 }, { x: 20, y: -30, z: 0 })).toBe(false);
  });

  it("blocks a climbing shot that passes through a rock above the plane", () => {
    const world = makeWorld(configs);
    const rock = spawnAsteroid(world, configs, "asteroid.large-hazard", { x: 0, z: 0 });
    world.transforms.get(rock)!.pos.y = 10;
    rebuildSpatial(world);

    expect(hasLineOfSight(world, { x: -20, y: -10, z: 0 }, { x: 20, y: 30, z: 0 })).toBe(false);
    expect(hasLineOfSight(world, { x: -20, y: 0, z: 0 }, { x: 20, y: 0, z: 0 })).toBe(true);
  });

  it("keeps the world-free variant in step with the World one, altitude included", () => {
    const world = makeWorld(configs);
    const rock = spawnAsteroid(world, configs, "asteroid.large-hazard", { x: 5, z: 0 });
    world.transforms.get(rock)!.pos.y = 12;
    rebuildSpatial(world);
    const blockers = [{ pos: { x: 5, y: 12, z: 0 }, radius: world.colliders.get(rock)!.radius }];

    for (const y of [0, 12]) {
      const a = { x: -20, y, z: 0 };
      const b = { x: 20, y, z: 0 };
      expect(hasLineOfSight(world, a, b)).toBe(hasLineOfSightAmong(a, b, blockers));
    }
    // …and a caller that has not gone 3D yet (bots, until T4) still reads the plane.
    expect(hasLineOfSightAmong({ x: -20, z: 0 }, { x: 20, z: 0 }, [{ pos: { x: 5, z: 0 }, radius: 8 }])).toBe(false);
  });
});

describe("hasLineOfSightBetween (per-tick pair cache)", () => {
  it("caches per unordered pair and re-evaluates once the cache is cleared", () => {
    const world = makeWorld(configs);
    spawnAsteroid(world, configs, "asteroid.large-hazard", { x: 0, z: 0 });
    const a = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, { x: -30, z: 0 }, 0);
    const b = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 1, { x: 30, z: 0 }, 0);
    rebuildSpatial(world);

    expect(hasLineOfSightBetween(world, a, b)).toBe(false);
    expect(hasLineOfSightBetween(world, b, a)).toBe(false); // same cache slot, either order

    // Move b out of the shadow but keep the cache: the tick's answer is frozen.
    world.transforms.get(b)!.pos.z = 40;
    rebuildSpatial(world);
    expect(hasLineOfSightBetween(world, a, b)).toBe(false);

    world.losCache.clear();
    expect(hasLineOfSightBetween(world, a, b)).toBe(true);
    expect(world.losCache.size).toBe(1);
  });

  it("reports no line of sight to an entity that has no transform", () => {
    const world = makeWorld(configs);
    const a = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 0, z: 0 }, 0);
    rebuildSpatial(world);
    expect(hasLineOfSightBetween(world, a, 99999)).toBe(false);
  });
});
