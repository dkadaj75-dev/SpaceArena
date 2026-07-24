import { describe, expect, it } from "vitest";
import type { EffectBase } from "@space-arena/shared";
import { applyParticleParam, resetParticleParamWarnings, type ParticleParamTarget } from "./particleParams.js";

function target(): ParticleParamTarget {
  return {
    emitRate: 0,
    minLifeTime: 0,
    maxLifeTime: 0,
    minSize: 0,
    maxSize: 0,
    minEmitPower: 0,
    maxEmitPower: 0,
  };
}

const base: EffectBase = {
  capacity: 200,
  emitRate: 0,
  lifeMin: 0.15,
  lifeMax: 0.4,
  sizeMin: 0.15,
  sizeMax: 0.4,
  speedMin: 4,
  speedMax: 8,
  color1: "#57d8ff",
  color2: "#2f6fb8",
};

describe("applyParticleParam", () => {
  it("maps emitRate straight through, clamped to non-negative", () => {
    const t = target();
    applyParticleParam(t, base, "emitRate", 120, () => {});
    expect(t.emitRate).toBe(120);
    applyParticleParam(t, base, "emitRate", -5, () => {});
    expect(t.emitRate).toBe(0);
  });

  it("maps lifeMin/lifeMax to minLifeTime/maxLifeTime", () => {
    const t = target();
    applyParticleParam(t, base, "lifeMin", 0.2, () => {});
    applyParticleParam(t, base, "lifeMax", 0.9, () => {});
    expect(t.minLifeTime).toBe(0.2);
    expect(t.maxLifeTime).toBe(0.9);
  });

  it("maps sizeMin/sizeMax to minSize/maxSize", () => {
    const t = target();
    applyParticleParam(t, base, "sizeMin", 0.3, () => {});
    applyParticleParam(t, base, "sizeMax", 1.1, () => {});
    expect(t.minSize).toBe(0.3);
    expect(t.maxSize).toBe(1.1);
  });

  it("maps speedMin/speedMax to minEmitPower/maxEmitPower", () => {
    const t = target();
    applyParticleParam(t, base, "speedMin", 6, () => {});
    applyParticleParam(t, base, "speedMax", 16, () => {});
    expect(t.minEmitPower).toBe(6);
    expect(t.maxEmitPower).toBe(16);
  });

  it("scales the base speed band multiplicatively for 'power'", () => {
    const t = target();
    applyParticleParam(t, base, "power", 2, () => {});
    expect(t.minEmitPower).toBe(base.speedMin * 2);
    expect(t.maxEmitPower).toBe(base.speedMax * 2);
  });

  it("warns exactly once per unknown param and does not mutate the target", () => {
    resetParticleParamWarnings();
    const t = target();
    const warnings: string[] = [];
    applyParticleParam(t, base, "bogusParam", 42, (m) => warnings.push(m));
    applyParticleParam(t, base, "bogusParam", 99, (m) => warnings.push(m));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("bogusParam");
    expect(t).toEqual(target());
  });
});
