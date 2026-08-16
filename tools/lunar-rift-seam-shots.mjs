// Boots the REAL client into arena.lunar-rift (5v5 Capture the Flag) headless, parks a
// camera at gameplay-like low oblique angles over known chunk borders, and
// screenshots each one twice: once as the game renders it, once with a magenta
// clear colour so any background bleeding through the ground is unmistakable.
//
//   node tools/lunar-rift-seam-shots.mjs --out <dir> [--tag before]
//
// Requires the dev client on :5173 and the game server on :2567.
/* global Buffer, window, process, console */
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  if (i < 0) return fallback;
  if (!process.argv[i + 1]) throw new Error(`${name} requires a value`);
  return process.argv[i + 1];
};
const OUT = path.resolve(arg("--out", "seam-shots"));
const TAG = arg("--tag", "shot");
mkdirSync(OUT, { recursive: true });

/**
 * Cameras aimed at internal chunk borders on FLAT ground, from the height and
 * pitch a chase camera actually uses. `look` is the point on the border line.
 */
const VIEWS = [
  // Canyon floor by the He-3 plant: the border the player flies over most.
  { name: "x0-canyon", eye: [-46, 6.5, -76], look: [0, -8.2, -38] },
  // Chosen by measurement — the flat-ground border samples with the worst
  // measured vertical step in the shipped assets (tools/lunar-rift-seam-audit).
  { name: "x0-910", eye: [-42, -0.6, 40], look: [0, -8.1, 54] },
  { name: "x0-56", eye: [-42, 7.2, -156], look: [0, -0.3, -142] },
  { name: "z0-610", eye: [77, 0.8, -42], look: [91, -6.7, 0] },
  { name: "z0-59", eye: [-154, 81.2, -42], look: [-140, 73.7, 0] },
  { name: "zm192-highland", eye: [-300, 86, -252], look: [-300, 73.2, -192] },
  { name: "z192-1014", eye: [7, 11.4, 150], look: [21, 3.9, 192] },
  { name: "overview", eye: [-150, 120, -300], look: [40, -4, 60] },
];

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on("pageerror", (e) => console.log(`  pageerror: ${e.message}`));

await page.goto("http://localhost:5173/", { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => !!window.__debug?.scene, null, { timeout: 300_000 });
// The launch fullscreen offer sits over the first screen.
const prompt = page.locator(".sa-fullscreen-prompt");
if (await prompt.isVisible().catch(() => false)) {
  await prompt.getByText("Not now", { exact: true }).click().catch(() => {});
}
console.log("starting 5v5 Capture the Flag through the lobby …");
const lobby = page.locator(".lobby-overlay");
await lobby.waitFor({ state: "visible", timeout: 300_000 });
await lobby.getByRole("button", { name: "5v5 Capture the Flag", exact: true }).click();
await page.locator(".sa-match-loading").waitFor({ state: "hidden", timeout: 300_000 });
await page.waitForFunction(() => window.__debug?.session?.arenaId === "arena.lunar-rift", null, { timeout: 300_000 });

const info = await page.evaluate(() => {
  const scene = window.__debug.scene;
  return {
    arenaId: window.__debug.session?.arenaId,
    meshes: scene.meshes.length,
    terrain: scene.meshes.filter((m) => /TERRAIN/.test(m.name)).length,
    hardwareScaling: window.__debug.engine.getHardwareScalingLevel(),
  };
});
console.log(`  ${JSON.stringify(info)}`);
if (info.terrain === 0) throw new Error("no terrain meshes in the scene");

// Let streaming/LOD settle, then freeze the game so the camera stays put.
await page.evaluate(() => {
  for (let i = 0; i < 90; i++) window.__debug.forceFrame(33);
  const scene = window.__debug.scene;
  window.__debug.engine.stopRenderLoop();
  // Pin the render resolution. The quality tier is probed at runtime and picks
  // a different hardware scaling level from run to run under software
  // rendering, which would make two runs' pixel counts incomparable. 1.0 is
  // also the most sensitive setting: a seam a downscaled buffer would blur
  // away still shows here.
  window.__debug.engine.setHardwareScalingLevel(1);
  window.__debug.engine.resize();
  // A dedicated camera cloned from the live one: same class, same projection
  // defaults, but nothing in the game reaches in and re-aims it.
  scene.__seamCam = scene.activeCamera.clone("seamCam");
  scene.__origClear = scene.clearColor.clone();
  scene.__sky = scene.meshes.filter((m) => /sky/i.test(m.name));
});

/**
 * Drives the scene's own active camera: detach its controller, then set
 * position and target directly. Everything else about the frame — materials,
 * lights, LOD selection, hardware scaling — stays exactly as the game set it.
 */
async function shoot(view, magenta) {
  const dataUrl = await page.evaluate(({ view, magenta }) => {
    const scene = window.__debug.scene;
    const cam = scene.__seamCam;
    const Vec3 = cam.position.constructor;
    cam.detachControl?.();
    if ("lockedTarget" in cam) cam.lockedTarget = null;
    cam.parent = null;
    // The game's camera is an arc-rotate chase rig: setTarget re-derives the
    // position from the stored radius, and the rig's radius/beta limits clamp
    // whatever we ask for. Clear the limits, aim, then setPosition (which
    // re-derives alpha/beta/radius from the eye point) to pin the exact pose.
    // The bare position.set covers a plain free camera.
    for (const limit of ["lowerRadiusLimit", "upperRadiusLimit", "lowerBetaLimit", "upperBetaLimit", "lowerAlphaLimit", "upperAlphaLimit"]) {
      if (limit in cam) cam[limit] = null;
    }
    cam.checkCollisions = false;
    cam.position.set(view.eye[0], view.eye[1], view.eye[2]);
    cam.setTarget?.(new Vec3(view.look[0], view.look[1], view.look[2]));
    cam.setPosition?.(new Vec3(view.eye[0], view.eye[1], view.eye[2]));
    cam.minZ = 0.25;
    cam.maxZ = 4000;
    scene.activeCamera = cam;
    // The skybox is what fills the background in normal play, so a magenta
    // clear colour only reveals a hole in the ground once the sky is out of
    // the way. Anything the ground fails to cover then reads as pure magenta.
    scene.clearColor = magenta
      ? new (scene.clearColor.constructor)(1, 0, 1, 1)
      : scene.__origClear.clone();
    for (const mesh of scene.__sky) mesh.setEnabled(!magenta);
    // LOD picking happens at render time from the camera we just moved. Read
    // the canvas back in the same synchronous block so the game's own rAF loop
    // cannot repaint (and move the camera back) before the pixels are grabbed.
    scene.render();
    scene.render();
    return {
      png: scene.getEngine().getRenderingCanvas().toDataURL("image/png"),
      at: [cam.globalPosition.x, cam.globalPosition.y, cam.globalPosition.z].map((v) => Math.round(v * 100) / 100),
    };
  }, { view, magenta });
  const file = path.join(OUT, `${TAG}_${view.name}${magenta ? "_magenta" : ""}.png`);
  writeFileSync(file, Buffer.from(dataUrl.png.split(",")[1], "base64"));
  return { file, at: dataUrl.at };
}

for (const view of VIEWS) {
  const plain = await shoot(view, false);
  const magenta = await shoot(view, true);
  // The eye point is printed so a before/after pair can be proven to be the
  // same camera rather than assumed to be.
  console.log(`  ${view.name} eye ${JSON.stringify(plain.at)} -> ${path.basename(plain.file)}, ${path.basename(magenta.file)}`);
}

await browser.close();
console.log(`done -> ${OUT}`);
