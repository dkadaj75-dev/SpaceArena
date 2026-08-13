/**
 * Dependency-free QA renderer: a z-buffer software rasteriser over the FINAL
 * visual meshes, so what you judge is the geometry that ships (displacement,
 * baked vertex colour, CSG bores and all) rather than a raymarch of the
 * heightfield. AO is already baked into the vertex colour, so there is no
 * shadow pass — just the arena's own sun as a lambert key.
 */
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

export interface PreviewMesh {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
  /** World-space placement offset (chunk meshes are emitted chunk-local). */
  offset: readonly [number, number, number];
}

export interface View {
  readonly name: string;
  readonly eye: readonly [number, number, number];
  readonly target: readonly [number, number, number];
  readonly fov: number;
}

const SUN: readonly [number, number, number] = (() => {
  const d: [number, number, number] = [-0.707, 0.5, -0.5];
  const l = Math.hypot(d[0], d[1], d[2]);
  return [d[0] / l, d[1] / l, d[2] / l];
})();

const SUPERSAMPLE = 2;
const NEAR = 0.05;

function skyColor(dy: number): [number, number, number] {
  const t = Math.max(0, Math.min(1, (dy + 0.2) / 1.2));
  return [0.012 + 0.01 * t, 0.012 + 0.012 * t, 0.02 + 0.02 * t];
}

/** Per-vertex shading: the lunar look from the approved QA renders. */
function shade(color: readonly [number, number, number], n: readonly [number, number, number]): [number, number, number] {
  const diff = Math.max(0, n[0] * SUN[0] + n[1] * SUN[1] + n[2] * SUN[2]);
  const skyFill = 0.1 + 0.1 * Math.max(0, n[1]);
  const bounce = 0.05 * Math.max(0, -n[1] + 0.4);
  const e = 1.35 * diff + skyFill + bounce;
  return [color[0] * e, color[1] * e, color[2] * e];
}

interface Vertex {
  /** View space. */
  vx: number; vy: number; vz: number;
  r: number; g: number; b: number;
}

function lerpVertex(a: Vertex, b: Vertex, t: number): Vertex {
  return {
    vx: a.vx + (b.vx - a.vx) * t,
    vy: a.vy + (b.vy - a.vy) * t,
    vz: a.vz + (b.vz - a.vz) * t,
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
  };
}

export function renderView(meshes: readonly PreviewMesh[], view: View, outPath: string, width = 880, height = 500): void {
  const w = width * SUPERSAMPLE, h = height * SUPERSAMPLE;
  const aspect = w / h;
  const fl = 1 / Math.tan((view.fov * Math.PI) / 360);

  const eye = view.eye;
  const fwd = normalize([view.target[0] - eye[0], view.target[1] - eye[1], view.target[2] - eye[2]]);
  const right = normalize(cross(fwd, [0, 1, 0]));
  const up = cross(right, fwd);

  const color = new Float32Array(w * h * 3);
  const depth = new Float32Array(w * h);
  // Background: per-pixel sky along the primary ray, plus the same star hash
  // the approved QA renders used.
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const u = ((i + 0.5) / w) * 2 - 1, v = 1 - ((j + 0.5) / h) * 2;
      const dir = normalize([
        fwd[0] * fl + right[0] * u * aspect + up[0] * v,
        fwd[1] * fl + right[1] * u * aspect + up[1] * v,
        fwd[2] * fl + right[2] * u * aspect + up[2] * v,
      ]);
      let c = skyColor(dir[1]);
      const star = Math.abs(Math.sin(i * 12.9898 + j * 78.233) * 43758.5453) % 1;
      if (star > 0.9975) c = [0.8, 0.8, 0.85];
      const o = (j * w + i) * 3;
      color[o] = c[0]; color[o + 1] = c[1]; color[o + 2] = c[2];
    }
  }

  const poly: Vertex[] = [];
  const clipped: Vertex[] = [];
  for (const mesh of meshes) {
    const { positions, normals, colors, indices, offset } = mesh;
    for (let t = 0; t < indices.length; t += 3) {
      poly.length = 0;
      for (let c = 0; c < 3; c++) {
        const vi = indices[t + c]!;
        const px = positions[vi * 3]! + offset[0];
        const py = positions[vi * 3 + 1]! + offset[1];
        const pz = positions[vi * 3 + 2]! + offset[2];
        const dx = px - eye[0], dy = py - eye[1], dz = pz - eye[2];
        const lit = shade(
          [colors[vi * 3]!, colors[vi * 3 + 1]!, colors[vi * 3 + 2]!],
          [normals[vi * 3]!, normals[vi * 3 + 1]!, normals[vi * 3 + 2]!],
        );
        poly.push({
          vx: dx * right[0] + dy * right[1] + dz * right[2],
          vy: dx * up[0] + dy * up[1] + dz * up[2],
          vz: dx * fwd[0] + dy * fwd[1] + dz * fwd[2],
          r: lit[0], g: lit[1], b: lit[2],
        });
      }
      if (poly[0]!.vz < NEAR && poly[1]!.vz < NEAR && poly[2]!.vz < NEAR) continue;
      // Sutherland-Hodgman against the single near plane.
      clipped.length = 0;
      for (let c = 0; c < 3; c++) {
        const cur = poly[c]!, next = poly[(c + 1) % 3]!;
        const curIn = cur.vz >= NEAR, nextIn = next.vz >= NEAR;
        if (curIn) clipped.push(cur);
        if (curIn !== nextIn) clipped.push(lerpVertex(cur, next, (NEAR - cur.vz) / (next.vz - cur.vz)));
      }
      for (let f = 2; f < clipped.length; f++) {
        rasterize(color, depth, w, h, aspect, fl, clipped[0]!, clipped[f - 1]!, clipped[f]!);
      }
    }
  }

  const out = new Uint8Array(width * height * 3);
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      for (let c = 0; c < 3; c++) {
        let acc = 0;
        for (let sj = 0; sj < SUPERSAMPLE; sj++) {
          for (let si = 0; si < SUPERSAMPLE; si++) {
            acc += Math.min(255, Math.pow(Math.max(0, color[((j * SUPERSAMPLE + sj) * w + i * SUPERSAMPLE + si) * 3 + c]!), 1 / 2.2) * 255);
          }
        }
        out[(j * width + i) * 3 + c] = acc / (SUPERSAMPLE * SUPERSAMPLE);
      }
    }
  }
  writePng(outPath, width, height, out);
}

