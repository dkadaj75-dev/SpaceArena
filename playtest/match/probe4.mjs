// Is the slowness just boot? Wait for the main thread to go quiet, then click.
import { chromium } from "playwright";
import { DEVICE, LAUNCH_ARGS, BASE, sleep } from "./lib.mjs";

const HEADLESS = !process.env.HEADED;
const ARGS = process.env.NOSW ? ["--disable-dev-shm-usage"] : LAUNCH_ARGS;
const browser = await chromium.launch({ headless: HEADLESS, args: ARGS });
const ctx = await browser.newContext({ ...DEVICE });
const page = await ctx.newPage();

const t0 = Date.now();
await page.goto(`${BASE}/?login=1`, { waitUntil: "domcontentloaded" });
await page.locator(".sa-fullscreen-prompt").waitFor({ state: "visible", timeout: 60000 });
console.log("prompt at", Date.now() - t0, "ms");

// Settle detector: N consecutive 1s windows with >= minFps rAF callbacks.
async function settle(page, { minFps = 25, windows = 3, maxMs = 90000 } = {}) {
  const start = Date.now();
  let good = 0;
  while (Date.now() - start < maxMs) {
    const fps = await page.evaluate(
      () =>
        new Promise((res) => {
          const t = performance.now();
          let f = 0;
          const tick = () => {
            f++;
            if (performance.now() - t > 1000) return res(f / ((performance.now() - t) / 1000));
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }),
    );
    good = fps >= minFps ? good + 1 : 0;
    console.log(`   settle fps=${fps.toFixed(1)} streak=${good}`);
    if (good >= windows) return { ok: true, ms: Date.now() - start, fps };
  }
  return { ok: false, ms: Date.now() - start };
}

console.log("settle:", await settle(page));

for (const [label, sel] of [["skip", ".sa-fullscreen-prompt-skip"]]) {
  const t = Date.now();
  await page.locator(sel).click({ timeout: 30000 }).catch((e) => console.log("  err", e.message.split("\n")[0]));
  console.log(`${label} click ${Date.now() - t}ms`);
}
await sleep(1000);
console.log("auth visible:", await page.locator(".auth-overlay").isVisible());
console.log("settle2:", await settle(page));
const t2 = Date.now();
await page.locator(".auth-overlay").getByText("Log in / Register", { exact: true }).click({ timeout: 30000 });
console.log("toggle click", Date.now() - t2, "ms");
await sleep(500);
console.log(
  "tabs:",
  await page.locator(".auth-overlay .sa-screen-tab").allTextContents(),
);
await browser.close();
