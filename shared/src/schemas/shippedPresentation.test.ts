import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { arenaSchema, sunDirLength, SUN_DIR_UNIT_TOLERANCE } from "./arena.js";
import { qualitySchema, QUALITY_TIERS } from "./quality.js";
import { themeSchema } from "./theme.js";
import { tuningSchema } from "./tuning.js";

/**
 * Contract tests over the SHIPPED pack, for presentation decisions the user asked
 * for by name. A schema can only say a field is well-formed; these assert the pack
 * actually made the choice — the classic silent-failure shape in this repo is a
 * new knob that validates fine and is never authored.
 */
const CONTENT_ROOT = fileURLToPath(new URL("../../../content/", import.meta.url));

function load(relPath: string): unknown {
  return JSON.parse(readFileSync(CONTENT_ROOT + relPath, "utf8")) as unknown;
}

describe("shipped quality tiers — spawn markers and ambient dust", () => {
  const tiers = QUALITY_TIERS.map((tier) => {
    const parsed = qualitySchema.safeParse(load(`quality/${tier}.json`));
    expect(parsed.success, `quality/${tier}.json must validate`).toBe(true);
    if (!parsed.success) throw parsed.error;
    return { tier, config: parsed.data };
  });

  it("hides the team spawn gizmos in every shipped tier", () => {
    // They are an authoring aid. The dev editor forces them back on for itself
    // (SceneBuilder.setSpawnMarkerOverride), which is where designers need them.
    for (const { tier, config } of tiers) {
      expect(config.scene.spawnMarkers, `${tier} must not show spawn markers`).toBe(false);
    }
  });

  it("never substitutes procedural asteroid LODs in any shipped tier", () => {
    for (const { tier, config } of tiers) {
      expect(config.asteroids.proceduralOnly, `${tier} must use authored asteroid models`).not.toBe(true);
      expect(config.asteroids.lodMediumDistance, `${tier} must not swap to a procedural medium LOD`).toBe(0);
      expect(config.asteroids.lodLowDistance, `${tier} must not swap to a procedural low LOD`).toBe(0);
    }
  });

  it("authors ambient dust on every tier, and disables it below high", () => {
    for (const { tier, config } of tiers) {
      const dust = config.scene.dust;
      expect(dust, `${tier} should author a dust block`).toBeDefined();
      if (!dust) continue;
      // Subtle by design: motes, not snow.
      expect(dust.alpha).toBeLessThanOrEqual(0.5);
      expect(dust.size).toBeLessThanOrEqual(1);
      expect(dust.boxSize).toBeGreaterThan(0);
      if (tier === "low" || tier === "med") {
        // Alpha-blended sprites are pure overdraw — the one budget a budget phone
        // has least of, and the tier that already drops glow and the hex shader.
        expect(dust.count).toBe(0);
      } else {
        expect(dust.count).toBeGreaterThan(0);
      }
    }
  });

  it("scales dust density with the tier, never against it", () => {
    const counts = tiers.map(({ config }) => config.scene.dust?.count ?? 0);
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]!).toBeGreaterThanOrEqual(counts[i - 1]!);
    }
  });
});

