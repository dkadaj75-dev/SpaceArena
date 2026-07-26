import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

type Vec3 = { x: number; y: number; z: number };
type Placement = {
  asteroidId: string;
  position: Vec3;
  rotation?: number;
  scale?: number;
};

const asteroidRadii: Record<string, number> = {
  "asteroid.small-rock": 3.5,
  "asteroid.small-rock-b": 3.5,
  "asteroid.large-hazard": 8,
  "asteroid.large-hazard-b": 8,
};
const asteroidIds = Object.keys(asteroidRadii);

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

function radiusOf(p: Placement): number {
  return asteroidRadii[p.asteroidId]! * (p.scale ?? 1);
}

function rounded(n: number): number {
  return Math.round(n * 10) / 10;
}

function randomDirection(random: () => number): Vec3 {
  const y = random() * 2 - 1;
  const angle = random() * Math.PI * 2;
  const planar = Math.sqrt(1 - y * y);
  return { x: planar * Math.cos(angle), y, z: planar * Math.sin(angle) };
}

function candidate(
  random: () => number,
  position: Vec3,
  index: number,
  forceSmall = false,
): Placement {
  const pool = forceSmall ? asteroidIds.slice(0, 2) : asteroidIds;
  const asteroidId = pool[index % pool.length]!;
  return {
    asteroidId,
    position: { x: rounded(position.x), y: rounded(position.y), z: rounded(position.z) },
    rotation: rounded(random() * Math.PI),
    scale: rounded(0.85 + random() * 0.5),
  };
}

function accepts(
  placement: Placement,
  accepted: readonly Placement[],
  maxExtent: number,
  corridor: readonly [Vec3, Vec3],
): boolean {
  const radius = radiusOf(placement);
  if (Math.hypot(placement.position.x, placement.position.y, placement.position.z) + radius > maxExtent) return false;
  if (distanceToSegment(placement.position, corridor[0], corridor[1]) - radius < 25) return false;
  return accepted.every((other) => distance(placement.position, other.position) - radius - radiusOf(other) >= 12);
}

function addAround(
  accepted: Placement[],
  random: () => number,
  anchor: Vec3,
  count: number,
  spread: number,
  maxExtent: number,
  corridor: readonly [Vec3, Vec3],
): void {
  for (let local = 0; local < count; local++) {
    let placed = false;
    for (let attempt = 0; attempt < 20_000; attempt++) {
      const direction = randomDirection(random);
      const magnitude = spread * (0.35 + random() * 0.65);
      const p = candidate(
        random,
        {
          x: anchor.x + direction.x * magnitude,
          y: anchor.y + direction.y * magnitude,
          z: anchor.z + direction.z * magnitude,
        },
        accepted.length,
      );
      if (accepts(p, accepted, maxExtent, corridor)) {
        accepted.push(p);
        placed = true;
        break;
      }
    }
    if (!placed) throw new Error(`could not fill cluster at ${JSON.stringify(anchor)}`);
  }
}

function addString(
  accepted: Placement[],
  random: () => number,
  start: Vec3,
  end: Vec3,
  count: number,
  maxExtent: number,
  corridor: readonly [Vec3, Vec3],
): void {
  for (let index = 0; index < count; index++) {
    let placed = false;
    const t = index / (count - 1);
    for (let attempt = 0; attempt < 20_000; attempt++) {
      const jitter = randomDirection(random);
      const position = {
        x: start.x + (end.x - start.x) * t + jitter.x * 12,
        y: start.y + (end.y - start.y) * t + jitter.y * 12,
        z: start.z + (end.z - start.z) * t + jitter.z * 12,
      };
      const p = candidate(random, position, accepted.length);
      if (accepts(p, accepted, maxExtent, corridor)) {
        accepted.push(p);
        placed = true;
        break;
      }
    }
    if (!placed) throw new Error(`could not fill string from ${JSON.stringify(start)}`);
  }
}

