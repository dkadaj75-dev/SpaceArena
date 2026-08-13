/**
 * The small hand-authored props: boulders, tunnel guide lights, the flag landing
 * pad and the team beacons. All procedural, all deterministic, all vertex
 * coloured so they sit in the same no-texture budget as the terrain.
 */
import { hash2, vnoise3 } from "./riftLib.js";
import type { Surface } from "./mesh.js";
import type { MaterialSpec, Part } from "./glb.js";

export type Vec = [number, number, number];

export const ROCK_MATERIAL: MaterialSpec = { name: "RIFT_ROCK", metallic: 0, roughness: 0.96, baseColor: [1, 1, 1, 1] };
export const DECK_MATERIAL: MaterialSpec = { name: "RIFT_DECK", metallic: 0.05, roughness: 0.72, baseColor: [1, 1, 1, 1] };
export const GLOW_WARM: MaterialSpec = {
  name: "RIFT_GLOW_WARM",
  metallic: 0,
  roughness: 0.4,
  baseColor: [0.06, 0.055, 0.05, 1],
  emissive: [1, 0.86, 0.66],
};
export const GLOW_BLUE: MaterialSpec = {
  name: "RIFT_GLOW_BLUE",
  metallic: 0,
  roughness: 0.35,
  baseColor: [0.04, 0.07, 0.1, 1],
  emissive: [0.27, 0.78, 1],
};
export const GLOW_RED: MaterialSpec = {
  name: "RIFT_GLOW_RED",
  metallic: 0,
  roughness: 0.35,
  baseColor: [0.1, 0.04, 0.05, 1],
  emissive: [1, 0.25, 0.36],
};

class Builder {
  readonly pos: number[] = [];
  readonly nrm: number[] = [];
  readonly col: number[] = [];
  readonly idx: number[] = [];

  vertex(p: Vec, n: Vec, c: Vec): number {
    const id = this.pos.length / 3;
    this.pos.push(p[0], p[1], p[2]);
    this.nrm.push(n[0], n[1], n[2]);
    this.col.push(c[0], c[1], c[2]);
    return id;
  }

  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }

  /** Flat-shaded quad, wound p0->p1->p2->p3. */
  quad(p0: Vec, p1: Vec, p2: Vec, p3: Vec, c: Vec): void {
    const n = faceNormal(p0, p1, p2);
    const a = this.vertex(p0, n, c), b = this.vertex(p1, n, c), d = this.vertex(p2, n, c), e = this.vertex(p3, n, c);
    this.tri(a, b, d);
    this.tri(a, d, e);
  }

  surface(): Surface {
    return {
      positions: Float32Array.from(this.pos),
      normals: Float32Array.from(this.nrm),
      colors: Float32Array.from(this.col),
      indices: Uint32Array.from(this.idx),
    };
  }
}

function faceNormal(a: Vec, b: Vec, c: Vec): Vec {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const l = Math.hypot(nx, ny, nz) || 1;
  return [nx / l, ny / l, nz / l];
}

// ---------- boulders ----------

interface Tri { a: number; b: number; c: number }

