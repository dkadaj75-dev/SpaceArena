import { NullEngine, ParticleSystem, Scene, TransformNode } from "@babylonjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EffectConfig } from "@space-arena/shared";
import { ExplosionFx, closeRangeFlashScale } from "./ExplosionFx.js";
import { DEFAULT_JUICE_SETTINGS } from "./juiceSettings.js";

const engines: NullEngine[] = [];
const effect: EffectConfig = {
  id: "fx.test", type: "effect", version: 1, name: "test",
  base: { capacity: 80, emitRate: 0, lifeMin: 0.2, lifeMax: 0.7, sizeMin: 0.4, sizeMax: 1.2, speedMin: 5, speedMax: 12, color1: "#fff0b0", color2: "#ff421a" },
  params: [],
};
const high = { enabled: true, budgetMultiplier: 1, maxEmitterCapacity: 80 };
/** Mirrors the module's fixed slot count; the pool is asserted against it below. */
const POOL_SIZE = 6;

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

  it("scales the physical burst per call so a warhead cannot read as a hull death", () => {
    const fx = makeFx();
    const slot = engines.at(-1)!.scenes[0]!.getTransformNodeByName("fx.explosion.slot.0")!;

    fx.burst(effect, 0, 0, 0, undefined, 0.45);
    expect(slot.scaling.x).toBeCloseTo(0.45, 5);

    // Slots are recycled: an unscaled burst must clear the previous caller's scale.
    for (let i = 0; i < POOL_SIZE + 1; i++) fx.burst(effect, i, 0);
    expect(slot.scaling.x).toBeCloseTo(1, 5);
    fx.dispose();
  });

  /**
   * Playtest finding 8: "death explosions white out the screen; a full-screen
   * orange fireball that swamps the HUD". The flash is a world-space sphere
   * ~3.6 units across at 0.95 alpha — from chase distance a bright ball, at
   * contact range something the camera is INSIDE.
   */
  it("fades a burst the camera is inside, and leaves a distant one alone", () => {
    // Well clear: the authored effect, untouched.
    expect(closeRangeFlashScale(30, 1.8)).toBe(1);
    expect(closeRangeFlashScale(12, 1.8)).toBe(1);
    // On the sphere's surface, and inside it: nothing to see.
    expect(closeRangeFlashScale(1.8, 1.8)).toBe(0);
    expect(closeRangeFlashScale(0, 1.8)).toBe(0);
    // Between the two it ramps rather than popping.
    const near = closeRangeFlashScale(3, 1.8);
    expect(near).toBeGreaterThan(0);
    expect(near).toBeLessThan(1);
    expect(closeRangeFlashScale(4.5, 1.8)).toBeGreaterThan(near);
    // A missing camera (headless, teardown) reads as "far away" — never as a
    // reason to gate an effect off.
    expect(closeRangeFlashScale(Number.POSITIVE_INFINITY, 1.8)).toBe(1);
    expect(closeRangeFlashScale(10, 0)).toBe(1);
  });

  it("keeps the flash under full opacity even at its peak", () => {
    const fx = makeFx();
    fx.burst(effect, 0, 0, 0);
    fx.update(1);
    const scene = (fx as unknown as { scene: Scene }).scene;
    const flash = scene.getMeshByName("fx.explosion.flash.0");
    // No camera in a NullEngine scene, so the proximity ramp is 1 here and this
    // is the peak the effect is authored to reach.
    expect(flash?.material?.alpha).toBeGreaterThan(0.4);
    expect(flash?.material?.alpha).toBeLessThan(0.8);
    fx.dispose();
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
