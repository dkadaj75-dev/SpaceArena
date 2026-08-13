/**
 * Chunk meshing: heightfield grid -> watertight solid -> CSG bores -> displaced,
 * vertex-coloured render surface (+ a coarser collision surface from the very
 * same functions, so the two never disagree).
 */
import type { ManifoldToplevel } from "manifold-3d";
import { subtractBores, type BoreCutOptions, type IndexedMesh } from "./csg.js";
import {
  COLLISION_CEILING,
  COLLISION_OVER,
  PLAYABLE_OVER,
  RiftField,
  WORLD_EXT,
  type Bore,
} from "./field.js";
import { heightAtDetailed, vnoise3 } from "./riftLib.js";

export const CHUNKS_PER_SIDE = 4;
export const CHUNK_SIZE = (WORLD_EXT * 2) / CHUNKS_PER_SIDE;
/** Depth of the temporary solid used for CSG; also the skirt datum. */
export const SOLID_BOTTOM = -26;
export const SKIRT_DROP = 1.5;

/**
 * Per-chunk grid pitch. The spec asks for 1.6u on playable chunks and 4.0u on
 * pure highland, but 1.6u everywhere is needlessly expensive because only the
 * core chunks are predominantly playable. The
 * middle tier keeps the flank lanes dense while fitting the budget with room
 * for the CSG bores. See the deviation note in the tool header.
 */
const CELL_CORE = 1.6;
const CELL_FLANK = 2;
const CELL_HIGHLAND = 4;
const CORE_FRACTION = 0.62;
const FLANK_FRACTION = 0.08;
/** Existing collision pitch retained for its tested terrain fidelity. */
const COLLISION_CELL = 2.5;
const COLLISION_CELL_HIGHLAND = 4;

/**
 * Bore tessellation per stage. Rings along the axis are what carry the rib
 * displacement; the collision tube samples the SAME displacement function at
 * its own (coarser) ring/segment positions, exactly as the terrain surface does.
 */
const BORE_LOD0 = { segments: 40, ringSpacing: 2.4 } as const;
const BORE_LOD1 = { segments: 24, ringSpacing: 5 } as const;
const BORE_COLLISION = { segments: 18, ringSpacing: 7 } as const;
/** Slack used to recognise a bore-surface vertex; covers the outward ribbing. */
const BORE_VERTEX_SLACK = 1.15;

export interface ChunkSpec {
  readonly index: number;
  readonly ix: number;
  readonly iz: number;
  /** World-space min corner. */
  readonly x0: number;
  readonly z0: number;
  /** World-space centre (the placement position; meshes are emitted local to it). */
  readonly cx: number;
  readonly cz: number;
  readonly cell: number;
  readonly collisionCell: number;
  readonly playFraction: number;
  readonly bores: readonly Bore[];
}

export interface Surface {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
}

export function planChunks(field: RiftField): ChunkSpec[] {
  const specs: ChunkSpec[] = [];
  for (let iz = 0; iz < CHUNKS_PER_SIDE; iz++) {
    for (let ix = 0; ix < CHUNKS_PER_SIDE; ix++) {
      const x0 = -WORLD_EXT + ix * CHUNK_SIZE;
      const z0 = -WORLD_EXT + iz * CHUNK_SIZE;
      let hits = 0, total = 0;
      for (let j = 0; j <= 32; j++) {
        for (let i = 0; i <= 32; i++) {
          total++;
          if (field.minOverAt(x0 + i * 5, z0 + j * 5) < PLAYABLE_OVER) hits++;
        }
      }
      const playFraction = hits / total;
      const cell = playFraction >= CORE_FRACTION ? CELL_CORE : playFraction >= FLANK_FRACTION ? CELL_FLANK : CELL_HIGHLAND;
      specs.push({
        index: iz * CHUNKS_PER_SIDE + ix,
        ix,
        iz,
        x0,
        z0,
        cx: x0 + CHUNK_SIZE / 2,
        cz: z0 + CHUNK_SIZE / 2,
        cell,
        collisionCell: cell === CELL_HIGHLAND ? COLLISION_CELL_HIGHLAND : COLLISION_CELL,
        playFraction,
        bores: field.bores.filter((bore) => boreTouchesChunk(bore, x0, z0)),
      });
    }
  }
  return specs;
}