function rasterize(
  color: Float32Array,
  depth: Float32Array,
  w: number,
  h: number,
  aspect: number,
  fl: number,
  a: Vertex,
  b: Vertex,
  c: Vertex,
): void {
  const project = (v: Vertex): [number, number, number] => {
    const iw = 1 / v.vz;
    const u = (v.vx * fl * iw) / aspect, y = v.vy * fl * iw;
    return [((u + 1) / 2) * w - 0.5, ((1 - y) / 2) * h - 0.5, iw];
  };
  const pa = project(a), pb = project(b), pc = project(c);
  const area = (pb[0] - pa[0]) * (pc[1] - pa[1]) - (pb[1] - pa[1]) * (pc[0] - pa[0]);
  if (area === 0) return;
  const inv = 1 / area;
  const minX = Math.max(0, Math.floor(Math.min(pa[0], pb[0], pc[0])));
  const maxX = Math.min(w - 1, Math.ceil(Math.max(pa[0], pb[0], pc[0])));
  const minY = Math.max(0, Math.floor(Math.min(pa[1], pb[1], pc[1])));
  const maxY = Math.min(h - 1, Math.ceil(Math.max(pa[1], pb[1], pc[1])));
  if (minX > maxX || minY > maxY) return;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const w0 = ((pb[0] - pa[0]) * (y - pa[1]) - (pb[1] - pa[1]) * (x - pa[0])) * inv;
      const w1 = ((pa[0] - pc[0]) * (y - pc[1]) - (pa[1] - pc[1]) * (x - pc[0])) * inv;
      const w2 = 1 - w0 - w1;
      if (w0 < 0 || w1 < 0 || w2 < 0) continue;
      // w0 weights c, w1 weights b, w2 weights a (edge-function convention).
      const iw = w2 * pa[2] + w1 * pb[2] + w0 * pc[2];
      const index = y * w + x;
      if (iw <= depth[index]!) continue;
      depth[index] = iw;
      const scale = 1 / iw;
      const o = index * 3;
      color[o] = (w2 * a.r * pa[2] + w1 * b.r * pb[2] + w0 * c.r * pc[2]) * scale;
      color[o + 1] = (w2 * a.g * pa[2] + w1 * b.g * pb[2] + w0 * c.g * pc[2]) * scale;
      color[o + 2] = (w2 * a.b * pa[2] + w1 * b.b * pb[2] + w0 * c.b * pc[2]) * scale;
    }
  }
}

function normalize(v: readonly [number, number, number]): [number, number, number] {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

function cross(a: readonly [number, number, number], b: readonly [number, number, number]): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

// ---------- PNG (ported from the prototype QA renderer) ----------

function crc32(buf: Uint8Array): number {
  let c: number, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]!) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

export function writePng(path: string, w: number, h: number, rgb: Uint8Array): void {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc(h * (w * 3 + 1));
  for (let j = 0; j < h; j++) {
    raw[j * (w * 3 + 1)] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + j * w * 3, w * 3).copy(raw, j * (w * 3 + 1) + 1);
  }
  writeFileSync(path, Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]));
}
