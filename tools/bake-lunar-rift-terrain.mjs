// Turns the raw chunk meshes emitted by tools/generate-lunar-rift.ts into the
// shipped Lunar Rift terrain: simplified LOD0 + LOD1, split into RIFT_FLOOR and
// RIFT_WALL by slope, with world-space box UVs and the PBR material block the
// arena's textures expect.
//
//   node tools/bake-lunar-rift-terrain.mjs [--props-dir path] [--arena path]
//
// This replaces the old Blender pass (tools/blender_terrain_pass.py), which is
// where four shipped "seam fixes" worth of damage came from. Three rules the
// Blender pass broke and this one keeps:
//
//   1. THE BORDER RING IS NEVER TOUCHED. Every vertex on the chunk's mesh
//      boundary is locked out of simplification, so both LOD levels of every
//      chunk present exactly the vertex ring the generator produced — and since
//      the generator samples one uniform world grid, the neighbour's ring is the
//      same list of points. Borders are welded by construction, not tolerance.
//      (Blender's DECIMATE guard tested |x|==96 exactly, which the generator's
//      lateral displacement defeats, and the limited-dissolve that ran after it
//      had no guard at all and ate whole border rows into 90u chords.)
//   2. BOTH LOD LEVELS COME FROM ONE MESH, so a cross-LOD border is watertight.
//   3. UVs AND MATERIALS ARE CHOSEN PER FACE, not per vertex, and the slope
//      jitter is hashed in ARENA-WORLD space, not chunk-local space — otherwise
//      the same world point classifies differently on either side of a border.
//
// Idempotent: a GLB that already carries RIFT_FLOOR/RIFT_WALL is already baked
// and is left alone. Re-run the generator to get a fresh raw mesh to bake.
/* global Buffer, process, console */
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const { Document, NodeIO } = createRequire(import.meta.url)("@gltf-transform/core");
const io = new NodeIO();

const BAKE_VERSION = 1;

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  if (i < 0) return fallback;
  if (!process.argv[i + 1]) throw new Error(`${name} requires a value`);
  return process.argv[i + 1];
};
const PROPS = path.resolve(process.cwd(), arg("--props-dir", "content/props"));
const ARENA = path.resolve(process.cwd(), arg("--arena", "content/arenas/lunar-rift.json"));

// ---- shipped budgets (they used to live in generate-lunar-rift.ts) ----
// LOD1 cannot go much below this: it holds the same locked border ring and the
// same locked cliffs as LOD0, and both locks exist to stop a seam.
const LOD0_TRI_BUDGET = 150_000;
const LOD1_TRI_BUDGET = 80_000;
/**
 * Simplification stops when the cheapest remaining collapse would move the
 * surface further than this. The quadric cost sums squared distances to the
 * faces around a vertex, so with ~6 incident faces 0.06 is about 10cm of world
 * error at LOD0 — under the 2u grid pitch and well under the 1.3u displacement
 * amplitude the surface carries — and LOD1 spends ~36cm at a distance where a
 * chunk is a few dozen pixels tall.
 */
const LOD0_ERROR = Number(arg("--lod0-error", "0.06"));
const LOD1_ERROR = Number(arg("--lod1-error", "0.8"));
/**
 * Minimum triangle shape quality a collapse may leave behind, as
 * (2 * area) / longest-edge^2 — 1/sqrt(3) for an equilateral triangle, 0 for a
 * degenerate splinter.
 */
const MIN_TRIANGLE_QUALITY = Number(arg("--min-quality", "0.08"));
/** Faces whose up-component is below this keep every vertex they touch. */
const STEEP_LOCK = Number(arg("--steep-lock", "0.5"));
/** Hard ceilings per chunk, applied even when the error budget is not spent. */
const LOD0_MAX_TRIS = Number(arg("--lod0-max", "11000"));
const LOD1_MAX_TRIS = Number(arg("--lod1-max", "4200"));

// Slope split, ported from the Blender pass so the look does not move.
const SLOPE_UP = 0.55;
const SLOPE_JITTER = 0.12;
const NOISE_CELL = 3.5;
const TILE_FLOOR = 90;
const TILE_WALL = 24;

// ---------------------------------------------------------------- GLB codec

const COMPONENTS = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const SIZES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const ELEMENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
const align4 = (n) => (n + 3) & ~3;

function parseGlb(bytes) {
  const jsonLength = bytes.readUInt32LE(12);
  const json = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString("utf8"));
  const binAt = 20 + jsonLength;
  const binLength = bytes.readUInt32LE(binAt);
  return { json, bin: Buffer.from(bytes.subarray(binAt + 8, binAt + 8 + binLength)) };
}

