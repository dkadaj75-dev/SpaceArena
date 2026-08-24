/* global process, console, Buffer, document, ImageData, makeNebula */
// Equirect nebula skybox generator — renders in headless Chromium (canvas) and
// saves WEBP. Noise is sampled in 3D direction space so the pano wraps seamlessly.
// Usage: node make-skybox.mjs <outDir> [paletteName]
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const OUT = process.argv[2] ?? ".";
const ONLY = process.argv[3];
// 4096x2048 (was 2048x1024). One equirect pixel is 0.088 deg, which is what a
// 50-deg-wide crescent and a sub-degree ring line need before they stair-step.
// The cost is small: at Q88 the three panoramas total 332 kB (128 + 122 + 82)
// against 122 kB at half the size, on a 5 MB budget that only gates JS. Full
// run is ~100 s. Q is the lever if that ever has to be trimmed: ring-nebula
// measures 94 kB at 0.82 and 196 kB at 0.94. 0.88 is unchanged from the 2k
// panoramas — the budget gave no reason to move it.
// A palette may override this with its own `size: { w, h }`. ring-nebula does:
// its giant is 104 deg across, so the same texel budget spreads a quarter as
// thick over the one feature the sky is built around, and the ring line is
// sub-degree regardless of how big the planet gets.
const W = 4096, H = 2048;
const WEBP_QUALITY = 0.88;

