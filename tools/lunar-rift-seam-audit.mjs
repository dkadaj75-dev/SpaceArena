// Lunar Rift chunk-border audit — the gate that keeps the ground continuous.
//
//   node tools/lunar-rift-seam-audit.mjs [--props-dir path] [--arena path] [--lod 0|1|mix]
//
// Two measurements:
//
//  1. HOLES IN THE GROUND (the hard gate). Weld all 16 placed chunks by world
//     position and count triangle edges that belong to only ONE triangle, minus
//     the arena's outer rim, which is open because the world ends there. If the
//     neighbouring chunks present the same vertex ring every internal edge is
//     shared and the count is zero. Anything above zero is a literal hole: at a
//     grazing camera angle the background shows through it as a dead-straight
//     line, which is the bug the player has been reporting.
//  2. SURFACE DIVERGENCE near a border, sampled on near-horizontal ground only
//     (on a cliff the two samples are 4cm apart across a 60u drop and the number
//     means nothing). Informational — a real hole shows up in metric 1.
//
// `--lod mix` checkerboards the LOD levels so every internal border is
// cross-LOD, which is the normal in-play state (chunk centres are 192u apart).
/* global Buffer, process, console */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const arg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  if (!process.argv[index + 1]) throw new Error(`${name} requires a value`);
  return process.argv[index + 1];
};

const PROPS = path.resolve(process.cwd(), arg("--props-dir", "content/props"));
const ARENA = path.resolve(process.cwd(), arg("--arena", "content/arenas/lunar-rift.json"));
const MODE = arg("--lod", "0");
const SAMPLE = Number(arg("--sample", "0.25"));
/** Gates. A ledge under a millimetre of world scale cannot shade or leak. */
const OPEN_EDGE_GATE_U = 0.5;
const LEDGE_GATE_U = 0.05;
const LEDGE_FRACTION_GATE = 0.01;

const CHUNKS_PER_SIDE = 4;
const CHUNK_SIZE = 192;
const PLANES = [-192, 0, 192];

const COMPONENTS = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const SIZES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const ELEMENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

export function parseGlb(bytes) {
  const jsonLength = bytes.readUInt32LE(12);
  const json = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString("utf8"));
  const binAt = 20 + jsonLength;
  const binLength = bytes.readUInt32LE(binAt);
  return { json, bin: Buffer.from(bytes.subarray(binAt + 8, binAt + 8 + binLength)) };
}

