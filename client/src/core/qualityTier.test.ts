import { describe, expect, it } from "vitest";
import { qualitySchema, type QualityConfig, type QualityTier } from "@space-arena/shared";
import {
  newAutoTierState,
  isSafari,
  parseStoredTier,
  probeDevice,
  probePasses,
  resolveStartTier,
  sampleAutoTier,
  selectInitialTier,
  sortTiers,
  stepTier,
  tierConfig,
} from "./qualityTier.js";

/** Builds a schema-valid tier config so the tests exercise the real shape. */
function tier(
  name: QualityTier,
  overrides: Partial<{
    probe: QualityConfig["probe"];
    autoTier: QualityConfig["autoTier"];
  }> = {},
): QualityConfig {
  return qualitySchema.parse({
    id: `quality.${name}`,
    type: "quality",
    version: 1,
    tier: name,
    probe: overrides.probe ?? { minCores: 0, minMemoryGb: 0, allowMobile: true },
    autoTier: overrides.autoTier ?? {
      sampleAfterMs: 5000,
      sampleWindowMs: 3000,
      demoteBelowFps: 26,
      promoteAboveFps: 56,
    },
    render: { hardwareScalingMultiplier: 1, maxDevicePixelRatio: 2, freezeStatics: true },
    glow: { enabled: true, intensity: 0.5 },
    particles: { enabled: true, budgetMultiplier: 1, maxEmitterCapacity: 80 },
    asteroids: { lodMediumDistance: 60, lodLowDistance: 100, lodCullDistance: 0, thinInstances: false },
    projectiles: { useInstances: true },
    scene: {
      skyboxEnabled: true,
      boundaryShieldShader: true,
      starfieldPoints: 400,
      spawnMarkers: true,
    },
  });
}

const LOW = tier("low", { probe: { minCores: 0, minMemoryGb: 0, allowMobile: true } });
const MED = tier("med", { probe: { minCores: 4, minMemoryGb: 3, allowMobile: true } });
const HIGH = tier("high", { probe: { minCores: 8, minMemoryGb: 8, allowMobile: false } });
const ULTRA = tier("ultra", { probe: { minCores: 8, minMemoryGb: 8, allowMobile: true } });
const TIERS = [ULTRA, HIGH, LOW, MED]; // deliberately unsorted

describe("quality terrain defaults", () => {
  it("keeps the block optional and defaults fields when it is authored", () => {
    expect(LOW.scene.terrain).toBeUndefined();
    const parsed = qualitySchema.parse({ ...LOW, scene: { ...LOW.scene, terrain: {} } });
    expect(parsed.scene.terrain).toEqual({ enabled: true, lodBias: 1 });
    expect(() => qualitySchema.parse({ ...LOW, scene: { ...LOW.scene, terrain: { lodBias: 0 } } })).toThrow();
  });
});

