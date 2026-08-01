import { describe, expect, it } from "vitest";
import {
  advanceBeaconClock,
  beaconPhase,
  beaconPulse,
  beaconRadius,
  BEACON_ALPHA,
  BEACON_ALPHA_SWING,
  BEACON_DEFAULT_RADIUS,
  BEACON_MAX_RADIUS,
  BEACON_MIN_RADIUS,
  BEACON_PULSE_MS,
  BEACON_SCALE_SWING,
} from "./flagBeacon.js";

describe("beaconRadius (owner 2026-08-01)", () => {
  it("uses the authored capture radius when there is one", () => {
    expect(beaconRadius(16)).toBe(16);
  });

  it("still shows a beacon when content authored no radius", () => {
    expect(beaconRadius(0)).toBe(BEACON_DEFAULT_RADIUS);
    expect(beaconRadius(-4)).toBe(BEACON_DEFAULT_RADIUS);
    expect(beaconRadius(Number.NaN)).toBe(BEACON_DEFAULT_RADIUS);
  });

  it("clamps to a readable band at both ends", () => {
    expect(beaconRadius(0.5)).toBe(BEACON_MIN_RADIUS);
    expect(beaconRadius(5000)).toBe(BEACON_MAX_RADIUS);
  });
});

describe("beaconPulse (owner 2026-08-01)", () => {
  it("breathes gently — the base must never look like it moved", () => {
    let minScale = Infinity;
    let maxScale = -Infinity;
    let minAlpha = Infinity;
    let maxAlpha = -Infinity;
    for (let t = 0; t <= BEACON_PULSE_MS; t += 10) {
      const { scale, alpha } = beaconPulse(t);
      minScale = Math.min(minScale, scale);
      maxScale = Math.max(maxScale, scale);
      minAlpha = Math.min(minAlpha, alpha);
      maxAlpha = Math.max(maxAlpha, alpha);
    }
    expect(minScale).toBeGreaterThanOrEqual(1 - BEACON_SCALE_SWING - 1e-9);
    expect(maxScale).toBeLessThanOrEqual(1 + BEACON_SCALE_SWING + 1e-9);
    expect(minAlpha).toBeGreaterThan(0);
    expect(maxAlpha).toBeLessThan(1);
    expect(minAlpha).toBeGreaterThanOrEqual(BEACON_ALPHA - BEACON_ALPHA_SWING - 1e-9);
    expect(maxAlpha).toBeLessThanOrEqual(BEACON_ALPHA + BEACON_ALPHA_SWING + 1e-9);
  });

  it("is a pure function of the clock, so a hitch cannot leave it stuck", () => {
    // Same clock reading ⇒ same beacon, however the renderer got there.
    expect(beaconPulse(1234, 0.25)).toEqual(beaconPulse(1234, 0.25));
    const wrapped = beaconPulse(BEACON_PULSE_MS * 3);
    expect(wrapped.scale).toBeCloseTo(beaconPulse(0).scale, 6);
    expect(wrapped.alpha).toBeCloseTo(beaconPulse(0).alpha, 6);
  });

  it("survives a garbage clock rather than producing NaN geometry", () => {
    const { scale, alpha } = beaconPulse(Number.NaN, Number.NaN);
    expect(Number.isFinite(scale)).toBe(true);
    expect(Number.isFinite(alpha)).toBe(true);
  });
});

describe("beaconPhase (owner 2026-08-01)", () => {
  it("stays inside one breath and is stable per id", () => {
    for (const id of [0, 1, 7, 42, 1000]) {
      const phase = beaconPhase(id);
      expect(phase).toBeGreaterThanOrEqual(0);
      expect(phase).toBeLessThan(1);
      expect(beaconPhase(id)).toBe(phase);
    }
  });

  it("gives neighbouring bases visibly different phases — no lockstep", () => {
    expect(Math.abs(beaconPhase(1) - beaconPhase(2))).toBeGreaterThan(0.1);
  });
});

describe("advanceBeaconClock (owner 2026-08-01)", () => {
  it("wraps to one breath so a long match keeps its precision", () => {
    let clock = 0;
    for (let i = 0; i < 10_000; i++) clock = advanceBeaconClock(clock, 16.7);
    expect(clock).toBeGreaterThanOrEqual(0);
    expect(clock).toBeLessThan(BEACON_PULSE_MS);
  });

  it("wrapping does not change the pulse it produces", () => {
    const raw = 5 * BEACON_PULSE_MS + 700;
    expect(beaconPulse(advanceBeaconClock(raw, 0)).scale).toBeCloseTo(beaconPulse(raw).scale, 6);
    expect(beaconPulse(advanceBeaconClock(raw, 0)).alpha).toBeCloseTo(beaconPulse(raw).alpha, 6);
  });

  it("ignores a nonsense frame delta instead of poisoning the clock", () => {
    expect(advanceBeaconClock(100, Number.NaN)).toBe(100);
    expect(advanceBeaconClock(Number.NaN, 10)).toBe(10);
  });
});
