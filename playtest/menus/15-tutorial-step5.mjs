// Phase 5e — one more coach card: ENERGY -> TARGET LOCK.
import { launch, close, shot, sleep, bootToLobby, parkPointer } from "./lib.mjs";

const { ctx, page, logs } = await launch({ headless: process.env.SA_HEADLESS === "1" });
const view = () =>
  page.evaluate(() => ({
    counter: document.querySelector(".sa-tutorial-counter")?.textContent,
    title: document.querySelector(".sa-tutorial-title")?.textContent,
    buttons: [...document.querySelectorAll(".hud-module-btn")].map((b) => {
      const r = b.getBoundingClientRect();
      return { t: b.querySelector(".slot-type")?.textContent, w: Math.round(r.width), h: Math.round(r.height) };
    }),
  }));

await bootToLobby(page);
await page.locator('.lobby-overlay [data-lobby-action="tutorial"]').click();
await page.locator("[data-tutorial]").waitFor({ state: "visible", timeout: 180000 });
for (let i = 0; i < 40; i++) {
  const t = await page.locator(".hud-throttle-track").boundingBox().catch(() => null);
  if (t && t.height > 20) break;
  await sleep(1000);
}
const box = await page.locator(".hud-throttle-track").boundingBox();
const x = box.x + box.width / 2;
await page.mouse.move(x, box.y + box.height - 4);
await page.mouse.down();
for (let i = 0; i <= 12; i++) {
  await page.mouse.move(x, box.y + box.height - 4 - (box.height - 8) * (i / 12));
  await sleep(70);
}
await page.mouse.up();
await sleep(2500);

for (let pass = 0; pass < 3; pass++) {
  await page.mouse.move(300, 260);
  await page.mouse.down();
  for (let i = 0; i < 18; i++) {
    await page.mouse.move(300 + i * 24, 260 + (pass % 2 ? -i * 2 : i * 2));
    await sleep(45);
  }
  await page.mouse.up();
  await sleep(700);
}
await sleep(2500);
await parkPointer(page);
console.log("now:", JSON.stringify(await view()));
await shot(page, "tutorial-coach-energy-step");

// ENERGY — tap the SHIELD hex
const btns = page.locator(".hud-module-btn");
const n = await btns.count();
console.log("module buttons:", n);
for (let i = 0; i < n; i++) {
  const t = await btns.nth(i).locator(".slot-type").textContent().catch(() => "");
  if (/shield/i.test(t ?? "")) {
    await btns.nth(i).click({ force: true });
    break;
  }
}
await sleep(3000);
await parkPointer(page);
console.log("after shield:", JSON.stringify(await view()));
await shot(page, "tutorial-coach-lock-step");

await sleep(3000);
await parkPointer(page);
await shot(page, "tutorial-coach-lock-step-settled");
console.log("final:", JSON.stringify(await view()));

await page.locator("[data-tutorial-skip]").click({ force: true });
await sleep(3000);
await parkPointer(page);
await shot(page, "tutorial-exit-final");
console.log(logs.filter((l) => l.includes("Tutorial")).slice(-8).join("\n"));
await close(ctx);
