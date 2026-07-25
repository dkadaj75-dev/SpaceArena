import { beforeAll, describe, expect, it } from "vitest";

import type { ConfigService } from "../core/ConfigService.js";
import { hasLineOfSight, hasLineOfSightAmong, hasLineOfSightBetween } from "./los.js";
import { pointSegmentDistSq, segmentIntersectsCircle } from "./math.js";
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

const A = { x: 0, z: 0 };
const B = { x: 10, z: 0 };

describe("pointSegmentDistSq", () => {
  it("measures perpendicular distance when the projection lands inside the segment", () => {
    expect(pointSegmentDistSq({ x: 5, z: 3 }, A, B)).toBeCloseTo(9, 10);
    expect(pointSegmentDistSq({ x: 5, z: 0 }, A, B)).toBeCloseTo(0, 10);
  });

  it("clamps to the endpoints when the projection falls outside the segment", () => {
    // Behind A (t < 0) → distance to A, not the infinite line.
    expect(pointSegmentDistSq({ x: -4, z: 3 }, A, B)).toBeCloseTo(25, 10);
    // Past B (t > 1) → distance to B.
    expect(pointSegmentDistSq({ x: 14, z: 3 }, A, B)).toBeCloseTo(25, 10);
  });

  it("degrades to point-to-point distance for a zero-length segment", () => {
    expect(pointSegmentDistSq({ x: 3, z: 4 }, A, A)).toBeCloseTo(25, 10);
    expect(pointSegmentDistSq(A, A, A)).toBe(0);
  });
});

describe("segmentIntersectsCircle", () => {
  it("counts exact tangency as an intersection (closed test)", () => {
    expect(segmentIntersectsCircle(A, B, { x: 5, z: 2 }, 2)).toBe(true);
    expect(segmentIntersectsCircle(A, B, { x: 5, z: 2 }, 1.999999)).toBe(false);
  });

  it("does not intersect a circle that is only near the infinite line, past the endpoint", () => {
    expect(segmentIntersectsCircle(A, B, { x: 20, z: 0 }, 5)).toBe(false);
    expect(segmentIntersectsCircle(A, B, { x: 14, z: 0 }, 5)).toBe(true); // reaches back to B
  });

  it("intersects when an endpoint is inside the circle", () => {
    expect(segmentIntersectsCircle(A, B, { x: 0, z: 0 }, 1)).toBe(true);
    expect(segmentIntersectsCircle(A, B, { x: 10, z: 0 }, 1)).toBe(true);
  });

  it("is symmetric in its endpoints", () => {
    const c = { x: 5, z: 1.5 };
    expect(segmentIntersectsCircle(A, B, c, 2)).toBe(segmentIntersectsCircle(B, A, c, 2));
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
