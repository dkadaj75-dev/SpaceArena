/**
 * Lunar Rift terrain core — layout + height + albedo. Deterministic, dep-free.
 *
 * This is a FAITHFUL port of the visually-approved prototype (`rift-lib.mjs`).
 * The noise, the layout constants, `carveProfile`, `craterField`, `heightAt` and
 * `albedoAt` were iterated against rendered output and signed off; do not
 * redesign them. The only additions are:
 *   - `heightAtDetailed` — same field, but it also returns the `minOver` the
 *     original computed internally (distance past the nearest feature's flat
 *     floor edge), which the mesher needs to pick per-chunk resolution and to
 *     clip the collision mesh to reachable space.
 *   - `vnoise3`/`fbm3` — the 2D hash extended to a 3D lattice, for the
 *     mesh-stage displacement that the heightfield cannot carry.
 */

export type Pt = readonly [number, number];

// ---------- noise ----------
export function hash2(ix: number, iz: number, seed: number): number {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ ix, 0xcc9e2d51); h = (h << 13) | (h >>> 19); h = (Math.imul(h, 5) + 0xe6546b64) >>> 0;
  h = Math.imul(h ^ iz, 0x1b873593); h = (h << 15) | (h >>> 17); h = (Math.imul(h, 5) + 0x38495ab5) >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** The same murmur-style mixer with a third lattice axis folded in. */
export function hash3(ix: number, iy: number, iz: number, seed: number): number {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ ix, 0xcc9e2d51); h = (h << 13) | (h >>> 19); h = (Math.imul(h, 5) + 0xe6546b64) >>> 0;
  h = Math.imul(h ^ iy, 0x1b873593); h = (h << 15) | (h >>> 17); h = (Math.imul(h, 5) + 0x38495ab5) >>> 0;
  h = Math.imul(h ^ iz, 0x85ebca6b); h = (h << 17) | (h >>> 15); h = (Math.imul(h, 5) + 0x1b873593) >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const sm = (t: number): number => t * t * (3 - 2 * t);

