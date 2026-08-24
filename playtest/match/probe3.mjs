// Which input method actually lands quickly?
import { chromium } from "playwright";
import { DEVICE, LAUNCH_ARGS, BASE, sleep } from "./lib.mjs";

const HEADLESS = !process.env.HEADED;
const ARGS = process.env.NOSW ? ["--disable-dev-shm-usage"] : LAUNCH_ARGS;
const browser = await chromium.launch({ headless: HEADLESS, args: ARGS });

async function fresh() {
  const ctx = await browser.newContext({ ...DEVICE });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/?login=1`, { waitUntil: "domcontentloaded" });
  await page.locator(".sa-fullscreen-prompt").waitFor({ state: "visible", timeout: 60000 });
  await sleep(3000);
  return { ctx, page };
}

async function time(label, fn) {
  const { ctx, page } = await fresh();
  const t = Date.now();
  let err = "";
  try {
    await fn(page);
  } catch (e) {
    err = e.message.split("\n")[0];
  }
  const dt = Date.now() - t;
  await sleep(500);
  const gone = !(await page.locator(".sa-fullscreen-prompt").isVisible().catch(() => false));
  console.log(`${label.padEnd(28)} ${String(dt).padStart(7)}ms  dismissed=${gone} ${err}`);
  await ctx.close();
}

const sel = ".sa-fullscreen-prompt-skip";

await time("locator.click force+noWait", (p) =>
  p.locator(sel).click({ force: true, noWaitAfter: true, timeout: 20000 }),
);
await time("touchscreen.tap", async (p) => {
  const b = await p.locator(sel).boundingBox();
  await p.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
});
await time("mouse.click", async (p) => {
  const b = await p.locator(sel).boundingBox();
  await p.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
});
await time("dispatch pointer+click", (p) =>
  p.evaluate((s) => {
    const el = document.querySelector(s);
    const r = el.getBoundingClientRect();
    const o = {
      bubbles: true,
      cancelable: true,
      composed: true,
      pointerId: 1,
      pointerType: "touch",
      isPrimary: true,
      clientX: r.x + r.width / 2,
      clientY: r.y + r.height / 2,
      button: 0,
      buttons: 1,
    };
    el.dispatchEvent(new PointerEvent("pointerdown", o));
    el.dispatchEvent(new PointerEvent("pointerup", { ...o, buttons: 0 }));
    el.dispatchEvent(new MouseEvent("click", { ...o, buttons: 0 }));
  }, sel),
);
await time("el.click()", (p) => p.evaluate((s) => document.querySelector(s).click(), sel));

await browser.close();