/** Octahedron subdivided `level` times and projected to the unit sphere. */
function icoSphere(level: number): { verts: Vec[]; tris: Tri[] } {
  const verts: Vec[] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  let tris: Tri[] = [
    { a: 0, b: 2, c: 4 }, { a: 2, b: 1, c: 4 }, { a: 1, b: 3, c: 4 }, { a: 3, b: 0, c: 4 },
    { a: 2, b: 0, c: 5 }, { a: 1, b: 2, c: 5 }, { a: 3, b: 1, c: 5 }, { a: 0, b: 3, c: 5 },
  ];
  for (let step = 0; step < level; step++) {
    const cache = new Map<string, number>();
    const next: Tri[] = [];
    const midpoint = (i: number, j: number): number => {
      const key = i < j ? `${i}_${j}` : `${j}_${i}`;
      const hit = cache.get(key);
      if (hit !== undefined) return hit;
      const p = verts[i]!, q = verts[j]!;
      const m: Vec = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2];
      const l = Math.hypot(m[0], m[1], m[2]) || 1;
      verts.push([m[0] / l, m[1] / l, m[2] / l]);
      const id = verts.length - 1;
      cache.set(key, id);
      return id;
    };
    for (const t of tris) {
      const ab = midpoint(t.a, t.b), bc = midpoint(t.b, t.c), ca = midpoint(t.c, t.a);
      next.push({ a: t.a, b: ab, c: ca }, { a: ab, b: t.b, c: bc }, { a: ca, b: bc, c: t.c }, { a: ab, b: bc, c: ca });
    }
    tris = next;
  }
  return { verts, tris };
}

export interface BoulderShape {
  readonly seed: number;
  readonly squashY: number;
  readonly stretchX: number;
  readonly rough: number;
}

export const BOULDER_SHAPES: Record<"a" | "b" | "c", BoulderShape> = {
  a: { seed: 2101, squashY: 0.78, stretchX: 1.12, rough: 1 },
  b: { seed: 2203, squashY: 0.94, stretchX: 1, rough: 0.82 },
  c: { seed: 2309, squashY: 0.66, stretchX: 1.28, rough: 1.18 },
};

/** Half-space set whose intersection is the boulder's angular core. */
function cleavagePlanes(shape: BoulderShape): { n: Vec; d: number }[] {
  const planes: { n: Vec; d: number }[] = [];
  for (let k = 0; k < 11; k++) {
    const u = hash2(k, 0, shape.seed + 701) * 2 - 1;
    const phi = hash2(k, 1, shape.seed + 703) * Math.PI * 2;
    const s = Math.sqrt(Math.max(0, 1 - u * u));
    planes.push({ n: [s * Math.cos(phi), u, s * Math.sin(phi)], d: 0.74 + 0.26 * hash2(k, 2, shape.seed + 707) });
  }
  return planes;
}

/**
 * Rock, not popcorn: a convex cleavage polytope blended with a noisy sphere,
 * then flat shaded. Lunar boulders are shattered ejecta — they want facets.
 */
function boulderPoint(unit: Vec, shape: BoulderShape, planes: readonly { n: Vec; d: number }[]): Vec {
  const s = shape.seed;
  const px = unit[0] * 2.1 + 11, py = unit[1] * 2.1 + 23, pz = unit[2] * 2.1 + 7;
  let blobby = 1;
  blobby += shape.rough * 0.26 * (vnoise3(px, py, pz, s) - 0.5);
  blobby += shape.rough * 0.15 * (vnoise3(px * 2.3, py * 2.3, pz * 2.3, s + 31) - 0.5);
  let faceted = Infinity;
  for (const plane of planes) {
    const dot = unit[0] * plane.n[0] + unit[1] * plane.n[1] + unit[2] * plane.n[2];
    if (dot > 1e-3) faceted = Math.min(faceted, plane.d / dot);
  }
  if (!Number.isFinite(faceted)) faceted = 1;
  let r = 0.52 * blobby + 0.48 * Math.min(faceted, 1.25);
  r += shape.rough * 0.055 * (vnoise3(px * 5.1, py * 5.1, pz * 5.1, s + 61) - 0.5);
  return [unit[0] * r * shape.stretchX, unit[1] * r * shape.squashY, unit[2] * r];
}

function buildBoulderGeometry(shape: BoulderShape, level: number): { verts: Vec[]; tris: Tri[] } {
  const sphere = icoSphere(level);
  const planes = cleavagePlanes(shape);
  const verts = sphere.verts.map((v) => boulderPoint(v, shape, planes));
  let maxR = 0;
  for (const v of verts) maxR = Math.max(maxR, Math.hypot(v[0], v[1], v[2]));
  const k = maxR > 0 ? 1 / maxR : 1;
  return { verts: verts.map((v): Vec => [v[0] * k, v[1] * k, v[2] * k]), tris: sphere.tris };
}

