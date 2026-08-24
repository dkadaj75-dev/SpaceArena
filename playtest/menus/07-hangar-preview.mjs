// Phase 3d — the BEFORE/AFTER compare readout raised the way a finger raises
// it: press-and-hold on a module card (260 ms), plus tap-to-pin.
import { launch, close, shot, sleep, bootToLobby, parkPointer } from "./lib.mjs";

const { ctx, page } = await launch({ headless: process.env.SA_HEADLESS === "1" });
const compare = () =>
  page.evaluate(() => document.querySelector(".hangar-compare")?.textContent?.trim().replace(/\s+/g, " ") ?? null);

await bootToLobby(page);
await page.locator('.lobby-overlay [data-lobby-action="hangar"]').click();
await page.locator(".hangar-panel").waitFor({ state: "visible", timeout: 60000 });
await sleep(3500);
await page.locator(".hangar-slot").first().click();
await page.locator(".hangar-sheet").waitFor({ state: "visible" });
await sleep(1000);
await parkPointer(page);
await shot(page, "hangar-sheet-idle-specs");
console.log("idle:", await compare());

// press and hold an unfitted card
const card = page.locator(".hangar-sheet [data-module]:not(.unavailable)").nth(2);
const box = await card.boundingBox();
const cx = box.x + box.width / 2;
const cy = box.y + box.height / 2;
await page.mouse.move(cx, cy);
await page.mouse.down();
await sleep(900);
await shot(page, "hangar-press-hold-before-after-delta");
console.log("holding:", await compare());
await page.mouse.up();
await sleep(600);
await shot(page, "hangar-after-hold-release");
console.log("released:", await compare());

// tap to pin the preview on another card
const other = page.locator(".hangar-sheet [data-module]:not(.unavailable)").nth(3);
await other.click({ force: true });
await sleep(900);
await parkPointer(page);
await shot(page, "hangar-preview-pinned-after-tap");
console.log("pinned:", await compare());

await page.locator(".hangar-sheet-done").click({ force: true });
await sleep(800);
await parkPointer(page);
await shot(page, "hangar-sheet-closed-after-preview");
console.log("closed:", await compare());
await close(ctx);