function readAccessor(json, bin, index) {
  const accessor = json.accessors[index];
  const view = json.bufferViews[accessor.bufferView];
  const Ctor = COMPONENTS[accessor.componentType];
  const elements = ELEMENTS[accessor.type];
  const componentSize = SIZES[accessor.componentType];
  const stride = view.byteStride ?? componentSize * elements;
  const base = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const data = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const out = new Ctor(accessor.count * elements);
  const read = (at) => accessor.componentType === 5121 ? data.getUint8(at)
    : accessor.componentType === 5123 ? data.getUint16(at, true)
      : accessor.componentType === 5125 ? data.getUint32(at, true) : data.getFloat32(at, true);
  for (let i = 0; i < accessor.count; i++) {
    for (let c = 0; c < elements; c++) out[i * elements + c] = read(base + i * stride + c * componentSize);
  }
  return out;
}

function writeGlb(json, bin) {
  json.buffers = [{ byteLength: bin.length }];
  let jsonBytes = Buffer.from(JSON.stringify(json));
  jsonBytes = Buffer.concat([jsonBytes, Buffer.alloc(align4(jsonBytes.length) - jsonBytes.length, 0x20)]);
  const binPadded = Buffer.concat([bin, Buffer.alloc(align4(bin.length) - bin.length)]);
  const out = Buffer.alloc(12 + 8 + jsonBytes.length + 8 + binPadded.length);
  out.writeUInt32LE(0x46546c67, 0); out.writeUInt32LE(2, 4); out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(jsonBytes.length, 12); out.writeUInt32LE(0x4e4f534a, 16); jsonBytes.copy(out, 20);
  const at = 20 + jsonBytes.length;
  out.writeUInt32LE(binPadded.length, at); out.writeUInt32LE(0x004e4942, at + 4); binPadded.copy(out, at + 8);
  return out;
}

// ------------------------------------------------------------ simplification

/**
 * Quadric edge-collapse simplification with a locked vertex set.
 *
 * A collapse always moves one vertex ONTO an existing neighbour, so the result
 * only ever contains original vertex positions — no new points, and nothing on
 * the locked ring can drift. Locked vertices are never the one that moves and
 * never disappear, so the mesh boundary comes out bit-identical.
 */
