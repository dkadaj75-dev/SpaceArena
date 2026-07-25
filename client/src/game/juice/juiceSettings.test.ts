import { describe, expect, it } from "vitest";
import type { ThemeConfig } from "@space-arena/shared";
import {
  DEFAULT_JUICE_SETTINGS,
  explosionEffectIdFor,
  juiceSettingsOf,
  shieldRipplePose,
} from "./juiceSettings.js";

describe("juiceSettingsOf", () => {
  it("falls back to the built-in defaults for a theme with no juice block", () => {
    expect(juiceSettingsOf(undefined)).toEqual(DEFAULT_JUICE_SETTINGS);
    expect(juiceSettingsOf({} as ThemeConfig)).toEqual(DEFAULT_JUICE_SETTINGS);
  });

  it("merges a partial juice block field by field", () => {
    const theme = {
      juice: {
        hitFlash: { durationMs: 400 },
        explosions: { asteroid: "fx.explosion-rock", byShipClass: { heavy: "fx.explosion-heavy" } },
      },
    } as unknown as ThemeConfig;
    const s = juiceSettingsOf(theme);
    expect(s.hitFlash.durationMs).toBe(400);
    expect(s.hitFlash.color).toBe(DEFAULT_JUICE_SETTINGS.hitFlash.color);
    expect(s.explosions.asteroidEffect).toBe("fx.explosion-rock");
    expect(s.explosions.byShipClass["heavy"]).toBe("fx.explosion-heavy");
    expect(s.explosions.burstCount).toBe(DEFAULT_JUICE_SETTINGS.explosions.burstCount);
  });
});

describe("explosionEffectIdFor", () => {
  const explosions = {
    defaultEffect: "fx.explosion-medium",
    asteroidEffect: "fx.explosion-rock",
    byShipClass: { light: "fx.explosion-light", heavy: "fx.explosion-heavy" },
    burstCount: 60,
    poolPerEffect: 3,
  };

  it("picks the asteroid variant for rocks", () => {
    expect(explosionEffectIdFor({ isAsteroid: true, shipClass: "light" }, explosions)).toBe("fx.explosion-rock");
  });

  it("picks the ship-class variant when one exists", () => {
    expect(explosionEffectIdFor({ isAsteroid: false, shipClass: "light" }, explosions)).toBe("fx.explosion-light");
    expect(explosionEffectIdFor({ isAsteroid: false, shipClass: "heavy" }, explosions)).toBe("fx.explosion-heavy");
  });

  it("falls back to the default for unmapped or unknown classes", () => {
    expect(explosionEffectIdFor({ isAsteroid: false, shipClass: "medium" }, explosions)).toBe("fx.explosion-medium");
    expect(explosionEffectIdFor({ isAsteroid: false, shipClass: null }, explosions)).toBe("fx.explosion-medium");
    expect(explosionEffectIdFor({ isAsteroid: false }, explosions)).toBe("fx.explosion-medium");
  });

  it("returns null when the theme configures no variant at all", () => {
    const none = { ...explosions, defaultEffect: null, asteroidEffect: null, byShipClass: {} };
    expect(explosionEffectIdFor({ isAsteroid: false, shipClass: "light" }, none)).toBeNull();
    expect(explosionEffectIdFor({ isAsteroid: true }, none)).toBeNull();
  });
});

describe("shieldRipplePose", () => {
  const ripple = DEFAULT_JUICE_SETTINGS.shieldRipple;

  it("starts at the low point of the cycle and peaks halfway through", () => {
    const start = shieldRipplePose(0, ripple);
    const mid = shieldRipplePose(ripple.periodMs / 2, ripple);
    expect(start.alpha).toBeCloseTo(ripple.minAlpha);
    expect(mid.alpha).toBeCloseTo(ripple.maxAlpha);
    expect(start.scale).toBeCloseTo(ripple.radiusScale * (1 - ripple.scaleWobble));
    expect(mid.scale).toBeCloseTo(ripple.radiusScale * (1 + ripple.scaleWobble));
  });

  it("loops — one full period returns to the start", () => {
    const start = shieldRipplePose(0, ripple);
    const looped = shieldRipplePose(ripple.periodMs * 3, ripple);
    expect(looped.alpha).toBeCloseTo(start.alpha);
    expect(looped.scale).toBeCloseTo(start.scale);
  });

  it("stays inside its configured alpha/scale band throughout", () => {
    for (let t = 0; t <= ripple.periodMs; t += 50) {
      const pose = shieldRipplePose(t, ripple);
      expect(pose.alpha).toBeGreaterThanOrEqual(ripple.minAlpha - 1e-9);
      expect(pose.alpha).toBeLessThanOrEqual(ripple.maxAlpha + 1e-9);
      expect(pose.scale).toBeGreaterThanOrEqual(ripple.radiusScale * (1 - ripple.scaleWobble) - 1e-9);
      expect(pose.scale).toBeLessThanOrEqual(ripple.radiusScale * (1 + ripple.scaleWobble) + 1e-9);
    }
  });

  it("survives a degenerate zero period without dividing by zero", () => {
    const pose = shieldRipplePose(123, { ...ripple, periodMs: 0 });
    expect(Number.isFinite(pose.alpha)).toBe(true);
    expect(Number.isFinite(pose.scale)).toBe(true);
  });
});
