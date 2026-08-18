import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { arenaSchema, type ArenaConfig } from "./arena.js";
import { asteroidSchema, type AsteroidConfig } from "./asteroid.js";
import { gamemodeSchema } from "./gamemode.js";
import { propSchema, type PropConfig } from "./prop.js";
import { shipSchema } from "./ship.js";
import { tuningSchema } from "./tuning.js";
import { ConfigService } from "../core/ConfigService.js";
import { DEFAULT_PROJECTILE_BOUNDS_MARGIN, WIRE_POSITION_LIMIT } from "./arena.js";

type Vec3 = { x: number; y?: number; z: number };
type ShippedArena = {
  name: string;
  file: string;
  expectedCount: number;
  maxExtent: number;
};

const CONTENT_ROOT = fileURLToPath(new URL("../../../content/", import.meta.url));
/**
 * Placement counts are PINNED, not bounded: an arena's rock population is
 * authored content, so a change to it should show up as a deliberate edit here.
 * Re-recorded 2026-08-15 when the fields were restocked with the new shaped
 * silhouettes (shard / pebble / spindle / twin-lobe / rubble-knot /
 * angular-chunk / cratered-boulder / monolith) — see `distinctIds` below for
 * the variety floor that came with them.
 */
const SHIPPED_ARENAS: readonly ShippedArena[] = [
  { name: "deep-field", file: "deep-field.json", expectedCount: 148, maxExtent: 210 },
  { name: "ring-nebula", file: "ring-nebula.json", expectedCount: 46, maxExtent: 126 },
  { name: "lunar-crater", file: "lunar-crater.json", expectedCount: 82, maxExtent: 360 },
  { name: "broken-halo", file: "broken-halo.json", expectedCount: 52, maxExtent: 150 },
  { name: "twin-titans", file: "twin-titans.json", expectedCount: 41, maxExtent: 100 },
];
/** Every shipped rock, discovered rather than listed: a new config cannot be missed. */
const asteroidFiles = readdirSync(`${CONTENT_ROOT}asteroids/`, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
  .map((entry) => entry.name)
  .sort();

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

const maxShipDiameter = Math.max(
  ...readdirSync(`${CONTENT_ROOT}ships/`, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => shipSchema.parse(loadJson(`${CONTENT_ROOT}ships/${entry.name}`)).collider.radius * 2),
);

describe("shipped arena asteroid geometry", () => {
  for (const shipped of SHIPPED_ARENAS) {
    it(`${shipped.name} stays volumetric, separated, corridor-safe, and within its extent cap`, () => {
      const arena = arenaSchema.parse(loadJson(`${CONTENT_ROOT}arenas/${shipped.file}`));
      const corridor = [teamCentroid(arena, 0), teamCentroid(arena, 1)] as const;
      const placements = arena.asteroidPlacements;
      expect(placements.length).toBe(shipped.expectedCount);

      // A field of identical rocks reads as wallpaper however many of them there
      // are, so variety is an invariant of the arena, not a nice-to-have: at
      // least eight distinct rock types, none of them more than 40% of the field.
      const perId = new Map<string, number>();
      for (const placement of placements) perId.set(placement.asteroidId, (perId.get(placement.asteroidId) ?? 0) + 1);
      expect(perId.size, `${arena.id} distinct rock types`).toBeGreaterThanOrEqual(8);
      for (const [id, count] of perId) {
        expect(count / placements.length, `${arena.id} share of ${id}`).toBeLessThanOrEqual(0.4);
      }

      for (let index = 0; index < placements.length; index++) {
        const placement = placements[index]!;
        const position = positionOf(placement.position);
        const colliderRadius = radii.get(placement.asteroidId)! * (placement.scale ?? 1);
        const extent = Math.hypot(position.x, position.y, position.z) + colliderRadius;

        // The authored bubble is the hard cap, including scaled colliders.
        expect(extent, `${arena.id} placement ${index} extent`).toBeLessThanOrEqual(shipped.maxExtent);
        // A centrepiece (the CTF crater retains one) may deliberately block the
        // straight spawn-to-spawn line, but it must never crowd a spawn pad.
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

describe("shipped CTF spawn capacity and clearance", () => {
  const ctfModes = readdirSync(`${CONTENT_ROOT}gamemodes/`, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => gamemodeSchema.parse(loadJson(`${CONTENT_ROOT}gamemodes/${entry.name}`)))
    .filter((mode) => mode.ctf !== undefined);

  for (const mode of ctfModes) {
    it(`${mode.id} has one clear spawn per team slot`, () => {
      expect(mode.defaultArena, `${mode.id} needs a default CTF arena`).toBeDefined();
      const arenaFile = `${mode.defaultArena!.replace("arena.", "")}.json`;
      const arena = arenaSchema.parse(loadJson(`${CONTENT_ROOT}arenas/${arenaFile}`));
      const teamSize = Number.parseInt(mode.teams, 10);

      for (const team of [0, 1]) {
        expect(
          arena.spawnPoints.filter((spawn) => spawn.team === team).length,
          `${arena.id} team ${team} spawn capacity for ${mode.id}`,
        ).toBeGreaterThanOrEqual(teamSize);
      }

      for (let index = 0; index < arena.spawnPoints.length; index++) {
        const spawn = arena.spawnPoints[index]!;
        const spawnPosition = positionOf(spawn.position);
        for (let otherIndex = 0; otherIndex < index; otherIndex++) {
          expect(
            distance(spawnPosition, positionOf(arena.spawnPoints[otherIndex]!.position)),
            `${arena.id} spawns ${otherIndex}/${index} ship clearance`,
          ).toBeGreaterThanOrEqual(maxShipDiameter);
        }
        for (const placement of arena.asteroidPlacements) {
          const asteroidRadius = radii.get(placement.asteroidId)! * (placement.scale ?? 1);
          expect(
            distance(spawnPosition, positionOf(placement.position)),
            `${arena.id} spawn ${spawn.id} outside ${placement.asteroidId}`,
          ).toBeGreaterThan(asteroidRadius);
        }
      }
    });
  }
});

describe("shipped canyon arena geometry", () => {
  const arena = arenaSchema.parse(loadJson(`${CONTENT_ROOT}arenas/lunar-rift.json`));
  const props = new Map<string, PropConfig>(
    readdirSync(`${CONTENT_ROOT}props/`, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => {
        const prop = propSchema.parse(loadJson(`${CONTENT_ROOT}props/${entry.name}`));
        return [prop.id, prop] as const;
      }),
  );
  const propPlacements = arena.propPlacements ?? [];
  const tolerance = 1e-3;
  const twinOf = (position: Required<Vec3>) => ({ x: -position.x, y: position.y, z: -position.z });
  const hasTwin = (positions: readonly Required<Vec3>[], position: Required<Vec3>) =>
    positions.some((candidate) => distance(candidate, twinOf(position)) <= tolerance);

  it("pins the generated placement count and preserves 180-degree placement symmetry", () => {
    expect(arena.bounds.shape).toBe("box");
    // 124 generated (16 terrain chunks + 54 twinned pairs — the designer
    // removed both approach-beacon pairs in the hangar spawn rework) plus the
    // hand-authored He-3 extraction plant centrepiece, which sits on the
    // symmetry point itself and is therefore its own 180-degree twin — plus
    // the ten CTF spawn hangar bays (five per team, authored as twinned pairs).
    expect(propPlacements).toHaveLength(135);
    const placements = propPlacements.map((placement) => ({
      propId: placement.propId,
      position: positionOf(placement.position),
      category: props.get(placement.propId)?.category,
    }));

    for (const placement of placements) {
      // Terrain chunks tile the grid one cell at a time. They intentionally do
      // not use paired placement records; all authored gameplay props do.
      if (placement.category === "terrain") continue;
      expect(
        placements.some((candidate) => distance(candidate.position, twinOf(placement.position)) <= tolerance),
        `${placement.propId} at ${JSON.stringify(placement.position)} needs its 180-degree twin`,
      ).toBe(true);
    }
  });

  it("keeps spawns, flags, and nav nodes point-symmetric", () => {
    const spawns = arena.spawnPoints;
    for (const spawn of spawns) {
      const twin = spawns.find((candidate) =>
        candidate.team !== spawn.team && distance(positionOf(candidate.position), twinOf(positionOf(spawn.position))) <= tolerance,
      );
      expect(twin, `${spawn.id} needs a team-swapped twin`).toBeDefined();
      if (!twin) continue;
      const headingDelta = ((twin.heading - spawn.heading - Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
      expect(Math.min(headingDelta, Math.PI * 2 - headingDelta), `${spawn.id} twin heading`).toBeLessThanOrEqual(tolerance);
    }

    for (const flag of arena.flagBases ?? []) {
      expect(
        (arena.flagBases ?? []).some((candidate) => candidate.team !== flag.team && distance(positionOf(candidate.position), twinOf(positionOf(flag.position))) <= tolerance),
        `${flag.id} needs a team-swapped twin`,
      ).toBe(true);
    }

    const nodes = arena.navGraph?.nodes ?? [];
    for (const node of nodes) {
      expect(hasTwin(nodes.map((candidate) => positionOf(candidate.position)), positionOf(node.position)), `${node.id} needs a 180-degree twin`).toBe(true);
    }
  });

  it("has CTF spawn capacity, collider clearance, and strictly in-bounds objectives", () => {
    if (arena.bounds.shape !== "box") throw new Error("lunar-rift must remain a box arena");
    const ctfModes = readdirSync(`${CONTENT_ROOT}gamemodes/`, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => gamemodeSchema.parse(loadJson(`${CONTENT_ROOT}gamemodes/${entry.name}`)))
      .filter((mode) => mode.ctf !== undefined && mode.defaultArena === arena.id);
    expect(ctfModes.length).toBeGreaterThan(0);
    for (const mode of ctfModes) {
      const teamSize = Number.parseInt(mode.teams, 10);
      for (const team of [0, 1]) {
        expect(arena.spawnPoints.filter((spawn) => spawn.team === team).length, `${mode.id} team ${team} capacity`).toBeGreaterThanOrEqual(teamSize);
      }
    }
    for (let index = 0; index < arena.spawnPoints.length; index++) {
      const point = positionOf(arena.spawnPoints[index]!.position);
      for (let other = 0; other < index; other++) {
        expect(distance(point, positionOf(arena.spawnPoints[other]!.position)), `spawns ${other}/${index} clearance`).toBeGreaterThanOrEqual(maxShipDiameter);
      }
    }
    for (const point of [...arena.spawnPoints.map((spawn) => positionOf(spawn.position)), ...(arena.flagBases ?? []).map((flag) => positionOf(flag.position))]) {
      expect(Math.abs(point.x)).toBeLessThan(arena.bounds.width / 2);
      expect(Math.abs(point.z)).toBeLessThan(arena.bounds.height / 2);
      expect(point.y).toBeGreaterThan(arena.bounds.floorY);
      expect(point.y).toBeLessThan(arena.bounds.ceilingY);
    }
  });

  it("connects the flag-base nearest nav nodes", () => {
    const graph = arena.navGraph;
    const flags = arena.flagBases;
    expect(graph).toBeDefined();
    expect(flags).toHaveLength(2);
    if (!graph || !flags || flags.length !== 2) return;
    const nearest = (point: Required<Vec3>) => graph.nodes.reduce((best, node) =>
      distance(positionOf(node.position), point) < distance(positionOf(best.position), point) ? node : best,
    );
    const adjacency = new Map(graph.nodes.map((node) => [node.id, new Set<string>()]));
    for (const [from, to] of graph.links) {
      adjacency.get(from)!.add(to);
      adjacency.get(to)!.add(from);
    }
    const start = nearest(positionOf(flags[0]!.position)).id;
    const goal = nearest(positionOf(flags[1]!.position)).id;
    const visited = new Set([start]);
    const queue = [start];
    for (const current of queue) {
      for (const next of adjacency.get(current) ?? []) {
        if (!visited.has(next)) { visited.add(next); queue.push(next); }
      }
    }
    expect(visited.has(goal), `${start} must reach ${goal}`).toBe(true);
  });

  it("keeps authored box coordinates inside the projectile wire envelope", () => {
    const tuning = tuningSchema.parse(loadJson(`${CONTENT_ROOT}tuning/default.json`));
    const limit = WIRE_POSITION_LIMIT - (tuning.projectileBoundsMargin ?? DEFAULT_PROJECTILE_BOUNDS_MARGIN);
    if (arena.bounds.shape !== "box") throw new Error("lunar-rift must remain a box arena");
    for (const extent of [arena.bounds.width / 2, arena.bounds.height / 2, Math.abs(arena.bounds.floorY), Math.abs(arena.bounds.ceilingY)]) {
      expect(extent).toBeLessThanOrEqual(limit);
    }
    const points = [
      ...propPlacements.map((placement) => positionOf(placement.position)),
      ...arena.spawnPoints.map((spawn) => positionOf(spawn.position)),
      ...(arena.flagBases ?? []).map((flag) => positionOf(flag.position)),
      ...(arena.navGraph?.nodes ?? []).map((node) => positionOf(node.position)),
    ];
    for (const point of points) {
      expect(Math.abs(point.x)).toBeLessThanOrEqual(limit);
      expect(Math.abs(point.y)).toBeLessThanOrEqual(limit);
      expect(Math.abs(point.z)).toBeLessThanOrEqual(limit);
    }
  });

  it("loads every referenced collision prop through ConfigService", async () => {
    const configs = new ConfigService((rel) => Promise.resolve(loadJson(`${CONTENT_ROOT}${rel}`)));
    const result = await configs.load("manifest.json");
    expect(result.ok, JSON.stringify(result.errors)).toBe(true);
    for (const placement of propPlacements) {
      const prop = configs.get<PropConfig>("prop", placement.propId);
      expect(prop, `${placement.propId} must be registered`).toBeDefined();
      if (prop?.collision) expect(prop.collision.bounds).toBeDefined();
    }
  });
});
