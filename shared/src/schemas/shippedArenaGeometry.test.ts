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
  { name: "deep-field", file: "deep-field.json", minimumCount: 90, maxExtent: 210 },
  { name: "ring-nebula", file: "ring-nebula.json", minimumCount: 14, maxExtent: 126 },
  { name: "lunar-crater", file: "lunar-crater.json", minimumCount: 27, maxExtent: 180 },
  { name: "broken-halo", file: "broken-halo.json", minimumCount: 14, maxExtent: 150 },
  { name: "twin-titans", file: "twin-titans.json", minimumCount: 14, maxExtent: 100 },
];
const asteroidFiles = [
  "small-rock.json",
  "small-rock-b.json",
  "large-hazard.json",
  "large-hazard-b.json",
  "colossal-a.json",
  "colossal-b.json",
];

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

        // The authored bubble is the hard cap, including scaled colliders.
        expect(extent, `${arena.id} placement ${index} extent`).toBeLessThanOrEqual(shipped.maxExtent);
        // The origin CENTREPIECE (owner 2026-07-31: a colossal rock to orbit
        // while fighting) deliberately blocks the straight spawn-to-spawn line,
        // so it is exempt from the corridor rule — but it must never crowd a
        // spawn pad.
        const isCentrepiece = Math.hypot(position.x, position.y, position.z) < colliderRadius;
        if (isCentrepiece) {
          for (const spawn of arena.spawnPoints) {
            expect(
              distance(position, positionOf(spawn.position)) - colliderRadius,
              `${arena.id} centrepiece clearance from a spawn pad`,
            ).toBeGreaterThanOrEqual(25);
          }
        } else {
          expect(
            distanceToSegment(position, corridor[0], corridor[1]) - colliderRadius,
            `${arena.id} placement ${index} corridor surface clearance`,
          ).toBeGreaterThanOrEqual(25);
        }

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
      if (arena.bounds.shape === "sphere" && arena.bounds.floorY !== undefined) {
        for (let index = 0; index < placements.length; index++) {
          const placement = placements[index]!;
          const colliderRadius = radii.get(placement.asteroidId)! * (placement.scale ?? 1);
          expect(
            (placement.position.y ?? 0) + colliderRadius,
            `${arena.id} placement ${index} floor clearance`,
          ).toBeGreaterThanOrEqual(arena.bounds.floorY);
        }
      } else {
        expect(Math.min(...ys)).toBeLessThan(-25);
        expect(Math.max(...ys)).toBeGreaterThan(25);
      }
      if (shipped.name === "deep-field") {
        expect(ys.filter((y) => Math.abs(y) >= 70).length / ys.length).toBeGreaterThanOrEqual(0.55);
        expect(ys.filter((y) => Math.abs(y) >= 105).length).toBeGreaterThanOrEqual(30);
        expect(Math.min(...ys.map(Math.abs))).toBeLessThanOrEqual(28);
        expect(Math.max(...ys.map(Math.abs))).toBeGreaterThanOrEqual(157.5);

        const colossal = placements.filter((placement) => placement.asteroidId.startsWith("asteroid.colossal"));
        expect(colossal.length).toBeGreaterThanOrEqual(4);
        expect(colossal.length).toBeLessThanOrEqual(6);
        for (const placement of colossal) {
          const position = positionOf(placement.position);
          const colliderRadius = radii.get(placement.asteroidId)! * (placement.scale ?? 1);
          for (const spawn of arena.spawnPoints) {
            expect(
              distance(position, positionOf(spawn.position)) - colliderRadius,
              `${arena.id} colossal ${placement.asteroidId} spawn surface clearance`,
            ).toBeGreaterThanOrEqual(30);
          }
        }
      } else if (arena.bounds.shape !== "sphere" || arena.bounds.floorY === undefined) {
        expect(Math.max(...ys.map(Math.abs))).toBeGreaterThanOrEqual(35);
      }
    });
  }
});
