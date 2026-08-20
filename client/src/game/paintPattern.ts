import { DynamicTexture, Texture, type Scene } from "@babylonjs/core";
import type { PaintPattern } from "@space-arena/shared";

/**
 * Procedural paint finishes (zebra / tiger / rust).
 *
 * A "funny" skin is not a colour — it is a PATTERN, and a pattern has to live
 * in the albedo texture or it cannot exist at all: a material carries exactly
 * one base colour. Drawing it into a texture is also what keeps the skin a
 * REAL surface rather than a flat sticker — metallic, roughness and clearcoat
 * are never touched here, so the striped plate still catches the arena's
 * reflections exactly like the plate underneath it did.
 *
 * Everything is drawn from a fixed seed: two clients, the hangar preview and
 * the editor must agree pixel-for-pixel about what "Tiger" looks like.
 */

/** Edge length of a generated pattern texture. */
export const PATTERN_TEXTURE_SIZE = 512;
/** Pattern repeats across one UV tile when a paint authors no `patternScale`. */
export const DEFAULT_PATTERN_SCALE = 3;

/**
 * The 2D drawing surface a pattern needs — a structural subset of
 * `CanvasRenderingContext2D` so tests can hand in a recorder and so a headless
 * canvas that refuses `getContext("2d")` is a `null` we can fall back from
 * rather than a crash.
 */
export interface PatternContext {
  fillStyle: string;
  globalAlpha: number;
  fillRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void;
  closePath(): void;
  fill(): void;
  ellipse(x: number, y: number, rx: number, ry: number, rotation: number, start: number, end: number): void;
}

/** mulberry32 — small, fast, and identical on every engine we ship on. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Draw `pattern` across a `size`×`size` surface: `base` is the plate, `mark` is
 * the stripe/blotch colour. Pure and deterministic — the texture wrapper below
 * is the only part that needs a Scene.
 */
export function drawPaintPattern(
  ctx: PatternContext,
  size: number,
  pattern: PaintPattern,
  base: string,
  mark: string,
): void {
  ctx.globalAlpha = 1;
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = mark;
  if (pattern === "zebra") drawZebra(ctx, size);
  else if (pattern === "tiger") drawTiger(ctx, size);
  else drawRust(ctx, size, base, mark);
  ctx.globalAlpha = 1;
}

/**
 * Broad wavy bands running top-to-bottom, tapering at both ends. Zebra reads as
 * zebra because the bands are WIDE and irregular; evenly spaced hard bars read
 * as a barcode.
 */
function drawZebra(ctx: PatternContext, size: number): void {
  const random = rng(0x2eb4a);
  const bands = 9;
  for (let i = 0; i < bands; i++) {
    // Wrap one band past the right edge so the texture tiles without a seam.
    const centre = ((i + random() * 0.35) / bands) * size;
    const width = size * (0.028 + random() * 0.035);
    const lean = size * (random() * 0.22 - 0.11);
    const belly = size * (0.05 + random() * 0.08) * (random() < 0.5 ? -1 : 1);
    for (const offset of [0, size, -size]) {
      ctx.beginPath();
      ctx.moveTo(centre + offset, -2);
      ctx.quadraticCurveTo(centre + belly + offset, size * 0.5, centre + lean + offset, size + 2);
      ctx.lineTo(centre + lean + width * 0.35 + offset, size + 2);
      ctx.quadraticCurveTo(centre + belly + width + offset, size * 0.5, centre + width + offset, -2);
      ctx.closePath();
      ctx.fill();
    }
  }
}

/**
 * Short broken bars marching down the surface — a tiger's stripes stop and
 * restart, which is the whole difference between "tiger" and "zebra".
 */
function drawTiger(ctx: PatternContext, size: number): void {
  const random = rng(0x71643);
  const rows = 14;
  for (let row = 0; row < rows; row++) {
    const y = ((row + 0.5) / rows) * size;
    const bars = 2 + Math.floor(random() * 2);
    for (let bar = 0; bar < bars; bar++) {
      const length = size * (0.16 + random() * 0.26);
      const x = random() * size;
      const thickness = size * (0.018 + random() * 0.022);
      const droop = size * (random() * 0.06 - 0.03);
      for (const offset of [0, size, -size]) {
        ctx.beginPath();
        ctx.moveTo(x + offset, y);
        ctx.quadraticCurveTo(x + length * 0.5 + offset, y + droop, x + length + offset, y + droop * 0.4);
        ctx.quadraticCurveTo(x + length * 0.5 + offset, y + droop + thickness, x + offset, y + thickness);
        ctx.closePath();
        ctx.fill();
      }
    }
  }
}

/**
 * Corrosion: broad soft blotches, then darker pitting inside them, then fine
 * speckle over the whole plate. Alpha does the blending, so the base colour
 * stays visible through the thin edges the way real oxidation does.
 */
function drawRust(ctx: PatternContext, size: number, base: string, mark: string): void {
  const random = rng(0x5c0de);
  ctx.fillStyle = mark;
  for (let i = 0; i < 26; i++) {
    const x = random() * size;
    const y = random() * size;
    const rx = size * (0.04 + random() * 0.13);
    const ry = rx * (0.55 + random() * 0.8);
    ctx.globalAlpha = 0.25 + random() * 0.5;
    ctx.beginPath();
    ctx.ellipse(x, y, rx, ry, random() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  // Pitting: small dark bites out of the corroded patches.
  ctx.globalAlpha = 0.55;
  for (let i = 0; i < 220; i++) {
    const s = size * (0.004 + random() * 0.012);
    ctx.fillRect(random() * size, random() * size, s, s);
  }
  // Bare metal showing through, so rust never reads as a solid brown coat.
  ctx.fillStyle = base;
  ctx.globalAlpha = 0.35;
  for (let i = 0; i < 90; i++) {
    const s = size * (0.004 + random() * 0.016);
    ctx.fillRect(random() * size, random() * size, s, s);
  }
}

/**
 * A tiling albedo texture for `pattern`, or `null` when the host has no 2D
 * canvas (headless test runs) — callers fall back to the flat channel colour,
 * which is a duller skin but never a missing hull.
 */
export function paintPatternTexture(
  scene: Scene,
  name: string,
  pattern: PaintPattern,
  base: string,
  mark: string,
  scale: number,
): Texture | null {
  const texture = new DynamicTexture(name, { width: PATTERN_TEXTURE_SIZE, height: PATTERN_TEXTURE_SIZE }, scene, true);
  const ctx = texture.getContext() as unknown as PatternContext | null;
  if (!ctx || typeof ctx.fillRect !== "function") {
    texture.dispose();
    return null;
  }
  drawPaintPattern(ctx, PATTERN_TEXTURE_SIZE, pattern, base, mark);
  texture.update(false);
  texture.wrapU = Texture.WRAP_ADDRESSMODE;
  texture.wrapV = Texture.WRAP_ADDRESSMODE;
  texture.uScale = scale;
  texture.vScale = scale;
  return texture;
}