function simplify(pos, nrm, idx, locked, { errorLimit, maxTris }) {
  const vertexCount = pos.length / 3;
  const tri = Int32Array.from(idx);
  const triCount = tri.length / 3;
  const dead = new Uint8Array(triCount);
  const vertexDead = new Uint8Array(vertexCount);
  // Incident triangles per vertex; stale entries are filtered on read.
  const incident = Array.from({ length: vertexCount }, () => []);
  for (let t = 0; t < triCount; t++) {
    for (let c = 0; c < 3; c++) incident[tri[t * 3 + c]].push(t);
  }

  const Q = new Float64Array(vertexCount * 10);
  const faceNormal = (t, out) => {
    const a = tri[t * 3], b = tri[t * 3 + 1], c = tri[t * 3 + 2];
    const ax = pos[b * 3] - pos[a * 3], ay = pos[b * 3 + 1] - pos[a * 3 + 1], az = pos[b * 3 + 2] - pos[a * 3 + 2];
    const bx = pos[c * 3] - pos[a * 3], by = pos[c * 3 + 1] - pos[a * 3 + 1], bz = pos[c * 3 + 2] - pos[a * 3 + 2];
    out[0] = ay * bz - az * by;
    out[1] = az * bx - ax * bz;
    out[2] = ax * by - ay * bx;
    return Math.hypot(out[0], out[1], out[2]);
  };

  const n = [0, 0, 0];
  for (let t = 0; t < triCount; t++) {
    const len = faceNormal(t, n);
    if (len < 1e-12) continue;
    const a = n[0] / len, b = n[1] / len, c = n[2] / len;
    const v0 = tri[t * 3];
    const d = -(a * pos[v0 * 3] + b * pos[v0 * 3 + 1] + c * pos[v0 * 3 + 2]);
    const add = [a * a, a * b, a * c, a * d, b * b, b * c, b * d, c * c, c * d, d * d];
    for (let k = 0; k < 3; k++) {
      const v = tri[t * 3 + k] * 10;
      for (let i = 0; i < 10; i++) Q[v + i] += add[i];
    }
  }

  const liveTrisOf = (v) => {
    const list = incident[v];
    let w = 0;
    for (let i = 0; i < list.length; i++) if (!dead[list[i]]) list[w++] = list[i];
    list.length = w;
    return list;
  };

  /** Cost of moving `a` onto `b`; Infinity when the collapse is not allowed. */
  const cost = (a, b) => {
    if (locked[a] || vertexDead[a] || vertexDead[b]) return Infinity;
    const x = pos[b * 3], y = pos[b * 3 + 1], z = pos[b * 3 + 2];
    const qa = a * 10, qb = b * 10;
    let e = 0;
    const t = [x * x, x * y, x * z, x, y * y, y * z, y, z * z, z, 1];
    const w = [1, 2, 2, 2, 1, 2, 2, 1, 2, 1];
    for (let i = 0; i < 10; i++) e += w[i] * (Q[qa + i] + Q[qb + i]) * t[i];
    return e < 0 ? 0 : e;
  };

  const valid = (a, b) => {
    if (locked[a] || vertexDead[a] || vertexDead[b] || a === b) return false;
    const ta = liveTrisOf(a);
    // The edge must be interior (exactly two triangles) — collapsing an open
    // edge would pull the mesh boundary, and the boundary is the whole point.
    const shared = [];
    for (const t of ta) {
      const i0 = tri[t * 3], i1 = tri[t * 3 + 1], i2 = tri[t * 3 + 2];
      if (i0 === b || i1 === b || i2 === b) shared.push(t);
    }
    if (shared.length !== 2) return false;
    // Link condition: a and b may only share the two vertices opposite the
    // collapsed edge, or the collapse folds the surface onto itself.
    const nbrA = new Set();
    for (const t of ta) for (let c = 0; c < 3; c++) { const v = tri[t * 3 + c]; if (v !== a) nbrA.add(v); }
    const nbrB = new Set();
    for (const t of liveTrisOf(b)) for (let c = 0; c < 3; c++) { const v = tri[t * 3 + c]; if (v !== b) nbrB.add(v); }
    let common = 0;
    for (const v of nbrA) if (nbrB.has(v)) common++;
    const opposite = new Set();
    for (const t of shared) for (let c = 0; c < 3; c++) { const v = tri[t * 3 + c]; if (v !== a && v !== b) opposite.add(v); }
    if (common !== opposite.size) return false;
    // No triangle may flip or collapse to a sliver.
    const bx = pos[b * 3], by = pos[b * 3 + 1], bz = pos[b * 3 + 2];
    const before = [0, 0, 0];
    for (const t of ta) {
      if (shared.includes(t)) continue;
      const lenBefore = faceNormal(t, before);
      if (lenBefore < 1e-12) continue;
      const i = [tri[t * 3], tri[t * 3 + 1], tri[t * 3 + 2]];
      const px = i.map((v) => (v === a ? bx : pos[v * 3]));
      const py = i.map((v) => (v === a ? by : pos[v * 3 + 1]));
      const pz = i.map((v) => (v === a ? bz : pos[v * 3 + 2]));
      const ux = px[1] - px[0], uy = py[1] - py[0], uz = pz[1] - pz[0];
      const vx = px[2] - px[0], vy = py[2] - py[0], vz = pz[2] - pz[0];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const lenAfter = Math.hypot(nx, ny, nz);
      if (lenAfter < 1e-9) return false;
      const dot = (nx * before[0] + ny * before[1] + nz * before[2]) / (lenAfter * lenBefore);
      if (dot < 0.35) return false;
      // Shape quality. A collapse is allowed to make a triangle bigger but not
      // to make it a splinter: the smallest altitude (2 * area / longest edge)
      // has to stay a real fraction of that edge. Splinters are what a plain
      // "did the normal flip?" guard lets through, and they are miserable for
      // both shading derivatives and the rasterizer.
      const e = [
        Math.hypot(px[1] - px[0], py[1] - py[0], pz[1] - pz[0]),
        Math.hypot(px[2] - px[1], py[2] - py[1], pz[2] - pz[1]),
        Math.hypot(px[0] - px[2], py[0] - py[2], pz[0] - pz[2]),
      ];
      const longest = Math.max(e[0], e[1], e[2]);
      if (longest < 1e-9) return false;
      if (lenAfter / (longest * longest) < MIN_TRIANGLE_QUALITY) return false;
    }
    return true;
  };

  // ---- binary min-heap with lazy invalidation ----
  const heap = [];
  const version = new Int32Array(vertexCount);
  const heapPush = (item) => {
    heap.push(item);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p].cost <= heap[i].cost) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const heapPop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l].cost < heap[m].cost) m = l;
        if (r < heap.length && heap[r].cost < heap[m].cost) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };

  const offer = (a, b) => {
    const c = cost(a, b);
    if (c === Infinity) return;
    heapPush({ cost: c, a, b, va: version[a], vb: version[b] });
  };

  for (let t = 0; t < triCount; t++) {
    for (let c = 0; c < 3; c++) {
      const a = tri[t * 3 + c], b = tri[t * 3 + ((c + 1) % 3)];
      offer(a, b);
      offer(b, a);
    }
  }

  let live = triCount;
  while (heap.length && live > 4) {
    const top = heapPop();
    if (version[top.a] !== top.va || version[top.b] !== top.vb) continue;
    if (live <= maxTris && top.cost > errorLimit) break;
    if (!valid(top.a, top.b)) continue;
    const a = top.a, b = top.b;
    const ta = liveTrisOf(a).slice();
    for (const t of ta) {
      const i0 = tri[t * 3], i1 = tri[t * 3 + 1], i2 = tri[t * 3 + 2];
      if (i0 === b || i1 === b || i2 === b) { dead[t] = 1; live--; continue; }
      for (let c = 0; c < 3; c++) if (tri[t * 3 + c] === a) tri[t * 3 + c] = b;
      incident[b].push(t);
    }
    vertexDead[a] = 1;
    for (let i = 0; i < 10; i++) Q[b * 10 + i] += Q[a * 10 + i];
    version[a]++;
    version[b]++;
    const touched = new Set([b]);
    for (const t of liveTrisOf(b)) for (let c = 0; c < 3; c++) touched.add(tri[t * 3 + c]);
    for (const v of touched) version[v]++;
    for (const t of liveTrisOf(b)) {
      for (let c = 0; c < 3; c++) {
        const u = tri[t * 3 + c], w = tri[t * 3 + ((c + 1) % 3)];
        offer(u, w);
        offer(w, u);
      }
    }
  }

  // ---- compact ----
  const remap = new Int32Array(vertexCount).fill(-1);
  const outPos = [], outNrm = [], outIdx = [];
  for (let t = 0; t < triCount; t++) {
    if (dead[t]) continue;
    const ids = [tri[t * 3], tri[t * 3 + 1], tri[t * 3 + 2]];
    if (ids[0] === ids[1] || ids[1] === ids[2] || ids[0] === ids[2]) continue;
    for (const v of ids) {
      if (remap[v] < 0) {
        remap[v] = outPos.length / 3;
        outPos.push(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
        outNrm.push(nrm[v * 3], nrm[v * 3 + 1], nrm[v * 3 + 2]);
      }
      outIdx.push(remap[v]);
    }
  }
  return {
    pos: Float64Array.from(outPos),
    nrm: Float64Array.from(outNrm),
    idx: Uint32Array.from(outIdx),
  };
}

