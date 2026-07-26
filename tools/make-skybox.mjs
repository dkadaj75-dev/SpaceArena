/* eslint-env node, browser */
/* global makeNebula */
// Equirect nebula skybox generator — renders in headless Chromium (canvas) and
// saves WEBP. Noise is sampled in 3D direction space so the pano wraps seamlessly.
// Usage: node make-skybox.mjs <outDir>
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const OUT = process.argv[2] ?? ".";
const W = 2048, H = 1024;

const PALETTES = {
  "deep-field": {
    base: [5, 7, 12],
    dustA: { col: [92, 48, 22], hot: [176, 106, 47], lo: 0.44, hi: 0.88 },
    dustB: { col: [70, 52, 26], hot: [190, 150, 80], lo: 0.5, hi: 0.94 },
    core: [255, 214, 160],
    warp: 0.9, starGain: 1.0, seed: 7,
  },
  "ring-nebula": {
    base: [6, 6, 14],
    dustA: { col: [74, 42, 110], hot: [138, 79, 191], lo: 0.44, hi: 0.88 },
    dustB: { col: [30, 58, 110], hot: [79, 127, 208], lo: 0.5, hi: 0.94 },
    core: [224, 208, 255],
    warp: 1.15, starGain: 1.0, seed: 23,
  },
};

const PAGE_SCRIPT = `
function makeNebula(W, H, P) {
  // --- 3D simplex-ish value noise (gradient-free, cheap, good enough layered) ---
  const hash = (x, y, z) => {
    // murmur-style avalanche — a weaker mix squashed everything into [0, 0.5]
    // and rendered the sky black (dust thresholds unreachable).
    let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(z | 0, 0x9e3779b9) ^ Math.imul(P.seed, 0x85ebca6b);
    h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d);
    h ^= h >>> 12; h = Math.imul(h, 0x297a2d39);
    h ^= h >>> 15;
    return (h >>> 0) / 4294967296;
  };
  const smooth = t => t * t * (3 - 2 * t);
  const vnoise = (x, y, z) => {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const xf = x - xi, yf = y - yi, zf = z - zi;
    const u = smooth(xf), v = smooth(yf), w = smooth(zf);
    let acc = 0;
    for (let dz = 0; dz <= 1; dz++) for (let dy = 0; dy <= 1; dy++) for (let dx = 0; dx <= 1; dx++) {
      const wgt = (dx ? u : 1 - u) * (dy ? v : 1 - v) * (dz ? w : 1 - w);
      acc += wgt * hash(xi + dx, yi + dy, zi + dz);
    }
    return acc;
  };
  const fbm = (x, y, z, oct, rough) => {
    let a = 0, amp = 1, tot = 0, f = 1;
    for (let o = 0; o < oct; o++) {
      a += amp * vnoise(x * f, y * f, z * f); tot += amp; amp *= rough; f *= 2.02;
    }
    return a / tot;
  };
  // Multi-octave value noise piles up near 0.5, so stretch it hard before the
  // ramps — without this the dust never clears the ramp floor and the sky
  // renders black (found the hard way).
  const stretch = t => 1 / (1 + Math.exp(-(t - 0.5) * 14));
  const rampMix = (t, lo, hi, col, hot, outc) => {
    t = stretch(t);
    if (t <= lo) return;
    const k = Math.min(1, (t - lo) / (hi - lo));
    const kk = k * k;
    for (let c = 0; c < 3; c++) outc[c] += col[c] * kk * (1 - k * 0.5) + hot[c] * kk * k;
  };

  const img = new Uint8ClampedArray(W * H * 4);
  for (let py = 0; py < H; py++) {
    const theta = (py / H) * Math.PI; // 0..pi
    const st = Math.sin(theta), ct = Math.cos(theta);
    for (let px = 0; px < W; px++) {
      const phi = (px / W) * 2 * Math.PI;
      const dx = st * Math.cos(phi), dy = ct, dz = st * Math.sin(phi);
      // Domain warp for wispy structure
      const wx = fbm(dx * 1.3 + 11, dy * 1.3, dz * 1.3, 4, 0.55) - 0.5;
      const wy = fbm(dx * 1.3, dy * 1.3 + 7, dz * 1.3, 4, 0.55) - 0.5;
      const ax = dx + wx * P.warp, ay = dy + wy * P.warp, az = dz + (wx - wy) * 0.5 * P.warp;

      const c = [P.base[0], P.base[1], P.base[2]];
      const nA = fbm(ax * 1.9, ay * 1.9, az * 1.9, 6, 0.55);
      rampMix(nA, P.dustA.lo, P.dustA.hi, P.dustA.col, P.dustA.hot, c);
      const nB = fbm(ax * 3.4 + 31, ay * 3.4, az * 3.4, 6, 0.5);
      rampMix(nB, P.dustB.lo, P.dustB.hi, P.dustB.col, P.dustB.hot, c);
      // Bright cores inside dense dust (stretched like the ramps)
      const nC = 1 / (1 + Math.exp(-(fbm(dx * 5.2 + 53, dy * 5.2, dz * 5.2, 4, 0.5) - 0.52) * 16));
      const core = Math.pow(Math.max(0, nC), 6) * Math.max(0, (1 / (1 + Math.exp(-(nA - 0.52) * 16))) - 0.35) * 2.2;
      for (let ch = 0; ch < 3; ch++) c[ch] += P.core[ch] * core;

      // Stars: jittered point per 3D cell, distance in direction space
      const S = 90;
      const cx = Math.floor(dx * S), cy = Math.floor(dy * S), cz = Math.floor(dz * S);
      let star = 0;
      const jx = cx + hash(cx, cy, cz), jy = cy + hash(cy, cz, cx), jz = cz + hash(cz, cx, cy);
      const ddx = dx * S - jx, ddy = dy * S - jy, ddz = dz * S - jz;
      const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
      if (d2 < 0.004) {
        const b = hash(cx * 3 + 1, cy * 3 + 2, cz * 3 + 3);
        star = Math.max(0, 1 - d2 / 0.004) ** 3 * (0.35 + 1.4 * b * b) * 255 * P.starGain;
      }
      const i = (py * W + px) * 4;
      img[i] = Math.min(255, c[0] + star);
      img[i + 1] = Math.min(255, c[1] + star);
      img[i + 2] = Math.min(255, c[2] + star * 0.95);
      img[i + 3] = 255;
    }
  }
  return img;
}
`;

const browser = await chromium.launch();
const page = await browser.newPage();
for (const [name, palette] of Object.entries(PALETTES)) {
  const dataUrl = await page.evaluate(
    ([script, W, H, P]) => {
      eval(script); // eslint-disable-line no-eval
      const img = makeNebula(W, H, P);
      const cv = document.createElement("canvas");
      cv.width = W; cv.height = H;
      cv.getContext("2d").putImageData(new ImageData(img, W, H), 0, 0);
      return cv.toDataURL("image/webp", 0.88);
    },
    [PAGE_SCRIPT, W, H, palette],
  );
  const buf = Buffer.from(dataUrl.split(",")[1], "base64");
  const file = path.join(OUT, `${name}.webp`);
  fs.writeFileSync(file, buf);
  console.log(`${file}: ${(buf.length / 1024).toFixed(0)} KB`);
}
await browser.close();
