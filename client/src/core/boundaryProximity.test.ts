import { describe, expect, it } from "vitest";
import {
  BOUNDARY_HEX_DENSITY_MAX,
  BOUNDARY_HEX_DENSITY_MIN,
  BoundaryWarningLatch,
  boundaryProximityFactor,
  boundaryShieldOpacity,
  boundaryShieldRedMix,
  boundaryShieldRenderParams,
} from "./boundaryProximity.js";

describe("boundary shield proximity curves", () => {
  it("stays at base opacity far away and reaches full opacity at contact", () => {
    expect(boundaryProximityFactor(40, 40)).toBe(0);
    expect(boundaryShieldOpacity(100, 40, 0.03)).toBeCloseTo(0.03);
    expect(boundaryShieldOpacity(20, 40, 0.03)).toBeCloseTo(0.515);
    expect(boundaryShieldOpacity(0, 40, 0.03)).toBe(1);
    expect(boundaryShieldOpacity(-5, 40, 0.03)).toBe(1);
  });

  it("keeps the shield blue until the red threshold, then blends to red", () => {
    expect(boundaryShieldRedMix(20, 12)).toBe(0);
    expect(boundaryShieldRedMix(12, 12)).toBe(0);
    expect(boundaryShieldRedMix(6, 12)).toBe(0.5);
    expect(boundaryShieldRedMix(0, 12)).toBe(1);
  });

  it("bounds every value sent to either boundary material", () => {
    expect(boundaryShieldRenderParams(42, 0.018)).toEqual({ hexDensity: 42, opacity: 0.018 });
    expect(boundaryShieldRenderParams(1e12, 4)).toEqual({
      hexDensity: BOUNDARY_HEX_DENSITY_MAX,
      opacity: 1,
    });
    expect(boundaryShieldRenderParams(Number.NaN, Number.NaN)).toEqual({
      hexDensity: BOUNDARY_HEX_DENSITY_MIN,
      opacity: 0,
    });
    expect(boundaryShieldRenderParams(-10, -2)).toEqual({
      hexDensity: BOUNDARY_HEX_DENSITY_MIN,
      opacity: 0,
    });
  });
});

describe("BoundaryWarningLatch", () => {
  it("fires on entry, does not spam, and rearms only after leaving", () => {
    const latch = new BoundaryWarningLatch();
    expect(latch.update(30, 20)).toBe(false);
    expect(latch.update(19, 20)).toBe(true);
    expect(latch.update(10, 20)).toBe(false);
    expect(latch.update(21, 20)).toBe(false);
    expect(latch.update(20, 20)).toBe(true);
  });

  it("rearms explicitly for a respawn that remains inside the warning zone", () => {
    const latch = new BoundaryWarningLatch();
    expect(latch.update(10, 20)).toBe(true);
    expect(latch.update(10, 20)).toBe(false);
    latch.reset();
    expect(latch.update(10, 20)).toBe(true);
  });
});
