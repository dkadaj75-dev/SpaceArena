import { describe, expect, it } from "vitest";
import { resampleTrail, trailAlphas, TRAIL_POINTS, type TrailPoint } from "./flagTrail.js";

const p = (x: number, y = 0, z = 0): TrailPoint => ({ x, y, z });

/** Total path length of a point ladder. */
function pathLength(points: readonly TrailPoint[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(
      points[i]!.x - points[i - 1]!.x,
      points[i]!.y - points[i - 1]!.y,
      points[i]!.z - points[i - 1]!.z,
    );
  }
  return total;
}

describe("resampleTrail (owner 2026-07-31)", () => {
  it("always produces exactly the fixed point count — the line mesh needs it", () => {
    const out: TrailPoint[] = [];
    resampleTrail([p(0), p(10)], out);
    expect(out).toHaveLength(TRAIL_POINTS);
    resampleTrail([p(0), p(1), p(2), p(3), p(4), p(5)], out);
    expect(out).toHaveLength(TRAIL_POINTS);
  });

  it("keeps the ends exactly where the sim put them", () => {
    const out: TrailPoint[] = [];
    resampleTrail([p(0, 1, 2), p(5, 5, 5), p(10, 0, -4)], out);
    expect(out[0]).toEqual({ x: 0, y: 1, z: 2 });
    expect(out[TRAIL_POINTS - 1]!.x).toBeCloseTo(10, 6);
    expect(out[TRAIL_POINTS - 1]!.z).toBeCloseTo(-4, 6);
  });

  it("keeps the path's length, give or take the corners it rounds off", () => {
    const trail = [p(0), p(10), p(10, 10), p(0, 10)];
    const out: TrailPoint[] = [];
    resampleTrail(trail, out);
    // A fixed ladder of samples cuts each corner slightly; what matters is that
    // the ribbon covers the path rather than inventing or losing most of it.
    const ratio = pathLength(out) / pathLength(trail);
    expect(ratio).toBeGreaterThan(0.95);
    expect(ratio).toBeLessThanOrEqual(1);
  });

  it("is exact on a straight run, where there is nothing to round off", () => {
    const trail = [p(0), p(30), p(60)];
    const out: TrailPoint[] = [];
    resampleTrail(trail, out);
    expect(pathLength(out)).toBeCloseTo(60, 6);
  });

  it("spaces points evenly ALONG the path, not per input point", () => {
    // One long leg then a cluster of short ones: index-based sampling would
    // crowd the ribbon into the cluster.
    const trail = [p(0), p(90), p(91), p(92), p(93)];
    const out: TrailPoint[] = [];
    resampleTrail(trail, out);
    const steps: number[] = [];
    for (let i = 1; i < out.length; i++) steps.push(Math.abs(out[i]!.x - out[i - 1]!.x));
    const min = Math.min(...steps);
    const max = Math.max(...steps);
    expect(max - min).toBeLessThan(1e-6);
  });

  it("reuses the caller's array instead of allocating each frame", () => {
    const out: TrailPoint[] = [];
    resampleTrail([p(0), p(5)], out);
    const first = out[0];
    resampleTrail([p(1), p(6)], out);
    expect(out[0]).toBe(first);
    expect(out[0]!.x).toBe(1);
  });

  it("reports nothing to draw for an empty trail, leaving the buffer alone", () => {
    const out: TrailPoint[] = [p(7)];
    expect(resampleTrail([], out)).toBe(false);
    expect(out).toEqual([p(7)]);
  });

  it("survives a degenerate trail whose points never move", () => {
    const out: TrailPoint[] = [];
    expect(resampleTrail([p(3), p(3), p(3)], out)).toBe(true);
    expect(out.every((q) => q.x === 3)).toBe(true);
  });

  it("handles a single breadcrumb", () => {
    const out: TrailPoint[] = [];
    expect(resampleTrail([p(4, 5, 6)], out)).toBe(true);
    expect(out).toHaveLength(TRAIL_POINTS);
    expect(out[0]).toEqual({ x: 4, y: 5, z: 6 });
  });
});

describe("trailAlphas", () => {
  it("fades from invisible at the tail to bright at the runner", () => {
    const alphas = trailAlphas();
    expect(alphas).toHaveLength(TRAIL_POINTS);
    expect(alphas[0]).toBe(0);
    expect(alphas[alphas.length - 1]).toBeCloseTo(0.85, 6);
    for (let i = 1; i < alphas.length; i++) expect(alphas[i]!).toBeGreaterThan(alphas[i - 1]!);
  });
});
