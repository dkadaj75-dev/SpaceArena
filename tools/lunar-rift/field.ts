/**
 * The sampled Lunar Rift field: one global height/minOver grid, a horizon AO
 * grid derived from it, the mesh-stage displacement, tunnel bore geometry and
 * the final vertex-colour recipe.
 *
 * Everything downstream (visual mesh, LOD1, collision mesh, preview, checks)
 * reads THIS object, so the visual surface, the collision surface and the QA
 * render are guaranteed to agree. Normals and AO come from the global grid
 * rather than from per-chunk topology, which is what keeps shading continuous
 * across chunk seams.
 */
import {
  CEILING,
  H_TOP,
  TUNNELS,
  WALL_RUN,
  albedoAt,
  fbm,
  heightAtDetailed,
  vnoise,
  vnoise3,
  type Tunnel,
} from "./riftLib.js";

export const WORLD_EXT = 384;
/** Height/minOver lattice pitch. 1u resolves everything `heightAt` carries. */
export const GRID_CELL = 1;
export const GRID_N = (WORLD_EXT * 2) / GRID_CELL + 1;
/** AO is low frequency; marching it at 2u costs a quarter as much. */
export const AO_CELL = 2;
export const AO_N = (WORLD_EXT * 2) / AO_CELL + 1;

/** Displacement ramps in between these slopes (radians). */
const DISP_SLOPE_LO = (40 * Math.PI) / 180;
const DISP_SLOPE_HI = (70 * Math.PI) / 180;
const DISP_AMP = 1.3;
/**
 * Amplitude of the horizontal fracture bands that break up the flutes. The
 * brief suggested ~0.5u; that vanishes against the carve profile's +-5u lateral
 * flute noise, so it is dialled up until the bands actually read.
 */
const BAND_AMP = 1.1;
/** Coarsest banding a wall vertex column can carry; see strataSampleLimit. */
const STRATA_PERIOD = 50;
/** Peak outward radial roughness on a tunnel bore. */
const BORE_AMP = 0.7;
/** Bore interior material: fresh fractured rock, warmer + darker than regolith. */
const BORE_ALBEDO: readonly [number, number, number] = [0.3, 0.265, 0.223];

export interface Vec3 { x: number; y: number; z: number }

/** A tunnel with the derived bore frame the mesher and the checks both need. */
export interface Bore {
  readonly tunnel: Tunnel;
  /** Unit axis direction, a -> b. */
  readonly dir: readonly [number, number, number];
  /** Cylinder start, pushed back out of the rock. */
  readonly start: readonly [number, number, number];
  /** Cylinder end, pushed forward out of the rock. */
  readonly end: readonly [number, number, number];
  /** Axial length of the cut cylinder. */
  readonly length: number;
  /** Axial parameter (from `start`) where the bore enters rock. */
  readonly tIn: number;
  /** Axial parameter (from `start`) where the bore leaves rock. */
  readonly tOut: number;
  /** World-space portal centres at `tIn` / `tOut`. */
  readonly portals: readonly [Vec3, Vec3];
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (a: number, b: number, v: number): number => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

export class RiftField {
  readonly height: Float32Array;
  readonly minOver: Float32Array;
  readonly ao: Float32Array;
  readonly bores: readonly Bore[];

