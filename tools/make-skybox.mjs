/* global process, console, Buffer, document, ImageData, makeNebula */
// Equirect nebula skybox generator — renders in headless Chromium (canvas) and
// saves WEBP. Noise is sampled in 3D direction space so the pano wraps seamlessly.
// Usage: node make-skybox.mjs <outDir> [paletteName]
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const OUT = process.argv[2] ?? ".";
const ONLY = process.argv[3];
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
    warp: 1.25, starGain: 1.0, seed: 7, gain: 1.3,
    bandN: [0.28, 0.86, 0.42], bandWidth: 0.36, bandGain: 0.75,
    planet: {
      dir: [0.05, -0.5, 0.8646],
      angularRadiusDeg: 38,
      surface: { base: [190, 133, 85], band: [122, 78, 53], detail: [252, 177, 105] },
      atmosphere: [104, 178, 255],
    },
    sun: { dir: [0.777, 0.309, 0.55], color: [255, 236, 200], discDeg: 3.4, glowDeg: 26 },
  },
  "ring-nebula": {
    base: [6, 6, 14],
    dustA: { col: [52, 30, 80], hot: [116, 66, 160], lo: 0.56, hi: 1.0 },
    dustB: { col: [22, 42, 82], hot: [66, 106, 175], lo: 0.62, hi: 1.02 },
    dustC: { col: [40, 24, 56], hot: [96, 60, 130], lo: 0.6, hi: 1.04 },
    core: [224, 208, 255],
    warp: 1.5, starGain: 1.0, seed: 23, gain: 1.3,
    bandN: [-0.5, 0.75, 0.43], bandWidth: 0.42, bandGain: 0.8,
    planet: {
      dir: [0.35, 0.15, -0.9247],
      angularRadiusDeg: 14,
      surface: { base: [82, 94, 116], band: [52, 61, 82], detail: [122, 136, 158] },
      atmosphere: [116, 178, 255],
    },
    sun: { dir: [-0.677, -0.208, -0.706], color: [220, 228, 255], discDeg: 3.0, glowDeg: 24 },
  },
  "lunar-crater": {
    base: [2, 3, 5],
    dustA: { col: [20, 18, 16], hot: [34, 30, 25], lo: 0.98, hi: 1.1 },
    // dustB doubles as the galactic-band medium: its ramp thresholds keep it
    // out of the open sky, so its colour can run bright enough for a visible
    // Milky Way river without lifting the black background.
    dustB: { col: [48, 44, 38], hot: [28, 24, 19], lo: 0.99, hi: 1.1 },
    dustC: { col: [11, 10, 9], hot: [21, 18, 15], lo: 0.99, hi: 1.1 },
    core: [40, 40, 42],
    warp: 0.2, starGain: 0.9, seed: 61, gain: 0.55,
    // The Orion Arm: a warm-toned diagonal river across the black sky.
    bandN: [0.58, 0.55, -0.60], bandWidth: 0.3, bandGain: 2.2,
    planet: {
      // Readable Apollo-8-style Earthrise. ~75 deg of azimuth from the sun:
      // far enough to clear its glow, close enough that the disc renders
      // gibbous — at the old anti-solar spot the lit-phase shading left only
      // a crescent and the atmosphere halo (verifier caught it).
      dir: [-0.749, 0.208, 0.629],
      angularRadiusDeg: 8,
      surface: {
        base: [38, 84, 148], band: [70, 110, 160], detail: [230, 238, 245],
        detailGain: 0.72,
      },
      atmosphere: [130, 190, 255],
    },
    ground: {
      horizon: -0.065,
      surface: [104, 106, 108],
      rim: [151, 152, 153],
      craters: [
        { phi: 0.45, y: -0.43, radius: 0.13 },
        { phi: 2.25, y: -0.31, radius: 0.09 },
        { phi: 4.15, y: -0.55, radius: 0.16 },
        { phi: 5.55, y: -0.25, radius: 0.07 },
      ],
    },
    sun: { dir: [-0.707, 0.5, -0.5], color: [255, 255, 255], discDeg: 3.2, glowDeg: 24 },
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
  const smoothRange = (lo, hi, value) => {
    const t = Math.max(0, Math.min(1, (value - lo) / (hi - lo)));
    return smooth(t);
  };
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
      // Resolve nebula and stars before foreground sky furniture. The planet
      // replaces the background inside its disc; atmosphere stays additive.
      const g = P.gain ?? 1;
      let out = [
        c[0] * g + star + bright * (0.85 + 0.3 * warmth),
        c[1] * g + star + bright * 0.92,
        c[2] * g + star * 0.95 + bright * (1.15 - 0.3 * warmth),
      ];
      if (P.planet) {
        const planet = P.planet;
        const pd = planet.dir;
        const cosAng = Math.min(1, Math.max(-1, dx * pd[0] + dy * pd[1] + dz * pd[2]));
        const ang = Math.acos(cosAng) * (180 / Math.PI);
        const radiusDeg = planet.angularRadiusDeg;
        const edgeHalfWidth = 0.075;
        if (ang < radiusDeg + 3.2) {
        const discAlpha = 1 - smoothRange(radiusDeg - edgeHalfWidth, radiusDeg + edgeHalfWidth, ang);
        const upSeed = Math.abs(pd[1]) < 0.96 ? [0, 1, 0] : [1, 0, 0];
        let ex = upSeed[1] * pd[2] - upSeed[2] * pd[1];
        let ey = upSeed[2] * pd[0] - upSeed[0] * pd[2];
        let ez = upSeed[0] * pd[1] - upSeed[1] * pd[0];
        const el = Math.hypot(ex, ey, ez); ex /= el; ey /= el; ez /= el;
        const nx = pd[1] * ez - pd[2] * ey;
        const ny = pd[2] * ex - pd[0] * ez;
        const nz = pd[0] * ey - pd[1] * ex;
        const sinRadius = Math.sin(radiusDeg * Math.PI / 180);
        const localX = (dx * ex + dy * ey + dz * ez) / sinRadius;
        const localY = (dx * nx + dy * ny + dz * nz) / sinRadius;
        const radial = Math.hypot(localX, localY);
        const surfaceZ = Math.sqrt(Math.max(0, 1 - Math.min(1, radial * radial)));
        const snx = ex * localX + nx * localY - pd[0] * surfaceZ;
        const sny = ey * localX + ny * localY - pd[1] * surfaceZ;
        const snz = ez * localX + nz * localY - pd[2] * surfaceZ;
        const sunDir = P.sun?.dir ?? [0.4, 0.7, 0.2];
        const ndotl = snx * sunDir[0] + sny * sunDir[1] + snz * sunDir[2];
        const illumination = 0.03 + smoothRange(-0.12, 0.2, ndotl) * 0.97;
        const limb = 0.28 + 0.72 * Math.pow(surfaceZ, 0.38);
        const latitudeBands = 0.5 + 0.5 * Math.sin(
          localY * 26 + fbm(snx * 2.2 + 211, sny * 2.2, snz * 2.2, 4, 0.58) * 7,
        );
        const detailNoise = fbm(snx * 7.5 + 307, sny * 7.5, snz * 7.5, 5, 0.55);
        const bandMix = smoothRange(0.32, 0.72, latitudeBands);
        // Earth palettes can opt into stronger, patchier cloud cover without
        // changing the established band/detail balance of other planets.
        const detailMix = smoothRange(0.5, 0.78, detailNoise) * (planet.surface.detailGain ?? 0.46);
        for (let ch = 0; ch < 3; ch++) {
          const broad = planet.surface.base[ch] * (1 - bandMix) + planet.surface.band[ch] * bandMix;
          const surface = (broad * (1 - detailMix) + planet.surface.detail[ch] * detailMix)
            * illumination * limb;
          out[ch] = out[ch] * (1 - discAlpha) + surface * discAlpha;
        }
        if (ang > radiusDeg - edgeHalfWidth && ang < radiusDeg + 3.2) {
          const sunDotPlanet = sunDir[0] * pd[0] + sunDir[1] * pd[1] + sunDir[2] * pd[2];
          let tx = sunDir[0] - pd[0] * sunDotPlanet;
          let ty = sunDir[1] - pd[1] * sunDotPlanet;
          let tz = sunDir[2] - pd[2] * sunDotPlanet;
          const tl = Math.hypot(tx, ty, tz);
          if (tl > 0) { tx /= tl; ty /= tl; tz /= tl; }
          const sunward = Math.max(0, snx * tx + sny * ty + snz * tz);
          const rimFalloff = 1 - smoothRange(radiusDeg - edgeHalfWidth, radiusDeg + 3.2, ang);
          const atmosphereGain = rimFalloff * (0.08 + 0.46 * sunward);
          for (let ch = 0; ch < 3; ch++) out[ch] += planet.atmosphere[ch] * atmosphereGain;
        }
        }
      }

      // Optional painted terrain for arenas whose enclosing panorama also has
      // to provide the ground. It intentionally lives in direction space: the
      // horizon wraps seamlessly and the lower hemisphere reads as a distant,
      // bowl-shaped floor without requiring an engine terrain mesh.
      if (P.ground) {
        const ground = P.ground;
        const rimNoise = fbm(dx * 5.5 + 401, 0, dz * 5.5, 4, 0.55) - 0.5;
        const rimTop = ground.horizon + rimNoise * 0.045;
        if (dy < rimTop) {
          const coarse = fbm(dx * 4.2 + 503, dy * 4.2, dz * 4.2, 5, 0.58);
          const fine = fbm(dx * 18 + 607, dy * 18, dz * 18, 4, 0.52);
          const rock = (coarse - 0.5) * 34 + (fine - 0.5) * 16;
          let shade = rock;
          for (const crater of ground.craters ?? []) {
            let dphi = Math.abs(phi - crater.phi);
            dphi = Math.min(dphi, Math.PI * 2 - dphi);
            const dist = Math.hypot(dphi * Math.max(0.3, st), (dy - crater.y) * 2.1);
            const bowl = 1 - smoothRange(crater.radius * 0.35, crater.radius, dist);
            const lip = smoothRange(crater.radius * 0.72, crater.radius * 0.9, dist)
              * (1 - smoothRange(crater.radius * 0.9, crater.radius * 1.12, dist));
            shade += lip * 25 - bowl * 35;
          }
          const rimMix = 1 - smoothRange(rimTop - 0.105, rimTop - 0.025, dy);
          const grazingLight = smoothRange(-0.75, ground.horizon, dy) * 10;
          for (let ch = 0; ch < 3; ch++) {
            const base = ground.surface[ch] * (1 - rimMix) + ground.rim[ch] * rimMix;
            out[ch] = base + shade + grazingLight;
          }
        }
      }

      // The nearby star is painted LAST so it dominates the planet, dust and stars.
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
        if (ang < 70) sun += Math.pow(1 - ang / 70, 3) * 0.16;
      }
      const i = (py * W + px) * 4;
      const sc = P.sun ? P.sun.color : [255, 255, 255];
      // gain lifts the NEBULA only — stars and the sun already saturate.
      img[i] = Math.min(255, out[0] + sc[0] * sun);
      img[i + 1] = Math.min(255, out[1] + sc[1] * sun);
      img[i + 2] = Math.min(255, out[2] + sc[2] * sun);
      img[i + 3] = 255;
    }
  }
  return img;
}
`;

const installedChromium = "/opt/pw-browsers/chromium";
const browser = await chromium.launch(
  fs.existsSync(installedChromium)
    ? { executablePath: installedChromium, args: ["--no-sandbox"] }
    : undefined,
);
const page = await browser.newPage();
for (const [name, palette] of Object.entries(PALETTES)) {
  if (ONLY && name !== ONLY) continue;
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
