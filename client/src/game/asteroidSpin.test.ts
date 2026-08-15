import { describe, expect, it } from "vitest";
import {
  DEFAULT_ASTEROID_SPIN,
  asteroidSpinFor,
  rockOrientationAt,
} from "./asteroidSpin.js";

describe("asteroidSpinFor", () => {
  it("is deterministic per placement index and varies between indices", () => {
    expect(asteroidSpinFor(42, undefined)).toEqual(asteroidSpinFor(42, undefined));
    expect(asteroidSpinFor(42, undefined)).not.toEqual(asteroidSpinFor(43, undefined));
  });

  it("keeps the derived pace inside the configured range and uses defaults", () => {
    for (let id = 1; id <= 100; id++) {
      const configured = Math.abs(asteroidSpinFor(id, { minDegPerSec: 1, maxDegPerSec: 3 }).radiansPerSec);
      expect(configured * (180 / Math.PI)).toBeGreaterThanOrEqual(1);
      expect(configured * (180 / Math.PI)).toBeLessThanOrEqual(3);
      const fallback = Math.abs(asteroidSpinFor(id, undefined).radiansPerSec) * (180 / Math.PI);
      expect(fallback).toBeGreaterThanOrEqual(DEFAULT_ASTEROID_SPIN.minDegPerSec);
      expect(fallback).toBeLessThanOrEqual(DEFAULT_ASTEROID_SPIN.maxDegPerSec);
    }
  });
});

describe("rockOrientationAt", () => {
  it("writes the expected axis-angle pose in place without changing object identity", () => {
    const quaternion = { x: 0, y: 0, z: 0, w: 1 };
    const identity = quaternion;
    rockOrientationAt({ axisX: 0, axisY: 1, axisZ: 0, radiansPerSec: Math.PI / 2 }, 0, 1, quaternion);
    expect(quaternion).toBe(identity);
    expect(quaternion.x).toBeCloseTo(0);
    expect(quaternion.y).toBeCloseTo(Math.SQRT1_2);
    expect(quaternion.z).toBeCloseTo(0);
    expect(quaternion.w).toBeCloseTo(Math.SQRT1_2);
  });

  it("is a pure function of match time — the renderer never accumulates drift", () => {
    // The whole point of the closed form: sampling at t, then again at t, then
    // jumping backwards, all give the same pose. An integration could not.
    const spin = { axisX: 1, axisY: 0, axisZ: 0, radiansPerSec: 0.4 };
    const a = { x: 0, y: 0, z: 0, w: 1 };
    const b = { x: 0, y: 0, z: 0, w: 1 };
    rockOrientationAt(spin, 0, 17.25, a);
    rockOrientationAt(spin, 0, 3, b);
    rockOrientationAt(spin, 0, 17.25, b);
    expect(b).toEqual(a);
    // ...and it stays a unit quaternion however far out the clock runs.
    rockOrientationAt(spin, 0, 100000, a);
    expect(Math.hypot(a.x, a.y, a.z, a.w)).toBeCloseTo(1, 10);
  });

  it("applies the authored placement yaw under the tumble", () => {
    const still = { axisX: 0, axisY: 1, axisZ: 0, radiansPerSec: 0 };
    const posed = { x: 0, y: 0, z: 0, w: 1 };
    rockOrientationAt(still, Math.PI / 2, 12, posed);
    expect(posed.y).toBeCloseTo(Math.SQRT1_2);
    expect(posed.w).toBeCloseTo(Math.SQRT1_2);
  });
});
