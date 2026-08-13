import { NullEngine, ParticleSystem, Scene, TransformNode } from "@babylonjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EffectConfig } from "@space-arena/shared";
import { ExplosionFx } from "./ExplosionFx.js";
import { DEFAULT_JUICE_SETTINGS } from "./juiceSettings.js";

const engines: NullEngine[] = [];
const effect: EffectConfig = {
  id: "fx.test", type: "effect", version: 1, name: "test",
  base: { capacity: 80, emitRate: 0, lifeMin: 0.2, lifeMax: 0.7, sizeMin: 0.4, sizeMax: 1.2, speedMin: 5, speedMax: 12, color1: "#fff0b0", color2: "#ff421a" },
  params: [],
};
const high = { enabled: true, budgetMultiplier: 1, maxEmitterCapacity: 80 };

afterEach(() => { for (const engine of engines.splice(0)) engine.dispose(); });

function makeFx(quality = high): ExplosionFx {
  const engine = new NullEngine(); engines.push(engine);
  const scene = new Scene(engine);
  return new ExplosionFx(scene, DEFAULT_JUICE_SETTINGS.explosions, quality, new TransformNode("root", scene));
}

describe("ExplosionFx lifecycle pool", () => {
  it("keeps debris alive for five seconds, fades it for three, then releases the slot", () => {
    const fx = makeFx();
    fx.burst(effect, 1, 2, 3);
    expect(fx.activeCount).toBe(1);
    fx.update(5_000);
    expect(fx.activeCount).toBe(1);
    fx.update(2_999);
    expect(fx.activeCount).toBe(1);
    fx.update(1);
    expect(fx.activeCount).toBe(0);
    fx.dispose();
  });

  it("recycles the oldest fixed slot instead of growing under repeated kills", () => {
    const fx = makeFx();
    for (let i = 0; i < 30; i++) fx.burst(effect, i, 0);
    expect(fx.poolSize).toBe(6);
    expect(fx.activeCount).toBe(6);
    fx.dispose();
  });

  it("scales burst budget and omits particle work when particles are disabled", () => {
    const low = makeFx({ enabled: true, budgetMultiplier: 0.35, maxEmitterCapacity: 40 });
    expect(low.burstCountFor(effect)).toBeLessThan(makeFx().burstCountFor(effect));
    low.dispose();
    const off = makeFx({ enabled: false, budgetMultiplier: 0, maxEmitterCapacity: 0 });
    expect(off.burst(effect, 0, 0)).toBe(false);
    expect(off.activeCount).toBe(1); // flash + cheap hull shards still communicate the kill.
    off.dispose();
  });

  it("never disposes the scene-shared particle sprite while rebuilding or releasing the pool", () => {
    const dispose = vi.spyOn(ParticleSystem.prototype, "dispose");
    const fx = makeFx();
    fx.setQuality({ enabled: true, budgetMultiplier: 0.6, maxEmitterCapacity: 60 });
    fx.dispose();
    expect(dispose).toHaveBeenCalled();
    expect(dispose.mock.calls.every(([disposeTexture]) => disposeTexture === false)).toBe(true);
    dispose.mockRestore();
  });
});