export function vnoise(x: number, z: number, seed: number): number {
  const ix = Math.floor(x), iz = Math.floor(z), fx = x - ix, fz = z - iz;
  const a = hash2(ix, iz, seed), b = hash2(ix + 1, iz, seed), c = hash2(ix, iz + 1, seed), d = hash2(ix + 1, iz + 1, seed);
  const u = sm(fx), v = sm(fz);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

export function fbm(x: number, z: number, seed: number, oct = 5, lac = 2.03, gain = 0.5): number {
  let amp = 0.5, f = 1, sum = 0, norm = 0;
  for (let i = 0; i < oct; i++) { sum += amp * vnoise(x * f, z * f, seed + i * 101); norm += amp; amp *= gain; f *= lac; }
  return sum / norm;
}

/** Trilinear value noise on the 3D lattice, 0..1. */
export function vnoise3(x: number, y: number, z: number, seed: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const u = sm(x - ix), v = sm(y - iy), w = sm(z - iz);
  const c000 = hash3(ix, iy, iz, seed), c100 = hash3(ix + 1, iy, iz, seed);
  const c010 = hash3(ix, iy + 1, iz, seed), c110 = hash3(ix + 1, iy + 1, iz, seed);
  const c001 = hash3(ix, iy, iz + 1, seed), c101 = hash3(ix + 1, iy, iz + 1, seed);
  const c011 = hash3(ix, iy + 1, iz + 1, seed), c111 = hash3(ix + 1, iy + 1, iz + 1, seed);
  const x00 = c000 + (c100 - c000) * u, x10 = c010 + (c110 - c010) * u;
  const x01 = c001 + (c101 - c001) * u, x11 = c011 + (c111 - c011) * u;
  const y0 = x00 + (x10 - x00) * v, y1 = x01 + (x11 - x01) * v;
  return y0 + (y1 - y0) * w;
}

// ---------- layout (authored south side; twin = 180° rotation) ----------
// CEILING is load-bearing for collision correctness, not just a gameplay cap:
// buildChunkCollision culls highland faces "a ship cannot enter", which is only
// true while ship centers (<= CEILING - radius) stay below the lowest culled
// highland surface (~73.3). Raising CEILING lets hulls descend inside culled
// rock. KILL_FLOOR sits far below the deepest reachable carve (~-10.7); the
// -26 seen in collision bounds is the unreachable CSG basement (SOLID_BOTTOM),
// not terrain a ship can touch.
export const H_TOP = 80, CEILING = 74, KILL_FLOOR = -20;
export const TEAM = { c: [0, -255] as Pt, r: 112, floor: 4, rim: 3.5 };
export const MID = { c: [0, 0] as Pt, r: 98, floor: -8, rim: 4.5 };

export interface Lane { readonly pts: readonly Pt[]; readonly width: number; readonly floor: number }
export interface Tunnel { readonly a: Pt; readonly b: Pt; readonly r: number; readonly portalY: number }
export interface Crater { readonly c: Pt; readonly r: number; readonly floor: number; readonly rim: number }

export const LANES_SOUTH: readonly Lane[] = [
  { pts: [[0, -143], [22, -120], [0, -98]], width: 34, floor: 0 },
  { pts: [[-108, -225], [-210, -145], [-252, 0], [-210, 145], [-108, 225]], width: 36, floor: 0 },
];
export const MOUTHS_SOUTH: readonly Lane[] = [
  { pts: [[0, -166], [0, -143]], width: 30, floor: 2 },
  { pts: [[-88, -247], [-108, -225]], width: 30, floor: 2 },
  { pts: [[88, -247], [108, -225]], width: 30, floor: 2 },
  { pts: [[0, -98], [0, -80]], width: 32, floor: -4 },
];
export const TUNNELS_SOUTH: readonly Tunnel[] = [
  { a: [-205, -95], b: [-68, -68], r: 7.5, portalY: 12 },
  { a: [-205, 95], b: [-68, 68], r: 7.5, portalY: 12 },
];

export const rot180 = (p: Pt): Pt => [-p[0], -p[1]];
const twinLane = (l: Lane): Lane => ({ ...l, pts: l.pts.map(rot180) });

export const LANES: readonly Lane[] = [...LANES_SOUTH, ...LANES_SOUTH.map(twinLane)];
export const MOUTHS: readonly Lane[] = [...MOUTHS_SOUTH, ...MOUTHS_SOUTH.map(twinLane)];
export const TUNNELS: readonly Tunnel[] = [
  ...TUNNELS_SOUTH,
  ...TUNNELS_SOUTH.map((t) => ({ ...t, a: rot180(t.a), b: rot180(t.b) })),
];
export const CRATERS: readonly Crater[] = [{ ...TEAM }, { ...TEAM, c: rot180(TEAM.c) }, { ...MID }];

export interface SpawnPoint { id: string; team: number; position: { x: number; y: number; z: number }; heading: number }
export const SPAWNS: readonly SpawnPoint[] = (() => {
  const out: SpawnPoint[] = [];
  [-28, -14, 0, 14, 28].forEach((x, i) => {
    out.push({ id: `sp-blue-${i + 1}`, team: 0, position: { x, y: 8, z: -278 }, heading: Math.PI / 2 });
    out.push({ id: `sp-red-${i + 1}`, team: 1, position: { x: -x, y: 8, z: 278 }, heading: -Math.PI / 2 });
  });
  return out;
})();

export interface FlagBase { id: string; team: number; position: { x: number; y: number; z: number }; radius: number }
export const FLAGS: readonly FlagBase[] = [
  { id: "flag-base-blue", team: 0, position: { x: 0, y: 6, z: -255 }, radius: 16 },
  { id: "flag-base-red", team: 1, position: { x: 0, y: 6, z: 255 }, radius: 16 },
];

// ---------- height ----------
export function segDist(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const abx = bx - ax, abz = bz - az;
  const t = Math.max(0, Math.min(1, ((px - ax) * abx + (pz - az) * abz) / (abx * abx + abz * abz)));
  return Math.hypot(px - (ax + abx * t), pz - (az + abz * t));
}

export function polylineDist(px: number, pz: number, pts: readonly Pt[]): number {
  let d = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) d = Math.min(d, segDist(px, pz, pts[i]![0], pts[i]![1], pts[i + 1]![0], pts[i + 1]![1]));
  return d;
}

function smin(a: number, b: number, k: number): number {
  const h = Math.max(0, Math.min(1, 0.5 + 0.5 * (b - a) / k));
  return b + (a - b) * h - k * h * (1 - h);
}

export const WALL_RUN = 16;