export function readAccessor(json, bin, index) {
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

/** World-space triangle soup for one chunk GLB, with a coarse XZ bucket index. */
export function loadChunk(file, offset) {
  const { json, bin } = parseGlb(readFileSync(file));
  const tris = [];
  for (const mesh of json.meshes) {
    for (const primitive of mesh.primitives) {
      const pos = readAccessor(json, bin, primitive.attributes.POSITION);
      const idx = readAccessor(json, bin, primitive.indices);
      for (let t = 0; t < idx.length; t += 3) {
        const a = idx[t], b = idx[t + 1], c = idx[t + 2];
        if (a === b || b === c || a === c) continue;
        tris.push([
          [pos[a * 3] + offset.x, pos[a * 3 + 1] + offset.y, pos[a * 3 + 2] + offset.z],
          [pos[b * 3] + offset.x, pos[b * 3 + 1] + offset.y, pos[b * 3 + 2] + offset.z],
          [pos[c * 3] + offset.x, pos[c * 3 + 1] + offset.y, pos[c * 3 + 2] + offset.z],
        ]);
      }
    }
  }
  return index(tris);
}

const BUCKET = 8;
function index(tris) {
  const buckets = new Map();
  for (const tri of tris) {
    const minX = Math.min(tri[0][0], tri[1][0], tri[2][0]), maxX = Math.max(tri[0][0], tri[1][0], tri[2][0]);
    const minZ = Math.min(tri[0][2], tri[1][2], tri[2][2]), maxZ = Math.max(tri[0][2], tri[1][2], tri[2][2]);
    for (let i = Math.floor(minX / BUCKET); i <= Math.floor(maxX / BUCKET); i++) {
      for (let j = Math.floor(minZ / BUCKET); j <= Math.floor(maxZ / BUCKET); j++) {
        const k = `${i},${j}`;
        let list = buckets.get(k);
        if (!list) { list = []; buckets.set(k, list); }
        list.push(tri);
      }
    }
  }
  return { tris, buckets };
}

/** Height of the highest surface at (x, z), or null where the chunk has none. */
export function topAt(chunk, x, z) {
  const list = chunk.buckets.get(`${Math.floor(x / BUCKET)},${Math.floor(z / BUCKET)}`);
  if (!list) return null;
  let best = null;
  for (const tri of list) {
    const [p0, p1, p2] = tri;
    const d = (p1[2] - p2[2]) * (p0[0] - p2[0]) + (p2[0] - p1[0]) * (p0[2] - p2[2]);
    if (Math.abs(d) < 1e-12) continue;
    const l0 = ((p1[2] - p2[2]) * (x - p2[0]) + (p2[0] - p1[0]) * (z - p2[2])) / d;
    if (l0 < 0 || l0 > 1) continue;
    const l1 = ((p2[2] - p0[2]) * (x - p2[0]) + (p0[0] - p2[0]) * (z - p2[2])) / d;
    if (l1 < 0 || l1 > 1) continue;
    const l2 = 1 - l0 - l1;
    if (l2 < 0 || l2 > 1) continue;
    const y = l0 * p0[1] + l1 * p1[1] + l2 * p2[1];
    if (best === null || y > best) best = y;
  }
  return best;
}

// `fileURLToPath`, not `new URL(...).pathname`: on Windows the latter yields
// "/D:/repo/tools/x.mjs" (leading slash, forward slashes) while `path.resolve`
// yields "D:\repo\tools\x.mjs", so the guard never matched and the audit exited
// 0 having measured nothing. It ran on Linux, which is why the seam gate looked
// green everywhere it was ever checked.
const entry = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entry === fileURLToPath(import.meta.url)) {
  main();
}

function lodOf(index) {
  if (MODE === "0") return 0;
  if (MODE === "1") return 1;
  return ((index % CHUNKS_PER_SIDE) + Math.floor(index / CHUNKS_PER_SIDE)) % 2;
}

/**
 * Metric 1: open (single-triangle) edges after welding all 16 placed chunks in
 * world space.
 *
 * A chunk rim is NOT a straight line at x/z = ±192: the generator displaces
 * surface vertices laterally by up to 2.4u, so the shared ring wanders either
 * side of the nominal plane. Testing "is this edge in the border plane" would
 * therefore miss exactly the edges that wander, which is how earlier passes
 * convinced themselves the borders were welded. So this counts EVERY open edge
 * and subtracts only the arena's outer rim (|x| or |z| ≈ 384), which is
 * genuinely open because the world ends there. Whatever is left is a hole in
 * the ground, wherever it happens to sit.
 */
