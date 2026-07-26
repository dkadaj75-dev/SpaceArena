import { describe, expect, it } from "vitest";
import {
  DEFAULT_ASTEROID_SPIN,
  advanceAsteroidSpin,
  asteroidSpinFor,
} from "./asteroidSpin.js";

describe("asteroidSpinFor", () => {
  it("is deterministic per entity id and varies between ids", () => {
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

describe("advanceAsteroidSpin", () => {
  it("applies the expected axis-angle rotation in place without changing object identity", () => {
    const quaternion = { x: 0, y: 0, z: 0, w: 1 };
    const identity = quaternion;
    advanceAsteroidSpin(
      quaternion,
      { axisX: 0, axisY: 1, axisZ: 0, radiansPerSec: Math.PI / 2 },
      1,
    );
    expect(quaternion).toBe(identity);
    expect(quaternion.x).toBeCloseTo(0);
    expect(quaternion.y).toBeCloseTo(Math.SQRT1_2);
    expect(quaternion.z).toBeCloseTo(0);
    expect(quaternion.w).toBeCloseTo(Math.SQRT1_2);
  });

  it("composes frame steps and ignores zero elapsed time", () => {
    const stepped = { x: 0, y: 0, z: 0, w: 1 };
    const once = { ...stepped };
    const spin = { axisX: 1, axisY: 0, axisZ: 0, radiansPerSec: 0.4 };
    advanceAsteroidSpin(stepped, spin, 0.5);
    advanceAsteroidSpin(stepped, spin, 0.5);
    advanceAsteroidSpin(once, spin, 1);
    expect(stepped).toEqual(expect.objectContaining({
      x: expect.closeTo(once.x, 10),
      w: expect.closeTo(once.w, 10),
    }));
    const before = { ...once };
    advanceAsteroidSpin(once, spin, 0);
    expect(once).toEqual(before);
  });
});