/** Wall profile: near-sheer with subtle broken strata + talus foot. */
function carveProfile(d: number, halfW: number, floorY: number, topY: number, sx: number, sz: number): number {
  const over = d - halfW;
  if (over <= 0) return floorY + 0.35 * (fbm(sx * 0.22, sz * 0.22, 787, 3) - 0.5);
  if (over >= WALL_RUN) return topY;
  let t = over / WALL_RUN;
  // subtle strata: sine ledges with laterally drifting phase + band-count variation
  const bandN = 5 + 4 * vnoise(sx * 0.006, sz * 0.006, 717);
  const phase = 6.28 * fbm(sx * 0.012, sz * 0.012, 727, 2);
  const strataAmp = 0.05 * (0.4 + 0.6 * fbm(sx * 0.02 + 77, sz * 0.02, 767, 2));
  const strata = strataAmp * Math.sin(t * bandN * 6.28 + phase) * Math.sin(Math.PI * t);
  // fine wall roughness (fracture faces)
  const rough = 0.04 * (fbm(sx * 0.07, sz * 0.07, 737, 4) - 0.5) * Math.sin(Math.PI * t);
  t = Math.max(0, Math.min(1, t + strata + rough));
  const s = t * t * (3 - 2 * t);
  let y = floorY + (topY - floorY) * s;
  // talus apron over the first ~6 units
  if (over < 8) {
    const talusN = fbm(sx * 0.09 + 55, sz * 0.09, 747, 3);
    y += (1 - over / 8) * 3.2 * talusN * talusN;
  }
  // crisp broken lip right at the top edge
  if (over > WALL_RUN - 2.2) {
    const lipN = fbm(sx * 0.07 - 99, sz * 0.07, 757, 3);
    y += (1 - (WALL_RUN - over) / 2.2) * 1.6 * (lipN - 0.35);
  }
  return y;
}

/** Impact-crater field: jittered-grid craters at one scale. Classic bowl + raised rim. */
function craterField(x: number, z: number, cellSize: number, seed: number, chance: number, maxR: number, maxDepth: number): number {
  const ci = Math.floor(x / cellSize), cj = Math.floor(z / cellSize);
  let dh = 0;
  for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
    const gi = ci + di, gj = cj + dj;
    if (hash2(gi, gj, seed) > chance) continue;
    const cx = (gi + 0.15 + 0.7 * hash2(gi, gj, seed + 1)) * cellSize;
    const cz = (gj + 0.15 + 0.7 * hash2(gi, gj, seed + 2)) * cellSize;
    // power-law-ish sizes: many small, few big
    const u = hash2(gi, gj, seed + 3);
    const r = maxR * (0.25 + 0.75 * u * u);
    const d = Math.hypot(x - cx, z - cz) / r;
    if (d >= 1.35) continue;
    const depth = maxDepth * (r / maxR);
    const rimH = depth * 0.09;
    if (d < 1) dh += depth * (d * d - 1) + rimH;                  // bowl, center = -depth + rim
    else dh += rimH * (1 - sm((d - 1) / 0.35));                   // sharp raised rim falloff
  }
  return dh;
}

export interface HeightSample {
  /** Terrain height. */
  h: number;
  /**
   * Distance past the nearest carved feature's flat floor edge: <= 0 on floors,
   * >= WALL_RUN on untouched highland, in between on a wall face.
   */
  minOver: number;
}