/**
 * Steep terrain carries the silhouette, and silhouette error is the error a
 * player sees: a collapse ALONG a cliff face is cheap in quadric terms (it
 * barely moves the surface off its own plane) but it re-cuts the outline the
 * cliff draws against the sky. Cliffs and talus cones are a small share of the
 * triangles, so they are simply held at full resolution.
 */
function steepVertices(pos, nrm, idx, limit) {
  const locked = new Uint8Array(pos.length / 3);
  for (let t = 0; t < idx.length; t += 3) {
    const ids = [idx[t], idx[t + 1], idx[t + 2]];
    const p = ids.map((v) => [pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]]);
    const u = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]];
    const v = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const len = Math.hypot(n[0], n[1], n[2]);
    if (len < 1e-12) continue;
    const ref = [0, 1, 2].map((c) => (nrm[ids[0] * 3 + c] + nrm[ids[1] * 3 + c] + nrm[ids[2] * 3 + c]) / 3);
    const sign = n[0] * ref[0] + n[1] * ref[1] + n[2] * ref[2] < 0 ? -1 : 1;
    if ((sign * n[1]) / len < limit) for (const v2 of ids) locked[v2] = 1;
  }
  return locked;
}

/** Vertices that sit on an open (single-triangle) edge: the chunk's own rim. */
function boundaryVertices(pos, idx) {
  const count = pos.length / 3;
  const edges = new Map();
  for (let t = 0; t < idx.length; t += 3) {
    for (let c = 0; c < 3; c++) {
      const a = idx[t + c], b = idx[t + ((c + 1) % 3)];
      const key = a < b ? a * count + b : b * count + a;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  const locked = new Uint8Array(count);
  for (const [key, n] of edges) {
    if (n === 2) continue;
    locked[Math.floor(key / count)] = 1;
    locked[key % count] = 1;
  }
  return locked;
}

/** Sorted, printable fingerprint of the mesh boundary, for the safety check. */
function boundaryFingerprint(pos, idx) {
  const count = pos.length / 3;
  const edges = new Map();
  for (let t = 0; t < idx.length; t += 3) {
    for (let c = 0; c < 3; c++) {
      const a = idx[t + c], b = idx[t + ((c + 1) % 3)];
      const key = a < b ? a * count + b : b * count + a;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  const out = [];
  const p = (v) => `${pos[v * 3].toFixed(5)},${pos[v * 3 + 1].toFixed(5)},${pos[v * 3 + 2].toFixed(5)}`;
  for (const [key, n] of edges) {
    if (n === 2) continue;
    const a = Math.floor(key / count), b = key % count;
    const [x, y] = [p(a), p(b)].sort();
    out.push(`${x}|${y}`);
  }
  return out.sort().join("\n");
}

// -------------------------------------------------------- classify + project

/**
 * Stable hash of a quantised ARENA-WORLD point. The Blender pass hashed the
 * chunk-LOCAL centre, and 192 / 3.5 is not an integer, so the same world point
 * landed in different lattice cells on either side of a border and could
 * classify as floor on one side and wall on the other — a straight line of
 * albedo, tiling and normal changes exactly on the seam.
 */
function faceNoise(x, y, z) {
  const qx = Math.floor(x / NOISE_CELL), qy = Math.floor(y / NOISE_CELL), qz = Math.floor(z / NOISE_CELL);
  // Every step stays unsigned. `h ^= h >>> 16` on its own yields a SIGNED
  // int32, and a negative h here pushed the jitter well outside [-1, 1] — the
  // slope threshold could fall to 0.19, which put near-vertical faces into the
  // FLOOR material with the floor's 90u tiling.
  let h = (Math.imul(qx, 73856093) ^ Math.imul(qy, 19349663) ^ Math.imul(qz, 83492791)) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  h = Math.imul(h, 0x7feb352d) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  h = Math.imul(h, 0x846ca68b) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return (h / 0xffffffff) * 2 - 1;
}

const MATERIALS = [
  {
    name: "RIFT_FLOOR",
    doubleSided: true,
    pbrMetallicRoughness: {
      baseColorFactor: [0.48, 0.49, 0.53, 1],
      metallicFactor: 0,
      baseColorTexture: { index: 0 },
      metallicRoughnessTexture: { index: 2 },
    },
    normalTexture: { index: 1, scale: 1.15 },
    occlusionTexture: { index: 2 },
  },
  {
    name: "RIFT_WALL",
    doubleSided: true,
    pbrMetallicRoughness: {
      baseColorFactor: [0.56, 0.57, 0.61, 1],
      metallicFactor: 0,
      baseColorTexture: { index: 3 },
      metallicRoughnessTexture: { index: 5 },
    },
    normalTexture: { index: 4, scale: 1.25 },
    occlusionTexture: { index: 5 },
  },
];
const IMAGES = [
  { name: "moon_dusted_01_diff_1k", mimeType: "image/jpeg", uri: "textures/game/moon_dusted_01_diff_1k_df55e08c63fa.jpg" },
  { name: "moon_dusted_01_nor_1k", mimeType: "image/jpeg", uri: "textures/game/moon_dusted_01_nor_1k_f73a75efeb49.jpg" },
  { name: "moon_dusted_01_ao_1k-moon_dusted_01_rough_1k", mimeType: "image/jpeg", uri: "textures/game/moon_dusted_01_ao_1k-moon_dusted_01_roug_bb75cb1cc5dd.jpg" },
  { name: "cliff_side_diff_1k", mimeType: "image/jpeg", uri: "textures/game/cliff_side_diff_1k_201fe54947b7.jpg" },
  { name: "cliff_side_nor_1k", mimeType: "image/jpeg", uri: "textures/game/cliff_side_nor_1k_24bcf83ec5cd.jpg" },
  { name: "cliff_side_ao_1k-cliff_side_rough_1k", mimeType: "image/jpeg", uri: "textures/game/cliff_side_ao_1k-cliff_side_rough_1k_1fd93fd83d64.jpg" },
];
const TEXTURES = IMAGES.map((_, i) => ({ source: i, sampler: 0 }));
const SAMPLERS = [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }];

/**
 * Splits the mesh into a FLOOR and a WALL primitive and gives every face a
 * planar projection chosen from its OWN normal, at its OWN material's tile
 * scale. Vertices shared by faces that want different projections are
 * duplicated, so no triangle ever interpolates between two unrelated
 * projections — that is what used to blow a face's texel density up by 3.75x
 * and drop it several mip levels, drawing a bright band along the chunk edge.
 */
function project(mesh, offset) {
  const buckets = [
    { verts: new Map(), pos: [], nrm: [], uv: [], idx: [] },
    { verts: new Map(), pos: [], nrm: [], uv: [], idx: [] },
  ];
  const triCount = mesh.idx.length / 3;
  for (let t = 0; t < triCount; t++) {
    const ids = [mesh.idx[t * 3], mesh.idx[t * 3 + 1], mesh.idx[t * 3 + 2]];
    const wx = ids.map((v) => mesh.pos[v * 3] + offset.x);
    const wy = ids.map((v) => mesh.pos[v * 3 + 1] + offset.y);
    const wz = ids.map((v) => mesh.pos[v * 3 + 2] + offset.z);
    const ux = wx[1] - wx[0], uy = wy[1] - wy[0], uz = wz[1] - wz[0];
    const vx = wx[2] - wx[0], vy = wy[2] - wy[0], vz = wz[2] - wz[0];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-12) continue;
    nx /= len; ny /= len; nz /= len;
    // Orient against the authored vertex normals: the classification wants the
    // OUTWARD face, and winding alone is not a promise after CSG.
    const refY = (mesh.nrm[ids[0] * 3 + 1] + mesh.nrm[ids[1] * 3 + 1] + mesh.nrm[ids[2] * 3 + 1]) / 3;
    const refX = (mesh.nrm[ids[0] * 3] + mesh.nrm[ids[1] * 3] + mesh.nrm[ids[2] * 3]) / 3;
    const refZ = (mesh.nrm[ids[0] * 3 + 2] + mesh.nrm[ids[1] * 3 + 2] + mesh.nrm[ids[2] * 3 + 2]) / 3;
    if (nx * refX + ny * refY + nz * refZ < 0) { nx = -nx; ny = -ny; nz = -nz; }
    const cx = (wx[0] + wx[1] + wx[2]) / 3, cy = (wy[0] + wy[1] + wy[2]) / 3, cz = (wz[0] + wz[1] + wz[2]) / 3;
    const material = ny >= SLOPE_UP + SLOPE_JITTER * faceNoise(cx, cy, cz) ? 0 : 1;
    const tile = material === 0 ? TILE_FLOOR : TILE_WALL;
    const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
    const axis = ay >= ax && ay >= az ? 1 : ax >= az ? 0 : 2;
    const bucket = buckets[material];
    for (let c = 0; c < 3; c++) {
      const v = ids[c];
      const key = v * 4 + axis;
      let out = bucket.verts.get(key);
      if (out === undefined) {
        out = bucket.pos.length / 3;
        bucket.verts.set(key, out);
        bucket.pos.push(mesh.pos[v * 3], mesh.pos[v * 3 + 1], mesh.pos[v * 3 + 2]);
        bucket.nrm.push(mesh.nrm[v * 3], mesh.nrm[v * 3 + 1], mesh.nrm[v * 3 + 2]);
        const u = axis === 1 ? wx[c] : axis === 0 ? wz[c] : wx[c];
        const w = axis === 1 ? wz[c] : wy[c];
        bucket.uv.push(u / tile, w / tile);
      }
      bucket.idx.push(out);
    }
  }
  return buckets;
}

/**
 * Geometry goes through @gltf-transform's writer rather than a hand-rolled one.
 * The PBR block is then patched into the JSON, because the textures are
 * uri-referenced files that gltf-transform's writer will not emit alongside
 * embedded geometry (the same reason tools/postprocess-terrain-glbs.mjs did its
 * own container surgery).
 */
async function encode(name, buckets) {
  const doc = new Document();
  doc.getRoot().getAsset().generator = "space-arena/bake-lunar-rift-terrain";
  const buffer = doc.createBuffer();
  const mesh = doc.createMesh(name);
  const materials = MATERIALS.map((spec) => doc.createMaterial(spec.name));
  for (const [material, bucket] of buckets.entries()) {
    if (bucket.idx.length === 0) continue;
    // No COLOR_0: it was flat white on every shipped vertex, nothing reads it,
    // and a VEC4 vertex-colour attribute makes Babylon treat the mesh as
    // possibly alpha-blended.
    const count = bucket.pos.length / 3;
    const primitive = doc.createPrimitive()
      .setAttribute("POSITION", doc.createAccessor().setType("VEC3").setArray(Float32Array.from(bucket.pos)).setBuffer(buffer))
      .setAttribute("NORMAL", doc.createAccessor().setType("VEC3").setArray(Float32Array.from(bucket.nrm)).setBuffer(buffer))
      .setAttribute("TEXCOORD_0", doc.createAccessor().setType("VEC2").setArray(Float32Array.from(bucket.uv)).setBuffer(buffer))
      .setIndices(doc.createAccessor().setType("SCALAR")
        .setArray(count > 65535 ? Uint32Array.from(bucket.idx) : Uint16Array.from(bucket.idx)).setBuffer(buffer))
      .setMaterial(materials[material]);
    mesh.addPrimitive(primitive);
  }
  doc.createScene(name).addChild(doc.createNode(name).setMesh(mesh));
  const { json, bin } = parseGlb(Buffer.from(await io.writeBinary(doc)));
  // Swap each emitted placeholder material for the textured PBR block of the
  // same name, in place, so every primitive's material index still points at
  // the material it was given.
  json.materials = json.materials.map((emitted) => {
    const spec = MATERIALS.find((candidate) => candidate.name === emitted.name);
    if (!spec) throw new Error(`unexpected material ${emitted.name}`);
    return spec;
  });
  json.textures = TEXTURES;
  json.images = IMAGES;
  json.samplers = SAMPLERS;
  json.asset.extras = { ...(json.asset.extras ?? {}), lunarRiftTerrainBake: BAKE_VERSION };
  return writeGlb(json, bin);
}

// ------------------------------------------------------------------ pipeline

const arena = JSON.parse(readFileSync(ARENA, "utf8"));
const offsets = new Map(
  arena.propPlacements
    .filter((p) => /^prop\.lunar-rift-chunk-\d+$/.test(p.propId))
    .map((p) => [Number(p.propId.replace("prop.lunar-rift-chunk-", "")), p.position]),
);

let misclassified = 0;
/**
 * Re-derives every emitted face's slope from the bytes that are about to be
 * written and checks it against the band the classifier is allowed to use. A
 * near-vertical face in the FLOOR primitive is both a shading lie and a texel
 * density blow-up, so this must stay at zero.
 */
function auditClassification(buckets, offset) {
  let bad = 0;
  for (const [material, bucket] of buckets.entries()) {
    for (let t = 0; t < bucket.idx.length; t += 3) {
      const ids = [bucket.idx[t], bucket.idx[t + 1], bucket.idx[t + 2]];
      const p = ids.map((v) => [bucket.pos[v * 3] + offset.x, bucket.pos[v * 3 + 1] + offset.y, bucket.pos[v * 3 + 2] + offset.z]);
      const u = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]];
      const v = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
      const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const len = Math.hypot(n[0], n[1], n[2]);
      if (len < 1e-12) continue;
      const ref = [0, 1, 2].map((c) => (bucket.nrm[ids[0] * 3 + c] + bucket.nrm[ids[1] * 3 + c] + bucket.nrm[ids[2] * 3 + c]) / 3);
      const sign = n[0] * ref[0] + n[1] * ref[1] + n[2] * ref[2] < 0 ? -1 : 1;
      const ny = (sign * n[1]) / len;
      if (material === 0 && ny < SLOPE_UP - SLOPE_JITTER) bad++;
      if (material === 1 && ny > SLOPE_UP + SLOPE_JITTER) bad++;
    }
  }
  return bad;
}

