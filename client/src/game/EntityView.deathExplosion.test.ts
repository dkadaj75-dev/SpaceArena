import { NullEngine, Scene } from "@babylonjs/core";
import { describe, expect, it, vi } from "vitest";
import type { ConfigService, EffectConfig, Snapshot } from "@space-arena/shared";
import { ViewManager } from "./EntityView.js";
import { DEFAULT_JUICE_SETTINGS } from "./juice/juiceSettings.js";

const effect: EffectConfig = {
  id: "fx.death-test",
  type: "effect",
  version: 1,
  name: "death test",
  base: {
    capacity: 10,
    emitRate: 0,
    lifeMin: 0.1,
    lifeMax: 0.3,
    sizeMin: 0.2,
    sizeMax: 0.7,
    speedMin: 2,
    speedMax: 5,
    color1: "#ffffff",
    color2: "#ff4400",
  },
  params: [],
  sound: "[SOUND: explosion_test]",
};

const emptySnapshot: Snapshot = {
  tick: 2,
  elapsed: 1,
  phase: "live",
  countdownRemaining: 0,
  teamScores: [],
  winnerTeam: null,
  ships: [],
  asteroids: [],
  projectiles: [],
  decoys: [],
  flags: [],
};

describe("EntityView death explosion", () => {
  it("spawns at the event death point after the entity and its snapshot are gone", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const configs = {
      get: (type: string, id: string) => type === "effect" && id === effect.id ? effect : undefined,
      getAll: (type: string) => type === "tuning" ? [{ projectilePoolSize: 1, beamFadeMs: 120 }] : [],
    } as unknown as ConfigService;
    const playSound = vi.fn();
    const view = new ViewManager(
      scene,
      configs,
      () => undefined,
      {
        projectiles: { useInstances: true },
        particles: { enabled: false, budgetMultiplier: 0, maxEmitterCapacity: 0 },
        asteroids: { lodMediumDistance: 0, lodLowDistance: 0, lodCullDistance: 0, thinInstances: false },
      },
      {
        juice: {
          ...DEFAULT_JUICE_SETTINGS,
          explosions: { ...DEFAULT_JUICE_SETTINGS.explosions, defaultEffect: effect.id },
        },
        playSound,
        playerId: 42,
      },
    );

    view.consumeEvents([{
      type: "entityDestroyed",
      entityId: 42,
      killerId: 7,
      isAsteroid: false,
      pos: { x: 12, y: -4, z: 9 },
    }], emptySnapshot);

    expect(view.explosionFx.activeCount).toBe(1);
    expect(scene.getTransformNodeByName("fx.explosion.slot.0")!.position.asArray()).toEqual([12, -4, 9]);
    expect(playSound).toHaveBeenCalledWith("explosion_test");

    view.dispose();
    scene.dispose();
    engine.dispose();
  });
});