describe("probeDevice", () => {
  it("reads cores, memory and the Chromium mobile hint", () => {
    expect(
      probeDevice({ hardwareConcurrency: 8, deviceMemory: 8, userAgentData: { mobile: true } }),
    ).toEqual({ cores: 8, memoryGb: 8, mobile: true });
  });

  it("falls back to the UA string when userAgentData is absent", () => {
    const probe = probeDevice({
      hardwareConcurrency: 8,
      userAgent: "Mozilla/5.0 (Linux; Android 13; Pixel 6) AppleWebKit/537.36",
    });
    expect(probe.mobile).toBe(true);
    expect(probe.memoryGb).toBeNull();
  });

  it("treats a touch-capable Macintosh UA as mobile (iPadOS desktop mode)", () => {
    expect(probeDevice({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X)", maxTouchPoints: 5 }).mobile).toBe(true);
    expect(probeDevice({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X)", maxTouchPoints: 0 }).mobile).toBe(false);
  });

  it("zeroes cores and nulls memory for missing/absurd values instead of guessing", () => {
    expect(probeDevice(undefined)).toEqual({ cores: 0, memoryGb: null, mobile: false });
    expect(probeDevice({ hardwareConcurrency: 0, deviceMemory: Number.NaN })).toEqual({
      cores: 0,
      memoryGb: null,
      mobile: false,
    });
  });
});

describe("isSafari", () => {
  it("recognises macOS and iPadOS Safari but excludes other browsers", () => {
    expect(isSafari({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Version/17.0 Safari/605.1.15" })).toBe(true);
    expect(isSafari({ userAgent: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) Version/17.0 Mobile/15E148 Safari/604.1" })).toBe(true);
    expect(isSafari({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) CriOS/120.0 Mobile/15E148 Safari/604.1" })).toBe(false);
  });
});

describe("sortTiers / tierConfig / stepTier", () => {
  it("orders cheapest → best regardless of pack order", () => {
    expect(sortTiers(TIERS).map((t) => t.tier)).toEqual(["low", "med", "high", "ultra"]);
  });

  it("looks a tier up by name", () => {
    expect(tierConfig(TIERS, "med")).toBe(MED);
    expect(tierConfig([LOW], "high")).toBeUndefined();
  });

  it("steps one rung and clamps at both ends", () => {
    expect(stepTier(TIERS, "med", 1)).toBe("high");
    expect(stepTier(TIERS, "med", -1)).toBe("low");
    expect(stepTier(TIERS, "high", 1)).toBe("ultra");
    expect(stepTier(TIERS, "ultra", 1)).toBe("ultra");
    expect(stepTier(TIERS, "low", -1)).toBe("low");
  });

  it("skips missing rungs so a two-tier pack still steps", () => {
    expect(stepTier([LOW, HIGH], "low", 1)).toBe("high");
  });
});

describe("probePasses", () => {
  it("rejects a tier that forbids mobile on a mobile device", () => {
    expect(probePasses(HIGH, { cores: 16, memoryGb: 16, mobile: true })).toBe(false);
    expect(probePasses(HIGH, { cores: 16, memoryGb: 16, mobile: false })).toBe(true);
  });

  it("enforces core and memory floors, ignoring floors set to 0", () => {
    expect(probePasses(MED, { cores: 2, memoryGb: 8, mobile: true })).toBe(false);
    expect(probePasses(MED, { cores: 8, memoryGb: 2, mobile: true })).toBe(false);
    expect(probePasses(MED, { cores: 4, memoryGb: 3, mobile: true })).toBe(true);
    expect(probePasses(LOW, { cores: 0, memoryGb: 0, mobile: true })).toBe(true);
  });

  it("skips memory floors when the browser never reports deviceMemory (Safari/Firefox)", () => {
    expect(probePasses(MED, { cores: 8, memoryGb: null, mobile: true })).toBe(true);
    expect(probePasses(HIGH, { cores: 8, memoryGb: null, mobile: false })).toBe(true);
    // Cores are still enforced against an unknown memory reading.
    expect(probePasses(MED, { cores: 2, memoryGb: null, mobile: true })).toBe(false);
  });
});

describe("selectInitialTier", () => {
  it("picks ultra on a capable desktop", () => {
    expect(selectInitialTier(TIERS, { cores: 12, memoryGb: 16, mobile: false })).toBe("ultra");
  });

  it("allows a flagship phone to reach ultra", () => {
    expect(selectInitialTier(TIERS, { cores: 8, memoryGb: 8, mobile: true })).toBe("ultra");
  });

  it("picks med on a mid-range phone", () => {
    expect(selectInitialTier(TIERS, { cores: 6, memoryGb: 4, mobile: true })).toBe("med");
  });

  it("picks med on an iPhone that reports cores but no deviceMemory", () => {
    expect(selectInitialTier(TIERS, { cores: 6, memoryGb: null, mobile: true })).toBe("med");
  });

  it("falls back to low on a budget phone and on an unknown device", () => {
    expect(selectInitialTier(TIERS, { cores: 4, memoryGb: 2, mobile: true })).toBe("low");
    expect(selectInitialTier(TIERS, { cores: 0, memoryGb: 0, mobile: false })).toBe("low");
  });

  it("returns low when the pack ships no quality configs", () => {
    expect(selectInitialTier([], { cores: 16, memoryGb: 32, mobile: false })).toBe("low");
  });
});

describe("parseStoredTier / resolveStartTier", () => {
  it("accepts known tier names case-insensitively and rejects anything else", () => {
    expect(parseStoredTier("HIGH")).toBe("high");
    expect(parseStoredTier(" med ")).toBe("med");
    expect(parseStoredTier("ultra")).toBe("ultra");
    expect(parseStoredTier(null)).toBeNull();
    expect(parseStoredTier("")).toBeNull();
  });

  it("lets a stored override beat the probe", () => {
    expect(resolveStartTier(TIERS, { cores: 0, memoryGb: 0, mobile: true }, "high")).toEqual({
      tier: "high",
      fromOverride: true,
    });
  });

  it("ignores an override the pack has no config for", () => {
    expect(resolveStartTier([LOW, MED], { cores: 6, memoryGb: 4, mobile: true }, "high")).toEqual({
      tier: "med",
      fromOverride: false,
    });
  });

  it("uses the probe when nothing is stored", () => {
    expect(resolveStartTier(TIERS, { cores: 12, memoryGb: 16, mobile: false }, null)).toEqual({
      tier: "ultra",
      fromOverride: false,
    });
  });

  it("uses Safari's ultra default only with no stored choice", () => {
    expect(resolveStartTier(TIERS, { cores: 0, memoryGb: 0, mobile: true }, null, true)).toEqual({
      tier: "ultra",
      fromOverride: false,
    });
    expect(resolveStartTier(TIERS, { cores: 0, memoryGb: 0, mobile: true }, "low", true)).toEqual({
      tier: "low",
      fromOverride: true,
    });
  });
});

describe("sampleAutoTier", () => {
  /** Drives `frames` frames of `fps` at 16 ms each, returning the first change. */
  function run(config: QualityConfig, fps: number, frames = 800) {
    const state = newAutoTierState();
    for (let i = 0; i < frames; i++) {
      const result = sampleAutoTier(state, config, TIERS, fps, 16);
      if (result.tier) return { result, state };
    }
    return { result: { tier: null, averageFps: null }, state };
  }

  it("does nothing during the warm-up window", () => {
    const state = newAutoTierState();
    for (let i = 0; i < 100; i++) {
      // 100 × 16 ms = 1.6 s, well inside the 5 s warm-up
      expect(sampleAutoTier(state, MED, TIERS, 5, 16).tier).toBeNull();
    }
    expect(state.sampleFrames).toBe(0);
    expect(state.adjusted).toBe(false);
  });

  it("demotes after the window when the average is below the floor", () => {
    const { result } = run(MED, 18);
    expect(result.tier).toBe("low");
    expect(result.averageFps).toBeCloseTo(18, 5);
  });

  it("promotes after the window when the average is above the ceiling", () => {
    const { result } = run(MED, 60);
    expect(result.tier).toBe("high");
  });

  it("stays put inside the hysteresis band", () => {
    const { result, state } = run(MED, 40);
    expect(result.tier).toBeNull();
    expect(state.adjusted).toBe(true);
  });

  it("adjusts at most once per match", () => {
    const state = newAutoTierState();
    let changes = 0;
    for (let i = 0; i < 4000; i++) {
      if (sampleAutoTier(state, MED, TIERS, 10, 16).tier) changes++;
    }
    expect(changes).toBe(1);
  });

  it("honours a 0 threshold as 'never in that direction'", () => {
    const noDemote = tier("low", {
      autoTier: { sampleAfterMs: 100, sampleWindowMs: 100, demoteBelowFps: 0, promoteAboveFps: 55 },
    });
    expect(run(noDemote, 5).result.tier).toBeNull();

    const noPromote = tier("high", {
      autoTier: { sampleAfterMs: 100, sampleWindowMs: 100, demoteBelowFps: 40, promoteAboveFps: 0 },
    });
    expect(run(noPromote, 120).result.tier).toBeNull();
  });

  it("cannot step past the ends of the ladder", () => {
    const lowDemote = tier("low", {
      autoTier: { sampleAfterMs: 100, sampleWindowMs: 100, demoteBelowFps: 30, promoteAboveFps: 0 },
    });
    expect(run(lowDemote, 5).result.tier).toBeNull();
  });

  it("ignores unusable FPS readings and never demotes on them alone", () => {
    const state = newAutoTierState();
    let changed: string | null = null;
    for (let i = 0; i < 800; i++) {
      const r = sampleAutoTier(state, MED, TIERS, Number.NaN, 16);
      if (r.tier) changed = r.tier;
    }
    expect(state.sampleFrames).toBe(0);
    expect(changed).toBeNull();
  });
});
