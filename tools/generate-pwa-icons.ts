/**
 * PWA icon generator (ROADMAP §11 6.5).
 *
 *   npx tsx tools/generate-pwa-icons.ts
 *
 * Writes the manifest's PNG icons into `client/public/icons/` plus an SVG
 * favicon. Re-run it after changing the palette or the glyph; the output is
 * deterministic, so an unchanged design produces byte-identical files.
 *
 * Why hand-rolled: the repo has no image library and the PWA work is allowed
 * exactly one new dependency (vite-plugin-pwa). A PNG is a trivial container —
 * signature, IHDR, one zlib-deflated IDAT of filter-0 scanlines, IEND — and
 * `node:zlib` already provides the only hard part. Total cost: this file.
 *
 * The artwork is a placeholder: dark rounded square, cyan reticle ring, "SA"
 * drawn as stroked polylines (round-capped capsules, analytically anti-aliased).
 * Replace it with real art without touching the encoder.
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// --- palette (matches content/themes/default.json + index.html) --------------
const BG_TOP: RGB = [0x0a, 0x0f, 0x1a]; // manifest theme_color
const BG_BOTTOM: RGB = [0x04, 0x06, 0x0d];
const CYAN: RGB = [0x57, 0xd8, 0xff]; // --hud-primary

type RGB = [number, number, number];
type Point = [number, number];

const OUT_DIR = fileURLToPath(new URL("../client/public/", import.meta.url));

// ---------------------------------------------------------------------------
// PNG encoding
// ---------------------------------------------------------------------------

/** CRC-32 (IEEE 802.3), table built once. `node:zlib.crc32` exists only on newer Node. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/** Encode an RGBA byte array (width*height*4) as an 8-bit truecolour-alpha PNG. */
function encodePng(rgba: Uint8Array, width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour + alpha
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // Filter type 0 (None) in front of every scanline. The art is smooth gradients
  // and flat fills, so deflate does the work and a smarter filter buys little.
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Tiny rasterizer — everything is "coverage of a signed-distance shape"
// ---------------------------------------------------------------------------

class Canvas {
  readonly pixels: Uint8Array;

  constructor(readonly size: number) {
    this.pixels = new Uint8Array(size * size * 4);
  }

  /** Source-over blend of `color` at `coverage` (0..1) onto one pixel. */
  private blend(x: number, y: number, color: RGB, coverage: number): void {
    if (coverage <= 0) return;
    const a = Math.min(1, coverage);
    const i = (y * this.size + x) * 4;
    const dstA = this.pixels[i + 3]! / 255;
    const outA = a + dstA * (1 - a);
    if (outA <= 0) return;
    for (let c = 0; c < 3; c++) {
      const src = color[c]!;
      const dst = this.pixels[i + c]!;
      this.pixels[i + c] = Math.round((src * a + dst * dstA * (1 - a)) / outA);
    }
    this.pixels[i + 3] = Math.round(outA * 255);
  }

  /**
   * Fill every pixel whose signed distance is < 0, anti-aliased across the
   * one-pixel band around the edge. `distance` is in pixels, negative inside.
   */
  fill(distance: (x: number, y: number) => number, color: (x: number, y: number) => RGB, alpha = 1): void {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        const d = distance(x + 0.5, y + 0.5);
        const coverage = Math.min(1, Math.max(0, 0.5 - d));
        if (coverage > 0) this.blend(x, y, color(x, y), coverage * alpha);
      }
    }
  }
}

/** Signed distance to a rounded rectangle centred in the canvas. */
function roundedRect(cx: number, cy: number, halfW: number, halfH: number, radius: number) {
  return (x: number, y: number): number => {
    const dx = Math.abs(x - cx) - (halfW - radius);
    const dy = Math.abs(y - cy) - (halfH - radius);
    const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
    return outside + Math.min(Math.max(dx, dy), 0) - radius;
  };
}

/** Signed distance to an annulus (ring) of the given radius and stroke width. */
function ring(cx: number, cy: number, radius: number, width: number) {
  return (x: number, y: number): number => Math.abs(Math.hypot(x - cx, y - cy) - radius) - width / 2;
}

/** Signed distance to a round-capped capsule between two points. */
function segment(a: Point, b: Point, width: number) {
  const [ax, ay] = a;
  const [bx, by] = b;
  const vx = bx - ax;
  const vy = by - ay;
  const lenSq = vx * vx + vy * vy || 1;
  return (x: number, y: number): number => {
    const t = Math.min(1, Math.max(0, ((x - ax) * vx + (y - ay) * vy) / lenSq));
    return Math.hypot(x - (ax + t * vx), y - (ay + t * vy)) - width / 2;
  };
}

/** Signed distance to the union of several shapes (min of the distances). */
function union(...shapes: ((x: number, y: number) => number)[]) {
  return (x: number, y: number): number => {
    let best = Infinity;
    for (const shape of shapes) best = Math.min(best, shape(x, y));
    return best;
  };
}

const solid =
  (color: RGB) =>
  (): RGB =>
    color;

/** Vertical gradient between two colours across the canvas height. */
const gradient =
  (top: RGB, bottom: RGB, size: number) =>
  (_x: number, y: number): RGB => {
    const t = y / (size - 1);
    return [
      Math.round(top[0] + (bottom[0] - top[0]) * t),
      Math.round(top[1] + (bottom[1] - top[1]) * t),
      Math.round(top[2] + (bottom[2] - top[2]) * t),
    ];
  };

