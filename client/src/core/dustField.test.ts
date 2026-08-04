import { describe, expect, it } from "vitest";
import { DEFAULT_DUST, resolveDustParams, type DustQuality } from "./dustField.js";

/** The shipped tiers, as authored in `content/quality/*.json`. */
const SHIPPED: Record<string, NonNullable<DustQuality>> = {
  low: { count: 0, size: 0.35, alpha: 0.3, driftSpeed: 0.8, boxSize: 120 },
  med: { count: 180, size: 0.35, alpha: 0.3, driftSpeed: 0.8, boxSize: 120 },
  high: { count: 340, size: 0.4, alpha: 0.34, driftSpeed: 1.0, boxSize: 120 },
  ultra: { count: 560, size: 0.45, alpha: 0.38, driftSpeed: 1.2, boxSize: 140 },
};

describe("resolveDustParams", () => {
  it("disables dust on the shipped low tier", () => {
    // Alpha-blended sprites are pure overdraw, which is the budget a phone at the
    // cheapest tier has least of — low turns them off outright.
    expect(resolveDustParams(SHIPPED["low"])).toBeNull();
  });

  it("derives the emit box, lifetime band and rate from the authored knobs", () => {
    const params = resolveDustParams(SHIPPED["med"])!;
    expect(params).not.toBeNull();
    expect(params.count).toBe(180);
    expect(params.halfExtent).toBe(60);
    // Lifetime tracks one box-crossing either side, so the field neither churns
    // nor trails motes the box has left behind.
    expect(params.minLifeTime).toBeCloseTo(3, 6);
    expect(params.maxLifeTime).toBeCloseTo(6, 6);
    // Steady-state population = emitRate × mean lifetime, back to the authored count.
    expect(params.emitRate * ((params.minLifeTime + params.maxLifeTime) / 2)).toBeCloseTo(180, 6);
  });

  it("scales the box with the authored boxSize", () => {
    const params = resolveDustParams({ ...SHIPPED["med"]!, boxSize: 60 })!;
    expect(params.halfExtent).toBe(30);
    expect(params.minLifeTime).toBeCloseTo(1.5, 6);
    expect(params.maxLifeTime).toBeCloseTo(3, 6);
  });

  it("carries the high tier's denser, brighter authoring through", () => {
    const params = resolveDustParams(SHIPPED["high"])!;
    expect(params.count).toBe(340);
    expect(params.size).toBeCloseTo(0.4, 6);
    expect(params.alpha).toBeCloseTo(0.34, 6);
    expect(params.driftSpeed).toBeCloseTo(1, 6);
  });

  it("falls back to the documented default for a pack that predates the block", () => {
    const params = resolveDustParams(undefined)!;
    expect(params.count).toBe(DEFAULT_DUST.count);
    expect(params.halfExtent).toBe(DEFAULT_DUST.boxSize / 2);
  });

  it("clamps hostile values rather than handing Babylon a NaN", () => {
    expect(resolveDustParams({ ...SHIPPED["med"]!, count: Number.NaN })).toBeNull();
    expect(resolveDustParams({ ...SHIPPED["med"]!, count: -5 })).toBeNull();
    // Fractional counts floor to a whole particle capacity.
    expect(resolveDustParams({ ...SHIPPED["med"]!, count: 12.9 })!.count).toBe(12);
    expect(resolveDustParams({ ...SHIPPED["med"]!, alpha: 4 })!.alpha).toBe(1);
    expect(resolveDustParams({ ...SHIPPED["med"]!, alpha: -1 })!.alpha).toBe(0);
    expect(resolveDustParams({ ...SHIPPED["med"]!, driftSpeed: -3 })!.driftSpeed).toBe(0);
    expect(resolveDustParams({ ...SHIPPED["med"]!, boxSize: 0 })!.halfExtent).toBe(
      DEFAULT_DUST.boxSize / 2,
    );
  });
});
