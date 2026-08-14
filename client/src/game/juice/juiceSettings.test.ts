import { describe, expect, it } from "vitest";
import type { ThemeConfig } from "@space-arena/shared";
import {
  DEFAULT_JUICE_SETTINGS,
  MISSILE_IMPACT_SCALE,
  explosionEffectIdFor,
  juiceSettingsOf,
  missileImpactEffectIdsFor,
  shieldBubbleColorOf,
  shieldImpactFlare,
  shieldRipplePose,
  viewRelationOf,
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

  it("takes the shield tints from the theme's HUD colours when the juice block omits them", () => {
    const theme = {
      colors: { "--hud-shield": "#001122", "--hud-danger": "#EF4444" },
      juice: { shieldRipple: { periodMs: 900 } },
    } as unknown as ThemeConfig;
    const s = juiceSettingsOf(theme);
    expect(s.shieldRipple.color).toBe("#001122");
    expect(s.shieldRipple.hostileColor).toBe("#EF4444");
    expect(s.shieldRipple.periodMs).toBe(900);
  });

  it("lets an explicit juice tint override the theme's HUD colours", () => {
    const theme = {
      colors: { "--hud-shield": "#001122", "--hud-danger": "#EF4444" },
      juice: { shieldRipple: { color: "#abcdef", hostileColor: "#fedcba" } },
    } as unknown as ThemeConfig;
    const s = juiceSettingsOf(theme);
    expect(s.shieldRipple.color).toBe("#abcdef");
    expect(s.shieldRipple.hostileColor).toBe("#fedcba");
  });
});

describe("viewRelationOf", () => {
  it("reads the viewer's own hull as friendly whatever its team says", () => {
    expect(viewRelationOf(7, 1, 7, 0)).toBe("friendly");
  });

  it("splits other ships by team", () => {
    expect(viewRelationOf(3, 0, 7, 0)).toBe("friendly");
    expect(viewRelationOf(3, 1, 7, 0)).toBe("hostile");
  });

  it("stays friendly when the viewer's team is unknown", () => {
    // Spectating or pre-first-snapshot: a whole arena of red bubbles would be
    // a louder lie than a shield that is briefly the wrong blue.
    expect(viewRelationOf(3, 1, null, null)).toBe("friendly");
    expect(viewRelationOf(3, 1, 7, null)).toBe("friendly");
    expect(viewRelationOf(3, undefined, 7, 0)).toBe("friendly");
  });
});

describe("shieldBubbleColorOf", () => {
  const ripple = DEFAULT_JUICE_SETTINGS.shieldRipple;

  it("paints an enemy shell in the hostile tint and my own side in the friendly one", () => {
    expect(shieldBubbleColorOf("hostile", ripple)).toBe(ripple.hostileColor);
    expect(shieldBubbleColorOf("friendly", ripple)).toBe(ripple.color);
  });

  it("keeps the two tints distinct in the shipped defaults", () => {
    expect(ripple.hostileColor).not.toBe(ripple.color);
  });
});

describe("explosionEffectIdFor", () => {
  const explosions = {
    defaultEffect: "fx.explosion-medium",
    asteroidEffect: "fx.explosion-rock",
    missileImpactEffect: "fx.missile-impact",
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

describe("missileImpactEffectIdsFor", () => {
  const explosions = {
    defaultEffect: "fx.explosion-medium",
    asteroidEffect: "fx.explosion-rock",
    missileImpactEffect: "fx.missile-impact",
    byShipClass: {},
    burstCount: 60,
    poolPerEffect: 3,
  };

  it("prefers the warhead variant and keeps the death burst as a fallback", () => {
    expect(missileImpactEffectIdsFor(explosions)).toEqual(["fx.missile-impact", "fx.explosion-medium"]);
  });

  it("never offers the same id twice", () => {
    const same = { ...explosions, missileImpactEffect: "fx.explosion-medium" };
    expect(missileImpactEffectIdsFor(same)).toEqual(["fx.explosion-medium"]);
  });

  it("is empty when nothing is configured, so nothing is drawn", () => {
    expect(missileImpactEffectIdsFor({ ...explosions, missileImpactEffect: null, defaultEffect: null })).toEqual([]);
  });

  it("ships a dedicated warhead variant by default", () => {
    expect(DEFAULT_JUICE_SETTINGS.explosions.missileImpactEffect).toBe("fx.missile-impact");
    expect(MISSILE_IMPACT_SCALE).toBeLessThan(1); // smaller than a hull coming apart
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

  it("keeps the idle band barely visible, well under the impact peak", () => {
    // The point of the rebalance: an unhit shield is nearly transparent, and a
    // hit one is unmistakable. Pinned as a ratio so retuning the numbers cannot
    // quietly bring the permanent bubble back.
    expect(ripple.maxAlpha).toBeLessThan(0.06);
    expect(ripple.impactAlpha).toBeGreaterThan(ripple.maxAlpha * 5);
  });

  it("jumps to the impact alpha on a fresh hit and decays back to idle", () => {
    const idle = shieldRipplePose(0, ripple);
    const hit = shieldRipplePose(0, ripple, 0);
    const settled = shieldRipplePose(0, ripple, ripple.impactDecayMs);
    expect(hit.alpha).toBeCloseTo(ripple.impactAlpha);
    expect(hit.alpha).toBeGreaterThan(idle.alpha * 5);
    expect(hit.scale).toBeGreaterThan(idle.scale);
    expect(settled.alpha).toBeCloseTo(idle.alpha);
    expect(settled.scale).toBeCloseTo(idle.scale);
  });

  it("decays monotonically across the flare and never dips below idle", () => {
    let previous = Infinity;
    for (let age = 0; age <= ripple.impactDecayMs * 1.5; age += 20) {
      const pose = shieldRipplePose(0, ripple, age);
      expect(pose.alpha).toBeLessThanOrEqual(previous + 1e-9);
      expect(pose.alpha).toBeGreaterThanOrEqual(ripple.minAlpha - 1e-9);
      previous = pose.alpha;
    }
  });

  it("treats an omitted impact age as the pure idle pose", () => {
    expect(shieldRipplePose(200, ripple)).toEqual(shieldRipplePose(200, ripple, Number.POSITIVE_INFINITY));
  });

  it("never lets a hit DIM a bubble whose theme authored a low impact alpha", () => {
    const perverse = { ...ripple, minAlpha: 0.4, maxAlpha: 0.4, impactAlpha: 0.05 };
    expect(shieldRipplePose(0, perverse, 0).alpha).toBeCloseTo(0.4);
  });
});

describe("shieldImpactFlare", () => {
  it("peaks at the hit and reaches zero at the end of the decay", () => {
    expect(shieldImpactFlare(0, 400)).toBe(1);
    expect(shieldImpactFlare(400, 400)).toBe(0);
    expect(shieldImpactFlare(9999, 400)).toBe(0);
  });

  it("front-loads the falloff so consecutive hits read as separate beats", () => {
    // Squared: half way through the window the flare is already down to a
    // quarter, not a half.
    expect(shieldImpactFlare(200, 400)).toBeCloseTo(0.25);
  });

  it("is zero for no impact on record or a degenerate decay window", () => {
    expect(shieldImpactFlare(Number.POSITIVE_INFINITY, 400)).toBe(0);
    expect(shieldImpactFlare(Number.NaN, 400)).toBe(0);
    expect(shieldImpactFlare(0, 0)).toBe(0);
  });
});