function boreTouchesChunk(bore: Bore, x0: number, z0: number): boolean {
  const pad = bore.tunnel.r + 1;
  const minX = Math.min(bore.start[0], bore.end[0]) - pad, maxX = Math.max(bore.start[0], bore.end[0]) + pad;
  const minZ = Math.min(bore.start[2], bore.end[2]) - pad, maxZ = Math.max(bore.start[2], bore.end[2]) + pad;
  return maxX >= x0 && minX <= x0 + CHUNK_SIZE && maxZ >= z0 && minZ <= z0 + CHUNK_SIZE;
}

// ---------- solid construction ----------

interface ChunkGrid {
  /** Verts per side. */
  n: number;
  cell: number;
  /** Terrain height per grid node, row major. */
  h: Float32Array;
}

function sampleChunkGrid(spec: ChunkSpec, cell: number): ChunkGrid {
  const cells = Math.round(CHUNK_SIZE / cell);
  const n = cells + 1;
  const h = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    const z = spec.z0 + j * cell;
    for (let i = 0; i < n; i++) h[j * n + i] = heightAtDetailed(spec.x0 + i * cell, z).h;
  }
  return { n, cell, h };
}

/** Perimeter grid indices, counter-clockwise in plan view, without repeating the seam. */
function perimeterIndices(n: number): number[] {
  const ring: number[] = [];
  for (let i = 0; i < n - 1; i++) ring.push(i);                       // z = z0, +x
  for (let j = 0; j < n - 1; j++) ring.push(j * n + (n - 1));         // x = x1, +z
  for (let i = n - 1; i > 0; i--) ring.push((n - 1) * n + i);         // z = z1, -x
  for (let j = n - 1; j > 0; j--) ring.push(j * n);                   // x = x0, -z
  return ring;
}

function buildSolid(spec: ChunkSpec, grid: ChunkGrid): IndexedMesh {
  const { n, cell, h } = grid;
  const ring = perimeterIndices(n);
  const vertexCount = n * n + ring.length + 1;
  const positions = new Float32Array(vertexCount * 3);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const o = (j * n + i) * 3;
      positions[o] = spec.x0 + i * cell;
      positions[o + 1] = h[j * n + i]!;
      positions[o + 2] = spec.z0 + j * cell;
    }
  }
  const ringBase = n * n;
  for (let k = 0; k < ring.length; k++) {
    const src = ring[k]! * 3, dst = (ringBase + k) * 3;
    positions[dst] = positions[src]!;
    positions[dst + 1] = SOLID_BOTTOM;
    positions[dst + 2] = positions[src + 2]!;
  }
  const centre = ringBase + ring.length;
  positions[centre * 3] = spec.cx;
  positions[centre * 3 + 1] = SOLID_BOTTOM;
  positions[centre * 3 + 2] = spec.cz;

  const triCount = (n - 1) * (n - 1) * 2 + ring.length * 2 + ring.length;
  const indices = new Uint32Array(triCount * 3);
  let k = 0;
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
      // alternate the diagonal for isotropy (as in the approved draft)
      if ((i + j) & 1) { indices[k++] = a; indices[k++] = c; indices[k++] = b; indices[k++] = b; indices[k++] = c; indices[k++] = d; }
      else { indices[k++] = a; indices[k++] = c; indices[k++] = d; indices[k++] = a; indices[k++] = d; indices[k++] = b; }
    }
  }
  for (let e = 0; e < ring.length; e++) {
    const t0 = ring[e]!, t1 = ring[(e + 1) % ring.length]!;
    const b0 = ringBase + e, b1 = ringBase + ((e + 1) % ring.length);
    indices[k++] = t0; indices[k++] = t1; indices[k++] = b0;
    indices[k++] = t1; indices[k++] = b1; indices[k++] = b0;
    indices[k++] = centre; indices[k++] = b0; indices[k++] = b1;
  }
  return { positions, indices };
}