export function heightAtDetailed(x: number, z: number): HeightSample {
  const warp = 7 * (fbm(x * 0.021 + 31, z * 0.021 - 17, 909, 3) - 0.5);
  // buttress warp: medium-frequency spurs pushing walls in/out
  const buttress = 5.5 * (fbm(x * 0.017 - 61, z * 0.017 + 43, 919, 3) - 0.5);
  const wx = x + warp, wz = z - warp;
  let h = H_TOP + 5.5 * (fbm(x * 0.008, z * 0.008, 101, 4) - 0.5);
  // highland regolith texture
  h += 1.5 * (fbm(x * 0.045, z * 0.045, 111, 4) - 0.5);
  // track distance past each feature's flat floor edge: <=0 on floors, >=WALL_RUN on highland
  let minOver = Infinity;
  for (const l of LANES) {
    const edgeNoise = buttress + 2.2 * (fbm(wx * 0.055, wz * 0.055, 202, 4) - 0.5);
    const d = polylineDist(wx, wz, l.pts);
    minOver = Math.min(minOver, d + edgeNoise - l.width / 2);
    const floorRelief = l.floor + 2.2 * (fbm(x * 0.035, z * 0.035, 303, 4) - 0.5) + 0.7 * (fbm(x * 0.11, z * 0.11, 313, 3) - 0.5);
    h = smin(carveProfile(d + edgeNoise, l.width / 2, floorRelief, H_TOP, x, z), h, 6);
  }
  for (const m of MOUTHS) {
    const edgeNoise = buttress * 0.6 + 1.8 * (fbm(wx * 0.055, wz * 0.055, 208, 4) - 0.5);
    const d = polylineDist(wx, wz, m.pts);
    minOver = Math.min(minOver, d + edgeNoise - m.width / 2);
    const floorRelief = m.floor + 1.4 * (fbm(x * 0.035, z * 0.035, 303, 4) - 0.5);
    h = smin(carveProfile(d + edgeNoise, m.width / 2, floorRelief, H_TOP, x, z), h, 9);
  }
  for (const c of CRATERS) {
    const d = Math.hypot(wx - c.c[0], wz - c.c[1]);
    const rimNoise = 2.5 * (fbm(Math.atan2(wz - c.c[1], wx - c.c[0]) * 18 + 40, d * 0.05, 414, 3) - 0.5);
    const bowlFloor = c.floor + 1.6 * (fbm(x * 0.045 + 7, z * 0.045, 404, 4) - 0.5) + 0.5 * (fbm(x * 0.12, z * 0.12, 424, 3) - 0.5);
    minOver = Math.min(minOver, d + rimNoise - (c.r - WALL_RUN * 0.4));
    const bowl = carveProfile(d + rimNoise, c.r - WALL_RUN * 0.4, bowlFloor, H_TOP + c.rim, x, z);
    h = smin(bowl, h, 8);
    if (d > c.r && d < c.r + 40) h += (1 - (d - c.r) / 40) * 2.2 * fbm(x * 0.09, z * 0.09, 505, 3);
  }
  // crater fields masked by carve distance: highland gets the full field, floors a light
  // young-surface field, wall faces (0 < minOver < WALL_RUN) almost none.
  const highlandMask = sm(Math.max(0, Math.min(1, (minOver - WALL_RUN) / 8)));
  const floorMask2 = sm(Math.max(0, Math.min(1, -minOver / 4)));
  if (highlandMask > 0.01) {
    const clusters = 0.55 + 0.45 * fbm(x * 0.006 - 300, z * 0.006 + 300, 171, 2);
    h += (craterField(x, z, 90, 121, 0.5 * clusters, 26, 5.0) +
          craterField(x, z, 38, 131, 0.5 * clusters, 10, 2.4) +
          craterField(x, z, 15, 141, 0.5, 4, 1.0)) * highlandMask;
  }
  if (floorMask2 > 0.01) {
    h += (craterField(x, z, 40, 149, 0.4, 12, 2.0) +
          craterField(x, z, 26, 151, 0.4, 7, 1.4) +
          craterField(x, z, 11, 161, 0.35, 2.6, 0.5)) * floorMask2;
  }
  return { h, minOver };
}

export function heightAt(x: number, z: number): number {
  return heightAtDetailed(x, z).h;
}

// ---------- vertex color (albedo pre-AO) ----------
/** Returns [r,g,b] 0..1. slope = radians from horizontal. */
export function albedoAt(x: number, z: number, y: number, slope: number): [number, number, number] {
  const dustNoise = fbm(x * 0.05 + 900, z * 0.05, 808, 3);
  const mottle = 0.9 + 0.2 * fbm(x * 0.018 + 500, z * 0.018 - 500, 818, 4);   // large patches
  const grain = 0.92 + 0.16 * fbm(x * 0.35, z * 0.35, 828, 3);                 // fine grain
  // strata band tint on steep faces
  const band = Math.floor(((y + 24) / (H_TOP + 30)) * 9);
  const bandTint = 0.88 + 0.24 * hash2(band, 17, 111) - 0.12;
  const rock: [number, number, number] = [0.35 * bandTint, 0.33075 * bandTint, 0.308 * bandTint];
  const regolith: [number, number, number] = [0.43 + 0.05 * dustNoise, 0.419592 + 0.045 * dustNoise, 0.399592 + 0.04 * dustNoise];
  const scree: [number, number, number] = [0.385, 0.36925, 0.34825];
  const sFlat = Math.max(0, Math.min(1, (slope - 0.35) / 0.35));
  const sSteep = Math.max(0, Math.min(1, (slope - 0.78) / 0.35));
  const out: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const mix1 = regolith[i]! * (1 - sFlat) + scree[i]! * sFlat;
    out[i] = (mix1 * (1 - sSteep) + rock[i]! * sSteep) * mottle * grain;
  }
  return out;
}
