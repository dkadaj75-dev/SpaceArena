// Phase 3c — the module card sheet in detail (hover preview, selection delta,
// CLEAR SLOT), driven with raw mouse moves because Playwright's actionability
// hover times out on these cards.
import { launch, close, shot, sleep, bootToLobby, parkPointer } from "./lib.mjs";

const { ctx, page, logs } = await launch({ headless: process.env.SA_HEADLESS === "1" });

async function step(name, fn) {
  try {
    await fn();
  } catch (err) {
    console.log(`!! step "${name}" failed: ${String(err).split("\n")[0]}`);
  }
}

const specs = () =>
  page.evaluate(() => ({
    compare: document.querySelector(".hangar-compare")?.textContent?.trim() ?? null,
    power: document.querySelector(".hangar-power-text")?.textContent ?? null,
  }));

await bootToLobby(page);
await page.locator('.lobby-overlay [data-lobby-action="hangar"]').click();
await page.locator(".hangar-panel").waitFor({ state: "visible", timeout: 60000 });
await sleep(3500);
await parkPointer(page);
await shot(page, "hangar-open-main-hull");

// Which hull does the hangar open on?
console.log("opens on:", await page.evaluate(() => document.querySelector(".hangar-ship-name")?.textContent));

await step("open sheet", async () => {
  await page.locator(".hangar-slot").first().click();
  await page.locator(".hangar-sheet").waitFor({ state: "visible", timeout: 20000 });
  await sleep(1000);
});

// Why does hover time out? Report what actually sits over a card's centre.
console.log(
  "card hit-test:",
  JSON.stringify(
    await page.evaluate(() => {
      const cards = [...document.querySelectorAll(".hangar-sheet [data-module]")];
      return cards.slice(0, 4).map((c) => {
        const r = c.getBoundingClientRect();
        const cx = r.x + r.width / 2;
        const cy = r.y + r.height / 2;
        const top = document.elementFromPoint(cx, cy);
        return {
          id: c.dataset.module,
          rect: [r.x, r.y, r.width, r.height].map(Math.round),
          belowViewport: r.bottom > window.innerHeight,
          top: top ? `${top.tagName}.${String(top.className).slice(0, 40)}` : null,
          contains: top ? c.contains(top) : null,
        };
      });
    }),
  ),
);
console.log(
  "deck scroll:",
  JSON.stringify(
    await page.evaluate(() => {
      const b = document.querySelector(".hangar-deck-body");
      return b ? { clientW: b.clientWidth, scrollW: b.scrollWidth, clientH: b.clientHeight, scrollH: b.scrollHeight } : null;
    }),
  ),
);

// --- hover preview by raw mouse move ---
await step("hover preview", async () => {
  const box = await page.locator(".hangar-sheet [data-module]").nth(3).boundingBox();
  console.log("before hover:", JSON.stringify(await specs()));
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await sleep(900);
  await shot(page, "hangar-card-hover-before-after");
  console.log("during hover:", JSON.stringify(await specs()));
});

// --- select the hovered card ---
await step("select card", async () => {
  const card = page.locator(".hangar-sheet [data-module]").nth(3);
  const name = await card.locator(".hangar-card-name").textContent();
  await card.click({ force: true });
  await sleep(1500);
  await parkPointer(page);
  await shot(page, "hangar-card-selected-state");
  console.log("selected", name, JSON.stringify(await specs()));
  console.log(
    "selected card class:",
    await page.evaluate(() => document.querySelector(".hangar-sheet [data-module]:nth-child(4)")?.className ?? null),
  );
});

// --- an unavailable card ---
await step("unavailable card", async () => {
  const un = page.locator(".hangar-sheet .hangar-card.unavailable").first();
  if (!(await un.count())) return;
  const box = await un.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await sleep(700);
  await shot(page, "hangar-card-unavailable-hover");
  console.log("unavailable title:", await un.getAttribute("title"));
});

// --- CLEAR SLOT ---
await step("clear slot", async () => {
  await shot(page, "hangar-before-clear-slot");
  await page.locator(".hangar-sheet-clear").click({ force: true });
  await sleep(1400);
  await parkPointer(page);
  await shot(page, "hangar-after-clear-slot");
  console.log("after clear:", JSON.stringify(await specs()));
});

// --- refit and close ---
await step("refit + done", async () => {
  await page.locator(".hangar-sheet [data-module]").nth(0).click({ force: true });
  await sleep(1300);
  await parkPointer(page);
  await shot(page, "hangar-refit-then-done");
  await page.locator(".hangar-sheet-done").click({ force: true });
  await sleep(1000);
});

// --- a core/internal slot ---
await step("core slot sheet", async () => {
  const kinds = await page.evaluate(() => [...document.querySelectorAll(".hangar-slot")].map((s) => s.dataset.kind));
  console.log("slot kinds:", JSON.stringify(kinds));
  const idx = kinds.findIndex((k) => k !== kinds[0]);
  if (idx < 0) return;
  await page.locator(".hangar-slot").nth(idx).click();
  await page.locator(".hangar-sheet").waitFor({ state: "visible", timeout: 20000 });
  await sleep(1000);
  await parkPointer(page);
  await shot(page, `hangar-sheet-${kinds[idx]}-slot`);
  await page.locator(".hangar-sheet-done").click({ force: true });
  await sleep(800);
});

// --- last core slot (right-most tile) to check the row overflow ---
await step("last slot sheet", async () => {
  const n = await page.locator(".hangar-slot").count();
  console.log(
    "last slot box:",
    JSON.stringify(
      await page.evaluate(() => {
        const s = [...document.querySelectorAll(".hangar-slot")].at(-1);
        const r = s.getBoundingClientRect();
        return { rect: [r.x, r.y, r.width, r.height].map(Math.round), viewportW: window.innerWidth, clippedRight: r.right > window.innerWidth };
      }),
    ),
  );
  await page.locator(".hangar-slot").nth(n - 1).click({ force: true });
  await page.locator(".hangar-sheet").waitFor({ state: "visible", timeout: 20000 });
  await sleep(900);
  await parkPointer(page);
  await shot(page, "hangar-sheet-last-slot");
  await page.locator(".hangar-sheet-done").click({ force: true });
  await sleep(700);
});

await step("close", async () => {
  await page.locator(".hangar-close").click();
  await page.locator(".lobby-overlay").waitFor({ state: "visible", timeout: 30000 });
  await sleep(1200);
});

console.log("--- console tail ---");
console.log(logs.filter((l) => !l.includes("instanced mesh")).slice(-8).join("\n"));
await close(ctx);
