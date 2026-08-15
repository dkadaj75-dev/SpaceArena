import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { asteroidSchema, type AsteroidConfig } from "./asteroid.js";
import { resolveRockShape } from "../collision/rockShape.js";

const CONTENT_ROOT = fileURLToPath(new URL("../../../content/", import.meta.url));
const TEXTURE_DIR = `${CONTENT_ROOT}props/textures/game/`;

const asteroids: AsteroidConfig[] = readdirSync(`${CONTENT_ROOT}asteroids/`, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
  .map((entry) => asteroidSchema.parse(JSON.parse(readFileSync(`${CONTENT_ROOT}asteroids/${entry.name}`, "utf8"))))
  .sort((a, b) => (a.id < b.id ? -1 : 1));

/** Longest / shortest surface radius, and how far the body reaches at all. */
function silhouette(config: AsteroidConfig): { min: number; max: number; mean: number; aspect: number } {
  const shape = resolveRockShape(config.shape!);
  return {
    min: shape.minRadius,
    max: shape.maxRadius,
    mean: shape.meanRadius,
    aspect: shape.maxRadius / shape.minRadius,
  };
}

describe("shipped asteroid catalogue", () => {
  it("ships enough rock types to build a field out of", () => {
    expect(asteroids.length).toBeGreaterThanOrEqual(12);
  });

  it("gives every rock a shape, so nothing is left colliding as a sphere", () => {
    for (const config of asteroids) {
      expect(config.shape, `${config.id} must author a shape`).toBeDefined();
    }
  });

  it("keeps the drawn body inside its nominal radius", () => {
    // Arena placement, separation and the extent cap are all authored against
    // `radius`, so a shape that overshot it would silently break the spacing the
    // arena geometry test enforces.
    for (const config of asteroids) {
      const { max } = silhouette(config);
      expect(max, `${config.id} bounding radius`).toBeLessThanOrEqual(1.05);
      expect(max, `${config.id} bounding radius`).toBeGreaterThanOrEqual(0.75);
    }
  });

  it("leaves a solid core big enough for the collision march to resolve", () => {
    // `rockSegmentEntry` marches at a fraction of the inner radius; a body with
    // a vanishing core would need an unbounded number of samples to be sure of
    // a hit, so the catalogue is held to a real one.
    for (const config of asteroids) {
      const { min, max } = silhouette(config);
      expect(min, `${config.id} solid core`).toBeGreaterThan(0.15 * max);
    }
  });

  it("spans a real range of silhouettes rather than one potato at four sizes", () => {
    const aspects = asteroids.map(silhouette).map((s) => s.aspect);
    // Round bodies AND genuinely elongated ones both have to be present.
    expect(Math.min(...aspects)).toBeLessThan(1.7);
    expect(Math.max(...aspects)).toBeGreaterThan(2.8);
    // No two configs may resolve to the same silhouette signature.
    const signatures = new Set(asteroids.map((config) => {
      const s = silhouette(config);
      return `${s.min.toFixed(4)}:${s.mean.toFixed(4)}:${s.max.toFixed(4)}`;
    }));
    expect(signatures.size).toBe(asteroids.length);
  });

  it("covers every authored silhouette family", () => {
    const families = {
      multiLobe: asteroids.filter((c) => c.shape!.lobes.length > 1),
      elongated: asteroids.filter((c) => {
        const [x, y, z] = c.shape!.lobes[0]!.radii;
        return Math.max(x, y, z) / Math.min(x, y, z) >= 1.8;
      }),
      cratered: asteroids.filter((c) => (c.shape!.craters?.count ?? 0) >= 5),
      faceted: asteroids.filter((c) => (c.shape!.facets?.count ?? 0) >= 5),
    };
    for (const [family, members] of Object.entries(families)) {
      expect(members.length, `${family} silhouettes`).toBeGreaterThanOrEqual(2);
    }
  });

  it("spreads sizes and tumble rates across the catalogue", () => {
    const radii = asteroids.map((c) => c.radius);
    expect(Math.min(...radii)).toBeLessThanOrEqual(2);
    expect(Math.max(...radii)).toBeGreaterThanOrEqual(16);
    const spins = asteroids.map((c) => c.render.spin).filter((spin) => spin !== undefined);
    expect(spins.length).toBe(asteroids.length);
    // Small rocks tumble visibly; colossals barely turn.
    expect(Math.max(...spins.map((s) => s!.maxDegPerSec))).toBeGreaterThanOrEqual(20);
    expect(Math.min(...spins.map((s) => s!.minDegPerSec))).toBeLessThanOrEqual(0.5);
  });

  it("dresses every rock in a PBR set that is actually in the pack", () => {
    const used = new Set<string>();
    for (const config of asteroids) {
      const surface = config.render.surface;
      expect(surface, `${config.id} must author a surface`).toBeDefined();
      if (!surface) continue;
      used.add(surface.textureSet);
      for (const map of ["diff", "nor", "rough", "ao"]) {
        const file = `${TEXTURE_DIR}${surface.textureSet}_${map}_1k.jpg`;
        expect(existsSync(file), `${config.id} needs ${surface.textureSet}_${map}_1k.jpg`).toBe(true);
      }
      // Tiling is authored in metres and has to stay a fraction of the body, or
      // a colossal wears one stretched tile and a pebble wears fifty.
      expect(surface.tileMeters, `${config.id} tile size`).toBeLessThan(config.radius * 2);
      expect(surface.tileMeters, `${config.id} tile size`).toBeGreaterThan(config.radius * 0.4);
    }
    // The catalogue must not read as clones: several distinct scans in play.
    expect(used.size).toBeGreaterThanOrEqual(3);
  });

  it("gives one normal strength per scan set, because the texture carries it", () => {
    // The renderer caches one `Texture` per scan set and the normal-map strength
    // rides `Texture.level` on it, so two configs sharing a set cannot hold
    // different strengths — authoring them differently gives BOTH whichever
    // config was built last. Strength is a property of the scan anyway: these
    // four differ by ~5x in the slope they encode, and that spread is why they
    // could not all sit near 1 and still read as rock.
    const bySet = new Map<string, Map<number, string[]>>();
    for (const config of asteroids) {
      const surface = config.render.surface;
      if (!surface) continue;
      const strengths = bySet.get(surface.textureSet) ?? new Map<number, string[]>();
      strengths.set(surface.normalStrength, [...(strengths.get(surface.normalStrength) ?? []), config.id]);
      bySet.set(surface.textureSet, strengths);
    }
    for (const [set, strengths] of bySet) {
      expect([...strengths.keys()], `${set} strengths: ${JSON.stringify([...strengths])}`).toHaveLength(1);
      // A map turned all the way down is the other classic way rock reads flat.
      expect([...strengths.keys()][0]!, `${set} strength`).toBeGreaterThan(0.5);
    }
  });

  it("keeps the tessellation budget proportional to the body", () => {
    // Babylon's icosphere is 20 * subdivisions^2 triangles — NOT 20 * 4^n, which
    // this test used to assume. That mistake is why the catalogue was capped at
    // detail 4: it was believed to cost 5120 triangles when it costs 320, and the
    // rocks were left tessellated far coarser than the budget allowed. A crater
    // 25 degrees across cannot show on a body carrying 180 facets, so raising
    // this is not decoration — it is what lets the authored shape be seen at all.
    // Vertices still land exactly on the sim's field (client rockMesh.test.ts),
    // so finer sampling moves the drawn body TOWARD the collided one.
    const triangles = (detail: number): number => 20 * detail * detail;
    let previousRadius = 0;
    let previousDetail = 0;
    for (const config of [...asteroids].sort((a, b) => a.radius - b.radius)) {
      const detail = config.render.detail;
      expect(detail, `${config.id} must author a detail level`).toBeDefined();
      if (!detail) continue;
      if (config.radius >= 11) expect(detail, `${config.id} is colossal`).toBeGreaterThanOrEqual(6);
      if (config.radius <= 2) expect(detail, `${config.id} is a pebble`).toBeLessThanOrEqual(3);
      // The ceiling is the shape schema's, and it is ~2.2k vertices once the
      // box-projection UVs unweld it — small change against a ship hull.
      expect(detail).toBeLessThanOrEqual(6);
      expect(triangles(detail), `${config.id} triangle budget`).toBeLessThanOrEqual(720);
      // A bigger body never gets a coarser mesh than a smaller one.
      if (config.radius > previousRadius) expect(detail, `${config.id} vs previous`).toBeGreaterThanOrEqual(previousDetail);
      previousRadius = config.radius;
      previousDetail = detail;
    }
  });
});