// ---------------------------------------------------------------------------
// The Orion's Arm mark
// ---------------------------------------------------------------------------

/**
 * "SA" as stroked polylines in a unit box (x right, y down), so the glyph scales
 * to any icon size without a font.
 */
const S_PATH: Point[] = [
  [0.97, 0.13],
  [0.66, 0.0],
  [0.24, 0.01],
  [0.0, 0.21],
  [0.07, 0.41],
  [0.48, 0.5],
  [0.9, 0.59],
  [1.0, 0.79],
  [0.77, 0.99],
  [0.33, 1.0],
  [0.04, 0.87],
];
const A_STROKES: [Point, Point][] = [
  [
    [0, 1],
    [0.5, 0],
  ],
  [
    [0.5, 0],
    [1, 1],
  ],
  [
    [0.18, 0.68],
    [0.82, 0.68],
  ],
];

function strokesFor(box: { x: number; y: number; w: number; h: number }, width: number) {
  const map = ([ux, uy]: Point): Point => [box.x + ux * box.w, box.y + uy * box.h];
  const shapes: ((x: number, y: number) => number)[] = [];
  for (let i = 0; i < S_PATH.length - 1; i++) shapes.push(segment(map(S_PATH[i]!), map(S_PATH[i + 1]!), width));
  return { shapes, map, width };
}

interface IconOptions {
  size: number;
  /** Maskable icons must keep their art inside the inner 80% safe zone. */
  maskable?: boolean;
}

function drawIcon({ size, maskable = false }: IconOptions): Buffer {
  const canvas = new Canvas(size);
  const center = size / 2;

  // Background. A maskable icon is full-bleed (the launcher applies its own
  // mask); the "any" icon draws its own rounded square.
  const bgRadius = maskable ? 0 : size * 0.22;
  canvas.fill(roundedRect(center, center, center, center, bgRadius), gradient(BG_TOP, BG_BOTTOM, size));

  // Everything below is scaled by the safe-zone factor so the maskable variant
  // survives a circular crop.
  const safe = maskable ? 0.78 : 1;

  // Reticle ring — faint, decorative, ties the mark to the tactical HUD.
  canvas.fill(ring(center, center, size * 0.395 * safe, Math.max(1, size * 0.022 * safe)), solid(CYAN), 0.35);

  // "SA", two glyph boxes side by side.
  const glyphH = size * 0.34 * safe;
  const glyphW = size * 0.24 * safe;
  const gap = size * 0.06 * safe;
  const totalW = glyphW * 2 + gap;
  const left = center - totalW / 2;
  const top = center - glyphH / 2;
  const stroke = Math.max(2, size * 0.062 * safe);

  const sBox = { x: left, y: top, w: glyphW, h: glyphH };
  const aBox = { x: left + glyphW + gap, y: top, w: glyphW, h: glyphH };

  const sShapes = strokesFor(sBox, stroke).shapes;
  const aMap = ([ux, uy]: Point): Point => [aBox.x + ux * aBox.w, aBox.y + uy * aBox.h];
  const aShapes = A_STROKES.map(([a, b]) => segment(aMap(a), aMap(b), stroke));

  canvas.fill(union(...sShapes, ...aShapes), solid(CYAN));

  return encodePng(canvas.pixels, size, size);
}

/** The same mark as scalable vector art, for the browser tab and modern manifests. */
function drawSvg(): string {
  const toPath = (points: Point[]): string =>
    points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${(x * 100).toFixed(1)} ${(y * 100).toFixed(1)}`).join(" ");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="Orion's Arm">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#0a0f1a"/>
      <stop offset="1" stop-color="#04060d"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="113" fill="url(#bg)"/>
  <circle cx="256" cy="256" r="202" fill="none" stroke="#57d8ff" stroke-opacity="0.35" stroke-width="11"/>
  <g fill="none" stroke="#57d8ff" stroke-width="32" stroke-linecap="round" stroke-linejoin="round">
    <g transform="translate(101 169) scale(1.23 1.74)">
      <path d="${toPath(S_PATH)}"/>
    </g>
    <g transform="translate(256 169) scale(1.23 1.74)">
      ${A_STROKES.map(([a, b]) => `<path d="${toPath([a, b])}"/>`).join("\n      ")}
    </g>
  </g>
</svg>
`;
}

// ---------------------------------------------------------------------------

function main(): void {
  mkdirSync(path.join(OUT_DIR, "icons"), { recursive: true });

  const outputs: [string, Buffer | string][] = [
    ["icons/icon-192.png", drawIcon({ size: 192 })],
    ["icons/icon-512.png", drawIcon({ size: 512 })],
    ["icons/icon-maskable-512.png", drawIcon({ size: 512, maskable: true })],
    ["icons/apple-touch-icon-180.png", drawIcon({ size: 180 })],
    ["favicon.svg", drawSvg()],
  ];

  for (const [rel, data] of outputs) {
    const abs = path.join(OUT_DIR, rel);
    writeFileSync(abs, data);
    const bytes = typeof data === "string" ? Buffer.byteLength(data) : data.length;
    console.log(`  ${rel.padEnd(32)} ${String(bytes).padStart(7)} B`);
  }
  console.log(`\n✔ wrote ${outputs.length} icon files to ${OUT_DIR}`);
}

main();