// ---------- refinement ----------

const PLANE_EPS = 5e-3;

/** Triangles that lie wholly on a footprint plane or the bottom are the CSG scaffold. */
function isScaffold(px: readonly number[], py: readonly number[], pz: readonly number[], spec: ChunkSpec): boolean {
  const x1 = spec.x0 + CHUNK_SIZE, z1 = spec.z0 + CHUNK_SIZE;
  const all = (values: readonly number[], target: number): boolean =>
    Math.abs(values[0]! - target) < PLANE_EPS && Math.abs(values[1]! - target) < PLANE_EPS && Math.abs(values[2]! - target) < PLANE_EPS;
  return all(px, spec.x0) || all(px, x1) || all(pz, spec.z0) || all(pz, z1) || all(py, SOLID_BOTTOM);
}

class Accum {
  readonly pos: number[] = [];
  readonly nrm: number[] = [];
  readonly col: number[] = [];
  readonly idx: number[] = [];

  vertex(p: readonly [number, number, number], n: readonly [number, number, number], c: readonly [number, number, number]): number {
    const id = this.pos.length / 3;
    this.pos.push(p[0], p[1], p[2]);
    this.nrm.push(n[0], n[1], n[2]);
    this.col.push(c[0], c[1], c[2]);
    return id;
  }

  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }

  toSurface(offsetX: number, offsetZ: number): Surface {
    const positions = new Float32Array(this.pos.length);
    for (let i = 0; i < this.pos.length; i += 3) {
      positions[i] = this.pos[i]! - offsetX;
      positions[i + 1] = this.pos[i + 1]!;
      positions[i + 2] = this.pos[i + 2]! - offsetZ;
    }
    return {
      positions,
      normals: Float32Array.from(this.nrm),
      colors: Float32Array.from(this.col),
      indices: Uint32Array.from(this.idx),
    };
  }
}

interface RefineResult {
  accum: Accum;
  /** Grid index -> accum vertex id, for the skirt (undefined where dropped). */
  gridVertex: Int32Array;
}