describe("shipped arenas — the painted star is the key light", () => {
  // Trimmed to the two surviving arenas 2026-08-18; deep-field, lunar-crater,
  // broken-halo and twin-titans were deleted with the asteroid overhaul.
  // Intensities raised 2026-08-21 on the two deathmatch skies (owner: "increase
  // the in-game light"): ring-nebula's key went 1.0 -> 1.5. The DIRECTIONS are
  // the invariant this suite exists for — light must arrive from where the star
  // is drawn — and none of them moved.
  const EXPECTED = {
    "ring-nebula.json": { dir: [-0.677, -0.208, -0.706], color: "#dce4ff", intensity: 1.5 },
    // Parker Point's star is DRAWN (`render.star`) rather than painted, so its
    // sun block is the light that body casts; both must point the same way,
    // which `gamemodeArena.test.ts` pins directly against the two fields.
    "parker-point.json": { dir: [0.9118, 0.2419, -0.3319], color: "#ffd9a8", intensity: 1.9 },
    "lunar-rift.json": { dir: [-0.707, 0.5, -0.5], color: "#ffffff", intensity: 1.45 },
  } as const;

  for (const [file, expected] of Object.entries(EXPECTED)) {
    it(`${file} authors the sun matching where the star is painted`, () => {
      const parsed = arenaSchema.safeParse(load(`arenas/${file}`));
      expect(parsed.success, `${file} must validate`).toBe(true);
      if (!parsed.success) throw parsed.error;
      const sun = parsed.data.render?.skybox.sun;
      expect(sun, `${file} should author render.skybox.sun`).toBeDefined();
      if (!sun) return;
      // These EXACT directions match the star in the regenerated panoramas; a
      // silent edit here would light the scene from the wrong side of the sky.
      expect(sun.dir).toEqual(expected.dir);
      expect(sun.color).toBe(expected.color);
      expect(sun.intensity).toBeCloseTo(expected.intensity, 6);
      expect(Math.abs(sunDirLength(sun.dir) - 1)).toBeLessThanOrEqual(SUN_DIR_UNIT_TOLERANCE);
      // A soft fill has to survive alongside it, or the unlit side of every hull
      // is a black silhouette rather than a shadow.
      expect(parsed.data.lighting?.ambientIntensity ?? 0).toBeGreaterThan(0);
    });
  }
});

describe("shipped arenas — proximity-only boundary wireframes", () => {
  const FILES = ["ring-nebula.json"];

  for (const file of FILES) {
    it(`${file} hides the shield until close range and uses fine hex wires`, () => {
      const parsed = arenaSchema.safeParse(load(`arenas/${file}`));
      expect(parsed.success, `${file} must validate`).toBe(true);
      if (!parsed.success) throw parsed.error;
      const shield = parsed.data.render?.boundaryShield;
      expect(shield, `${file} should author a boundary shield`).toBeDefined();
      if (!shield) return;
      expect(shield.baseOpacity).toBe(1);
      expect(shield.glowStartDistance).toBeLessThanOrEqual(16);
      expect(shield.redTransitionDistance).toBeLessThan(shield.warnDistance);
      expect(shield.warnDistance).toBeLessThan(shield.glowStartDistance);
      expect(shield.hexDensity).toBe(42);
      expect(shield.hexLineWidth).toBeCloseTo(0.012, 6);
    });
  }
});

describe("shipped tuning + theme — match start countdown", () => {
  it("authors a 3 second countdown", () => {
    const parsed = tuningSchema.safeParse(load("tuning/default.json"));
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw parsed.error;
    expect(parsed.data.matchCountdownSec).toBe(3);
  });

  it("authors the 3-2-1 and GO audio cues", () => {
    const parsed = themeSchema.safeParse(load("themes/default.json"));
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw parsed.error;
    const cues = parsed.data.audio?.cues;
    expect(cues?.countdownTick).toBeTruthy();
    expect(cues?.countdownGo).toBeTruthy();
  });
});

