// Phase 5b — actually satisfy the first coach steps so the next cards appear.
import { launch, close, shot, sleep, bootToLobby, parkPointer } from "./lib.mjs";

const { ctx, page, logs } = await launch({ headless: process.env.SA_HEADLESS === "1" });

const view = () =>
  page.evaluate(() => ({
    counter: document.querySelector(".sa-tutorial-counter")?.textContent,
    title: document.querySelector(".sa-tutorial-title")?.textContent,
    text: document.querySelector(".sa-tutorial-text")?.textContent,
    hint: document.querySelector(".sa-tutorial-hint")?.textContent,
  }));

await bootToLobby(page);
await page.locator('.lobby-overlay [data-lobby-action="tutorial"]').click();
await page.locator("[data-tutorial]").waitFor({ state: "visible", timeout: 120000 });
await sleep(2000);
await parkPointer(page);
console.log("step:", JSON.stringify(await view()));
await shot(page, "tutorial-step-1-throttle");

// 1) THROTTLE — hold W
await page.keyboard.down("w");
await sleep(2600);
await page.keyboard.up("w");
await sleep(1500);
await parkPointer(page);
console.log("step:", JSON.stringify(await view()));
await shot(page, "tutorial-step-2-steering");

// 2) STEERING — drag across the view with the right button
await page.mouse.move(460, 220);
await page.mouse.down({ button: "right" });
for (let i = 0; i < 12; i++) {
  await page.mouse.move(460 + i * 26, 220 + i * 4);
  await sleep(60);
}
await page.mouse.up({ button: "right" });
await sleep(2000);
await parkPointer(page);
console.log("step:", JSON.stringify(await view()));
await shot(page, "tutorial-step-3-guns");

// 3) GUNS — space a few times
for (let i = 0; i < 8; i++) {
  await page.keyboard.press("Space");
  await sleep(450);
}
await sleep(1500);
await parkPointer(page);
console.log("step:", JSON.stringify(await view()));
await shot(page, "tutorial-step-4-energy");

// 4) ENERGY — toggle the shield module button in the HUD
try {
  const mod = page.locator(".hud-modules button").nth(1);
  if (await mod.count()) await mod.click({ force: true });
  await sleep(2000);
  await parkPointer(page);
  console.log("step:", JSON.stringify(await view()));
  await shot(page, "tutorial-step-5-lock");
} catch (err) {
  console.log("shield step:", String(err).split("\n")[0]);
}

// The exit
await page.locator("[data-tutorial-skip]").click({ force: true });
await sleep(2500);
await parkPointer(page);
await shot(page, "tutorial-exit-to-lobby");
console.log("--- console tail ---");
console.log(logs.filter((l) => l.includes("Tutorial") || l.includes("error")).slice(-10).join("\n"));
await close(ctx);
