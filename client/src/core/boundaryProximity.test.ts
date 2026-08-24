import { describe, expect, it } from "vitest";
import {
  BOUNDARY_HEX_DENSITY_MAX,
  BOUNDARY_HEX_DENSITY_MIN,
  BOUNDARY_SHIELD_FLAT_MAX_OPACITY,
  BOUNDARY_SHIELD_MAX_OPACITY,
  BoundaryWarningLatch,
  boundaryProximityFactor,
  boundaryShellFlatAlpha,
  boundaryShieldOpacity,
  boundaryShieldRedMix,
  boundaryShieldRenderParams,
} from "./boundaryProximity.js";

describe("boundary shield proximity curves", () => {
  it("is fully invisible far away and ramps up toward contact", () => {
    expect(boundaryProximityFactor(40, 40)).toBe(0);
    expect(boundaryShieldOpacity(100, 40, 1)).toBe(0);
    expect(boundaryShieldOpacity(40, 40, 1)).toBe(0);
    expect(boundaryShieldOpacity(35, 40, 1)).toBeCloseTo(0.125);
    // …and never past the legibility ceiling, whatever the arena authors.
    expect(boundaryShieldOpacity(0, 40, 1)).toBe(BOUNDARY_SHIELD_MAX_OPACITY);
    expect(boundaryShieldOpacity(-5, 40, 1)).toBe(BOUNDARY_SHIELD_MAX_OPACITY);
  });

  /**
   * Playtest finding 6: "the entire viewport including HUD text is washed
   * pink, no wall geometry visible, hull draining at 5%". Ring Nebula authors
   * `baseOpacity: 1` and the shell is a sphere the pilot is INSIDE, so at
   * contact it is the whole field of view — and on the LOW tier that AUTO picks
   * on a phone it is drawn as one unmasked emissive surface with no hex mask to
   * break it up. Both paths are capped, the flat one harder.
   */
  it("caps the shell so the HUD stays readable right against the wall", () => {
    expect(BOUNDARY_SHIELD_MAX_OPACITY).toBeLessThan(0.5);
    expect(BOUNDARY_SHIELD_FLAT_MAX_OPACITY).toBeLessThan(BOUNDARY_SHIELD_MAX_OPACITY);
    // The authored intensity still reads BELOW the cap: an arena may choose to
    // be fainter, never to be a filter over the whole screen.
    expect(boundaryShieldOpacity(38, 40, 0.5)).toBeCloseTo(0.025);
    expect(boundaryShellFlatAlpha(1)).toBe(BOUNDARY_SHIELD_FLAT_MAX_OPACITY);
    expect(boundaryShellFlatAlpha(0.05)).toBeCloseTo(0.05);
    expect(boundaryShellFlatAlpha(Number.NaN)).toBe(0);
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