function openBorderEdges(placements) {
  const TOL = 1e-3;
  const key = (x, y, z) => `${Math.round(x / TOL)},${Math.round(y / TOL)},${Math.round(z / TOL)}`;
  const verts = new Map();
  const edges = new Map();
  for (let i = 0; i < 16; i++) {
    const file = path.join(PROPS, `lunar-rift-chunk-${i}${lodOf(i) ? "_lod1" : ""}.glb`);
    const { json, bin } = parseGlb(readFileSync(file));
    const off = placements.get(i);
    for (const mesh of json.meshes) {
      for (const prim of mesh.primitives) {
        const pos = readAccessor(json, bin, prim.attributes.POSITION);
        const idx = readAccessor(json, bin, prim.indices);
        for (let t = 0; t < idx.length; t += 3) {
          const ks = [];
          for (let c = 0; c < 3; c++) {
            const v = idx[t + c];
            const x = pos[v * 3] + off.x, y = pos[v * 3 + 1] + off.y, z = pos[v * 3 + 2] + off.z;
            const k = key(x, y, z);
            if (!verts.has(k)) verts.set(k, [x, y, z]);
            ks.push(k);
          }
          if (ks[0] === ks[1] || ks[1] === ks[2] || ks[0] === ks[2]) continue;
          for (let e = 0; e < 3; e++) {
            const a = ks[e], b = ks[(e + 1) % 3];
            const ek = a < b ? `${a}|${b}` : `${b}|${a}`;
            edges.set(ek, (edges.get(ek) ?? 0) + 1);
          }
        }
      }
    }
  }
  const RIM = 384;
  const onArenaRim = (p) => Math.abs(Math.abs(p[0]) - RIM) < 3 || Math.abs(Math.abs(p[2]) - RIM) < 3;
  const perPlane = new Map();
  let count = 0, length = 0, rimLength = 0;
  const worst = [];
  for (const [ek, n] of edges) {
    if (n === 2) continue;
    const [ka, kb] = ek.split("|");
    const a = verts.get(ka), b = verts.get(kb);
    const len = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    if (onArenaRim(a) && onArenaRim(b)) { rimLength += len; continue; }
    count++;
    length += len;
    let plane = "elsewhere";
    for (const p of PLANES) {
      if (Math.abs(a[0] - p) < 3 && Math.abs(b[0] - p) < 3) plane = `near x=${p}`;
      if (Math.abs(a[2] - p) < 3 && Math.abs(b[2] - p) < 3) plane = `near z=${p}`;
    }
    perPlane.set(plane, (perPlane.get(plane) ?? 0) + len);
    worst.push({ len, a, plane });
  }
  worst.sort((x, y) => y.len - x.len);
  return { count, length, rimLength, perPlane, worst: worst.slice(0, 5) };
}

/** Metric 2: vertical step across the border, measured only on flat ground. */
function flatLedge(chunks) {
  const borders = [];
  for (let iz = 0; iz < CHUNKS_PER_SIDE; iz++) {
    for (let ix = 0; ix < CHUNKS_PER_SIDE; ix++) {
      const index = iz * CHUNKS_PER_SIDE + ix;
      const x0 = -384 + ix * CHUNK_SIZE, z0 = -384 + iz * CHUNK_SIZE;
      if (ix < CHUNKS_PER_SIDE - 1) borders.push({ axis: "x", plane: x0 + CHUNK_SIZE, a: index, b: index + 1, from: z0, to: z0 + CHUNK_SIZE });
      if (iz < CHUNKS_PER_SIDE - 1) borders.push({ axis: "z", plane: z0 + CHUNK_SIZE, a: index, b: index + CHUNKS_PER_SIDE, from: x0, to: x0 + CHUNK_SIZE });
    }
  }
  const EPS = 0.02;
  const FLAT_RUN = 3;
  const FLAT_SLOPE = 0.3;
  const rows = [];
  let flatLen = 0, steppedLen = 0, worst = 0, worstAt = "";
  const histogram = [0, 0, 0, 0];
  let samples = 0;
  for (const border of borders) {
    const A = chunks.get(border.a), B = chunks.get(border.b);
    let len = 0, stepped = 0, sum = 0, max = 0, n = 0;
    for (let t = border.from + SAMPLE / 2; t < border.to; t += SAMPLE) {
      const at = (side, back) => (border.axis === "x"
        ? topAt(side, border.plane + back, t)
        : topAt(side, t, border.plane + back));
      const ya = at(A, -EPS), yb = at(B, EPS);
      if (ya === null || yb === null) continue;
      const ya2 = at(A, -FLAT_RUN), yb2 = at(B, FLAT_RUN);
      if (ya2 === null || yb2 === null) continue;
      // Both sides must be near-horizontal: on a cliff the two samples are 4cm
      // apart across a 60u drop and the difference is meaningless.
      if (Math.abs(ya2 - ya) / FLAT_RUN > FLAT_SLOPE) continue;
      if (Math.abs(yb2 - yb) / FLAT_RUN > FLAT_SLOPE) continue;
      len += SAMPLE;
      n++;
      samples++;
      const d = Math.abs(ya - yb);
      sum += d;
      if (d > max) max = d;
      if (d > worst) { worst = d; worstAt = `${border.axis}=${border.plane} ${border.a}|${border.b} t=${t.toFixed(1)}`; }
      if (d > LEDGE_GATE_U) stepped += SAMPLE;
      if (d > 0.01) histogram[0]++;
      if (d > 0.05) histogram[1]++;
      if (d > 0.15) histogram[2]++;
      if (d > 0.5) histogram[3]++;
    }
    flatLen += len;
    steppedLen += stepped;
    if (len > 0) {
      rows.push({
        name: `${border.axis}=${String(border.plane).padStart(4)} ${String(border.a).padStart(2)}|${String(border.b).padStart(2)}`,
        len, stepped, mean: sum / Math.max(1, n), max,
      });
    }
  }
  return { rows, flatLen, steppedLen, worst, worstAt, histogram, samples };
}