let lod0Total = 0, lod1Total = 0, sourceTotal = 0, bytesTotal = 0;
let skipped = 0;
const sources = [];
for (let index = 0; index < 16; index++) {
  const file = path.join(PROPS, `lunar-rift-chunk-${index}.glb`);
  const { json, bin } = parseGlb(readFileSync(file));
  const names = (json.materials ?? []).map((m) => m.name);
  if (names.includes("RIFT_FLOOR") || names.includes("RIFT_WALL")) {
    skipped++;
    continue;
  }
  const offset = offsets.get(index);
  if (!offset) throw new Error(`no placement for chunk ${index}`);
  const primitive = json.meshes[0].primitives[0];
  const pos = Float64Array.from(readAccessor(json, bin, primitive.attributes.POSITION));
  const nrm = Float64Array.from(readAccessor(json, bin, primitive.attributes.NORMAL));
  const idx = Uint32Array.from(readAccessor(json, bin, primitive.indices));
  sourceTotal += idx.length / 3;
  const locked = boundaryVertices(pos, idx);
  const steep = steepVertices(pos, nrm, idx, STEEP_LOCK);
  for (let v = 0; v < locked.length; v++) if (steep[v]) locked[v] = 1;
  sources.push({ index, offset, pos, nrm, idx, locked });
}