function refineSolid(field: RiftField, spec: ChunkSpec, grid: ChunkGrid, solid: IndexedMesh, csgApplied: boolean): RefineResult {
  const { positions, indices } = solid;
  const vertexCount = positions.length / 3;
  const surfaceVert = new Uint8Array(vertexCount);
  const boreVert = new Uint8Array(vertexCount);
  const topCount = grid.n * grid.n;
  for (let v = 0; v < vertexCount; v++) {
    const x = positions[v * 3]!, y = positions[v * 3 + 1]!, z = positions[v * 3 + 2]!;
    boreVert[v] = field.insideAnyBore(x, y, z, BORE_VERTEX_SLACK) ? 1 : 0;
    if (!csgApplied) surfaceVert[v] = v < topCount ? 1 : 0;
    else surfaceVert[v] = Math.abs(y - field.heightAt(x, z)) < 1.2 ? 1 : 0;
  }

  // Keep everything that is not CSG scaffold.
  const keep: number[] = [];
  const px = [0, 0, 0], py = [0, 0, 0], pz = [0, 0, 0];
  for (let t = 0; t < indices.length; t += 3) {
    for (let c = 0; c < 3; c++) {
      const v = indices[t + c]!;
      px[c] = positions[v * 3]!; py[c] = positions[v * 3 + 1]!; pz[c] = positions[v * 3 + 2]!;
    }
    if (!isScaffold(px, py, pz, spec)) keep.push(t);
  }

  // Displace the surface, then rebuild the compacted vertex set.
  const displaced = new Float32Array(positions.length);
  for (let v = 0; v < vertexCount; v++) {
    const x = positions[v * 3]!, y = positions[v * 3 + 1]!, z = positions[v * 3 + 2]!;
    if (surfaceVert[v] && !boreVert[v]) {
      const d = field.displacement(x, y, z, field.baseNormal(x, z));
      displaced[v * 3] = x + d[0]; displaced[v * 3 + 1] = y + d[1]; displaced[v * 3 + 2] = z + d[2];
    } else {
      displaced[v * 3] = x; displaced[v * 3 + 1] = y; displaced[v * 3 + 2] = z;
    }
  }

  // Area-weighted mesh normals over the kept triangles (used for bore interiors).
  const meshNormals = new Float32Array(vertexCount * 3);
  for (const t of keep) {
    const a = indices[t]!, b = indices[t + 1]!, c = indices[t + 2]!;
    const ax = displaced[b * 3]! - displaced[a * 3]!, ay = displaced[b * 3 + 1]! - displaced[a * 3 + 1]!, az = displaced[b * 3 + 2]! - displaced[a * 3 + 2]!;
    const bx = displaced[c * 3]! - displaced[a * 3]!, by = displaced[c * 3 + 1]! - displaced[a * 3 + 1]!, bz = displaced[c * 3 + 2]! - displaced[a * 3 + 2]!;
    const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    for (let c2 = 0; c2 < 3; c2++) {
      const v = c2 === 0 ? a : c2 === 1 ? b : c;
      meshNormals[v * 3] = meshNormals[v * 3]! + nx;
      meshNormals[v * 3 + 1] = meshNormals[v * 3 + 1]! + ny;
      meshNormals[v * 3 + 2] = meshNormals[v * 3 + 2]! + nz;
    }
  }

  const accum = new Accum();
  const remap = new Int32Array(vertexCount).fill(-1);
  const emit = (v: number): number => {
    const existing = remap[v]!;
    if (existing >= 0) return existing;
    const x = displaced[v * 3]!, y = displaced[v * 3 + 1]!, z = displaced[v * 3 + 2]!;
    let normal: [number, number, number];
    if (surfaceVert[v] && !boreVert[v]) {
      normal = field.surfaceNormal(positions[v * 3]!, positions[v * 3 + 2]!);
    } else {
      const nx = meshNormals[v * 3]!, ny = meshNormals[v * 3 + 1]!, nz = meshNormals[v * 3 + 2]!;
      const l = Math.hypot(nx, ny, nz);
      normal = l < 1e-9 ? [0, 1, 0] : [nx / l, ny / l, nz / l];
    }
    const slope = Math.acos(Math.max(-1, Math.min(1, normal[1])));
    const id = accum.vertex([x, y, z], normal, field.vertexColor(x, y, z, normal, slope));
    remap[v] = id;
    return id;
  };
  for (const t of keep) accum.tri(emit(indices[t]!), emit(indices[t + 1]!), emit(indices[t + 2]!));

  const gridVertex = new Int32Array(topCount).fill(-1);
  if (!csgApplied) for (let v = 0; v < topCount; v++) gridVertex[v] = remap[v]!;
  return { accum, gridVertex };
}

// ---------- skirts ----------

