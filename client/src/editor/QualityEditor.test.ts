import { describe, expect, it, vi } from "vitest";
import { qualitySchema, type ConfigService, type QualityConfig, type QualityTier } from "@space-arena/shared";
import type { EditorHost } from "./EditorShell.js";
import { QualityEditor } from "./QualityEditor.js";

function tier(name: QualityTier): QualityConfig {
  return qualitySchema.parse({
    id: `quality.${name}`,
    type: "quality",
    version: 1,
    name,
    tier: name,
    probe: { minCores: 0, minMemoryGb: 0, allowMobile: true },
    autoTier: { sampleAfterMs: 1000, sampleWindowMs: 2000, demoteBelowFps: 20, promoteAboveFps: 50 },
    render: { hardwareScalingMultiplier: 1, maxDevicePixelRatio: 2, freezeStatics: true },
    glow: { enabled: true, intensity: 0.4 },
    particles: { enabled: true, budgetMultiplier: 1, maxEmitterCapacity: 80 },
    asteroids: { lodMediumDistance: 100, lodLowDistance: 200, lodCullDistance: 600, thinInstances: false },
    projectiles: { useInstances: true },
    scene: {
      skyboxEnabled: true,
      boundaryShieldShader: true,
      starfieldPoints: 300,
      spawnMarkers: true,
    },
  });
}

describe("QualityEditor", () => {
  it("edits every tier's LOD and scene knobs through ConfigService.replace", () => {
    const configs = [tier("low"), tier("med"), tier("high"), tier("ultra")];
    const replace = vi.fn(() => ({ ok: true as const, errors: [] }));
    const configService = {
      getAll: vi.fn((type: string) => (type === "quality" ? configs : [])),
      replace,
    } as unknown as ConfigService;
    const panel = new QualityEditor({ configService } as unknown as EditorHost, vi.fn());

    expect(panel.element.querySelectorAll('input[name="asteroids.lodMediumDistance"]')).toHaveLength(4);
    expect(panel.element.querySelectorAll('input[name="asteroids.lodLowDistance"]')).toHaveLength(4);
    expect(panel.element.querySelectorAll('input[name="asteroids.lodCullDistance"]')).toHaveLength(4);
    expect(panel.element.querySelectorAll('input[name="scene.skyboxEnabled"]')).toHaveLength(4);
    expect(panel.element.querySelectorAll('input[name="scene.boundaryShieldShader"]')).toHaveLength(4);

    const lowMedium = panel.element.querySelector<HTMLInputElement>(
      'input[name="asteroids.lodMediumDistance"]',
    )!;
    lowMedium.value = "160";
    lowMedium.dispatchEvent(new Event("change"));

    expect(replace).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "quality.low",
        asteroids: expect.objectContaining({ lodMediumDistance: 160 }),
      }),
    );
  });
});