export function buildBoulder(shape: BoulderShape): Part {
  const { verts, tris } = buildBoulderGeometry(shape, 3);
  const builder = new Builder();
  const base: Vec = [0.4, 0.383, 0.36];
  for (const t of tris) {
    const a = verts[t.a]!, b = verts[t.b]!, c = verts[t.c]!;
    const n = faceNormal(a, b, c);
    const mx = (a[0] + b[0] + c[0]) / 3, my = (a[1] + b[1] + c[1]) / 3, mz = (a[2] + b[2] + c[2]) / 3;
    const mottle = 0.84 + 0.32 * vnoise3(mx * 3.3 + 5, my * 3.3, mz * 3.3, shape.seed + 91);
    // Self-shadowing stand-in: undersides sit in their own dust shadow.
    const ao = 0.42 + 0.58 * (0.5 + 0.5 * n[1]);
    const colour: Vec = [base[0] * mottle * ao, base[1] * mottle * ao, base[2] * mottle * ao];
    builder.tri(builder.vertex(a, n, colour), builder.vertex(b, n, colour), builder.vertex(c, n, colour));
  }
  return { surface: builder.surface(), material: ROCK_MATERIAL };
}

export function buildBoulderCollision(shape: BoulderShape): { positions: Float32Array; indices: Uint32Array } {
  const { verts, tris } = buildBoulderGeometry(shape, 2);
  const positions = new Float32Array(verts.length * 3);
  verts.forEach((p, i) => { positions[i * 3] = p[0]; positions[i * 3 + 1] = p[1]; positions[i * 3 + 2] = p[2]; });
  const indices = new Uint32Array(tris.length * 3);
  tris.forEach((t, i) => { indices[i * 3] = t.a; indices[i * 3 + 1] = t.b; indices[i * 3 + 2] = t.c; });
  return { positions, indices };
}

// ---------- guide light ----------

/** A 4u emissive strip with a dark housing; lives inside tunnel bores. */
export function buildGuideLight(): Part[] {
  const housing = new Builder();
  const hx = 2, hy = 0.16, hz = 0.28;
  box(housing, [-hx, -hy, -hz], [hx, hy, hz], [0.11, 0.105, 0.1]);
  const strip = new Builder();
  const sx = 1.85, sy = 0.1, sz = 0.14;
  box(strip, [-sx, -sy, -sz - 0.02], [sx, sy, sz + 0.02], [1, 0.9, 0.72]);
  return [
    { surface: housing.surface(), material: { name: "RIFT_FIXTURE", metallic: 0.1, roughness: 0.8, baseColor: [1, 1, 1, 1] } },
    { surface: strip.surface(), material: GLOW_WARM },
  ];
}

function box(b: Builder, min: Vec, max: Vec, colour: Vec): void {
  const [x0, y0, z0] = min, [x1, y1, z1] = max;
  b.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], colour);          // +y
  b.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], colour);          // -y
  b.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], colour);          // +z
  b.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], colour);          // -z
  b.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], colour);          // +x
  b.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], colour);          // -x
}

// ---------- flag pad ----------

const PAD_RADIUS = 10;
const PAD_HEIGHT = 1.2;
const PAD_SEGMENTS = 40;