function addSkirt(field: RiftField, spec: ChunkSpec, grid: ChunkGrid, accum: Accum): void {
  const { n, cell } = grid;
  const ring = perimeterIndices(n);
  const border = (index: number): { p: [number, number, number]; c: [number, number, number] } => {
    const i = index % n, j = Math.floor(index / n);
    const x = spec.x0 + i * cell, z = spec.z0 + j * cell;
    const p = field.surfacePoint(x, z);
    const normal = field.surfaceNormal(x, z);
    const slope = Math.acos(Math.max(-1, Math.min(1, normal[1])));
    return { p, c: field.vertexColor(p[0], p[1], p[2], normal, slope) };
  };
  for (let e = 0; e < ring.length; e++) {
    const a = border(ring[e]!), b = border(ring[(e + 1) % ring.length]!);
    const outward: [number, number, number] = [b.p[2] - a.p[2], 0, a.p[0] - b.p[0]];
    const l = Math.hypot(outward[0], outward[2]) || 1;
    const flat: [number, number, number] = [outward[0] / l, 0, outward[2] / l];
    const top0 = accum.vertex(a.p, flat, a.c);
    const top1 = accum.vertex(b.p, flat, b.c);
    const bot0 = accum.vertex([a.p[0], a.p[1] - SKIRT_DROP, a.p[2]], flat, scaleColor(a.c, 0.72));
    const bot1 = accum.vertex([b.p[0], b.p[1] - SKIRT_DROP, b.p[2]], flat, scaleColor(b.c, 0.72));
    accum.tri(top0, top1, bot0);
    accum.tri(top1, bot1, bot0);
  }
}

function scaleColor(c: readonly [number, number, number], k: number): [number, number, number] {
  return [c[0] * k, c[1] * k, c[2] * k];
}

// ---------- portal rims ----------

const RIM_MAJOR_SEGMENTS = 24;
const RIM_MINOR_SEGMENTS = 6;

/**
 * A lip that HUGS the mouth instead of a flat donut pasted on the wall: for
 * every angle around the bore, march along the axis to where the terrain
 * surface actually crosses the cylinder, smooth that curve, and sweep a tube
 * along it. A planar torus on an oblique wall leaves half the ring hanging in
 * mid air; this one follows the hole.
 */
