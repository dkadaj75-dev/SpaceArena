// Perf probe: how fast does the menu render, and does a real click land?
import { chromium } from "playwright";
import { DEVICE, LAUNCH_ARGS, BASE, sleep } from "./lib.mjs";

const HEADLESS = process.env.HEADED ? false : true;
const ARGS = process.env.NOSW ? ["--disable-dev-shm-usage", "--autoplay-policy=no-user-gesture-required"] : LAUNCH_ARGS;
console.log("headless:", HEADLESS, "args:", ARGS.join(" "));

const browser = await chromium.launch({ headless: HEADLESS, args: ARGS });
const ctx = await browser.newContext({ ...DEVICE });
const page = await ctx.newPage();
await page.goto(`${BASE}/?login=1`, { waitUntil: "domcontentloaded" });
await page.locator(".sa-fullscreen-prompt").waitFor({ state: "visible", timeout: 60000 });
await sleep(4000);

const perf = await page.evaluate(async () => {
  const t0 = performance.now();
  let frames = 0;
  await new Promise((res) => {
    const tick = () => {
      frames++;
      if (performance.now() - t0 > 2000) return res();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const eng = window.__debug?.engine;
  let renderer = null;
  try {
    const gl = eng?._gl;
    const ext = gl?.getExtension("WEBGL_debug_renderer_info");
    renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl?.getParameter(gl.RENDERER);
  } catch (e) {
    renderer = "err " + e.message;
  }
  return {
    fps: (frames / ((performance.now() - t0) / 1000)).toFixed(1),
    renderSize: eng ? `${eng.getRenderWidth()}x${eng.getRenderHeight()}` : null,
    hwScale: eng?.getHardwareScalingLevel?.() ?? null,
    renderer,
    dpr: window.devicePixelRatio,
  };
});
console.log("perf:", perf);

const t = Date.now();
try {
  await page.locator(".sa-fullscreen-prompt").getByText("Not now", { exact: true }).click({ timeout: 45000 });
  console.log("click OK in", Date.now() - t, "ms");
} catch (e) {
  console.log("click FAILED after", Date.now() - t, "ms:", e.message.split("\n")[0]);
}
const stillThere = await page.locator(".sa-fullscreen-prompt").isVisible().catch(() => "gone");
console.log("prompt visible after click:", stillThere);
await browser.close();