if (skipped) {
  console.log(`${skipped} chunk(s) already baked — re-run tools/generate-lunar-rift.ts for a fresh source mesh.`);
}
if (sources.length === 0) process.exit(0);
if (skipped) throw new Error("refusing a partial bake: some chunks are baked and some are raw");

/**
 * Weld the chunk rims to each other before anything else touches them.
 *
 * The grid itself already lands both neighbours on the same world points, but
 * the manifold CSG that cuts the tunnel bores solves its plane intersections
 * per chunk, and at a bore that clips a chunk footprint it can land the same
 * intersection a few millimetres apart on the two sides. That is a real hole,
 * just a very thin one. Snapping every rim vertex to the mean of its cluster
 * closes it, and collapses the micro-edges around it to nothing.
 */
function weldRims(meshes) {
  const TOL = 0.03;
  const groups = [];
  const grid = new Map();
  const cellOf = (x, y, z) => `${Math.floor(x / TOL)},${Math.floor(y / TOL)},${Math.floor(z / TOL)}`;
  const members = [];
  for (const mesh of meshes) {
    for (let v = 0; v < mesh.pos.length / 3; v++) {
      if (!mesh.locked[v]) continue;
      const x = mesh.pos[v * 3] + mesh.offset.x;
      const y = mesh.pos[v * 3 + 1] + mesh.offset.y;
      const z = mesh.pos[v * 3 + 2] + mesh.offset.z;
      let found = -1;
      for (let dx = -1; dx <= 1 && found < 0; dx++) {
        for (let dy = -1; dy <= 1 && found < 0; dy++) {
          for (let dz = -1; dz <= 1 && found < 0; dz++) {
            for (const g of grid.get(cellOf(x + dx * TOL, y + dy * TOL, z + dz * TOL)) ?? []) {
              const c = groups[g];
              if (Math.hypot(c.x / c.n - x, c.y / c.n - y, c.z / c.n - z) <= TOL) { found = g; break; }
            }
          }
        }
      }
      if (found < 0) {
        found = groups.length;
        groups.push({ x: 0, y: 0, z: 0, n: 0 });
        const key = cellOf(x, y, z);
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push(found);
      }
      const g = groups[found];
      g.x += x; g.y += y; g.z += z; g.n++;
      members.push({ mesh, v, group: found });
    }
  }
  let moved = 0;
  for (const m of members) {
    const g = groups[m.group];
    const x = g.x / g.n, y = g.y / g.n, z = g.z / g.n;
    const dx = x - m.mesh.offset.x - m.mesh.pos[m.v * 3];
    const dy = y - m.mesh.offset.y - m.mesh.pos[m.v * 3 + 1];
    const dz = z - m.mesh.offset.z - m.mesh.pos[m.v * 3 + 2];
    if (Math.hypot(dx, dy, dz) > 1e-9) moved++;
    m.mesh.pos[m.v * 3] += dx;
    m.mesh.pos[m.v * 3 + 1] += dy;
    m.mesh.pos[m.v * 3 + 2] += dz;
  }
  return { groups: groups.length, moved };
}