function addPortalRim(field: RiftField, accum: Accum, bore: Bore, side: 0 | 1): void {
  const a: [number, number, number] = [bore.dir[0], 0, bore.dir[2]];
  const u: [number, number, number] = [0, 1, 0];
  const v: [number, number, number] = [-a[2], 0, a[0]];
  const major = bore.tunnel.r + 0.95;
  const anchor = side === 0 ? bore.tIn : bore.tOut;
  const inward = side === 0 ? 1 : -1;
  const radial: [number, number, number][] = [];
  const axial: number[] = [];
  const width: number[] = [];
  for (let s = 0; s < RIM_MAJOR_SEGMENTS; s++) {
    const theta = (s / RIM_MAJOR_SEGMENTS) * Math.PI * 2;
    const ct = Math.cos(theta), st = Math.sin(theta);
    const r: [number, number, number] = [u[0] * ct + v[0] * st, u[1] * ct + v[1] * st, u[2] * ct + v[2] * st];
    radial.push(r);
    let found = anchor;
    for (let step = -14; step <= 14; step += 0.4) {
      const t = anchor + inward * step;
      const px = bore.start[0] + a[0] * t + r[0] * major;
      const py = bore.start[1] + r[1] * major;
      const pz = bore.start[2] + a[2] * t + r[2] * major;
      if (field.heightAt(px, pz) >= py) { found = t; break; }
    }
    // Only 0.15u proud of the rock: a lip, not a pipe stub hanging in the air.
    axial.push(found - inward * 0.15);
    // Fractured collar: the ring thickness varies by +-40% around the mouth.
    const wx = bore.start[0] + a[0] * found + r[0] * major;
    const wy = bore.start[1] + r[1] * major;
    const wz = bore.start[2] + a[2] * found + r[2] * major;
    width.push(0.85 * (0.6 + 0.8 * vnoise3(wx * 0.22, wy * 0.22, wz * 0.22, 1487)));
  }
  for (let pass = 0; pass < 2; pass++) {
    const smoothed = axial.map((_, s) => {
      const prev = axial[(s - 1 + RIM_MAJOR_SEGMENTS) % RIM_MAJOR_SEGMENTS]!;
      const next = axial[(s + 1) % RIM_MAJOR_SEGMENTS]!;
      return prev * 0.25 + axial[s]! * 0.5 + next * 0.25;
    });
    for (let s = 0; s < RIM_MAJOR_SEGMENTS; s++) axial[s] = smoothed[s]!;
  }
  const base = accum.pos.length / 3;
  for (let s = 0; s < RIM_MAJOR_SEGMENTS; s++) {
    const r = radial[s]!, t = axial[s]!, minor = width[s]!;
    for (let m = 0; m < RIM_MINOR_SEGMENTS; m++) {
      const phi = (m / RIM_MINOR_SEGMENTS) * Math.PI * 2;
      const cp = Math.cos(phi), sp = Math.sin(phi);
      const normal: [number, number, number] = [r[0] * cp + a[0] * sp, r[1] * cp + a[1] * sp, r[2] * cp + a[2] * sp];
      const cx = bore.start[0] + a[0] * t + r[0] * (major + minor * cp) + a[0] * minor * sp;
      const cy = bore.start[1] + r[1] * (major + minor * cp) + a[1] * minor * sp;
      const cz = bore.start[2] + a[2] * t + r[2] * (major + minor * cp) + a[2] * minor * sp;
      // Same rock noise as the walls, outward only so the lip never chokes the bore.
      const bump = 0.3 * (0.5 + 0.5 * field.detail3(cx, cy, cz));
      const p: [number, number, number] = [cx + normal[0] * bump, cy + normal[1] * bump, cz + normal[2] * bump];
      // Broken rock face, never dusty regolith: colour it at a wall's slope.
      accum.vertex(p, normal, scaleColor(field.vertexColor(p[0], p[1], p[2], normal, Math.PI / 2), 0.82));
    }
  }
  for (let s = 0; s < RIM_MAJOR_SEGMENTS; s++) {
    const s1 = (s + 1) % RIM_MAJOR_SEGMENTS;
    for (let m = 0; m < RIM_MINOR_SEGMENTS; m++) {
      const m1 = (m + 1) % RIM_MINOR_SEGMENTS;
      const v00 = base + s * RIM_MINOR_SEGMENTS + m;
      const v01 = base + s * RIM_MINOR_SEGMENTS + m1;
      const v10 = base + s1 * RIM_MINOR_SEGMENTS + m;
      const v11 = base + s1 * RIM_MINOR_SEGMENTS + m1;
      accum.tri(v00, v10, v01);
      accum.tri(v01, v10, v11);
    }
  }
}

function portalsInChunk(spec: ChunkSpec, field: RiftField): { bore: Bore; side: 0 | 1 }[] {
  const out: { bore: Bore; side: 0 | 1 }[] = [];
  for (const bore of field.bores) {
    for (const side of [0, 1] as const) {
      const portal = bore.portals[side];
      if (portal.x >= spec.x0 && portal.x < spec.x0 + CHUNK_SIZE && portal.z >= spec.z0 && portal.z < spec.z0 + CHUNK_SIZE) {
        out.push({ bore, side });
      }
    }
  }
  return out;
}

// ---------- public builders ----------

function boreCut(field: RiftField, preset: { segments: number; ringSpacing: number }): BoreCutOptions {
  return { ...preset, displace: (x, y, z) => field.boreDisplacement(x, y, z) };
}

export function buildChunkSurface(
  wasm: ManifoldToplevel,
  field: RiftField,
  spec: ChunkSpec,
  cell: number,
  options: { rims: boolean; lod: 0 | 1 },
): Surface {
  const grid = sampleChunkGrid(spec, cell);
  const solid = buildSolid(spec, grid);
  const cut = subtractBores(wasm, solid, spec.bores, boreCut(field, options.lod === 0 ? BORE_LOD0 : BORE_LOD1));
  const { accum } = refineSolid(field, spec, grid, cut, spec.bores.length > 0);
  addSkirt(field, spec, grid, accum);
  if (options.rims) for (const portal of portalsInChunk(spec, field)) addPortalRim(field, accum, portal.bore, portal.side);
  return accum.toSurface(spec.cx, spec.cz);
}

