import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { arenaSchema, type ArenaConfig } from "./arena.js";
import { asteroidSchema, type AsteroidConfig } from "./asteroid.js";

type Vec3 = { x: number; y?: number; z: number };
type ShippedArena = {
  name: string;
  file: string;
  minimumCount: number;
  maxExtent: number;
};

const CONTENT_ROOT = fileURLToPath(new URL("../../../content/", import.meta.url));
const SHIPPED_ARENAS: readonly ShippedArena[] = [
  { name: "deep-field", file: "deep-field.json", minimumCount: 47, maxExtent: 315 },
  { name: "ring-nebula", file: "ring-nebula.json", minimumCount: 10, maxExtent: 90 },
];
const asteroidFiles = ["small-rock.json", "small-rock-b.json", "large-hazard.json", "large-hazard-b.json"];

function loadJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function positionOf(value: Vec3): Required<Vec3> {
  return { x: value.x, y: value.y ?? 0, z: value.z };
}

function distance(a: Required<Vec3>, b: Required<Vec3>): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function distanceToSegment(point: Required<Vec3>, start: Required<Vec3>, end: Required<Vec3>): number {
  const segment = { x: end.x - start.x, y: end.y - start.y, z: end.z - start.z };
  const offset = { x: point.x - start.x, y: point.y - start.y, z: point.z - start.z };
  const denominator = segment.x ** 2 + segment.y ** 2 + segment.z ** 2;
  const t = Math.max(
    0,
    Math.min(1, (offset.x * segment.x + offset.y * segment.y + offset.z * segment.z) / denominator),
  );
  return distance(point, {
    x: start.x + segment.x * t,
    y: start.y + segment.y * t,
    z: start.z + segment.z * t,
  });
}

function teamCentroid(arena: ArenaConfig, team: number): Required<Vec3> {
  const points = arena.spawnPoints.filter((spawn) => spawn.team === team);
  expect(points.length, `${arena.id} team ${team} needs spawn points`).toBeGreaterThan(0);
  return {
    x: points.reduce((sum, spawn) => sum + spawn.position.x, 0) / points.length,
    y: points.reduce((sum, spawn) => sum + (spawn.position.y ?? 0), 0) / points.length,
    z: points.reduce((sum, spawn) => sum + spawn.position.z, 0) / points.length,
  };
}

const radii = new Map<string, number>(
  asteroidFiles.map((file) => {
    const asteroid: AsteroidConfig = asteroidSchema.parse(loadJson(`${CONTENT_ROOT}asteroids/${file}`));
    return [asteroid.id, asteroid.radius];
  }),
);

describe("shipped arena asteroid geometry", () => {
  for (const shipped of SHIPPED_ARENAS) {
    it(`${shipped.name} stays volumetric, separated, corridor-safe, and within its extent cap`, () => {
      const arena = arenaSchema.parse(loadJson(`${CONTENT_ROOT}arenas/${shipped.file}`));
      const corridor = [teamCentroid(arena, 0), teamCentroid(arena, 1)] as const;
      const placements = arena.asteroidPlacements;
      expect(placements.length).toBeGreaterThanOrEqual(shipped.minimumCount);

      for (let index = 0; index < placements.length; index++) {
        const placement = placements[index]!;
        const position = positionOf(placement.position);
        const colliderRadius = radii.get(placement.asteroidId)! * (placement.scale ?? 1);
        const extent = Math.hypot(position.x, position.y, position.z) + colliderRadius;

        // Deep-field's 315 cap is the centi-int16 wire-safety invariant. This is
        // deliberately checked placement-by-placement, including scaled colliders.
        expect(extent, `${arena.id} placement ${index} extent`).toBeLessThanOrEqual(shipped.maxExtent);
        expect(
          distanceToSegment(position, corridor[0], corridor[1]) - colliderRadius,
          `${arena.id} placement ${index} corridor surface clearance`,
        ).toBeGreaterThanOrEqual(25);

        for (let otherIndex = 0; otherIndex < index; otherIndex++) {
          const other = placements[otherIndex]!;
          const otherRadius = radii.get(other.asteroidId)! * (other.scale ?? 1);
          expect(
            distance(position, positionOf(other.position)) - colliderRadius - otherRadius,
            `${arena.id} placements ${otherIndex}/${index} surface gap`,
          ).toBeGreaterThanOrEqual(12);
        }
      }

      const ys = placements.map((placement) => placement.position.y ?? 0);
      expect(Math.min(...ys)).toBeLessThan(-25);
      expect(Math.max(...ys)).toBeGreaterThan(25);
      if (shipped.name === "deep-field") {
        expect(ys.filter((y) => Math.abs(y) >= 100).length / ys.length).toBeGreaterThanOrEqual(0.6);
        expect(ys.filter((y) => Math.abs(y) >= 150).length).toBeGreaterThanOrEqual(30);
        expect(Math.min(...ys.map(Math.abs))).toBeLessThanOrEqual(40);
        expect(Math.max(...ys.map(Math.abs))).toBeGreaterThanOrEqual(225);
      } else {
        expect(Math.max(...ys.map(Math.abs))).toBeGreaterThanOrEqual(50);
      }
    });
  }
});
