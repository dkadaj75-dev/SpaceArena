import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ThemeConfig } from "@space-arena/shared";
import {
  DEFAULT_JUICE_SETTINGS,
  MISSILE_IMPACT_SCALE,
  explosionEffectIdFor,
  hullChargeLevel,
  impactFeedbackFor,
  juiceSettingsOf,
  missileImpactEffectIdsFor,
  shieldBubbleColorOf,
  shieldImpactFlare,
  shieldRipplePose,
  sparkEffectIdFor,
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
        energyCharge: { durationMs: 400 },
        explosions: { asteroid: "fx.explosion-rock", byShipClass: { heavy: "fx.explosion-heavy" } },
      },
    } as unknown as ThemeConfig;
    const s = juiceSettingsOf(theme);
    expect(s.energyCharge.durationMs).toBe(400);
    expect(s.energyCharge.color).toBe(DEFAULT_JUICE_SETTINGS.energyCharge.color);
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

describe("sparkEffectIdFor", () => {
  const sparks = DEFAULT_JUICE_SETTINGS.sparks;

  it("gives energy and kinetic weapons visibly different effects", () => {
    expect(sparkEffectIdFor("energy", sparks)).toBe("fx.impact-energy");
    expect(sparkEffectIdFor("kinetic", sparks)).toBe("fx.impact-kinetic");
    expect(sparkEffectIdFor("energy", sparks)).not.toBe(sparkEffectIdFor("kinetic", sparks));
  });

  it("falls back to the kinetic spray for a composite or unknown damage type", () => {
    // `hybrid` is what missiles carry today, and a content pack may invent more.
    for (const type of ["hybrid", "plasma", "", undefined, null]) {
      expect(sparkEffectIdFor(type, sparks)).toBe("fx.impact-kinetic");
    }
  });

  it("uses whichever effect a pack DID author when one is missing", () => {
    expect(sparkEffectIdFor("energy", { ...sparks, energyEffect: null })).toBe("fx.impact-kinetic");
    expect(sparkEffectIdFor("kinetic", { ...sparks, kineticEffect: null })).toBe("fx.impact-energy");
    expect(sparkEffectIdFor("kinetic", { ...sparks, kineticEffect: null, energyEffect: null })).toBeNull();
  });

  it("sparks a channelling beam on its own clock rather than per frame", () => {
    expect(sparks.channelIntervalMs).toBeGreaterThan(1000 / 60);
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

  it("keeps a raised shield VISIBLE at rest, with the flare still clearly above it", () => {
    // The 2026-08-14 doctrine ("an unhit shield is nearly transparent") was
    // written for the flat-sphere ripple and is SUPERSEDED: the hex bubble
    // must read while it is up (owner 2026-08-23, "the shield does not stay
    // up, visually"). Pinned as a band: visible enough to hold on screen,
    // transparent enough that the rim fresnel keeps the hull legible, and the
    // hit flare still unmistakably brighter than the idle peak.
    expect(ripple.minAlpha).toBeGreaterThan(0.05);
    expect(ripple.maxAlpha).toBeLessThan(0.15);
    expect(ripple.impactAlpha).toBeGreaterThan(ripple.maxAlpha * 1.5);
  });

  it("ships the owner's 2026-08-23 band: the visible baseline cut by 20% extra transparency", () => {
    // 0.10 / 0.14 / 0.25 × 0.8 — the persistent-bubble baseline with the "20%
    // more transparent" of the same request already applied.
    expect(ripple.minAlpha).toBeCloseTo(0.08, 6);
    expect(ripple.maxAlpha).toBeCloseTo(0.112, 6);
    expect(ripple.impactAlpha).toBeCloseTo(0.2, 6);
    // Both sides of the fight read from the same band; only the tint differs.
    expect(shieldBubbleColorOf("friendly", ripple)).not.toBe(shieldBubbleColorOf("hostile", ripple));
  });

  it("ships the same band in the SHIPPED theme, not just the built-in default", () => {
    const shipped = JSON.parse(
      readFileSync("content/themes/default.json", "utf8"),
    ) as ThemeConfig;
    const authored = juiceSettingsOf(shipped).shieldRipple;
    expect(authored.minAlpha).toBeCloseTo(0.08, 6);
    expect(authored.maxAlpha).toBeCloseTo(0.112, 6);
    expect(authored.impactAlpha).toBeCloseTo(0.2, 6);
    // The flare still reads over the now-visible idle band.
    expect(authored.impactAlpha).toBeGreaterThan(authored.maxAlpha * 1.5);
  });

  it("jumps to the impact alpha on a fresh hit and decays back to idle", () => {
    const idle = shieldRipplePose(0, ripple);
    const hit = shieldRipplePose(0, ripple, 0);
    const settled = shieldRipplePose(0, ripple, ripple.impactDecayMs);
    expect(hit.alpha).toBeCloseTo(ripple.impactAlpha);
    expect(hit.alpha).toBeGreaterThan(idle.alpha * 1.5);
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

describe("impactFeedbackFor", () => {
  it("blows a MISSILE up, whatever channel its damage went through", () => {
    // A warhead is authored `hybrid`, so the weapon is the only honest signal.
    expect(impactFeedbackFor("hybrid", "missile")).toBe("blast");
    expect(impactFeedbackFor("kinetic", "missile")).toBe("blast");
    expect(impactFeedbackFor("energy", "missile")).toBe("blast");
  });

  it("sparks a KINETIC round even if a pack gave it an odd damage type", () => {
    expect(impactFeedbackFor("kinetic", "kinetic")).toBe("spark");
    expect(impactFeedbackFor("hybrid", "kinetic")).toBe("spark");
  });

  it("electrifies the hull for an ENERGY weapon", () => {
    expect(impactFeedbackFor("energy", "beam")).toBe("charge");
    expect(impactFeedbackFor("energy", undefined)).toBe("charge");
  });

  it("reads a weaponless hybrid hit as a blast \u2014 that is the warhead's channel", () => {
    expect(impactFeedbackFor("hybrid", undefined)).toBe("blast");
    // ...but only when nothing contradicts it: a `hybrid` BEAM must not detonate.
    expect(impactFeedbackFor("hybrid", "beam")).toBe("spark");
  });

  it("falls back to sparks for anything it has never heard of", () => {
    // A hull scraping an asteroid, an old peer, a pack's invented type: all of
    // them are "something physical struck this", which is what a spark says.
    expect(impactFeedbackFor(undefined, undefined)).toBe("spark");
    expect(impactFeedbackFor(null, null)).toBe("spark");
    expect(impactFeedbackFor("plasma", undefined)).toBe("spark");
  });
});

describe("hullChargeLevel", () => {
  const charge = DEFAULT_JUICE_SETTINGS.energyCharge;

  it("is dark with no hit on record", () => {
    expect(hullChargeLevel(Number.POSITIVE_INFINITY, charge)).toBe(0);
    expect(hullChargeLevel(Number.NaN, charge)).toBe(0);
    expect(hullChargeLevel(-5, charge)).toBe(0);
  });

  it("peaks at the hit and is out by the end of the window", () => {
    expect(hullChargeLevel(0, charge)).toBeCloseTo(charge.intensity, 6);
    expect(hullChargeLevel(charge.durationMs, charge)).toBe(0);
    expect(hullChargeLevel(charge.durationMs * 2, charge)).toBe(0);
  });

  it("actually FLICKERS \u2014 the level is not monotonic across the window", () => {
    let rises = 0;
    let previous = hullChargeLevel(0, charge);
    for (let t = 1; t < charge.durationMs; t += 2) {
      const level = hullChargeLevel(t, charge);
      if (level > previous + 1e-9) rises++;
      previous = level;
    }
    expect(rises).toBeGreaterThan(2);
  });

  it("never blinks fully dark mid-flicker \u2014 that reads as a dropped frame", () => {
    for (let t = 0; t < charge.durationMs * 0.9; t += 1) {
      expect(hullChargeLevel(t, charge)).toBeGreaterThan(0);
    }
  });

  it("runs out overall even though it flickers", () => {
    expect(hullChargeLevel(charge.durationMs * 0.9, charge)).toBeLessThan(hullChargeLevel(0, charge));
  });

  it("draws nothing when the theme turns it off", () => {
    expect(hullChargeLevel(0, { ...charge, enabled: false })).toBe(0);
    expect(hullChargeLevel(0, { ...charge, durationMs: 0 })).toBe(0);
  });

  it("holds a steady level when the theme asks for no flicker", () => {
    const steady = { ...charge, flickerHz: 0 };
    expect(hullChargeLevel(0, steady)).toBeCloseTo(charge.intensity, 6);
    expect(hullChargeLevel(charge.durationMs / 2, steady)).toBeCloseTo(charge.intensity / 2, 6);
  });
});