const PALETTES = {
  // References are mostly DARK sky: dust confined to patches (~30% coverage),
  // muted mids, bright cores only deep inside the densest clouds.
  // sun.dir is a UNIT vector in the same 3D direction space the pano samples
  // (x = st*cos(phi), y = ct, z = st*sin(phi)) — the scene's directional light
  // must shine ALONG -dir so surfaces lit by it face the painted star.
  "deep-field": {
    base: [5, 7, 12],
    dustA: { col: [44, 27, 17], hot: [100, 65, 34], lo: 0.68, hi: 1.0 },
    dustB: { col: [38, 31, 20], hot: [105, 82, 43], lo: 0.72, hi: 1.02 },
    dustC: { col: [29, 22, 25], hot: [62, 47, 51], lo: 0.71, hi: 1.04 },
    core: [255, 214, 160],
    warp: 1.25, starGain: 1.0, seed: 7, gain: 0.92, nebulaGain: 0.34,
    bandN: [0.28, 0.86, 0.42], bandWidth: 0.31, bandGain: 1.35,
    bandCoreDir: [-0.78, 0.34, -0.52],
    planet: {
      dir: [0.05, -0.5, 0.8646],
      // bandScale sets how many zones cross the disc: the broad term runs at
      // phase*0.47, so ~26 gives four or five zones plus harmonics — Jupiter's
      // count. 13.5 gave barely one (a featureless ball), 44 gave corduroy.
      // The two surface tones must also stay APART: muting them together is
      // what flattened the banding even while the zones were still there.
      angularRadiusDeg: 12.5, kind: "gas", turbulence: 4.3, bandScale: 26,
      bandOffset: 0.45, bandContrast: 0.32,
      surface: { base: [150, 134, 78], band: [104, 101, 58], detail: [178, 146, 79] },
      atmosphere: [151, 151, 82], storm: { x: 0.34, y: -0.2, rx: 0.27, ry: 0.105 },
    },
    sun: { dir: [0.777, 0.309, 0.55], color: [255, 248, 230], discDeg: 0.72, glowDeg: 3.2, minimalGlow: true },
  },
  "ring-nebula": {
    // 8192x4096 for this sky only (owner request 2026-08-23, "higher
    // resolution"). One texel is 0.044 deg, which is what a 104-deg-wide
    // crescent's banding and a 1.7-deg ring line want now that the giant fills
    // this much sky. Only this palette pays for it; the others stay at 4k.
    size: { w: 8192, h: 4096 },
    base: [6, 6, 14],
    dustA: { col: [38, 25, 57], hot: [79, 49, 104], lo: 0.72, hi: 1.0 },
    dustB: { col: [19, 31, 57], hot: [48, 72, 111], lo: 0.76, hi: 1.02 },
    dustC: { col: [30, 21, 41], hot: [65, 45, 82], lo: 0.75, hi: 1.04 },
    core: [224, 208, 255],
    warp: 1.5, starGain: 1.0, seed: 23, gain: 0.9, nebulaGain: 0.24,
    bandN: [-0.5, 0.75, 0.43], bandWidth: 0.3, bandGain: 1.55,
    bandCoreDir: [0.66, 0.52, -0.54],
    planet: {
      // The brief for this sky is "the arena sits inside one of its rings", so
      // the giant is NEAR, not distant: 26 deg of angular radius (52 deg of
      // sky, ~5% of the sphere) and swung round in phase so it renders as a
      // crescent. Phase comes straight out of dir DOT sun.dir —
      // it was +0.64 here (a 50-deg phase, i.e. a nearly full ball). +0.47 gave
      // a razor crescent with no room left for banding; +0.22 (a 103-deg
      // phase) puts the terminator a fifth of the way across the disc, which
      // is a big sweeping lit limb that still has surface to show. Kept 77 deg
      // away from the star and 60 deg off the galactic band's plane, so
      // neither the approved sun nor the Milky Way river is swallowed.
      dir: [-0.8431, 0.3746, 0.3859],
      // Slightly tighter banding than deep-field's giant, so the two worlds do
      // not read as the same planet twice. See the note there on scale/tones.
      // 26 -> 52 deg (owner request 2026-08-23, "2X bigger"): 104 deg of sky,
      // ~20% of the sphere. bandScale is NOT touched — phase runs on the
      // normalised disc coordinate, so the zone COUNT is a property of the
      // planet, not of how close we are standing. Everything measured in
      // degrees FROM the planet does scale: the atmosphere skirt below, and
      // the ring geometry (see rings.normal / widthDeg and ringScale in the
      // page script).
      angularRadiusDeg: 52, kind: "gas", turbulence: 4.0, bandScale: 29,
      bandOffset: -0.25, bandContrast: 0.46, detailed: true,
      shadingGamma: 0.75, terminatorSoftness: 0.1,
      // "A bit more emissivity" (same request). This multiplies the disc's own
      // illumination — surface AND its limb haze — and nothing else, so the
      // ring glow, the atmosphere skirt and the nebula behind it all hold
      // still and the planet alone comes up. +25% is the most that fits before
      // the pale `detail` tone (236, 222, 190) starts clipping to flat white
      // in the brightest cloud tops.
      luminance: 1.25,
      // Tones pushed APART (see deep-field's note) and split by HUE as well
      // as value: the old olive pair differed by 23% in luminance, which read
      // as banding on a 10-deg ball and as one flat wash of yellow across a
      // 26-deg lit crescent. Pale gold zones over warm brown belts is both the
      // photoreal reference and a 50% luminance split.
      surface: { base: [186, 168, 122], band: [112, 84, 48], detail: [236, 222, 190] },
      // A 26-deg disc needs a proportionally deeper limb: the halo is a fixed
      // ANGULAR skirt outside the disc, not a fraction of it. So at 52 deg it
      // doubles too (1.6 -> 3.2), or the skirt thins to a hairline against a
      // disc twice as wide.
      atmosphere: [198, 186, 138], atmosphereDeg: 3.2, limbHaze: 0.42,
      // Moved into the lit crescent. At the old spot (-0.38, +0.16) the storm
      // sat squarely on the night side and simply vanished; this is the middle
      // of the crescent, which runs along disc-space (-0.947, -0.321).
      storm: { x: -0.52, y: -0.18, rx: 0.24, ry: 0.12, color: [198, 132, 104] },
      rings: {
        // The observer is IN the ring plane, so the sheet projects to a great
        // circle. Its normal is 4 deg off perpendicular to dir, which slides
        // the line just off the planet's centre — dead-on edge-on reads as a
        // drawn line, and the offset has to be read as a FRACTION of the disc:
        // it was 2 deg against a 26-deg radius, so a 52-deg radius needs 4 to
        // cross at the same place and leave the same sliver. The plane is
        // tilted 28 deg from horizontal so it cuts the sky diagonally. It
        // also passes close to the star, which is not a coincidence to design
        // away: a ring sits in the planet's equatorial plane and the star sits
        // near its orbital plane, so a low-obliquity giant genuinely shows its
        // brightest forward-scattering arc right beside the sun.
        normal: [0.1147, 0.8929, -0.4353],
        // Kept dim and SOFT-edged on purpose. The skybox sphere is 32
        // segments, so a razor-thin great circle would visibly kink at the
        // quad boundaries, and a bright band across the play space would
        // fight ship silhouettes. widthDeg is the 1-sigma half-width away
        // from the planet; it swells near the planet, where the line of sight
        // runs the long way through the sheet. It is an apparent width, so it
        // doubles with the planet (0.85 -> 1.7): the sheet did not get thicker,
        // we are twice as close to it.
        color: [196, 183, 161], gain: 0.42, frontGain: 0.5, widthDeg: 1.7,
      },
    },
    sun: { dir: [-0.677, -0.208, -0.706], color: [244, 248, 255], discDeg: 0.68, glowDeg: 3.0, minimalGlow: true },
  },
  // PARKER POINT (owner request 2026-08-21) — "the same as Ring Nebula, but
  // instead of the gas giant we have the sun, obviously bigger".
  //
  // So this palette paints NEITHER a planet NOR a sun: the star is drawn in the
  // scene instead, as real geometry (`arena.render.star` → `game/starBillboard`,
  // the main menu's own body), which is what lets it be arbitrarily large,
  // animated and lit without a 4k texture trying to hold a 100-deg disc.
  // Everything here is therefore just the backdrop it hangs against.
  //
  // Brighter than ring-nebula on purpose (the same owner request asked both
  // deathmatch skies to read lighter): more stars and a stronger galactic
  // river, with the base sky left dark so it does not turn milky.
  "parker-point": {
    base: [7, 8, 17],
    dustA: { col: [40, 28, 58], hot: [88, 58, 112], lo: 0.7, hi: 1.0 },
    dustB: { col: [22, 35, 62], hot: [58, 84, 126], lo: 0.74, hi: 1.02 },
    dustC: { col: [33, 24, 44], hot: [72, 52, 90], lo: 0.73, hi: 1.04 },
    core: [230, 216, 255],
    warp: 1.5,
    // 1.0 -> 1.7: "more visible stars in general". The star term is a cubic
    // falloff scaled by this, so it lifts the faint field far more than the
    // few bright ones — which is what reads as a deeper sky rather than as a
    // handful of blown-out dots.
    starGain: 1.7,
    // A different seed, or Parker Point is Ring Nebula's sky with the planet
    // painted out and every dust lane in the same place.
    seed: 41,
    // Sky gain 0.9 -> 1.02 and nebula 0.24 -> 0.31: brighter, still short of
    // the 1.25 that starts washing the black out from between the stars.
    gain: 1.02, nebulaGain: 0.31,
    bandN: [-0.42, 0.79, 0.45], bandWidth: 0.32, bandGain: 1.72,
    bandCoreDir: [0.62, 0.48, -0.62],
  },
  "lunar-crater": {
    base: [0, 0, 1], spaceBlack: true,
    dustA: { col: [20, 18, 16], hot: [34, 30, 25], lo: 0.98, hi: 1.1 },
    // dustB doubles as the galactic-band medium: its ramp thresholds keep it
    // out of the open sky, so its colour can run bright enough for a visible
    // Milky Way river without lifting the black background.
    dustB: { col: [48, 44, 38], hot: [28, 24, 19], lo: 0.99, hi: 1.1 },
    dustC: { col: [11, 10, 9], hot: [21, 18, 15], lo: 0.99, hi: 1.1 },
    core: [40, 40, 42],
    warp: 0.12, starGain: 1.15, seed: 61, gain: 0.38,
    // The Orion Arm: a warm-toned diagonal river across the black sky.
    bandN: [0.58, 0.55, -0.60], bandWidth: 0.24, bandGain: 2.35,
    bandCoreDir: [0.56, -0.78, -0.28],
    planet: {
      // Readable Apollo-8-style Earthrise. ~75 deg of azimuth from the sun:
      // far enough to clear its glow, close enough that the disc keeps a broad
      // lit face — at the old anti-solar spot the lit-phase shading left only
      // a sliver and the atmosphere halo (verifier caught it).
      // Raised 10 deg (12 -> 22 deg elevation) on the SAME azimuth: the
      // horizontal part of the vector is renormalised and rescaled by
      // cos(22 deg), the vertical set to sin(22 deg). It clears the crater rim
      // instead of sitting on it. Elevation is the only free parameter here,
      // so the phase angle drifts with it, 109 deg -> 113 deg.
      dir: [-0.71, 0.3746, 0.5963],
      angularRadiusDeg: 8, kind: "earth", detailed: true,
      // Earth's air scatters light well past the geometric terminator, and
      // this disc is small enough that a hard one just looks like a bite out
      // of it. Gamma is lower than the giant's for the same reason: the whole
      // point of the CTF sky is a bright blue centrepiece.
      shadingGamma: 0.5, terminatorSoftness: 0.17, nightFloor: 0.012,
      surface: {
        base: [26, 80, 158], band: [178, 138, 82], detail: [244, 248, 252],
        detailGain: 0.82,
      },
      atmosphere: [130, 190, 255], atmosphereDeg: 0.72, limbHaze: 0.3,
    },
    ground: {
      horizon: -0.065,
      surface: [72, 73, 74],
      rim: [137, 138, 139],
      craters: [
        { phi: 0.45, y: -0.43, radius: 0.13 },
        { phi: 2.25, y: -0.31, radius: 0.09 },
        { phi: 4.15, y: -0.55, radius: 0.16 },
        { phi: 5.55, y: -0.25, radius: 0.07 },
      ],
    },
    sun: { dir: [-0.707, 0.5, -0.5], color: [255, 255, 255], discDeg: 1.15, glowDeg: 4.5, minimalGlow: true },
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
      for (let ch = 0; ch < 3; ch++) c[ch] += P.dustA.col[ch] * haze * haze * (P.spaceBlack ? 0.008 : 0.10);
      // Galactic band: dust + stars concentrate along a tilted great circle.
      const bandDist = Math.abs(dx * P.bandN[0] + dy * P.bandN[1] + dz * P.bandN[2]);
      const band = Math.exp(-(bandDist * bandDist) / (P.bandWidth * P.bandWidth));
      const bandDust = fbm(ax * 2.6 + 97, ay * 2.6, az * 2.6, 5, 0.55);
      const bg = P.bandGain ?? 0.55;
      // The warm galactic bulge is localized along the great circle, fading
      // into cooler blue-white arms. Narrow, broken absorption lanes remove
      // light instead of merely drawing dark stripes over it.
      const coreDir = P.bandCoreDir;
      const alongCore = Math.max(0, dx * coreDir[0] + dy * coreDir[1] + dz * coreDir[2]);
      const bulge = band * Math.pow(alongCore, 5) * (0.55 + bandDust * 0.45);
      const arm = band * (0.32 + bandDust * 0.55);
      const laneWarp = (fbm(dx * 8 + 733, dy * 8, dz * 8, 3, 0.55) - 0.5) * P.bandWidth * 0.22;
      const laneA = Math.exp(-Math.pow((bandDist - P.bandWidth * 0.18 - laneWarp) / (P.bandWidth * 0.065), 2));
      const laneB = Math.exp(-Math.pow((bandDist - P.bandWidth * 0.38 + laneWarp) / (P.bandWidth * 0.085), 2));
      const lanes = Math.min(0.72, (laneA * 0.62 + laneB * 0.38) * (0.55 + bandDust * 0.45));
      for (let ch = 0; ch < 3; ch++) {
        const coolArm = [54, 64, 82][ch] * arm * bg;
        const warmCore = [132, 92, 54][ch] * bulge * bg;
        c[ch] = c[ch] * (1 - lanes) + (coolArm + warmCore) * (1 - lanes * 0.72);
      }
      // Keep decorative nebula subordinate to the galactic river: presets can
      // reduce its brightness independently without dimming the band or stars.
      const beforeNebula = [...c];
      const nA = fbm(ax * 1.9, ay * 1.9, az * 1.9, 6, 0.55);
      if (!P.spaceBlack) rampMix(nA, P.dustA.lo, P.dustA.hi, P.dustA.col, P.dustA.hot, c);
      const nB = fbm(ax * 3.4 + 31, ay * 3.4, az * 3.4, 6, 0.5);
      if (!P.spaceBlack) rampMix(nB, P.dustB.lo, P.dustB.hi, P.dustB.col, P.dustB.hot, c);
      // Third mid-scale layer at a decorrelated offset: fills the gaps the two
      // primary layers leave without pushing overall brightness up much.
      const nD = fbm(ax * 2.6 + 157, ay * 2.6, az * 2.6, 5, 0.55);
      if (!P.spaceBlack) rampMix(nD, P.dustC.lo, P.dustC.hi, P.dustC.col, P.dustC.hot, c);
      // Bright cores inside dense dust (stretched like the ramps)
      const nC = 1 / (1 + Math.exp(-(fbm(dx * 5.2 + 53, dy * 5.2, dz * 5.2, 4, 0.5) - 0.5) * 14));
      // Only inside genuinely dense dust (stretched nA above the dustA floor).
      const core = Math.pow(Math.max(0, nC), 8) * Math.max(0, (1 / (1 + Math.exp(-(nA - 0.5) * 14))) - 0.75) * 3.0;
      for (let ch = 0; ch < 3; ch++) c[ch] += P.core[ch] * core;
      const nebulaGain = P.nebulaGain ?? 1;
      for (let ch = 0; ch < 3; ch++) c[ch] = beforeNebula[ch] + (c[ch] - beforeNebula[ch]) * nebulaGain;

      // Stars: jittered point per 3D cell, distance in direction space
      const S = 90;
      const cx = Math.floor(dx * S), cy = Math.floor(dy * S), cz = Math.floor(dz * S);
      let star = 0;
      const jx = cx + hash(cx, cy, cz), jy = cy + hash(cy, cz, cx), jz = cz + hash(cz, cx, cy);
      const ddx = dx * S - jx, ddy = dy * S - jy, ddz = dz * S - jz;
      const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
      const starRadius2 = (P.spaceBlack ? 0.0055 : 0.004) * (1 + band * 1.15);
      if (d2 < starRadius2) {
        const b = hash(cx * 3 + 1, cy * 3 + 2, cz * 3 + 3);
        star = Math.max(0, 1 - d2 / starRadius2) ** 3 * (0.35 + 1.4 * b * b) * 255 * P.starGain;
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
        const atmosphereDeg = planet.atmosphereDeg ?? 0.6;
        // Ring system, painted BEFORE the disc so the planet occludes the far
        // arc for free; the near arc is added back over the disc afterwards.
        // Everything keys off ang (degrees from the planet's centre), so the
        // structure is locked to the planet and stays deterministic.
        let ringAmount = 0;
        if (planet.rings) {
          const rings = planet.rings;
          const rn = rings.normal;
          const offPlane = dx * rn[0] + dy * rn[1] + dz * rn[2];
          const angRad = ang * (Math.PI / 180);
          // Every angular constant in this block was tuned against a 26-deg
          // giant, and all of them are radial positions IN THE SHEET measured
          // out from the planet. They therefore belong to the planet's scale,
          // not to the sky's: leave them fixed while the disc grows and the
          // divisions end up buried inside it. ringScale is 1 at the original
          // tuning, so the numbers below still read as what was chosen.
          const ringScale = radiusDeg / 26;
          // Toward the planet the sight line runs the long way through the
          // sheet, so the band swells and brightens; 0.62 rad (~35 deg, i.e.
          // 1.4 planet radii) is where that thickening has effectively died
          // away.
          const swell = Math.exp(-(angRad * angRad) / Math.pow(0.62 * ringScale, 2));
          const halfWidth = rings.widthDeg * (Math.PI / 180) * (1 + swell * 1.9);
          const across = Math.exp(-(offPlane * offPlane) / (halfWidth * halfWidth));
          // Divisions. Radial position maps to angle from the planet, so soft
          // gaps parked at fixed angles read as concentric gaps in the sheet.
          const gaps = 1
            - 0.34 * Math.exp(-Math.pow((angRad - 0.3 * ringScale) / (0.045 * ringScale), 2))
            - 0.26 * Math.exp(-Math.pow((angRad - 0.52 * ringScale) / (0.06 * ringScale), 2))
            - 0.2 * Math.exp(-Math.pow((angRad - 0.95 * ringScale) / (0.1 * ringScale), 2));
          const grain = 0.72 + 0.56 * fbm(dx * 7 + 877, dy * 7, dz * 7, 4, 0.55);
          // Ring particles forward-scatter hard, and at this phase the star is
          // BEHIND the planet — the half of the sheet toward it glows, which is
          // most of what sells "we are inside the sheet" rather than "there is
          // a line painted on the sky".
          const toSun = P.sun ? dx * P.sun.dir[0] + dy * P.sun.dir[1] + dz * P.sun.dir[2] : 0;
          const forward = 0.62 + 0.75 * Math.max(0, toSun);
          // The far side of the sheet keeps going all the way round the sky,
          // but as a thread, not a feature: 0.16 is its floor.
          const reach = 0.16 + 0.84 * Math.exp(-Math.pow(angRad / (1.05 * ringScale), 2));
          ringAmount = Math.max(0, across * gaps * grain * forward * reach * rings.gain);
          for (let ch = 0; ch < 3; ch++) out[ch] += rings.color[ch] * ringAmount;
        }
        if (ang < radiusDeg + atmosphereDeg) {
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
        // planet.detailed is opt-in. deep-field's giant is an APPROVED
        // look and stays on the original Lambert/limb path untouched; only the
        // two worlds that had to grow or sharpen take the richer route.
        const detailed = planet.detailed === true;
        let illumination, limb;
        if (detailed) {
          const mu0 = Math.max(0, ndotl);
          // Lommel-Seeliger single scattering. The plain path's Lambert-times-
          // limb-darkening fades the disc to 28% exactly AT the limb, which is
          // precisely where a crescent lives — a big backlit planet loses the
          // one thing it is being shown for. 2.12 = (mu0 + mu + 0.12) at the
          // sub-solar point, so this is normalised to 1 there and the mix below
          // cannot shift exposure.
          const scatter = mu0 / (mu0 + surfaceZ + 0.12) * 2.12;
          // Lambert and Lommel-Seeliger together still measured ~25% dimmer
          // across the lit face than the flat-shaded path they replace, which
          // robbed the Earthrise of its punch. The gamma lifts the midtones
          // back without touching either end: 1 stays 1, 0 stays 0, and the
          // terminator falloff is still a falloff rather than a step.
          const shade = Math.pow(0.3 * mu0 + 0.7 * scatter, planet.shadingGamma ?? 1);
          // Terminator half-width, per planet. The plain path's [-0.12, 0.2]
          // smears it across a third of the disc radius: fine on a small ball,
          // a dirty gradient on a 26-deg crescent. Earth still wants the soft
          // one, because its air really does scatter light past the geometry.
          const soft = planet.terminatorSoftness ?? 0.1;
          // The night floor is not ambient cheating: at 26 deg across, a night
          // side clamped to black punched a hole in the sky instead of reading
          // as an unlit world in front of it. Over a BLACK sky there is nothing
          // to read against and nothing to light it, so lunar-crater turns it
          // most of the way back down.
          illumination = (planet.nightFloor ?? 0.045)
            + smoothRange(0.03 - soft, 0.03 + soft, ndotl) * shade;
          // A gentle Minnaert-ish edge falloff is all that is left to do: the
          // grazing view looks through more air, so the very rim sits back.
          limb = 0.72 + 0.28 * Math.pow(surfaceZ, 0.35);
        } else {
          illumination = 0.03 + smoothRange(-0.12, 0.2, ndotl) * 0.97;
          limb = 0.28 + 0.72 * Math.pow(surfaceZ, 0.38);
        }
        // Per-planet emissivity trim. It scales the disc's own lit response —
        // surface tones and the limb haze that blends into them — and deliberately
        // nothing else: the ring glow, the atmosphere skirt outside the disc
        // and the nebula behind it are all computed from other terms, so a
        // planet can be brought up without the sky coming with it. Default 1
        // leaves every existing sky bit-identical.
        illumination *= planet.luminance ?? 1;
        // Detailed planets sample noise in the DISC frame (localX, localY,
        // surfaceZ is a point on the unit sphere) instead of world space. That
        // is what makes anisotropic sampling possible: dividing the localY
        // frequency into the other two stretches every wisp ALONG the zones,
        // the way a rotating atmosphere shears its clouds.
        const detailNoise = detailed ? 0 : fbm(snx * 7.5 + 307, sny * 7.5, snz * 7.5, 5, 0.55);
        let baseMix = 0, detailMix = 0, specularAdd = 0, stormMix = 0;
        if (planet.kind === "earth" && detailed) {
          // Crisp coastlines come from a NARROW threshold band; on its own
          // that band is laser-cut, so a finer octave jitters the threshold
          // itself and the shoreline picks up fractal detail.
          const continents = fbm(localX * 2.6 + 211, localY * 2.6, surfaceZ * 2.6, 6, 0.55);
          const coast = fbm(localX * 9.5 + 853, localY * 9.5, surfaceZ * 9.5, 4, 0.5) - 0.5;
          baseMix = smoothRange(0.498, 0.536, continents + coast * 0.06);
          // Two weather systems rather than one blob field: broad frontal
          // cloud stretched along latitude, plus a finer curdled deck.
          const swirl = fbm(localX * 2.1 + 977, localY * 2.1, surfaceZ * 2.1, 3, 0.6) - 0.5;
          const frontal = fbm(localX * 3.6 + 419, localY * 5.6, surfaceZ * 3.6, 5, 0.56);
          const curdle = fbm(localX * 12 + 733, localY * 17, surfaceZ * 12, 4, 0.5);
          detailMix = Math.min(1,
            smoothRange(0.52, 0.7, frontal + swirl * 0.3)
            + smoothRange(0.6, 0.8, curdle) * 0.4,
          ) * (planet.surface.detailGain ?? 0.7);
          // Ice at the disc's own poles — the band axis IS the visible axis
          // here, which is exactly the Apollo-8 framing this sky quotes.
          const pole = smoothRange(0.8, 0.99, Math.abs(localY));
          baseMix *= 1 - pole;
          detailMix = Math.min(1, detailMix + pole * 0.85);
          // Ocean is specular, land and cloud are not. A broad low-power sheen
          // separates water from rock everywhere the light grazes; the tight
          // lobe on top is the sun glint, which at this phase lands near the
          // lit limb where it belongs.
          const hx = sunDir[0] - dx, hy = sunDir[1] - dy, hz = sunDir[2] - dz;
          const hl = Math.hypot(hx, hy, hz) || 1;
          const spec = Math.max(0, (snx * hx + sny * hy + snz * hz) / hl);
          specularAdd = (Math.pow(spec, 6) * 0.1 + Math.pow(spec, 60) * 0.42)
            * (1 - baseMix) * (1 - detailMix)
            * Math.max(0, Math.min(1, ndotl * 3));
        } else if (planet.kind === "earth") {
          // Low-frequency continental masks over ocean, with independent,
          // finer curled cloud systems; neither follows latitude mechanically.
          const continents = fbm(snx * 2.8 + 211, sny * 2.8, snz * 2.8, 5, 0.56);
          baseMix = smoothRange(0.49, 0.59, continents);
          const cloudWarp = fbm(snx * 4 + 419, sny * 4, snz * 4, 4, 0.56) - 0.5;
          detailMix = smoothRange(0.54, 0.68, detailNoise + cloudWarp * 0.24) * (planet.surface.detailGain ?? 0.7);
        } else if (detailed) {
          // Same incommensurate wave stack as the plain giant below, plus two
          // higher harmonics — at 26 deg across, four or five zones is a bare
          // sketch, and the harmonics are what turn each zone into a zone WITH
          // structure rather than a flat stripe.
          const shear = fbm(localX * 1.35 + 211, localY * 0.55, surfaceZ * 1.35, 4, 0.58) - 0.5;
          // A second, faster shear: one turbulence scale makes every boundary
          // wander with the same wavelength, which reads as a wobbly print.
          const shear2 = fbm(localX * 4.6 + 911, localY * 1.7, surfaceZ * 4.6, 4, 0.55) - 0.5;
          const turbulence = planet.turbulence ?? 4.0;
          const phase = localY * (planet.bandScale ?? 14)
            + shear * turbulence
            + shear2 * turbulence * 0.34
            + (planet.bandOffset ?? 0);
          const latitudeProfile = Math.sin(phase * 0.47 + 0.4) * 0.52
            + Math.sin(phase * 0.83 - 1.1) * 0.27
            + Math.sin(phase * 1.31 + 2.2) * 0.14
            + Math.sin(phase * 2.17 - 0.3) * 0.07
            + Math.sin(phase * 3.41 + 1.7) * 0.05
            + Math.sin(phase * 5.09 - 2.4) * 0.028;
          const narrowBelt = Math.exp(-Math.pow((phase - 1.15) / 0.32, 2));
          baseMix = 0.45 + latitudeProfile * (planet.bandContrast ?? 0.18) + narrowBelt * 0.07;
          // Three turbulence scales, each stretched along the zones (the
          // localY frequency is 2-3x the other two). The coarsest also
          // perturbs the zone mix itself, so belt edges curdle instead of
          // printing as clean stripes when the disc fills the sky.
          const swirlA = fbm(localX * 6.5 + 307, localY * 17, surfaceZ * 6.5, 5, 0.55);
          const swirlB = fbm(localX * 15 + 601, localY * 38, surfaceZ * 15, 4, 0.5);
          const swirlC = fbm(localX * 31 + 877, localY * 74, surfaceZ * 31, 3, 0.5);
          detailMix = smoothRange(0.52, 0.8, swirlA) * 0.17
            + smoothRange(0.58, 0.84, swirlB) * 0.09
            + smoothRange(0.6, 0.86, swirlC) * 0.05;
          baseMix += (swirlA - 0.5) * 0.11;
          const storm = planet.storm;
          if (storm) {
            // Foreshortening: a fixed patch of SURFACE projects narrower the
            // closer it sits to the limb, so the radial half of the offset is
            // divided back out by surfaceZ before the oval test. Without this
            // an off-centre storm reads as a decal pasted on the disc.
            const rr = Math.hypot(storm.x, storm.y) || 1;
            const ux = storm.x / rr, uy = storm.y / rr;
            const offX = localX - storm.x, offY = localY - storm.y;
            const radialOff = (offX * ux + offY * uy) / Math.max(0.25, surfaceZ);
            const tangOff = -offX * uy + offY * ux;
            const sd = Math.hypot(radialOff / storm.rx, tangOff / storm.ry);
            const oval = 1 - smoothRange(0.68, 1.05, sd);
            const stormAngle = Math.atan2(tangOff / storm.ry, radialOff / storm.rx);
            const vortex = (0.5 + 0.5 * Math.sin(stormAngle * 2.0 + sd * 8.0)) * oval;
            // The storm gets its OWN tone rather than borrowing the bright
            // cloud colour: a pale oval on pale zones is invisible, and the
            // reference for a giant's anticyclone is a salmon-red patch.
            stormMix = oval * (0.5 + vortex * 0.42);
            baseMix = baseMix * (1 - oval * 0.28) + vortex * oval * 0.24;
          }
        } else {
          // Broad zones and narrow belts come from incommensurate latitude
          // waves, avoiding a repeating light/dark cadence. Low-frequency
          // turbulence shifts the latitude coordinate itself: the resulting
          // boundaries meander along their length but remain rotationally
          // sheared rather than breaking into noisy scribbles.
          const shear = fbm(snx * 1.35 + 211, sny * 0.55, snz * 1.35, 3, 0.58) - 0.5;
          const phase = localY * (planet.bandScale ?? 14)
            + shear * (planet.turbulence ?? 4.0)
            + (planet.bandOffset ?? 0);
          const latitudeProfile = Math.sin(phase * 0.47 + 0.4) * 0.52
            + Math.sin(phase * 0.83 - 1.1) * 0.27
            + Math.sin(phase * 1.31 + 2.2) * 0.14
            + Math.sin(phase * 2.17 - 0.3) * 0.07;
          const narrowBelt = Math.exp(-Math.pow((phase - 1.15) / 0.32, 2));
          baseMix = 0.45 + latitudeProfile * (planet.bandContrast ?? 0.18) + narrowBelt * 0.07;
          detailMix = smoothRange(0.56, 0.82, detailNoise) * 0.11;
          const storm = planet.storm;
          if (storm) {
            const sd = Math.hypot((localX - storm.x) / storm.rx, (localY - storm.y) / storm.ry);
            const oval = 1 - smoothRange(0.68, 1.05, sd);
            const stormAngle = Math.atan2((localY - storm.y) / storm.ry, (localX - storm.x) / storm.rx);
            const vortex = (0.5 + 0.5 * Math.sin(stormAngle * 2.0 + sd * 8.0)) * oval;
            detailMix = Math.max(detailMix, oval * (0.34 + vortex * 0.34));
            baseMix = baseMix * (1 - oval * 0.28) + vortex * oval * 0.24;
          }
        }
        // Soft atmospheric limb: the last few percent of the disc is seen
        // through a long slant path, so the ground washes out toward the
        // atmosphere's own colour before the rim halo outside takes over. The
        // exponent has to be steep — at 2.6 the wash reached a third of the
        // way in and simply desaturated the whole lit crescent.
        const haze = detailed ? Math.pow(1 - surfaceZ, 3.4) * (planet.limbHaze ?? 0.4) : 0;
        for (let ch = 0; ch < 3; ch++) {
          const broad = planet.surface.base[ch] * (1 - baseMix) + planet.surface.band[ch] * baseMix;
          let tinted = broad * (1 - detailMix) + planet.surface.detail[ch] * detailMix;
          if (stormMix > 0) {
            const stormColor = planet.storm.color ?? planet.surface.detail;
            tinted = tinted * (1 - stormMix) + stormColor[ch] * stormMix;
          }
          let surface = tinted * illumination * limb;
          surface = surface * (1 - haze) + planet.atmosphere[ch] * illumination * haze * 0.85;
          surface += [255, 250, 242][ch] * specularAdd;
          out[ch] = out[ch] * (1 - discAlpha) + surface * discAlpha;
        }
        // The near arc of the ring passes IN FRONT of the planet. The disc has
        // just overwritten it, so put it back at a reduced gain: one thin lit
        // line crossing a mostly dark crescent, which is the single clearest
        // cue that the sheet has depth and we are sitting inside it.
        if (ringAmount > 0 && discAlpha > 0) {
          const front = ringAmount * (planet.rings.frontGain ?? 0.5) * discAlpha;
          for (let ch = 0; ch < 3; ch++) out[ch] += planet.rings.color[ch] * front;
        }
        if (ang > radiusDeg - edgeHalfWidth && ang < radiusDeg + atmosphereDeg) {
          const sunDotPlanet = sunDir[0] * pd[0] + sunDir[1] * pd[1] + sunDir[2] * pd[2];
          let tx = sunDir[0] - pd[0] * sunDotPlanet;
          let ty = sunDir[1] - pd[1] * sunDotPlanet;
          let tz = sunDir[2] - pd[2] * sunDotPlanet;
          const tl = Math.hypot(tx, ty, tz);
          if (tl > 0) { tx /= tl; ty /= tl; tz /= tl; }
          const sunward = Math.max(0, snx * tx + sny * ty + snz * tz);
          const rimFalloff = 1 - smoothRange(radiusDeg - edgeHalfWidth, radiusDeg + atmosphereDeg, ang);
          let atmosphereGain = rimFalloff * (0.08 + 0.46 * sunward);
          if (detailed) {
            // The flat 0.08 term draws the skirt right around the disc, which
            // on a crescent hangs a full lit ring around a world that is 80%
            // night. Sun-weight it instead.
            atmosphereGain = rimFalloff * (0.022 + 0.52 * sunward);
            // A THIN bright line hugging the limb on top of the broad skirt.
            // The skirt alone reads as a soft glow with no edge to it; real
            // atmospheres show a hard-lit hairline where the horizon is. Kept
            // low: on the giant the halo colour is a near-match for the
            // surface, so a strong hairline just blows the whole lit limb out.
            const rimBand = Math.exp(-Math.pow((ang - radiusDeg) / (atmosphereDeg * 0.42), 2));
            atmosphereGain += rimBand * (0.03 + 0.28 * sunward);
          }
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
          const rock = (coarse - 0.5) * 24 + (fine - 0.5) * 10;
          let shade = rock;
          for (const crater of ground.craters ?? []) {
            let dphi = Math.abs(phi - crater.phi);
            dphi = Math.min(dphi, Math.PI * 2 - dphi);
            const dist = Math.hypot(dphi * Math.max(0.3, st), (dy - crater.y) * 2.1);
            const bowl = 1 - smoothRange(crater.radius * 0.35, crater.radius, dist);
            const lip = smoothRange(crater.radius * 0.72, crater.radius * 0.9, dist)
              * (1 - smoothRange(crater.radius * 0.9, crater.radius * 1.12, dist));
            const lightSide = 0.35 + 0.65 * Math.max(0, Math.cos(phi - Math.atan2(-P.sun.dir[2], -P.sun.dir[0])));
            shade += lip * 38 * lightSide - bowl * 42;
          }
          const rimMix = 1 - smoothRange(rimTop - 0.105, rimTop - 0.025, dy);
          const sunAzimuth = Math.atan2(P.sun.dir[2], P.sun.dir[0]);
          const directLight = Math.max(0, Math.cos(phi - sunAzimuth)) ** 1.7;
          const grazingLight = smoothRange(-0.75, ground.horizon, dy) * (2 + directLight * 24);
          for (let ch = 0; ch < 3; ch++) {
            const base = ground.surface[ch] * (1 - rimMix) + ground.rim[ch] * rimMix;
            out[ch] = base + shade + grazingLight;
          }
        }
      }

      // The nearby star is painted LAST so it dominates the planet, dust and stars.
      // ISS-style nearby star: a hard saturated disc and compact corona with
      // a steep, uninterrupted falloff. No atmosphere means no wide soft halo.
      let sun = 0;
      if (P.sun) {
        const cosAng = dx * P.sun.dir[0] + dy * P.sun.dir[1] + dz * P.sun.dir[2];
        const ang = Math.acos(Math.min(1, Math.max(-1, cosAng))) * (180 / Math.PI);
        if (ang < P.sun.discDeg) sun = 1;
        else if (ang < P.sun.glowDeg) sun = Math.pow(1 - (ang - P.sun.discDeg) / (P.sun.glowDeg - P.sun.discDeg), 4.2) * 0.72;
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
// Injected as a real script, NOT eval'd inside the evaluate callback. A direct
// eval makes the whole enclosing scope a sloppy-eval context that V8 refuses to
// optimise, and this generator is nothing but a tight numeric loop: the same
// 2048x1024 pass took over six minutes through eval and about eight seconds
// through addScriptTag. At 4096x2048 that is the difference between usable and
// not. The generated pixels are identical either way.
await page.addScriptTag({ content: PAGE_SCRIPT });
for (const [name, palette] of Object.entries(PALETTES)) {
  if (ONLY && name !== ONLY) continue;
  const w = palette.size?.w ?? W, h = palette.size?.h ?? H;
  const dataUrl = await page.evaluate(
    ([W, H, P, quality]) => {
      const img = makeNebula(W, H, P);
      const cv = document.createElement("canvas");
      cv.width = W; cv.height = H;
      cv.getContext("2d").putImageData(new ImageData(img, W, H), 0, 0);
      return cv.toDataURL("image/webp", quality);
    },
    [w, h, palette, WEBP_QUALITY],
  );
  const buf = Buffer.from(dataUrl.split(",")[1], "base64");
  const file = path.join(OUT, `${name}.webp`);
  fs.writeFileSync(file, buf);
  console.log(`${file}: ${w}x${h}, ${(buf.length / 1024).toFixed(0)} KB`);
}
await browser.close();
