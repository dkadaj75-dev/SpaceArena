import { describe, expect, it } from "vitest";
import { COUNT_UP_DURATION_MS, countUpDone, countUpValue, easeOutCubic } from "./countUp.js";

describe("easeOutCubic", () => {
  it("pins the endpoints", () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
  });

  it("clamps out-of-range inputs", () => {
    expect(easeOutCubic(-2)).toBe(0);
    expect(easeOutCubic(4)).toBe(1);
    expect(easeOutCubic(Number.NaN)).toBe(0);
  });

  it("front-loads the motion (that is what makes it read as a count-up)", () => {
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5);
    expect(easeOutCubic(0.25)).toBeCloseTo(0.578, 3);
  });

  it("is monotonically increasing", () => {
    let previous = -1;
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const value = easeOutCubic(t);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });
});

describe("countUpValue", () => {
  it("starts at zero and lands exactly on the target", () => {
    expect(countUpValue(250, 0)).toBe(0);
    expect(countUpValue(250, COUNT_UP_DURATION_MS)).toBe(250);
    expect(countUpValue(250, COUNT_UP_DURATION_MS * 10)).toBe(250);
  });

  it("never overshoots along the way", () => {
    for (let t = 0; t <= COUNT_UP_DURATION_MS; t += 25) {
      const value = countUpValue(137, t);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(137);
    }
  });

  it("is monotonic across the sweep", () => {
    let previous = -1;
    for (let t = 0; t <= COUNT_UP_DURATION_MS; t += 17) {
      const value = countUpValue(1000, t);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });

  it("returns integers only", () => {
    for (let t = 0; t <= COUNT_UP_DURATION_MS; t += 60) {
      expect(Number.isInteger(countUpValue(999, t))).toBe(true);
    }
  });

  it("skips the animation for a zero/negative duration", () => {
    expect(countUpValue(42, 0, 0)).toBe(42);
    expect(countUpValue(42, 0, -100)).toBe(42);
  });

  it("handles a zero reward and non-finite input", () => {
    expect(countUpValue(0, 0)).toBe(0);
    expect(countUpValue(0, COUNT_UP_DURATION_MS)).toBe(0);
    expect(countUpValue(Number.NaN, 10)).toBe(0);
    expect(countUpValue(10, Number.NaN)).toBe(10);
  });

  it("sweeps downward for a negative target without overshooting", () => {
    expect(countUpValue(-100, 0)).toBe(0);
    expect(countUpValue(-100, COUNT_UP_DURATION_MS / 2)).toBeGreaterThanOrEqual(-100);
    expect(countUpValue(-100, COUNT_UP_DURATION_MS)).toBe(-100);
  });
});

describe("countUpDone", () => {
  it("reports completion at (and after) the duration", () => {
    expect(countUpDone(0)).toBe(false);
    expect(countUpDone(COUNT_UP_DURATION_MS - 1)).toBe(false);
    expect(countUpDone(COUNT_UP_DURATION_MS)).toBe(true);
    expect(countUpDone(0, 0)).toBe(true);
  });
});