export interface CollisionMesh {
  positions: Float32Array;
  indices: Uint32Array;
  bounds: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } };
}

/**
 * Collision surface for a chunk: same field, same displacement, coarser grid,
 * then clipped to reachable space — deep-highland interior triangles a ship can
 * never touch are dropped, tunnel walls are always kept.
 */
export function buildChunkCollision(wasm: ManifoldToplevel, field: RiftField, spec: ChunkSpec): CollisionMesh {
  const grid = sampleChunkGrid(spec, spec.collisionCell);
  const solid = buildSolid(spec, grid);
  const cut = subtractBores(wasm, solid, spec.bores, boreCut(field, BORE_COLLISION));
  const { positions, indices } = cut;
  const vertexCount = positions.length / 3;
  const displaced = new Float32Array(positions.length);
  const csgApplied = spec.bores.length > 0;
  const topCount = grid.n * grid.n;
  for (let v = 0; v < vertexCount; v++) {
    const x = positions[v * 3]!, y = positions[v * 3 + 1]!, z = positions[v * 3 + 2]!;
    const isSurface = csgApplied ? Math.abs(y - field.heightAt(x, z)) < 1.2 : v < topCount;
    const isBore = field.insideAnyBore(x, y, z, BORE_VERTEX_SLACK);
    if (isSurface && !isBore) {
      const d = field.displacement(x, y, z, field.baseNormal(x, z));
      displaced[v * 3] = x + d[0]; displaced[v * 3 + 1] = y + d[1]; displaced[v * 3 + 2] = z + d[2];
    } else {
      displaced[v * 3] = x; displaced[v * 3 + 1] = y; displaced[v * 3 + 2] = z;
    }
  }

  const outPositions: number[] = [];
  const outIndices: number[] = [];
  const remap = new Int32Array(vertexCount).fill(-1);
  const px = [0, 0, 0], py = [0, 0, 0], pz = [0, 0, 0];
  for (let t = 0; t < indices.length; t += 3) {
    for (let c = 0; c < 3; c++) {
      const v = indices[t + c]!;
      px[c] = positions[v * 3]!; py[c] = positions[v * 3 + 1]!; pz[c] = positions[v * 3 + 2]!;
    }
    if (isScaffold(px, py, pz, spec)) continue;
    let keep = false;
    for (let c = 0; c < 3 && !keep; c++) {
      if (field.insideAnyBore(px[c]!, py[c]!, pz[c]!, 3)) keep = true;
    }
    if (!keep) {
      const minY = Math.min(py[0]!, py[1]!, py[2]!);
      let minOver = Infinity;
      for (let c = 0; c < 3; c++) minOver = Math.min(minOver, field.minOverAt(px[c]!, pz[c]!));
      keep = minY <= COLLISION_CEILING && minOver < COLLISION_OVER;
    }
    if (!keep) continue;
    for (let c = 0; c < 3; c++) {
      const v = indices[t + c]!;
      if (remap[v]! < 0) {
        remap[v] = outPositions.length / 3;
        outPositions.push(displaced[v * 3]! - spec.cx, displaced[v * 3 + 1]!, displaced[v * 3 + 2]! - spec.cz);
      }
      outIndices.push(remap[v]!);
    }
  }
  return {
    positions: Float32Array.from(outPositions),
    indices: Uint32Array.from(outIndices),
    bounds: boundsOf(outPositions),
  };
}

export function boundsOf(positions: ArrayLike<number>): CollisionMesh["bounds"] {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i]!, y = positions[i + 1]!, z = positions[i + 2]!;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  if (!Number.isFinite(minX)) return { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } };
  return { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } };
}
