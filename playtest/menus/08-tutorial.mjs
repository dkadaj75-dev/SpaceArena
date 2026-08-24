// Phase 5 — the tutorial: the match loading screen, the first coach steps, and
// the exit path.
import { launch, close, shot, sleep, bootToLobby, parkPointer } from "./lib.mjs";

const { ctx, page, logs } = await launch({ headless: process.env.SA_HEADLESS === "1" });

async function step(name, fn) {
  try {
    await fn();
  } catch (err) {
    console.log(`!! step "${name}" failed: ${String(err).split("\n")[0]}`);
  }
}

await bootToLobby(page);
await parkPointer(page);

await page.locator('.lobby-overlay [data-lobby-action="tutorial"]').click();
await sleep(1200);
await shot(page, "tutorial-loading-screen");
console.log(
  "loading screen:",
  await page.evaluate(() => {
    const el = document.querySelector(".sa-loading, .match-loading, [class*='loading']");
    return el ? `${el.className}: ${el.textContent?.trim().slice(0, 200)}` : null;
  }),
);

await page.locator("[data-tutorial]").waitFor({ state: "visible", timeout: 120000 });
await sleep(1500);

for (let i = 1; i <= 4; i++) {
  await step(`coach step ${i}`, async () => {
    await parkPointer(page);
    const view = await page.evaluate(() => ({
      stage: document.querySelector("[data-tutorial]")?.dataset.stage,
      badge: document.querySelector(".sa-tutorial-badge")?.textContent,
      counter: document.querySelector(".sa-tutorial-counter")?.textContent,
      title: document.querySelector(".sa-tutorial-title")?.textContent,
      text: document.querySelector(".sa-tutorial-text")?.textContent,
      hint: document.querySelector(".sa-tutorial-hint")?.textContent,
      confirm: document.querySelector("[data-tutorial-confirm]")?.textContent,
      confirmVisible: (() => {
        const b = document.querySelector("[data-tutorial-confirm]");
        if (!b) return false;
        const r = b.getBoundingClientRect();
        return r.width > 0 && getComputedStyle(b).display !== "none";
      })(),
      card: (() => {
        const c = document.querySelector(".sa-tutorial-card");
        if (!c) return null;
        const r = c.getBoundingClientRect();
        return [r.x, r.y, r.width, r.height].map(Math.round);
      })(),
    }));
    console.log(`step ${i}:`, JSON.stringify(view));
    await shot(page, `tutorial-coach-step-${i}`);
    const confirm = page.locator("[data-tutorial-confirm]");
    if (view.confirmVisible) {
      await confirm.click({ force: true });
      await sleep(2000);
    } else {
      // Some steps wait on an in-world action; give them a beat and move on.
      await sleep(3500);
    }
  });
}

await step("hud behind the coach", async () => {
  await parkPointer(page);
  await shot(page, "tutorial-hud-context");
  console.log(
    "hud widgets:",
    await page.evaluate(() =>
      [...document.querySelectorAll("#hud > *")].map((e) => e.className || e.tagName).slice(0, 20).join(" | "),
    ),
  );
});

await step("skip tutorial", async () => {
  await shot(page, "tutorial-before-skip");
  await page.locator("[data-tutorial-skip]").click({ force: true });
  await sleep(2500);
  await parkPointer(page);
  await shot(page, "tutorial-after-skip");
  console.log(
    "screens now:",
    await page.evaluate(() =>
      [".lobby-overlay", ".sa-tutorial", "#hud", ".sa-results", "[class*='results']"]
        .map((s) => {
          const el = document.querySelector(s);
          if (!el) return `${s}:absent`;
          const r = el.getBoundingClientRect();
          return `${s}:${getComputedStyle(el).display}/${Math.round(r.width)}x${Math.round(r.height)}`;
        })
        .join(" "),
    ),
  );
});

await step("back to lobby", async () => {
  await page.locator(".lobby-overlay").waitFor({ state: "visible", timeout: 60000 });
  await sleep(2000);
  await parkPointer(page);
  await shot(page, "lobby-after-tutorial-exit");
});

console.log("--- console tail ---");
console.log(logs.filter((l) => !l.includes("instanced mesh")).slice(-15).join("\n"));
await close(ctx);
