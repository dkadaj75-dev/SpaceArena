import { NullEngine, ParticleSystem, Scene } from "@babylonjs/core";
import { afterEach, describe, expect, it } from "vitest";
import type { EffectConfig } from "@space-arena/shared";
import { getParticleTexture } from "../particleTexture.js";
import { SparkFx } from "./SparkFx.js";

const engines: NullEngine[] = [];
const high = { enabled: true, budgetMultiplier: 1, maxEmitterCapacity: 80 };

/** Mirrors the module's fixed ring size; the pool is asserted against it below. */
const POOL_SIZE = 12;

function effect(over: Partial<EffectConfig["base"]> = {}): EffectConfig {
  return {
    id: "fx.test-spark",
    type: "effect",
    version: 1,
    name: "test spark",
    base: {
      capacity: 30,
      emitRate: 0,
      lifeMin: 0.1,
      lifeMax: 0.3,
      sizeMin: 0.1,
      sizeMax: 0.3,
      speedMin: 5,
      speedMax: 12,
      color1: "#ffcc00",
      color2: "#ff3300",
      direction: [0.5, 0.5, 0.5],
      ...over,
    },
    params: [],
  };
}

afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose();
});

function makeFx(quality = high): { fx: SparkFx; scene: Scene } {
  const engine = new NullEngine();
  engines.push(engine);
  const scene = new Scene(engine);
  return { fx: new SparkFx(scene, quality), scene };
}

describe("SparkFx pool", () => {
  it("emits at the point it was given and frees the slot when the burst is over", () => {
    const { fx, scene } = makeFx();
    expect(fx.burst(effect(), 3, 4, 5, 0, 1, 0)).toBe(true);
    expect(fx.activeCount).toBe(1);

    const system = scene.particleSystems[0] as ParticleSystem;
    const emitter = system.emitter as { x: number; y: number; z: number };
    expect(emitter.x).toBeCloseTo(3, 5);
    expect(emitter.y).toBeCloseTo(4, 5);
    expect(emitter.z).toBeCloseTo(5, 5);

    fx.update(299); // lifeMax is 0.3s; the slot also carries a short tail
    expect(fx.activeCount).toBe(1);
    fx.update(200);
    expect(fx.activeCount).toBe(0);

    fx.dispose();
  });

  it("recycles the fixed ring instead of growing under sustained fire", () => {
    const { fx } = makeFx();
    for (let i = 0; i < 40; i++) fx.burst(effect(), i, 0, 0, 1, 0, 0);
    expect(fx.poolSize).toBe(POOL_SIZE);
    expect(fx.activeCount).toBe(POOL_SIZE);
    fx.dispose();
  });

  it("aims the spray along the axis it is handed, widened by the effect's own cone", () => {
    const { fx, scene } = makeFx();
    // Straight down +X, with a narrow authored cone.
    fx.burst(effect({ direction: [0.2, 0.2, 0.2] }), 0, 0, 0, 1, 0, 0);
    const system = scene.particleSystems[0] as ParticleSystem;
    expect(system.direction1.x).toBeCloseTo(0.8, 5);
    expect(system.direction2.x).toBeCloseTo(1.2, 5);
    expect(system.direction1.y).toBeCloseTo(-0.2, 5);
    expect(system.direction2.y).toBeCloseTo(0.2, 5);
    fx.dispose();
  });

  it("takes colour, size and lifetime straight from the effect config", () => {
    const { fx, scene } = makeFx();
    fx.burst(effect({ color1: "#ff8000", lifeMin: 0.2, lifeMax: 0.4, sizeMax: 0.9 }), 0, 0, 0, 0, 1, 0);
    const system = scene.particleSystems[0] as ParticleSystem;
    expect(system.color1.r).toBeCloseTo(1, 5);
    expect(system.color1.g).toBeCloseTo(128 / 255, 5);
    expect(system.color1.b).toBeCloseTo(0, 5);
    expect(system.minLifeTime).toBeCloseTo(0.2, 5);
    expect(system.maxLifeTime).toBeCloseTo(0.4, 5);
    expect(system.maxSize).toBeCloseTo(0.9, 5);
    fx.dispose();
  });

  it("scales the burst with the quality tier and draws nothing with particles off", () => {
    const { fx: low } = makeFx({ enabled: true, budgetMultiplier: 0.35, maxEmitterCapacity: 40 });
    const { fx: full } = makeFx();
    expect(low.burstCountFor(effect())).toBeLessThan(full.burstCountFor(effect()));
    low.dispose();
    full.dispose();

    const { fx: off, scene } = makeFx({ enabled: false, budgetMultiplier: 0, maxEmitterCapacity: 0 });
    expect(off.burst(effect(), 0, 0, 0, 0, 1, 0)).toBe(false);
    expect(off.activeCount).toBe(0);
    // A spark IS its particles: with them off there is nothing left to build.
    expect(scene.particleSystems.length).toBe(0);
    off.dispose();
  });

  it("keeps the scene-shared particle sprite alive when it is disposed", () => {
    const { fx, scene } = makeFx();
    fx.burst(effect(), 0, 0, 0, 0, 1, 0);
    const texture = (scene.particleSystems[0] as ParticleSystem).particleTexture!;
    fx.dispose();
    // Ship thrusters and the explosion pool draw from this very texture; taking
    // it down with the spark ring would poison every one of them.
    expect(scene.textures).toContain(texture);
    expect(getParticleTexture(scene)).toBe(texture);
  });
});
