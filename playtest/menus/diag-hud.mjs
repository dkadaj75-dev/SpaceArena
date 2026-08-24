// Diagnostic: is the flight HUD actually laid out during the tutorial?
import { launch, close, sleep, bootToLobby, shot } from "./lib.mjs";

const { ctx, page, logs } = await launch({ headless: process.env.SA_HEADLESS === "1" });
await bootToLobby(page);
await page.locator('.lobby-overlay [data-lobby-action="tutorial"]').click();
for (let i = 0; i < 30; i++) {
  await sleep(2000);
  const state = await page.evaluate(() => ({
    tutorial: !!document.querySelector("[data-tutorial]"),
    loading: document.querySelector(".sa-match-loading")?.textContent?.trim().slice(0, 120) ?? null,
    status: document.querySelector(".sa-screen-status")?.textContent ?? null,
  }));
  console.log(i, JSON.stringify(state));
  if (state.tutorial) break;
}
await shot(page, "diag-tutorial-entry");

for (const wait of [2000, 6000, 6000]) {
  await sleep(wait);
  const dump = await page.evaluate(() => {
    const rows = [];
    const walk = (el, depth) => {
      if (depth > 2) return;
      for (const c of el.children) {
        const r = c.getBoundingClientRect();
        const cs = getComputedStyle(c);
        rows.push({
          cls: (c.className || c.tagName).toString().slice(0, 40),
          rect: [r.x, r.y, r.width, r.height].map(Math.round),
          disp: cs.display,
          vis: cs.visibility,
          op: cs.opacity,
        });
        walk(c, depth + 1);
      }
    };
    const hud = document.getElementById("hud");
    if (hud) walk(hud, 0);
    return rows.filter((r) => /throttle|flight|module|joystick|boost|countdown|lobby-waiting/i.test(r.cls));
  });
  console.log(JSON.stringify(dump, null, 1));
  console.log("---");
}
await shot(page, "diag-tutorial-hud");
console.log(logs.filter((l) => /Countdown|Hud|flight|error/i.test(l)).slice(-12).join("\n"));
await close(ctx);