  constructor(log: (message: string) => void = () => {}) {
    const t0 = Date.now();
    this.height = new Float32Array(GRID_N * GRID_N);
    this.minOver = new Float32Array(GRID_N * GRID_N);
    for (let j = 0; j < GRID_N; j++) {
      const z = -WORLD_EXT + j * GRID_CELL;
      for (let i = 0; i < GRID_N; i++) {
        const sample = heightAtDetailed(-WORLD_EXT + i * GRID_CELL, z);
        this.height[j * GRID_N + i] = sample.h;
        this.minOver[j * GRID_N + i] = sample.minOver;
      }
    }
    log(`height grid ${GRID_N}x${GRID_N} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    const t1 = Date.now();
    this.ao = this.buildAo();
    log(`horizon AO ${AO_N}x${AO_N} in ${((Date.now() - t1) / 1000).toFixed(1)}s`);

    this.bores = TUNNELS.map((tunnel) => this.buildBore(tunnel));
  }

  // ---------- grid access ----------

  private gridH(i: number, j: number): number {
    const ci = i < 0 ? 0 : i > GRID_N - 1 ? GRID_N - 1 : i;
    const cj = j < 0 ? 0 : j > GRID_N - 1 ? GRID_N - 1 : j;
    return this.height[cj * GRID_N + ci]!;
  }

  /** Bilinear terrain height. Matches `heightAt` to well under a tenth of a unit. */
  heightAt(x: number, z: number): number {
    const fx = (x + WORLD_EXT) / GRID_CELL, fz = (z + WORLD_EXT) / GRID_CELL;
    const i = Math.max(0, Math.min(GRID_N - 2, Math.floor(fx)));
    const j = Math.max(0, Math.min(GRID_N - 2, Math.floor(fz)));
    const u = clamp01(fx - i), v = clamp01(fz - j);
    const a = this.gridH(i, j), b = this.gridH(i + 1, j), c = this.gridH(i, j + 1), d = this.gridH(i + 1, j + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }

  minOverAt(x: number, z: number): number {
    const fx = (x + WORLD_EXT) / GRID_CELL, fz = (z + WORLD_EXT) / GRID_CELL;
    const i = Math.max(0, Math.min(GRID_N - 2, Math.floor(fx)));
    const j = Math.max(0, Math.min(GRID_N - 2, Math.floor(fz)));
    const u = clamp01(fx - i), v = clamp01(fz - j);
    const g = (ii: number, jj: number): number => this.minOver[Math.min(GRID_N - 1, jj) * GRID_N + Math.min(GRID_N - 1, ii)]!;
    const a = g(i, j), b = g(i + 1, j), c = g(i, j + 1), d = g(i + 1, j + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }

  /** Undisplaced surface normal, from grid central differences. Chunk independent. */
  baseNormal(x: number, z: number): [number, number, number] {
    const e = 1.1;
    const nx = (this.heightAt(x - e, z) - this.heightAt(x + e, z)) / (2 * e);
    const nz = (this.heightAt(x, z - e) - this.heightAt(x, z + e)) / (2 * e);
    const l = Math.hypot(nx, 1, nz);
    return [nx / l, 1 / l, nz / l];
  }

  // ---------- horizon AO (ported from the approved draft) ----------

  private buildAo(): Float32Array {
    const dirs = 12, march = Math.round(48 / AO_CELL), step = AO_CELL / GRID_CELL;
    const ao = new Float32Array(AO_N * AO_N);
    const cos: number[] = [], sin: number[] = [];
    for (let d = 0; d < dirs; d++) {
      const a = (d / dirs) * Math.PI * 2;
      cos.push(Math.cos(a)); sin.push(Math.sin(a));
    }
    for (let j = 0; j < AO_N; j++) {
      const gj = j * step;
      for (let i = 0; i < AO_N; i++) {
        const gi = i * step;
        const y0 = this.gridH(gi, gj);
        let occ = 0;
        for (let d = 0; d < dirs; d++) {
          const dx = cos[d]!, dz = sin[d]!;
          let maxTan = 0;
          for (let s = 1; s <= march; s++) {
            const y = this.gridH(Math.round(gi + dx * s * step), Math.round(gj + dz * s * step));
            const t = (y - y0) / (s * AO_CELL);
            if (t > maxTan) maxTan = t;
          }
          occ += Math.atan(maxTan) / (Math.PI / 2);
        }
        const v = 1 - (occ / dirs) * 0.85;
        ao[j * AO_N + i] = v * v;      // squared: deepen crevices
      }
    }
    return ao;
  }

  aoAt(x: number, z: number): number {
    const fx = (x + WORLD_EXT) / AO_CELL, fz = (z + WORLD_EXT) / AO_CELL;
    const i = Math.max(0, Math.min(AO_N - 2, Math.floor(fx)));
    const j = Math.max(0, Math.min(AO_N - 2, Math.floor(fz)));
    const u = clamp01(fx - i), v = clamp01(fz - j);
    const g = (ii: number, jj: number): number => this.ao[jj * AO_N + ii]!;
    const a = g(i, j), b = g(i + 1, j), c = g(i, j + 1), d = g(i + 1, j + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }

  /**
   * Convex crests catch light — ported from the approved draft's colour pass,
   * but faded out on steep faces: a heightfield laplacian saturates on a
   * near-vertical wall, and adding a flat 0.12 to a wall albedo of ~0.18 washes
   * the canyons out completely.
   */
  crestAt(x: number, z: number, upness = 1): number {
    const e = GRID_CELL;
    const y = this.heightAt(x, z);
    const lap = (this.heightAt(x - e, z) + this.heightAt(x + e, z) + this.heightAt(x, z - e) + this.heightAt(x, z + e)) / 4 - y;
    return Math.max(0, Math.min(0.12, -lap * 0.08)) * Math.max(0, upness);
  }

  // ---------- mesh-stage displacement ----------

  /**
   * Signed 3D detail field, -1..1. Two octaves of lattice value noise; the
   * displacement rides it and the fracture-line shading looks for its zeros.
   */
  detail3(x: number, y: number, z: number): number {
    const a = vnoise3(x * 0.09, y * 0.09, z * 0.09, 1301) - 0.5;
    const b = vnoise3(x * 0.23, y * 0.23, z * 0.23, 1319) - 0.5;
    return clampSigned(a * 1.35 + b * 0.75);
  }

  /** 0 below 40 degrees of slope, full above 70. */
  displaceAmplitude(slope: number): number {
    return DISP_AMP * smoothstep(DISP_SLOPE_LO, DISP_SLOPE_HI, slope);
  }

  /**
   * Horizontal fracture bands that cut ACROSS the vertical flutes the carve
   * profile produces — without them the walls read as a hanging curtain.
   *
   * NOTE the axis assignment: the brief said "low in y ~0.05, higher in xz
   * ~0.15", but a field that varies slowly in y and quickly in xz is columnar
   * — it makes MORE vertical flutes. Bands that run horizontally need the fast
   * axis to be y. Same two frequencies, swapped onto the axes that produce the
   * stated effect.
   */
  bandDetail(x: number, y: number, z: number): number {
    return clampSigned((vnoise3(x * 0.05, y * 0.02, z * 0.05, 1327) - 0.5) * 2.1);
  }

  /**
   * MEASURED LIMIT, recorded here so nobody re-tries this: a canyon wall is
   * sampled at the chunk's HORIZONTAL pitch (1.6-2.0u), and its height gradient
   * is ~6:1, so consecutive vertex rows on a wall are 5-11u apart vertically
   * and the step is irregular. Anything banded finer than roughly 50u of height
   * therefore aliases into per-vertex speckle in BOTH geometry and COLOR_0 —
   * verified by probing colour up a wall column. Fine horizontal strata need a
   * detail texture (MAP-OVERHAUL.md §10 defers triplanar), not more noise.
   * `bandDetail` is tuned to the coarsest banding the mesh can actually carry.
   */
  strataSampleLimit(): number {
    return STRATA_PERIOD;
  }

  /** Low-frequency mask that leaves some wall sections as smoother slabs. */
  fluteMask(x: number, y: number, z: number): number {
    return 0.7 + 0.6 * vnoise3(x * 0.012, y * 0.012, z * 0.012, 1361);
  }

  /**
   * Displacement offset for a point sitting on the terrain surface. Purely a
   * function of world position, so the visual mesh, the collision mesh and the
   * QA render all agree even though they sample at different densities.
   */
  displacement(x: number, y: number, z: number, normal: readonly [number, number, number]): [number, number, number] {
    const hl = Math.hypot(normal[0], normal[2]);
    if (hl < 1e-6) return [0, 0, 0];
    const slope = Math.acos(Math.max(-1, Math.min(1, normal[1])));
    const amp = this.displaceAmplitude(slope);
    if (amp <= 0) return [0, 0, 0];
    const ramp = amp / DISP_AMP;
    const d = this.detail3(x, y, z) * amp * this.fluteMask(x, y, z) + this.bandDetail(x, y, z) * BAND_AMP * ramp;
    return [(normal[0] / hl) * d, 0, (normal[2] / hl) * d];
  }

  /**
   * Outward-only radial roughness for a tunnel bore, in world units. Always
   * >= 0 so the bore can only ever grow INTO the rock — the Ø15 clearance
   * guarantee is a floor, never a maybe. Two octaves: slow ribs along the bore
   * plus fine blast texture.
   */
  boreDisplacement(x: number, y: number, z: number): number {
    const ribs = vnoise3(x * 0.12, y * 0.12, z * 0.12, 1409);
    const fine = vnoise3(x * 0.5, y * 0.5, z * 0.5, 1427);
    return BORE_AMP * (0.62 * ribs + 0.38 * fine);
  }

  /** Final displaced surface point above (x, z). */
  surfacePoint(x: number, z: number): [number, number, number] {
    const y = this.heightAt(x, z);
    const n = this.baseNormal(x, z);
    const d = this.displacement(x, y, z, n);
    return [x + d[0], y + d[1], z + d[2]];
  }

  /** Normal of the displaced surface, by finite differences of `surfacePoint`. */
  surfaceNormal(x: number, z: number): [number, number, number] {
    const e = 0.85;
    const px0 = this.surfacePoint(x - e, z), px1 = this.surfacePoint(x + e, z);
    const pz0 = this.surfacePoint(x, z - e), pz1 = this.surfacePoint(x, z + e);
    const ax = px1[0] - px0[0], ay = px1[1] - px0[1], az = px1[2] - px0[2];
    const bx = pz1[0] - pz0[0], by = pz1[1] - pz0[1], bz = pz1[2] - pz0[2];
    // cross(dP/dz, dP/dx) is the upward normal for a graph surface.
    let nx = by * az - bz * ay, ny = bz * ax - bx * az, nz = bx * ay - by * ax;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-9) return [0, 1, 0];
    nx /= l; ny /= l; nz /= l;
    return ny < 0 ? [-nx, -ny, -nz] : [nx, ny, nz];
  }

  // ---------- tunnels ----------

  private buildBore(tunnel: Tunnel): Bore {
    const ax = tunnel.a[0], az = tunnel.a[1], bx = tunnel.b[0], bz = tunnel.b[1];
    const dx = bx - ax, dz = bz - az;
    const len = Math.hypot(dx, dz);
    const ux = dx / len, uz = dz / len;
    const y = tunnel.portalY;
    const clearBelow = y - tunnel.r - 1.5;
    // Push each cap out until the bore is clear of rock for 6 consecutive metres,
    // so the cut never leaves a blind pocket or a half-carved cap.
    const extend = (px: number, pz: number, sx: number, sz: number): number => {
      let run = 0;
      for (let t = 0; t <= 45; t += 1) {
        const h = this.heightAt(px + sx * t, pz + sz * t);
        run = h < clearBelow ? run + 1 : 0;
        if (run >= 6) return t + 3;
      }
      return 45;
    };
    const back = extend(ax, az, -ux, -uz);
    const fwd = extend(bx, bz, ux, uz);
    const start: [number, number, number] = [ax - ux * back, y, az - uz * back];
    const end: [number, number, number] = [bx + ux * fwd, y, bz + uz * fwd];
    const length = Math.hypot(end[0] - start[0], end[2] - start[2]);
    // Portals: where the terrain surface crosses the bore centreline height.
    let tIn = length * 0.25, tOut = length * 0.75, seen = false;
    for (let t = 0; t <= length; t += 0.5) {
      const h = this.heightAt(start[0] + ux * t, start[2] + uz * t);
      if (h >= y) {
        if (!seen) { tIn = t; seen = true; }
        tOut = t;
      }
    }
    return {
      tunnel,
      dir: [ux, 0, uz],
      start,
      end,
      length,
      tIn,
      tOut,
      portals: [
        { x: start[0] + ux * tIn, y, z: start[2] + uz * tIn },
        { x: start[0] + ux * tOut, y, z: start[2] + uz * tOut },
      ],
    };
  }

  /** Axial parameter and radial distance of a point relative to a bore. */
  boreCoords(bore: Bore, x: number, y: number, z: number): { t: number; radial: number } {
    const dx = x - bore.start[0], dy = y - bore.start[1], dz = z - bore.start[2];
    const t = dx * bore.dir[0] + dz * bore.dir[2];
    const rx = dx - bore.dir[0] * t, rz = dz - bore.dir[2] * t;
    return { t, radial: Math.hypot(rx, dy, rz) };
  }

  /** True when a point is inside (or just outside) any bore cylinder. */
  insideAnyBore(x: number, y: number, z: number, slack: number): boolean {
    for (const bore of this.bores) {
      const { t, radial } = this.boreCoords(bore, x, y, z);
      if (t < -slack || t > bore.length + slack) continue;
      if (radial <= bore.tunnel.r + slack) return true;
    }
    return false;
  }

  /**
   * Analytic tunnel darkening: 1 in the open, falling toward 0.12 the deeper a
   * surface sits between the two portals of a bore. The engine has no realtime
   * shadows and horizon AO cannot see into a CSG bore, so this is what makes
   * tunnels read as tunnels. `boreness` is how much of the bore's own material
   * grade (fresh blasted rock, warmer and darker than dusty regolith) applies.
   */
  tunnelInfluence(x: number, y: number, z: number): { shade: number; boreness: number } {
    let shade = 1, boreness = 0;
    for (const bore of this.bores) {
      const { t, radial } = this.boreCoords(bore, x, y, z);
      if (t <= bore.tIn || t >= bore.tOut) continue;
      const reach = 1 - smoothstep(bore.tunnel.r + 1.6, bore.tunnel.r + 9, radial);
      if (reach <= 0) continue;
      const depth = Math.min(t - bore.tIn, bore.tOut - t);
      const factor = 0.12 + 0.88 * Math.exp(-depth / 10);
      shade = Math.min(shade, 1 - reach * (1 - factor));
      boreness = Math.max(boreness, reach);
    }
    return { shade, boreness };
  }

  // ---------- vertex colour ----------

  /**
   * albedo x AO x tunnel shade, minus stain streaks and fracture lines.
   * `slope` is measured from the final (displaced) normal.
   */
  vertexColor(
    x: number,
    y: number,
    z: number,
    normal: readonly [number, number, number],
    slope: number,
  ): [number, number, number] {
    const albedo = albedoAt(x, z, y, slope);
    const ao = this.aoAt(x, z);
    const { shade, boreness } = this.tunnelInfluence(x, y, z);
    // A bore face has no meaningful heightfield curvature, so no crest term.
    const crest = this.crestAt(x, z, normal[1]) * (1 - boreness);
    if (boreness > 0) {
      // Fresh blasted rock: warmer and darker than the dusty exterior.
      const grit = 0.86 + 0.28 * vnoise3(x * 0.35, y * 0.35, z * 0.35, 1451);
      for (let i = 0; i < 3; i++) albedo[i] = albedo[i]! * (1 - boreness) + BORE_ALBEDO[i]! * grit * boreness;
    }

    // Vertical stain streaks: 1D noise along the wall's horizontal tangent,
    // stretched down the face.
    const steep = smoothstep(0.55, 1.0, slope);
    let darken = 0;
    if (steep > 0) {
      const hl = Math.hypot(normal[0], normal[2]) || 1;
      const tx = -normal[2] / hl, tz = normal[0] / hl;
      const u = x * tx + z * tz;
      // The same patch mask that damps the geometric fluting also damps the
      // streaking, so a "smooth slab" section reads smooth in colour too.
      const patch = this.fluteMask(x, y, z);
      const streak = fbm(u * 0.34, y * 0.028, 606, 3);
      darken += steep * 0.12 * patch * Math.max(0, (streak - 0.48) * 2.1);
      // Fracture lines: thin bands on the zero set of the displacement field.
      const d = this.detail3(x, y, z);
      darken += steep * 0.07 * (1 - smoothstep(0, 0.055, Math.abs(d)));
      // Broad bedding shading tied to the same field as the geometric banding,
      // at a wavelength the vertex density can actually carry (see strataSeam).
      darken += steep * 0.07 * (1 - smoothstep(0, 0.3, Math.abs(this.bandDetail(x, y, z))));
      // Faint grit variation so the streaks never look like clean stripes.
      darken += steep * 0.03 * (vnoise(u * 1.1, y * 0.6, 616) - 0.5);
    }
    const stain = 1 - Math.max(0, Math.min(0.18, darken));

    const scale = ao * shade * stain;
    return [
      Math.min(1, (albedo[0] + crest) * scale),
      Math.min(1, (albedo[1] + crest) * scale),
      Math.min(1, (albedo[2] + crest) * scale),
    ];
  }
}

function clampSigned(v: number): number {
  return v < -1 ? -1 : v > 1 ? 1 : v;
}

/** Reachability band used for chunk resolution + collision clipping. */
export const PLAYABLE_OVER = WALL_RUN + 12;
/**
 * The wall crosses the ceiling (y 74) at about minOver 13, so +3 still leaves
 * every reachable face collidable while dropping highland a ship cannot enter.
 * Trimmed from +6 to buy budget back for the ribbed bore tubes.
 */
export const COLLISION_OVER = WALL_RUN + 3;
export const COLLISION_CEILING = CEILING + 6;
export const HIGHLAND_TOP = H_TOP;
