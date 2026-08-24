// Phase 6b — sit through one short duel to capture the end-of-match results
// overlay, then leave. No combat exploration: that is the match agent's job.
import { launch, close, shot, sleep, bootToLobby, parkPointer } from "./lib.mjs";

const { ctx, page, logs } = await launch({ headless: process.env.SA_HEADLESS === "1" });

const visible = (sel) =>
  page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return false;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return cs.display !== "none" && cs.visibility !== "hidden" && Number(cs.opacity) > 0.05 && r.width > 0 && r.height > 0;
  }, sel);

await bootToLobby(page);
await parkPointer(page);
await page.locator('.lobby-overlay [data-lobby-action="deathmatch"]').click();
await sleep(700);
await page.locator(".sa-menu-group:not([hidden]) .sa-menu-card").first().click();

// Wait for the match to actually be flying.
for (let i = 0; i < 40; i++) {
  await sleep(2000);
  if (await visible(".hud-flight")) break;
}
await sleep(2000);
await parkPointer(page);
await shot(page, "match-hud-in-flight");

// Do nothing and let the duel resolve; poll for the results overlay.
let shown = false;
for (let i = 0; i < 90; i++) {
  await sleep(2000);
  if (await visible(".hud-results")) {
    shown = true;
    break;
  }
  if (i % 10 === 0) {
    console.log(
      i,
      JSON.stringify(
        await page.evaluate(() => ({
          status: document.querySelector(".hud-match-status")?.textContent?.trim().slice(0, 80),
          kills: document.querySelector(".hud-kill-feed")?.textContent?.trim().slice(0, 80),
        })),
      ),
    );
  }
}
console.log("results overlay shown:", shown);
await sleep(1200);
await parkPointer(page);
await shot(page, shown ? "match-results-overlay" : "match-no-results-after-3min");

if (shown) {
  console.log(
    "results content:",
    await page.evaluate(() => document.querySelector(".hud-results")?.textContent?.trim().replace(/\s+/g, " ")),
  );
  console.log(
    "results buttons:",
    JSON.stringify(
      await page.evaluate(() =>
        [...document.querySelectorAll(".hud-results button")].map((b) => {
          const r = b.getBoundingClientRect();
          return { label: b.textContent.trim(), w: Math.round(r.width), h: Math.round(r.height) };
        }),
      ),
    ),
  );
  await sleep(2500);
  await shot(page, "match-results-overlay-settled");
  const quit = page.getByRole("button", { name: /Quit to Menu/i });
  if (await quit.count()) {
    await quit.first().click({ force: true });
    await sleep(4000);
    await parkPointer(page);
    await shot(page, "lobby-after-quit-to-menu");
  }
}

console.log("errors:");
console.log(logs.filter((l) => l.startsWith("[error]") || l.startsWith("[pageerror]")).slice(-6).join("\n"));
await close(ctx);
