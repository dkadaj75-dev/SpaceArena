import { describe, expect, it, vi } from "vitest";
import {
  ConfigService,
  EventBus,
  qualitySchema,
  type ConfigEvents,
  type QualityConfig,
} from "@space-arena/shared";
import { QualityManager } from "./QualityManager.js";

function quality(): QualityConfig {
  return qualitySchema.parse({
    id: "quality.low",
    type: "quality",
    version: 1,
    tier: "low",
    probe: { minCores: 0, minMemoryGb: 0, allowMobile: true },
    autoTier: { sampleAfterMs: 1000, sampleWindowMs: 2000, demoteBelowFps: 0, promoteAboveFps: 0 },
    render: { hardwareScalingMultiplier: 1.33, maxDevicePixelRatio: 1.5, freezeStatics: true },
    glow: { enabled: false, intensity: 0 },
    particles: { enabled: true, budgetMultiplier: 0.35, maxEmitterCapacity: 40 },
    asteroids: {
      lodMediumDistance: 95,
      lodLowDistance: 220,
      lodCullDistance: 600,
      proceduralOnly: true,
      thinInstances: false,
    },
    projectiles: { useInstances: true },
    scene: {
      skyboxEnabled: true,
      boundaryShieldShader: false,
      starfieldPoints: 150,
      spawnMarkers: true,
    },
  });
}

describe("QualityManager hot reload", () => {
  it("re-emits the live tier when its designer config changes", () => {
    const bus = new EventBus<ConfigEvents>();
    const configs = new ConfigService(() => Promise.resolve(null), bus);
    const initial = quality();
    expect(configs.replace(initial).ok).toBe(true);
    const engine = { setHardwareScalingLevel: vi.fn() };
    const manager = new QualityManager(configs, engine, { bus, storage: null });
    const changed = vi.fn();
    manager.onChange(changed);

    expect(
      configs.replace({
        ...initial,
        asteroids: { ...initial.asteroids, lodMediumDistance: 160 },
      }).ok,
    ).toBe(true);

    expect(changed).toHaveBeenCalledWith(
      expect.objectContaining({
        asteroids: expect.objectContaining({ lodMediumDistance: 160 }),
      }),
    );
    manager.dispose();
  });
});
