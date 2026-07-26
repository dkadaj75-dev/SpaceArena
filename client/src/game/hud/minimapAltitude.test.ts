import { describe, expect, it } from "vitest";
import { altitudeTickPx, DEFAULT_ALTITUDE_TICK_PX } from "./minimapAltitude.js";

/**
 * BUBBLE.md §C — the minimap keeps its top-down (x, z) projection and carries the
 * bubble's third axis as a short tick beside each blip. The sign convention is
 * the thing to pin: canvas y grows DOWNWARD, so "above the player" is negative.
 */
describe("altitudeTickPx", () => {
  // 128 px map over a radius-300 bubble ⇒ 64 / 300 px per unit.
  const PX_PER_UNIT = 64 / 300;
  const MAX = DEFAULT_ALTITUDE_TICK_PX;

  it("grows UPWARD on screen for a contact above the player", () => {
    expect(altitudeTickPx(20, PX_PER_UNIT, MAX)).toBeLessThan(0);
    expect(altitudeTickPx(20, PX_PER_UNIT, MAX)).toBeCloseTo(-20 * PX_PER_UNIT, 9);
  });

  it("grows DOWNWARD for a contact below the player", () => {
    expect(altitudeTickPx(-20, PX_PER_UNIT, MAX)).toBeGreaterThan(0);
    expect(altitudeTickPx(-20, PX_PER_UNIT, MAX)).toBeCloseTo(20 * PX_PER_UNIT, 9);
  });

  it("uses the SAME scale as the map's x/z, so the tick is a real projection", () => {
    // 30 units up must draw exactly as far as 30 units north does on the map.
    expect(Math.abs(altitudeTickPx(30, PX_PER_UNIT, 100))).toBeCloseTo(30 * PX_PER_UNIT, 9);
  });

  it("saturates at ±maxPx so a contact at the top of the bubble cannot cross the map", () => {
    expect(altitudeTickPx(10_000, PX_PER_UNIT, MAX)).toBe(-MAX);
    expect(altitudeTickPx(-10_000, PX_PER_UNIT, MAX)).toBe(MAX);
    expect(altitudeTickPx(300, PX_PER_UNIT, MAX)).toBe(-MAX);
  });

  it("reports nothing for a contact on the player's own level", () => {
    expect(altitudeTickPx(0, PX_PER_UNIT, MAX)).toBe(0);
    // Sub-half-pixel: invisible anyway, and skipping it saves a canvas path.
    expect(altitudeTickPx(1, PX_PER_UNIT, MAX)).toBe(0);
  });

  it("draws nothing when the theme switches the ticks off (or the map has no scale)", () => {
    expect(altitudeTickPx(200, PX_PER_UNIT, 0)).toBe(0);
    expect(altitudeTickPx(200, 0, MAX)).toBe(0);
  });

  it("is symmetric about zero", () => {
    for (const dy of [3, 17, 60, 400]) {
      expect(altitudeTickPx(dy, PX_PER_UNIT, MAX)).toBeCloseTo(-altitudeTickPx(-dy, PX_PER_UNIT, MAX), 12);
    }
  });
});
