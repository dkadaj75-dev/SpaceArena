/* global process, console, Buffer, document, ImageData, makeNebula */
// Equirect nebula skybox generator — renders in headless Chromium (canvas) and
// saves WEBP. Noise is sampled in 3D direction space so the pano wraps seamlessly.
// Usage: node make-skybox.mjs <outDir>
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const OUT = process.argv[2] ?? ".";
const W = 2048, H = 1024;

const PALETTES = {
  // References are mostly DARK sky: dust confined to patches (~30% coverage),
  // muted mids, bright cores only deep inside the densest clouds.
  // sun.dir is a UNIT vector in the same 3D direction space the pano samples
  // (x = st*cos(phi), y = ct, z = st*sin(phi)) — the scene's directional light
  // must shine ALONG -dir so surfaces lit by it face the painted star.
  "deep-field": {
    base: [5, 7, 12],
    dustA: { col: [66, 34, 16], hot: [150, 92, 42], lo: 0.56, hi: 1.0 },
    dustB: { col: [48, 36, 18], hot: [160, 126, 66], lo: 0.62, hi: 1.02 },
    dustC: { col: [36, 26, 30], hot: [90, 64, 70], lo: 0.6, hi: 1.04 },
    core: [255, 214, 160],
    warp: 1.25, starGain: 1.0, seed: 7,
    bandN: [0.28, 0.86, 0.42], bandWidth: 0.36, bandGain: 0.75,
    sun: { dir: [0.777, 0.309, 0.55], color: [255, 236, 200], discDeg: 1.6, glowDeg: 14 },
  },
  "ring-nebula": {
    base: [6, 6, 14],
    dustA: { col: [52, 30, 80], hot: [116, 66, 160], lo: 0.56, hi: 1.0 },
    dustB: { col: [22, 42, 82], hot: [66, 106, 175], lo: 0.62, hi: 1.02 },
    dustC: { col: [40, 24, 56], hot: [96, 60, 130], lo: 0.6, hi: 1.04 },
    core: [224, 208, 255],
    warp: 1.5, starGain: 1.0, seed: 23,
    bandN: [-0.5, 0.75, 0.43], bandWidth: 0.42, bandGain: 0.8,
    sun: { dir: [-0.677, -0.208, -0.706], color: [220, 228, 255], discDeg: 1.3, glowDeg: 12 },
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
      // Faint broad haze so "empty" sky reads as deep space, not a void.
      const haze = fbm(dx * 0.9 + 71, dy * 0.9, dz * 0.9, 4, 0.6);
      for (let ch = 0; ch < 3; ch++) c[ch] += P.dustA.col[ch] * haze * haze * 0.10;
      // Galactic band: dust + stars concentrate along a tilted great circle.
      const bandDist = Math.abs(dx * P.bandN[0] + dy * P.bandN[1] + dz * P.bandN[2]);
      const band = Math.exp(-(bandDist * bandDist) / (P.bandWidth * P.bandWidth));
      const bandDust = fbm(ax * 2.6 + 97, ay * 2.6, az * 2.6, 5, 0.55);
      const bg = P.bandGain ?? 0.55;
      for (let ch = 0; ch < 3; ch++) c[ch] += P.dustB.col[ch] * band * bandDust * bg + P.dustA.col[ch] * band * 0.16;
      const nA = fbm(ax * 1.9, ay * 1.9, az * 1.9, 6, 0.55);
      rampMix(nA, P.dustA.lo, P.dustA.hi, P.dustA.col, P.dustA.hot, c);
      const nB = fbm(ax * 3.4 + 31, ay * 3.4, az * 3.4, 6, 0.5);
      rampMix(nB, P.dustB.lo, P.dustB.hi, P.dustB.col, P.dustB.hot, c);
      // Third mid-scale layer at a decorrelated offset: fills the gaps the two
      // primary layers leave without pushing overall brightness up much.
      const nD = fbm(ax * 2.6 + 157, ay * 2.6, az * 2.6, 5, 0.55);
      rampMix(nD, P.dustC.lo, P.dustC.hi, P.dustC.col, P.dustC.hot, c);
      // Bright cores inside dense dust (stretched like the ramps)
      const nC = 1 / (1 + Math.exp(-(fbm(dx * 5.2 + 53, dy * 5.2, dz * 5.2, 4, 0.5) - 0.5) * 14));
      // Only inside genuinely dense dust (stretched nA above the dustA floor).
      const core = Math.pow(Math.max(0, nC), 8) * Math.max(0, (1 / (1 + Math.exp(-(nA - 0.5) * 14))) - 0.75) * 3.0;
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
      // Rare bright glow stars (density boosted inside the band).
      const S2 = 26;
      const c2x = Math.floor(dx * S2), c2y = Math.floor(dy * S2), c2z = Math.floor(dz * S2);
      let bright = 0, warmth = 0.5;
      if (hash(c2x * 5 + 11, c2y * 5 + 12, c2z * 5 + 13) < 0.10 + band * 0.12) {
        const j2x = c2x + hash(c2x, c2y, c2z), j2y = c2y + hash(c2y, c2z, c2x), j2z = c2z + hash(c2z, c2x, c2y);
        const e2x = dx * S2 - j2x, e2y = dy * S2 - j2y, e2z = dz * S2 - j2z;
        const dd2 = e2x * e2x + e2y * e2y + e2z * e2z;
        const b2 = hash(c2x * 7 + 1, c2y * 7 + 2, c2z * 7 + 3);
        // Tight core + wide soft glow
        bright = (Math.exp(-dd2 / 0.0006) * 1.1 + Math.exp(-dd2 / 0.012) * 0.16) * 255 * (0.5 + b2);
        warmth = hash(c2x + 9, c2y + 9, c2z + 9);
      }
      // The nearby star: painted LAST so it dominates dust and stars alike.
      // cosAng near 1 = looking straight at the sun. Disc is hard-saturated,
      // glow falls off smoothly, plus a wide faint halo warming the sky around.
      let sun = 0;
      if (P.sun) {
        const cosAng = dx * P.sun.dir[0] + dy * P.sun.dir[1] + dz * P.sun.dir[2];
        const ang = Math.acos(Math.min(1, Math.max(-1, cosAng))) * (180 / Math.PI);
        if (ang < P.sun.discDeg) sun = 1;
        else if (ang < P.sun.glowDeg) sun = Math.pow(1 - (ang - P.sun.discDeg) / (P.sun.glowDeg - P.sun.discDeg), 2.4) * 0.8;
        // Halo is ADDITIVE across the whole range (not an else-branch): an
        // exclusive chain left a dark ring where the glow hit zero just before
        // the halo stepped back in.
        if (ang < 60) sun += Math.pow(1 - ang / 60, 3) * 0.1;
      }
      const i = (py * W + px) * 4;
      const sc = P.sun ? P.sun.color : [255, 255, 255];
      img[i] = Math.min(255, c[0] + star + bright * (0.85 + 0.3 * warmth) + sc[0] * sun);
      img[i + 1] = Math.min(255, c[1] + star + bright * 0.92 + sc[1] * sun);
      img[i + 2] = Math.min(255, c[2] + star * 0.95 + bright * (1.15 - 0.3 * warmth) + sc[2] * sun);
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
      eval(script);
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
