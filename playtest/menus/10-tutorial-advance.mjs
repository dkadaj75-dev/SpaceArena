// Phase 5c — advance the tutorial by driving the HUD the way a thumb would.
import { launch, close, shot, sleep, bootToLobby, parkPointer } from "./lib.mjs";

const { ctx, page, logs } = await launch({ headless: process.env.SA_HEADLESS === "1" });
const view = () =>
  page.evaluate(() => ({
    counter: document.querySelector(".sa-tutorial-counter")?.textContent,
    title: document.querySelector(".sa-tutorial-title")?.textContent,
    hint: document.querySelector(".sa-tutorial-hint")?.textContent,
  }));

await bootToLobby(page);
await page.locator('.lobby-overlay [data-lobby-action="tutorial"]').click();
await page.locator("[data-tutorial]").waitFor({ state: "visible", timeout: 120000 });
await sleep(2500);

console.log(
  "throttle geometry:",
  JSON.stringify(
    await page.evaluate(() => {
      const t = document.querySelector(".hud-throttle");
      const track = document.querySelector(".hud-throttle-track");
      const g = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return [r.x, r.y, r.width, r.height].map(Math.round);
      };
      return { throttle: g(t), track: g(track), readout: document.querySelector(".hud-throttle-readout")?.textContent };
    }),
  ),
);

// Drag the throttle track from its bottom to its top, as a finger would.
const box = await page.locator(".hud-throttle-track").boundingBox();
if (box) {
  const x = box.x + box.width / 2;
  await page.mouse.move(x, box.y + box.height - 6);
  await page.mouse.down();
  for (let i = 0; i <= 10; i++) {
    await page.mouse.move(x, box.y + box.height - 6 - (box.height - 12) * (i / 10));
    await sleep(70);
  }
  await page.mouse.up();
}
await sleep(2500);
await parkPointer(page);
console.log("after throttle drag:", JSON.stringify(await view()));
await shot(page, "tutorial-after-throttle");

// STEERING — one finger drag across the view
await page.mouse.move(300, 300);
await page.mouse.down();
for (let i = 0; i < 20; i++) {
  await page.mouse.move(300 + i * 22, 300 - i * 3);
  await sleep(50);
}
await page.mouse.up();
await sleep(2500);
await parkPointer(page);
console.log("after steer:", JSON.stringify(await view()));
await shot(page, "tutorial-after-steer");

// GUNS — tap the first weapon button repeatedly
const gun = page.locator(".hud-modules button").first();
if (await gun.count()) {
  for (let i = 0; i < 10; i++) {
    await gun.click({ force: true });
    await sleep(400);
  }
}
await sleep(2000);
await parkPointer(page);
console.log("after guns:", JSON.stringify(await view()));
await shot(page, "tutorial-after-guns");

// ENERGY — the shield button
const shield = page.locator(".hud-modules button").nth(1);
if (await shield.count()) await shield.click({ force: true });
await sleep(2500);
await parkPointer(page);
console.log("after shield:", JSON.stringify(await view()));
await shot(page, "tutorial-after-shield");

await page.locator("[data-tutorial-skip]").click({ force: true });
await sleep(2500);
await parkPointer(page);
await shot(page, "tutorial-skipped-to-lobby");
console.log(logs.filter((l) => l.includes("Tutorial")).slice(-8).join("\n"));
await close(ctx);