function deepField(): Placement[] {
  const random = mulberry32(0xdee9f13d);
  const placements: Placement[] = [];
  const corridor = [
    { x: -70, y: 10 / 3, z: -70 },
    { x: 70, y: -10 / 3, z: 70 },
  ] as const;

  addAround(placements, random, { x: -105, y: 178, z: 68 }, 8, 58, 315, corridor);
  addAround(placements, random, { x: 110, y: -182, z: -65 }, 8, 58, 315, corridor);
  addString(
    placements,
    random,
    { x: -225, y: 92, z: -92 },
    { x: -100, y: 232, z: -118 },
    7,
    315,
    corridor,
  );
  addString(
    placements,
    random,
    { x: 225, y: -92, z: 92 },
    { x: 100, y: -232, z: 118 },
    7,
    315,
    corridor,
  );
  addAround(placements, random, { x: 65, y: 232, z: -35 }, 5, 52, 315, corridor);
  addAround(placements, random, { x: -65, y: -232, z: 35 }, 5, 52, 315, corridor);

  for (const targetY of [35, -55, 85, -110, 135, -165, 205]) {
    let placed = false;
    for (let attempt = 0; attempt < 20_000; attempt++) {
      const angle = random() * Math.PI * 2;
      const planarRadius = 165 + random() * 80;
      const p = candidate(
        random,
        {
          x: Math.cos(angle) * planarRadius,
          y: targetY + (random() * 2 - 1) * 8,
          z: Math.sin(angle) * planarRadius,
        },
        placements.length,
        true,
      );
      if (accepts(p, placements, 315, corridor)) {
        placements.push(p);
        placed = true;
        break;
      }
    }
    if (!placed) throw new Error(`could not place sparse fill near y=${targetY}`);
  }
  return placements;
}

function ringNebula(): Placement[] {
  const random = mulberry32(0x91a6eb7a);
  const corridor = [
    { x: -59.5, y: 0, z: -49.5 },
    { x: 59.5, y: 0, z: 49.5 },
  ] as const;
  const anchors: Vec3[] = [
    { x: -42, y: 44, z: -2 },
    { x: -16, y: 55, z: 21 },
    { x: 18, y: 47, z: -30 },
    { x: 40, y: -45, z: 1 },
    { x: 14, y: -55, z: -23 },
    { x: -21, y: -47, z: 32 },
    { x: 59, y: 34, z: 15 },
    { x: -57, y: -34, z: -17 },
    { x: 4, y: 54, z: 48 },
    { x: -7, y: -53, z: -48 },
  ];
  const placements: Placement[] = [];

  for (const anchor of anchors) {
    let placed = false;
    for (let attempt = 0; attempt < 20_000; attempt++) {
      const direction = randomDirection(random);
      const p = candidate(
        random,
        {
          x: anchor.x + direction.x * 3,
          y: anchor.y + direction.y * 3,
          z: anchor.z + direction.z * 3,
        },
        placements.length,
        placements.length >= 6,
      );
      if (accepts(p, placements, 90, corridor)) {
        placements.push(p);
        placed = true;
        break;
      }
    }
    if (!placed) throw new Error(`could not place ring-nebula anchor ${JSON.stringify(anchor)}`);
  }
  return placements;
}

function placementLine(p: Placement): string {
  const extras = `${p.rotation === undefined ? "" : `, "rotation": ${p.rotation}`}${
    p.scale === undefined ? "" : `, "scale": ${p.scale}`
  }`;
  return `    { "asteroidId": "${p.asteroidId}", "position": { "x": ${p.position.x}, "y": ${p.position.y}, "z": ${p.position.z} }${extras} }`;
}

function writePlacements(relativePath: string, placements: readonly Placement[]): void {
  const path = resolve(relativePath);
  const source = readFileSync(path, "utf8");
  const replacement = `"asteroidPlacements": [\n${placements.map(placementLine).join(",\n")}\n  ],`;
  const placementBlock = /"asteroidPlacements": \[[\s\S]*?\n {2}\],/;
  if (!placementBlock.test(source)) throw new Error(`asteroidPlacements block not found in ${relativePath}`);
  const next = source.replace(placementBlock, replacement);
  writeFileSync(path, next);
}

writePlacements("content/arenas/deep-field.json", deepField());
writePlacements("content/arenas/ring-nebula.json", ringNebula());
