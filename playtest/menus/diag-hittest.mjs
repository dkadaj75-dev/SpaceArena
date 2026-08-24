// Diagnostic: which element actually receives a tap on the controls whose
// clicks time out (shop equip row, hangar skin swatches, hull dots)?
import { launch, close, sleep, bootToLobby, shot } from "./lib.mjs";

const { ctx, page } = await launch({ headless: process.env.SA_HEADLESS === "1" });
const hit = (sel) =>
  page.evaluate((s) => {
    const out = [];
    for (const el of [...document.querySelectorAll(s)].slice(0, 3)) {
      const r = el.getBoundingClientRect();
      const cx = r.x + r.width / 2;
      const cy = r.y + r.height / 2;
      const top = document.elementFromPoint(cx, cy);
      const cs = getComputedStyle(el);
      out.push({
        sel: s,
        rect: [r.x, r.y, r.width, r.height].map(Math.round),
        pointerEvents: cs.pointerEvents,
        visibility: cs.visibility,
        opacity: cs.opacity,
        parentPE: el.parentElement ? getComputedStyle(el.parentElement).pointerEvents : null,
        top: top ? `${top.tagName}.${String(top.className).slice(0, 50)}` : null,
        selfOrChild: top ? el.contains(top) : null,
      });
    }
    return out;
  }, sel);

await bootToLobby(page);

await page.locator('.lobby-overlay [data-lobby-action="shop"]').click();
await page.locator(".shop-overlay").waitFor({ state: "visible" });
await sleep(1500);
await page.locator('.shop-tabs [data-tab="paints"]').click();
await sleep(1200);
await page.locator(".shop-equip-btn").first().scrollIntoViewIfNeeded();
await sleep(500);
console.log("shop equip:", JSON.stringify(await hit(".shop-equip-btn"), null, 1));
console.log("shop buy:", JSON.stringify(await hit(".shop-buy"), null, 1));
await shot(page, "diag-shop-paints-equip-row");
// tap it the way a finger would
await page.locator(".shop-equip-btn").first().dispatchEvent("click");
await sleep(1500);
await shot(page, "shop-paint-after-equip-tap");
console.log(
  "equip states:",
  await page.evaluate(() =>
    [...document.querySelectorAll(".shop-card")].slice(0, 4).map((c) => `${c.dataset.entry}:${c.dataset.state}`).join(" "),
  ),
);

await page.locator(".shop-close").click();
await page.locator(".lobby-overlay").waitFor({ state: "visible" });
await sleep(1000);

await page.locator('.lobby-overlay [data-lobby-action="hangar"]').click();
await page.locator(".hangar-panel").waitFor({ state: "visible" });
await sleep(3500);
console.log("hangar dots:", JSON.stringify(await hit(".hangar-ship-dot"), null, 1));
console.log("hangar skins:", JSON.stringify(await hit("[data-cosmetic]"), null, 1));
console.log("hangar slots:", JSON.stringify(await hit(".hangar-slot"), null, 1));
console.log(
  "stage layers:",
  JSON.stringify(
    await page.evaluate(() =>
      [".hangar-stage", ".hangar-stage-view", ".hangar-ship-readout", ".hangar-ship-dots", ".hangar-skinrow"].map((s) => {
        const el = document.querySelector(s);
        if (!el) return { s, missing: true };
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return { s, pe: cs.pointerEvents, z: cs.zIndex, pos: cs.position, rect: [r.x, r.y, r.width, r.height].map(Math.round) };
      }),
    ),
    null,
    1,
  ),
);
await close(ctx);