describe("shipped theme - compact flight HUD", () => {
  it("authors the complete arena design-token board", () => {
    const parsed = themeSchema.safeParse(load("themes/default.json"));
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw parsed.error;
    expect(parsed.data.tokens).toEqual({
      palette: { blue500: "#3B82F6", red500: "#EF4444", white: "#E6F0FF", n900: "#05080D", n800: "#0B1118", n700: "#151E2A", n600: "#1E2937", n500: "#334155", n400: "#475569" },
      typography: { h1: "700 32px/40px 'Orbitron', system-ui, sans-serif", h2: "600 20px/28px 'Orbitron', system-ui, sans-serif", h3: "600 16px/24px 'Rajdhani', system-ui, sans-serif", body: "400 14px/20px 'Rajdhani', system-ui, sans-serif", caption: "500 12px/16px 'Rajdhani', system-ui, sans-serif", data: "400 14px/20px 'Orbitron', system-ui, sans-serif" },
      lineWeights: { hairline: "1px", thin: "2px", medium: "3px", strong: "4px" },
      radii: { small: "4px", medium: "8px", large: "16px" },
    });
  });

  it("authors the 3D radar, centre vital arcs, and restrained controls", () => {
    const parsed = themeSchema.safeParse(load("themes/default.json"));
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw parsed.error;
    const hud = parsed.data.hud;
    expect(hud?.radar?.rangeUnits).toBeGreaterThan(0);
    expect(hud?.radar?.elevationDeg).toBeGreaterThan(0);
    expect(hud?.vitalArcs?.enabled).toBe(true);
    // Restrained, but READABLE. It was 0.46 until the owner reported hull and
    // shield as unreadable mid-fight (2026-08-21); the arcs keep their
    // semi-circle design and a dark backing halo does most of the work, with the
    // authored opacity coming up to meet it. The ceiling stays because a fully
    // opaque arc would compete with the arena rather than frame it.
    expect(hud?.vitalArcs?.opacity).toBeGreaterThan(0.6);
    expect(hud?.vitalArcs?.opacity).toBeLessThan(0.9);
    // The ship-wide ENERGY panel died with the 2026-08-07 energy overhaul:
    // energy is per-module now and rides the module buttons'
    // own rings, so the shipped theme authors no `gauges` block at all.
    expect(hud?.gauges).toBeUndefined();
    expect(hud?.flight?.reticle?.showZone).toBe(false);
    // FIRE is the one intentionally prominent control: a complete but hairline
    // danger ring keeps the enlarged circular disc from reading as a plain dot.
    expect(hud?.flight?.fire?.ringArcDeg).toBe(360);
    expect(hud?.flight?.fire?.ringStrokePx).toBeCloseTo(1.5, 6);
    expect(hud?.flight?.throttle?.opacity).toBeCloseTo(0.6, 6);
  });

  it("owner pass 2026-07-31: hidden placeholder module meshes, subtle shield, quick modules, 2.5x reach", () => {
    const parsed = themeSchema.safeParse(load("themes/default.json"));
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw parsed.error;
    // Placeholder module meshes stay off the hulls until real models land.
    expect(parsed.data.juice?.deploy?.showMeshes).toBe(false);
    // The shield reads as a faint rim, not a balloon.
    const ripple = parsed.data.juice?.shieldRipple;
    expect(ripple?.maxAlpha ?? 1).toBeLessThanOrEqual(0.12);
    expect(ripple?.radiusScale ?? 9).toBeLessThanOrEqual(1.25);
  });

  it("parks the off-screen enemy arrows on a ring INSIDE the vital arcs, both orientations", () => {
    const parsed = themeSchema.safeParse(load("themes/default.json"));
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw parsed.error;
    const hud = parsed.data.hud;
    // Portrait: the ring is concentric with the arcs and sits in their interior,
    // with clearance for the arrow glyph and its distance label.
    const arcs = hud?.vitalArcs;
    const arrows = hud?.flight?.enemyArrows;
    expect(arrows?.ringRadiusPx).toBeGreaterThan(0);
    expect(arrows?.ringRadiusPx ?? Infinity).toBeLessThan(arcs?.radiusPx ?? 0);
    expect(arrows?.ringOffsetYPx).toBe(arcs?.offsetYPx);
    // Landscape: same containment against the landscape arcs (both values are
    // authored pre-scale, so they compare like-for-like).
    const landArcs = hud?.landscape?.vitalArcs;
    const landArrows = hud?.landscape?.flight?.enemyArrows;
    expect(landArrows?.ringRadiusPx).toBeGreaterThan(0);
    expect(landArrows?.ringRadiusPx ?? Infinity).toBeLessThan(landArcs?.radiusPx ?? 0);
    expect(landArrows?.ringOffsetYPx).toBe(landArcs?.offsetYPx);
  });
});
