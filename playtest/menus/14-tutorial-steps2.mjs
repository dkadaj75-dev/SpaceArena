// Phase 5d — wait out the countdown, then drive the real throttle strip so the
// coach actually advances. Captures coach steps 2-4.
import { launch, close, shot, sleep, bootToLobby, parkPointer } from "./lib.mjs";

const { ctx, page, logs } = await launch({ headless: process.env.SA_HEADLESS === "1" });
const view = () =>
  page.evaluate(() => ({
    counter: document.querySelector(".sa-tutorial-counter")?.textContent,
    title: document.querySelector(".sa-tutorial-title")?.textContent,
    hint: document.querySelector(".sa-tutorial-hint")?.textContent,
    throttle: (() => {
      const t = document.querySelector(".hud-throttle-track");
      if (!t) return null;
      const r = t.getBoundingClientRect();
      return [r.x, r.y, r.width, r.height].map(Math.round);
    })(),
    readout: document.querySelector(".hud-throttle-readout")?.textContent,
  }));

await bootToLobby(page);
await page.locator('.lobby-overlay [data-lobby-action="tutorial"]').click();
await page.locator("[data-tutorial]").waitFor({ state: "visible", timeout: 180000 });

// Wait until the throttle strip is actually laid out (it appears once the
// countdown clears).
for (let i = 0; i < 40; i++) {
  const v = await view();
  if (v.throttle && v.throttle[3] > 20) break;
  await sleep(1000);
}
console.log("ready:", JSON.stringify(await view()));
await parkPointer(page);
await shot(page, "tutorial-step1-throttle-live");

// Drag the throttle to full.
const box = await page.locator(".hud-throttle-track").boundingBox();
const x = box.x + box.width / 2;
await page.mouse.move(x, box.y + box.height - 4);
await page.mouse.down();
for (let i = 0; i <= 12; i++) {
  await page.mouse.move(x, box.y + box.height - 4 - (box.height - 8) * (i / 12));
  await sleep(80);
}
await sleep(600);
await page.mouse.up();
await sleep(2500);
await parkPointer(page);
console.log("after throttle:", JSON.stringify(await view()));
await shot(page, "tutorial-step2-after-throttle");

// STEERING — one finger drag across the view
for (let pass = 0; pass < 3; pass++) {
  await page.mouse.move(300, 260);
  await page.mouse.down();
  for (let i = 0; i < 18; i++) {
    await page.mouse.move(300 + i * 24, 260 + (pass % 2 ? -i * 2 : i * 2));
    await sleep(45);
  }
  await page.mouse.up();
  await sleep(800);
}
await sleep(2000);
await parkPointer(page);
console.log("after steer:", JSON.stringify(await view()));
await shot(page, "tutorial-step3-after-steer");

// GUNS — tap the laser button
const gun = page.locator(".hud-modules button").last();
for (let i = 0; i < 12; i++) {
  await gun.click({ force: true });
  await sleep(500);
}
await sleep(2000);
await parkPointer(page);
console.log("after guns:", JSON.stringify(await view()));
await shot(page, "tutorial-step4-after-guns");

// ENERGY — the shield button
const shield = page.locator(".hud-modules button").first();
await shield.click({ force: true });
await sleep(2500);
await parkPointer(page);
console.log("after shield:", JSON.stringify(await view()));
await shot(page, "tutorial-step5-after-shield");

await page.locator("[data-tutorial-skip]").click({ force: true });
await sleep(3000);
await parkPointer(page);
await shot(page, "tutorial-exit-confirmed");
console.log(logs.filter((l) => l.includes("Tutorial")).slice(-10).join("\n"));
await close(ctx);