export function buildFlagPad(): { parts: Part[]; collision: { positions: Float32Array; indices: Uint32Array } } {
  const deck = new Builder();
  const deckColour: Vec = [0.3, 0.31, 0.33];
  const rimColour: Vec = [0.22, 0.23, 0.25];
  const top: Vec[] = [], bottom: Vec[] = [];
  for (let s = 0; s < PAD_SEGMENTS; s++) {
    const a = (s / PAD_SEGMENTS) * Math.PI * 2;
    top.push([Math.cos(a) * PAD_RADIUS, PAD_HEIGHT, Math.sin(a) * PAD_RADIUS]);
    bottom.push([Math.cos(a) * PAD_RADIUS, 0, Math.sin(a) * PAD_RADIUS]);
  }
  const topCentre = deck.vertex([0, PAD_HEIGHT, 0], [0, 1, 0], deckColour);
  const topRing = top.map((p) => deck.vertex(p, [0, 1, 0], deckColour));
  for (let s = 0; s < PAD_SEGMENTS; s++) deck.tri(topCentre, topRing[(s + 1) % PAD_SEGMENTS]!, topRing[s]!);
  const bottomCentre = deck.vertex([0, 0, 0], [0, -1, 0], rimColour);
  const bottomRing = bottom.map((p) => deck.vertex(p, [0, -1, 0], rimColour));
  for (let s = 0; s < PAD_SEGMENTS; s++) deck.tri(bottomCentre, bottomRing[s]!, bottomRing[(s + 1) % PAD_SEGMENTS]!);
  for (let s = 0; s < PAD_SEGMENTS; s++) {
    const s1 = (s + 1) % PAD_SEGMENTS;
    deck.quad(bottom[s]!, top[s]!, top[s1]!, bottom[s1]!, rimColour);
  }

  const ring = new Builder();
  const glow: Vec = [1, 0.94, 0.8];
  for (let s = 0; s < PAD_SEGMENTS; s++) {
    const s1 = (s + 1) % PAD_SEGMENTS;
    const a0 = (s / PAD_SEGMENTS) * Math.PI * 2, a1 = (s1 / PAD_SEGMENTS) * Math.PI * 2;
    const inner = 8.3, outer = 9.1, y = PAD_HEIGHT + 0.03;
    ring.quad(
      [Math.cos(a0) * inner, y, Math.sin(a0) * inner],
      [Math.cos(a1) * inner, y, Math.sin(a1) * inner],
      [Math.cos(a1) * outer, y, Math.sin(a1) * outer],
      [Math.cos(a0) * outer, y, Math.sin(a0) * outer],
      glow,
    );
  }

  const collisionPositions: number[] = [];
  const collisionIndices: number[] = [];
  const push = (p: Vec): number => { collisionPositions.push(p[0], p[1], p[2]); return collisionPositions.length / 3 - 1; };
  const cTop = push([0, PAD_HEIGHT, 0]);
  const cBottom = push([0, 0, 0]);
  const cTopRing = top.map(push);
  const cBottomRing = bottom.map(push);
  for (let s = 0; s < PAD_SEGMENTS; s++) {
    const s1 = (s + 1) % PAD_SEGMENTS;
    collisionIndices.push(cTop, cTopRing[s]!, cTopRing[s1]!);
    collisionIndices.push(cBottom, cBottomRing[s1]!, cBottomRing[s]!);
    collisionIndices.push(cBottomRing[s]!, cTopRing[s]!, cTopRing[s1]!);
    collisionIndices.push(cBottomRing[s]!, cTopRing[s1]!, cBottomRing[s1]!);
  }

  return {
    parts: [
      { surface: deck.surface(), material: DECK_MATERIAL },
      { surface: ring.surface(), material: GLOW_WARM },
    ],
    collision: { positions: Float32Array.from(collisionPositions), indices: Uint32Array.from(collisionIndices) },
  };
}

// ---------- team beacon ----------

const BEACON_SIDES = 6;
const BEACON_HEIGHT = 7.5;

