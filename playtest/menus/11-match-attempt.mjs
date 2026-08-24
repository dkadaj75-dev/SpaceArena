// Phase 6 — start a match from the lobby to reach the results overlay, and to
// see whether the tutorial's start failure affects every match start.
import { launch, close, shot, sleep, bootToLobby, parkPointer } from "./lib.mjs";

const { ctx, page, logs } = await launch({ headless: process.env.SA_HEADLESS === "1" });

await bootToLobby(page);
await parkPointer(page);
await page.locator('.lobby-overlay [data-lobby-action="deathmatch"]').click();
await sleep(800);
await shot(page, "lobby-deathmatch-drawer-before-launch");
await page.locator('.sa-menu-group:not([hidden]) .sa-menu-card').first().click();
await sleep(1200);
await shot(page, "match-loading-screen");

for (let i = 0; i < 25; i++) {
  await sleep(2000);
  const s = await page.evaluate(() => ({
    loading: document.querySelector(".sa-match-loading")?.textContent?.trim().slice(0, 140) ?? null,
    hudFlight: !!document.querySelector(".hud-flight"),
    countdown: document.querySelector(".hud-countdown")?.textContent?.trim().slice(0, 60) ?? null,
    waiting: document.querySelector(".hud-lobby-waiting")?.textContent?.trim().slice(0, 80) ?? null,
    results: document.querySelector(".hud-results")?.textContent?.trim().slice(0, 120) ?? null,
    lobby: !!document.querySelector(".lobby-overlay") && getComputedStyle(document.querySelector(".lobby-overlay")).display !== "none",
    status: document.querySelector(".sa-screen-status")?.textContent ?? null,
  }));
  console.log(i, JSON.stringify(s));
  if (i === 3) await shot(page, "match-loading-mid");
  if (s.results) break;
}
await parkPointer(page);
await shot(page, "match-state-after-wait");

// Leave whatever we ended up in.
const cancel = page.getByRole("button", { name: /Cancel/i });
if (await cancel.count()) {
  await cancel.first().click({ force: true });
  await sleep(2500);
  await parkPointer(page);
  await shot(page, "match-after-cancel");
}
console.log("errors:");
console.log(logs.filter((l) => l.startsWith("[error]") || l.startsWith("[pageerror]")).slice(-8).join("\n"));
await close(ctx);
