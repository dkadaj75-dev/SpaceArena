// Phase 8 — loose ends: which hull the hangar opens on vs which is MAIN, the
// DPS delta arithmetic, and the settings sheet opened from inside a match.
import { launch, close, shot, sleep, bootToLobby, parkPointer } from "./lib.mjs";

const { ctx, page, logs } = await launch({ headless: process.env.SA_HEADLESS === "1" });

async function step(name, fn) {
  try {
    await fn();
  } catch (err) {
    console.log(`!! ${name}: ${String(err).split("\n")[0]}`);
  }
}

await bootToLobby(page);

// --- which hull is MAIN, and which one does the hangar show first? ---
await step("hangar landing hull", async () => {
  await page.locator('.lobby-overlay [data-lobby-action="hangar"]').click();
  await page.locator(".hangar-panel").waitFor({ state: "visible", timeout: 60000 });
  await sleep(3500);
  await parkPointer(page);
  const tour = [];
  for (let i = 0; i < 4; i++) {
    tour.push(
      await page.evaluate(() => ({
        name: document.querySelector(".hangar-ship-name")?.textContent,
        action: [...document.querySelectorAll(".hangar-stage-action button")].map((b) => b.textContent.trim()),
        badge: document.querySelector(".hangar-stage-badge")?.textContent ?? null,
      })),
    );
    if (i < 3) {
      await page.locator(".hangar-stage-arrow.next").click();
      await sleep(2400);
    }
  }
  console.log("hull tour:", JSON.stringify(tour));
});

// --- DPS arithmetic on a weapon slot ---
await step("dps delta", async () => {
  // back to the first hull
  for (let i = 0; i < 4; i++) {
    const n = await page.evaluate(() => document.querySelector(".hangar-ship-name")?.textContent);
    if (n === "INTERCEPTOR") break;
    await page.locator(".hangar-stage-arrow.next").click();
    await sleep(2200);
  }
  const read = () =>
    page.evaluate(() => ({
      compare: document.querySelector(".hangar-compare")?.textContent?.trim().replace(/\s+/g, " "),
      slots: [...document.querySelectorAll(".hangar-slot")].map((s) => `${s.dataset.socket}=${s.dataset.module || "-"}`),
    }));
  console.log("before:", JSON.stringify(await read()));
  await page.locator(".hangar-slot").first().click();
  await page.locator(".hangar-sheet").waitFor({ state: "visible", timeout: 20000 });
  await sleep(900);
  // fit the highest-DPS card first so the removal is unambiguous
  const best = await page.evaluate(() => {
    const cards = [...document.querySelectorAll(".hangar-sheet [data-module]:not(.unavailable)")];
    let bestIdx = 0;
    let bestDps = -1;
    cards.forEach((c, i) => {
      const m = /DPS\+(\d+(?:\.\d+)?)/.exec(c.textContent ?? "");
      const d = m ? Number(m[1]) : -1;
      if (d > bestDps) {
        bestDps = d;
        bestIdx = i;
      }
    });
    return { bestIdx, bestDps, name: cards[bestIdx]?.querySelector(".hangar-card-name")?.textContent };
  });
  console.log("best card:", JSON.stringify(best));
  await page.locator(".hangar-sheet [data-module]:not(.unavailable)").nth(best.bestIdx).click({ force: true });
  await sleep(1500);
  await parkPointer(page);
  await shot(page, "hangar-dps-fitted-best-weapon");
  console.log("after fit:", JSON.stringify(await read()));
  await page.locator(".hangar-sheet-clear").click({ force: true });
  await sleep(1500);
  await parkPointer(page);
  await shot(page, "hangar-dps-after-clearing-weapon");
  console.log("after clear:", JSON.stringify(await read()));
  // put it back so the loadout is not left stripped
  await page.locator(".hangar-sheet [data-module]:not(.unavailable)").nth(best.bestIdx).click({ force: true });
  await sleep(1200);
  await page.locator(".hangar-sheet-done").click({ force: true });
  await sleep(900);
  await page.locator(".hangar-close").click();
  await page.locator(".lobby-overlay").waitFor({ state: "visible", timeout: 30000 });
  await sleep(1200);
});

// --- the settings sheet opened from inside a match ---
await step("in-match settings", async () => {
  await page.locator('.lobby-overlay [data-lobby-action="tutorial"]').click();
  await page.locator("[data-tutorial]").waitFor({ state: "visible", timeout: 180000 });
  await sleep(4000);
  await parkPointer(page);
  await page.locator(".hud-settings-btn").click({ force: true });
  await page.locator(".settings-overlay").waitFor({ state: "visible", timeout: 30000 });
  await sleep(1200);
  await parkPointer(page);
  await shot(page, "settings-opened-from-match");
  console.log(
    "match settings buttons:",
    JSON.stringify(
      await page.evaluate(() =>
        [...document.querySelectorAll(".settings-overlay .sa-screen-btn")].map((b) => b.textContent.trim()),
      ),
    ),
  );
  await page.locator("[data-settings-quit]").scrollIntoViewIfNeeded();
  await sleep(400);
  await shot(page, "settings-match-quit-button");
  await page.locator("[data-settings-close]").click({ force: true });
  await sleep(1200);
  await parkPointer(page);
  await shot(page, "match-after-closing-settings");
  await page.locator("[data-tutorial-skip]").click({ force: true });
  await sleep(3000);
  await parkPointer(page);
  await shot(page, "lobby-final-state");
});

console.log("errors:");
console.log(logs.filter((l) => l.startsWith("[error]") || l.startsWith("[pageerror]")).slice(-8).join("\n"));
await close(ctx);