function main() {
  const arena = JSON.parse(readFileSync(ARENA, "utf8"));
  const placements = new Map(
    arena.propPlacements
      .filter((p) => /^prop\.lunar-rift-chunk-\d+$/.test(p.propId))
      .map((p) => [Number(p.propId.replace("prop.lunar-rift-chunk-", "")), p.position]),
  );

  const open = openBorderEdges(placements);
  const chunks = new Map();
  for (let i = 0; i < 16; i++) {
    chunks.set(i, loadChunk(path.join(PROPS, `lunar-rift-chunk-${i}${lodOf(i) ? "_lod1" : ""}.glb`), placements.get(i)));
  }
  const ledge = flatLedge(chunks);

  console.log(`LOD mode ${MODE} — 24 internal borders, ${SAMPLE}u samples`);
  console.log("");
  console.log(`HOLES IN THE GROUND  ${open.count} open edges, ${open.length.toFixed(2)}u`
    + `  (arena outer rim, legitimately open: ${open.rimLength.toFixed(0)}u)`);
  for (const [plane, len] of [...open.perPlane].sort()) console.log(`    ${plane}: ${len.toFixed(2)}u`);
  for (const w of open.worst) console.log(`    longest ${w.len.toFixed(3)}u at (${w.a.map((v) => v.toFixed(1)).join(", ")}) ${w.plane}`);
  console.log("");
  console.log(`SURFACE DIVERGENCE 2cm EITHER SIDE OF A BORDER  ${ledge.flatLen.toFixed(0)}u of near-horizontal border sampled`);
  console.log("  (informational: the rim is displaced laterally, so these two samples are not always");
  console.log("   the same point on the seam. A hole shows up in the metric above, not here.)");
  const worstRows = ledge.rows.sort((a, b) => b.max - a.max).slice(0, 8);
  console.log("  border            over 1cm    mean step     max step");
  for (const row of worstRows) {
    console.log(`  ${row.name}  ${((row.stepped / row.len) * 100).toFixed(1).padStart(7)}%  ${row.mean.toFixed(4).padStart(10)}u  ${row.max.toFixed(4).padStart(10)}u`);
  }
  const pct = (v) => ((v / Math.max(1, ledge.samples)) * 100).toFixed(2);
  console.log(`  >1cm ${pct(ledge.histogram[0])}%  >5cm ${pct(ledge.histogram[1])}%  >15cm ${pct(ledge.histogram[2])}%  >50cm ${pct(ledge.histogram[3])}%`);
  console.log(`  worst ${ledge.worst.toFixed(4)}u @ ${ledge.worstAt}`);

  const problems = [];
  if (open.length > OPEN_EDGE_GATE_U) problems.push(`${open.length.toFixed(2)}u of open edge away from the arena rim (limit ${OPEN_EDGE_GATE_U}u)`);
  const ledgeFraction = ledge.steppedLen / Math.max(1, ledge.flatLen);
  if (ledgeFraction > LEDGE_FRACTION_GATE) {
    problems.push(`${(ledgeFraction * 100).toFixed(2)}% of flat border diverges over ${LEDGE_GATE_U}u (limit ${(LEDGE_FRACTION_GATE * 100).toFixed(2)}%)`);
  }
  console.log("");
  if (problems.length) {
    console.log(`FAIL: ${problems.join("; ")}`);
    process.exitCode = 1;
  } else {
    console.log("PASS: chunk borders meet.");
  }
}