const weld = weldRims(sources);
console.log(`rim weld: ${weld.groups} shared rim points, ${weld.moved} vertices nudged onto them`);

console.log("chunk   source     LOD0     LOD1   floor%   LOD0 KB   LOD1 KB");
for (const source of sources) {
  const { index, offset, pos, nrm, idx, locked } = source;
  const before = boundaryFingerprint(pos, idx);

  const levels = [];
  for (const [lod, errorLimit, maxTris] of [[0, LOD0_ERROR, LOD0_MAX_TRIS], [1, LOD1_ERROR, LOD1_MAX_TRIS]]) {
    const mesh = simplify(pos, nrm, idx, locked, { errorLimit, maxTris });
    const after = boundaryFingerprint(mesh.pos, mesh.idx);
    if (after !== before) {
      throw new Error(`chunk ${index} LOD${lod}: simplification moved the chunk boundary — the seam guard failed`);
    }
    levels.push(mesh);
  }

  const outputs = [];
  for (const [lod, mesh] of levels.entries()) {
    const buckets = project(mesh, offset);
    misclassified += auditClassification(buckets, offset);
    const bytes = await encode(`LOD${lod}_TERRAIN_${index}`, buckets);
    const target = path.join(PROPS, `lunar-rift-chunk-${index}${lod === 1 ? "_lod1" : ""}.glb`);
    outputs.push({ target, bytes, tris: mesh.idx.length / 3, floor: buckets[0].idx.length / 3 });
  }
  for (const out of outputs) writeFileSync(out.target, out.bytes);
  lod0Total += outputs[0].tris;
  lod1Total += outputs[1].tris;
  bytesTotal += outputs[0].bytes.length + outputs[1].bytes.length;
  console.log(
    `${String(index).padStart(5)}${String(idx.length / 3).padStart(9)}${String(outputs[0].tris).padStart(9)}` +
    `${String(outputs[1].tris).padStart(9)}${((outputs[0].floor / outputs[0].tris) * 100).toFixed(0).padStart(8)}%` +
    `${(outputs[0].bytes.length / 1024).toFixed(0).padStart(10)}${(outputs[1].bytes.length / 1024).toFixed(0).padStart(10)}`,
  );
}

if (misclassified) {
  console.error(`${misclassified} faces sit outside their material's slope band`);
  process.exitCode = 1;
}
console.log(`\nsource ${sourceTotal.toLocaleString()} tris -> LOD0 ${lod0Total.toLocaleString()} / LOD1 ${lod1Total.toLocaleString()}` +
  ` (${(bytesTotal / 1e6).toFixed(2)} MB of chunk GLBs)`);
const fail = [];
if (lod0Total > LOD0_TRI_BUDGET) fail.push(`LOD0 ${lod0Total} > ${LOD0_TRI_BUDGET}`);
if (lod1Total > LOD1_TRI_BUDGET) fail.push(`LOD1 ${lod1Total} > ${LOD1_TRI_BUDGET}`);
if (fail.length) {
  console.error(`OVER BUDGET: ${fail.join(", ")}`);
  process.exitCode = 1;
}
