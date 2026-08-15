/* global process, console, document, Image */
import { chromium } from "playwright";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const OUT = process.argv[2] ?? "content/skyboxes";
// These MUST mirror make-skybox.mjs's planet.dir / sun.dir / angularRadiusDeg.
// The disc samples are placed as a fraction of the radius, so a radius that has
// drifted from the generator's aims them at open sky and the check silently
// stops testing anything (deep-field sat at 38 against a 12.5-deg planet).
const SPECS = {
  "deep-field": {
    planetDir: [0.05, -0.5, 0.8646],
    sunDir: [0.777, 0.309, 0.55],
    angularRadiusDeg: 12.5,
  },
  "ring-nebula": {
    planetDir: [-0.8431, 0.3746, 0.3859],
    sunDir: [-0.677, -0.208, -0.706],
    angularRadiusDeg: 26,
  },
  "lunar-crater": {
    planetDir: [-0.71, 0.3746, 0.5963],
    sunDir: [-0.707, 0.5, -0.5],
    angularRadiusDeg: 8,
  },
};

function normalized(vector) {
  const length = Math.hypot(...vector);
  return vector.map((value) => value / length);
}

function tangentTowardSun(spec) {
  const planet = normalized(spec.planetDir);
  const sun = normalized(spec.sunDir);
  const dot = planet[0] * sun[0] + planet[1] * sun[1] + planet[2] * sun[2];
  return normalized([
    sun[0] - planet[0] * dot,
    sun[1] - planet[1] * dot,
    sun[2] - planet[2] * dot,
  ]);
}

function directionAt(spec, angleDeg, sign) {
  const planet = normalized(spec.planetDir);
  const tangent = tangentTowardSun(spec);
  const theta = angleDeg * Math.PI / 180;
  return normalized([
    planet[0] * Math.cos(theta) + tangent[0] * Math.sin(theta) * sign,
    planet[1] * Math.cos(theta) + tangent[1] * Math.sin(theta) * sign,
    planet[2] * Math.cos(theta) + tangent[2] * Math.sin(theta) * sign,
  ]);
}

function discDirection(spec, radialFraction) {
  const angle = Math.asin(
    Math.min(0.999, Math.abs(radialFraction)) * Math.sin(spec.angularRadiusDeg * Math.PI / 180),
  ) * 180 / Math.PI;
  return directionAt(spec, angle, Math.sign(radialFraction));
}

const installedChromium = "/opt/pw-browsers/chromium";
const browser = await chromium.launch(
  existsSync(installedChromium)
    ? { executablePath: installedChromium, args: ["--no-sandbox"] }
    : undefined,
);
const page = await browser.newPage();
let failed = false;
for (const [name, spec] of Object.entries(SPECS)) {
  const directions = {
    litDisc: discDirection(spec, 0.78),
    litSky: directionAt(spec, spec.angularRadiusDeg + 5, 1),
    nightDisc: discDirection(spec, -0.45),
    nightSky: directionAt(spec, spec.angularRadiusDeg + 5, -1),
  };
  const samples = await page.evaluate(async ({ imageUrl, directions }) => {
    const image = new Image();
    image.src = imageUrl;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    const result = {};
    for (const [label, dir] of Object.entries(directions)) {
      let phi = Math.atan2(dir[2], dir[0]);
      if (phi < 0) phi += Math.PI * 2;
      const theta = Math.acos(Math.max(-1, Math.min(1, dir[1])));
      const x = Math.min(canvas.width - 1, Math.max(0, Math.round(phi / (Math.PI * 2) * canvas.width)));
      const y = Math.min(canvas.height - 1, Math.max(0, Math.round(theta / Math.PI * canvas.height)));
      const rgb = [...context.getImageData(x, y, 1, 1).data].slice(0, 3);
      result[label] = {
        x,
        y,
        rgb,
        luminance: rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722,
      };
    }
    return result;
  }, {
    imageUrl: `data:image/webp;base64,${readFileSync(path.resolve(OUT, `${name}.webp`)).toString("base64")}`,
    directions,
  });
  const litPass = samples.litDisc.luminance > samples.litSky.luminance;
  // Strict "night side darker than sky" only works over a glowing nebula; on a
  // black lunar sky both samples bottom out at the same floor, so allow equal
  // within a tolerance while still catching a night side that GLOWS. The
  // tolerance is 4 and not 1.5 because 1.5 is below one 8-bit step of the
  // darkest surface tone a planet can have: lunar-crater's unlit land samples
  // (2, 2, 1) = 1.9 with the night floor already at 0.012 of full sun, and it
  // measured 3.2 before that floor came down. A night side that is actually
  // lit lands at 20+, so nothing real escapes through the gap.
  const nightPass = samples.nightDisc.luminance < samples.nightSky.luminance + 4;
  console.log(`${name}: ${JSON.stringify(samples)} pass=${litPass && nightPass}`);
  failed ||= !litPass || !nightPass;
}
await browser.close();
if (failed) process.exitCode = 1;
