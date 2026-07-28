import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

type Vec3 = { x: number; y: number; z: number };
type Placement = {
  asteroidId: string;
  position: Vec3;
  rotation: number;
  scale: number;
};
type ArenaRecipe = {
  path: string;
  seed: number;
  boundsRadius: number;
  corridor: readonly [Vec3, Vec3];
  spawnPoints: readonly Vec3[];
  ids: readonly string[];
  radialRange: readonly [number, number];
  minSurfaceGap: number;
};

const asteroidRadii: Record<string, number> = {
  "asteroid.small-rock": 3.5,
  "asteroid.small-rock-b": 3.5,
  "asteroid.large-hazard": 8,
  "asteroid.large-hazard-b": 8,
  "asteroid.colossal-a": 18,
  "asteroid.colossal-b": 18,
};

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function distanceToSegment(p: Vec3, a: Vec3, b: Vec3): number {
  const ab = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
  const ap = { x: p.x - a.x, y: p.y - a.y, z: p.z - a.z };
  const denominator = ab.x * ab.x + ab.y * ab.y + ab.z * ab.z;
  const t = Math.max(0, Math.min(1, (ap.x * ab.x + ap.y * ab.y + ap.z * ab.z) / denominator));
  return distance(p, { x: a.x + ab.x * t, y: a.y + ab.y * t, z: a.z + ab.z * t });
}

function radiusOf(placement: Placement): number {
  return asteroidRadii[placement.asteroidId]! * placement.scale;
}

function rounded(value: number): number {
  return Math.round(value * 10) / 10;
}

function randomDirection(random: () => number): Vec3 {
  const y = random() * 2 - 1;
  const angle = random() * Math.PI * 2;
  const planar = Math.sqrt(1 - y * y);
  return { x: planar * Math.cos(angle), y, z: planar * Math.sin(angle) };
}

function shuffled<T>(values: readonly T[], random: () => number): T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [result[index], result[other]] = [result[other]!, result[index]!];
  }
  return result;
}

function accepts(placement: Placement, accepted: readonly Placement[], recipe: ArenaRecipe): boolean {
  const radius = radiusOf(placement);
  if (Math.hypot(placement.position.x, placement.position.y, placement.position.z) + radius > recipe.boundsRadius) {
    return false;
  }
  if (distanceToSegment(placement.position, recipe.corridor[0], recipe.corridor[1]) - radius < 25) {
    return false;
  }
  if (
    placement.asteroidId.startsWith("asteroid.colossal") &&
    recipe.spawnPoints.some((spawn) => distance(placement.position, spawn) - radius < 30)
  ) {
    return false;
  }
  return accepted.every(
    (other) => distance(placement.position, other.position) - radius - radiusOf(other) >= recipe.minSurfaceGap,
  );
}

function generate(recipe: ArenaRecipe): Placement[] {
  const random = mulberry32(recipe.seed);
  const accepted: Placement[] = [];
  // Place the largest colliders first, then shuffle within size classes. This
  // guarantees the authored colossal count without making later packing brittle.
  const orderedIds = [
    ...shuffled(recipe.ids.filter((id) => id.startsWith("asteroid.colossal")), random),
    ...shuffled(recipe.ids.filter((id) => id.startsWith("asteroid.large")), random),
    ...shuffled(recipe.ids.filter((id) => id.startsWith("asteroid.small")), random),
  ];

  for (const asteroidId of orderedIds) {
    let placed = false;
    for (let attempt = 0; attempt < 100_000; attempt++) {
      const direction = randomDirection(random);
      // Uniform-in-volume sampling within a shell keeps the field volumetric
      // while leaving the central spawn/fight lane readable.
      const [inner, outer] = recipe.radialRange;
      const magnitude = Math.cbrt(inner ** 3 + random() * (outer ** 3 - inner ** 3));
      const placement: Placement = {
        asteroidId,
        position: {
          x: rounded(direction.x * magnitude),
          y: rounded(direction.y * magnitude),
          z: rounded(direction.z * magnitude),
        },
        rotation: rounded(random() * Math.PI),
        scale: rounded(0.85 + random() * 0.3),
      };
      if (accepts(placement, accepted, recipe)) {
        accepted.push(placement);
        placed = true;
        break;
      }
    }
    if (!placed) throw new Error(`could not place ${asteroidId} in ${recipe.path}`);
  }
  return accepted;
}

function repeated(a: string, b: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => (index % 2 === 0 ? a : b));
}

const deepField = generate({
  path: "content/arenas/deep-field.json",
  seed: 0xdee9f13d,
  boundsRadius: 210,
  corridor: [
    { x: -49, y: 2.3, z: -49 },
    { x: 49, y: -2.3, z: 49 },
  ],
  spawnPoints: [
    { x: -49, y: 7, z: -49 },
    { x: -61.6, y: -4.2, z: -36.4 },
    { x: -36.4, y: 4.2, z: -61.6 },
    { x: 49, y: -7, z: 49 },
    { x: 61.6, y: 4.2, z: 36.4 },
    { x: 36.4, y: -4.2, z: 61.6 },
  ],
  ids: [
    ...repeated("asteroid.colossal-a", "asteroid.colossal-b", 5),
    ...repeated("asteroid.large-hazard", "asteroid.large-hazard-b", 25),
    ...repeated("asteroid.small-rock", "asteroid.small-rock-b", 60),
  ],
  radialRange: [82, 194],
  minSurfaceGap: 12,
});

const ringNebula = generate({
  path: "content/arenas/ring-nebula.json",
  seed: 0x91a6eb7a,
  boundsRadius: 63,
  corridor: [
    { x: -41.7, y: 0, z: -34.7 },
    { x: 41.7, y: 0, z: 34.7 },
  ],
  spawnPoints: [
    { x: -38.5, y: 7, z: -38.5 },
    { x: -44.8, y: -7, z: -30.8 },
    { x: 38.5, y: -7, z: 38.5 },
    { x: 44.8, y: 7, z: 30.8 },
  ],
  ids: [
    ...repeated("asteroid.large-hazard", "asteroid.large-hazard-b", 4),
    ...repeated("asteroid.small-rock", "asteroid.small-rock-b", 10),
  ],
  radialRange: [38, 57],
  minSurfaceGap: 12,
});

function placementLine(placement: Placement): string {
  return `    { "asteroidId": "${placement.asteroidId}", "position": { "x": ${placement.position.x}, "y": ${placement.position.y}, "z": ${placement.position.z} }, "rotation": ${placement.rotation}, "scale": ${placement.scale} }`;
}

function writePlacements(relativePath: string, placements: readonly Placement[]): void {
  const target = resolve(relativePath);
  const source = readFileSync(target, "utf8");
  const replacement = `"asteroidPlacements": [\n${placements.map(placementLine).join(",\n")}\n  ],`;
  const placementBlock = /"asteroidPlacements": \[[\s\S]*?\n {2}\],/;
  if (!placementBlock.test(source)) throw new Error(`asteroidPlacements block not found in ${relativePath}`);
  writeFileSync(target, source.replace(placementBlock, replacement));
  console.log(`${relativePath}: ${placements.length} placements`);
}

writePlacements("content/arenas/deep-field.json", deepField);
writePlacements("content/arenas/ring-nebula.json", ringNebula);