export function buildBeacon(team: "blue" | "red"): { parts: Part[]; collision: { positions: Float32Array; indices: Uint32Array } } {
  const pylon = new Builder();
  const shell: Vec = [0.26, 0.27, 0.29];
  const rings = [
    { y: 0, r: 1.05 },
    { y: BEACON_HEIGHT * 0.55, r: 0.72 },
    { y: BEACON_HEIGHT, r: 0.5 },
  ];
  for (let level = 0; level + 1 < rings.length; level++) {
    const lo = rings[level]!, hi = rings[level + 1]!;
    for (let s = 0; s < BEACON_SIDES; s++) {
      const a0 = (s / BEACON_SIDES) * Math.PI * 2, a1 = ((s + 1) / BEACON_SIDES) * Math.PI * 2;
      pylon.quad(
        [Math.cos(a0) * lo.r, lo.y, Math.sin(a0) * lo.r],
        [Math.cos(a0) * hi.r, hi.y, Math.sin(a0) * hi.r],
        [Math.cos(a1) * hi.r, hi.y, Math.sin(a1) * hi.r],
        [Math.cos(a1) * lo.r, lo.y, Math.sin(a1) * lo.r],
        shell,
      );
    }
  }
  const base = rings[0]!;
  const baseCentre = pylon.vertex([0, base.y, 0], [0, -1, 0], shell);
  const baseRing: number[] = [];
  for (let s = 0; s < BEACON_SIDES; s++) {
    const a = (s / BEACON_SIDES) * Math.PI * 2;
    baseRing.push(pylon.vertex([Math.cos(a) * base.r, base.y, Math.sin(a) * base.r], [0, -1, 0], shell));
  }
  for (let s = 0; s < BEACON_SIDES; s++) pylon.tri(baseCentre, baseRing[s]!, baseRing[(s + 1) % BEACON_SIDES]!);

  const head = new Builder();
  const headColour: Vec = team === "blue" ? [0.35, 0.8, 1] : [1, 0.35, 0.44];
  const hy = BEACON_HEIGHT + 1.15, hr = 1.15;
  const apexTop = head.vertex([0, hy + hr, 0], [0, 1, 0], headColour);
  const apexBottom = head.vertex([0, hy - hr, 0], [0, -1, 0], headColour);
  const belt: number[] = [];
  for (let s = 0; s < 8; s++) {
    const a = (s / 8) * Math.PI * 2;
    const p: Vec = [Math.cos(a) * hr, hy, Math.sin(a) * hr];
    const l = Math.hypot(p[0], 0, p[2]) || 1;
    belt.push(head.vertex(p, [p[0] / l, 0, p[2] / l], headColour));
  }
  for (let s = 0; s < 8; s++) {
    const s1 = (s + 1) % 8;
    head.tri(apexTop, belt[s1]!, belt[s]!);
    head.tri(apexBottom, belt[s]!, belt[s1]!);
  }

  const collisionPositions: number[] = [];
  const collisionIndices: number[] = [];
  const cRings: number[][] = [];
  for (const ring of [...rings, { y: hy + hr, r: 0.5 }]) {
    const ids: number[] = [];
    for (let s = 0; s < BEACON_SIDES; s++) {
      const a = (s / BEACON_SIDES) * Math.PI * 2;
      collisionPositions.push(Math.cos(a) * ring.r, ring.y, Math.sin(a) * ring.r);
      ids.push(collisionPositions.length / 3 - 1);
    }
    cRings.push(ids);
  }
  for (let level = 0; level + 1 < cRings.length; level++) {
    const lo = cRings[level]!, hi = cRings[level + 1]!;
    for (let s = 0; s < BEACON_SIDES; s++) {
      const s1 = (s + 1) % BEACON_SIDES;
      collisionIndices.push(lo[s]!, hi[s]!, hi[s1]!);
      collisionIndices.push(lo[s]!, hi[s1]!, lo[s1]!);
    }
  }

  return {
    parts: [
      { surface: pylon.surface(), material: DECK_MATERIAL },
      { surface: head.surface(), material: team === "blue" ? GLOW_BLUE : GLOW_RED },
    ],
    collision: { positions: Float32Array.from(collisionPositions), indices: Uint32Array.from(collisionIndices) },
  };
}
