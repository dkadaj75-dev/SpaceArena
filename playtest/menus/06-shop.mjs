// Phase 4 — the Shop: all three tabs, a free purchase, and the affordability
// states.
import { launch, close, shot, sleep, bootToLobby, parkPointer } from "./lib.mjs";

const { ctx, page, logs } = await launch({ headless: process.env.SA_HEADLESS === "1" });

async function step(name, fn) {
  try {
    await fn();
  } catch (err) {
    console.log(`!! step "${name}" failed: ${String(err).split("\n")[0]}`);
  }
}

// Watch for failing API calls — a 401 showed up in an earlier phase.
page.on("response", (r) => {
  if (r.status() >= 400) console.log(`HTTP ${r.status()} ${r.request().method()} ${r.url()}`);
});

const snapshot = () =>
  page.evaluate(() => ({
    credits: document.querySelector(".shop-credits .v")?.textContent,
    notice: document.querySelector(".shop-notice")?.textContent || null,
    tab: document.querySelector(".shop-grid")?.dataset.tab,
    cards: [...document.querySelectorAll(".shop-card")].map((c) => ({
      id: c.dataset.entry,
      state: c.dataset.state,
      name: c.querySelector(".shop-card-name")?.textContent,
      price: c.querySelector(".shop-price")?.textContent,
      free: c.querySelector(".shop-price")?.dataset.free,
      btn: c.querySelector(".shop-buy")?.textContent,
      btnDisabled: c.querySelector(".shop-buy")?.disabled ?? null,
      badge: c.querySelector(".shop-badge")?.textContent ?? null,
    })),
    bodyScroll: (() => {
      const b = document.querySelector(".shop-body");
      return b ? { clientH: b.clientHeight, scrollH: b.scrollHeight } : null;
    })(),
  }));

await bootToLobby(page);
await parkPointer(page);
await page.locator('.lobby-overlay [data-lobby-action="shop"]').click();
await page.locator(".shop-overlay").waitFor({ state: "visible", timeout: 60000 });
await sleep(1500);
await parkPointer(page);
await shot(page, "shop-ships-tab");
const ships = await snapshot();
console.log("SHIPS:", JSON.stringify(ships, null, 1));

// tab touch targets
console.log(
  "shop tabs:",
  JSON.stringify(
    await page.evaluate(() =>
      [...document.querySelectorAll(".shop-tabs .sa-tab")].map((b) => {
        const r = b.getBoundingClientRect();
        return { tab: b.dataset.tab, label: b.textContent, w: Math.round(r.width), h: Math.round(r.height), sel: b.getAttribute("aria-selected") };
      }),
    ),
  ),
);

// scroll the ships grid to the bottom
await step("scroll ships", async () => {
  await page.locator(".shop-body").evaluate((el) => (el.scrollTop = el.scrollHeight));
  await sleep(500);
  await shot(page, "shop-ships-scrolled");
});

// --- buy something free on the ships tab ---
await step("free purchase", async () => {
  await page.locator(".shop-body").evaluate((el) => (el.scrollTop = 0));
  await sleep(300);
  const freeCard = page.locator('.shop-card:has(.shop-price[data-free="true"]) .shop-buy').first();
  if (!(await freeCard.count())) {
    console.log("no free buyable ship");
    return;
  }
  await freeCard.scrollIntoViewIfNeeded();
  await sleep(300);
  await parkPointer(page);
  await shot(page, "shop-before-free-purchase");
  const before = await snapshot();
  await freeCard.click();
  await sleep(2000);
  await parkPointer(page);
  await shot(page, "shop-after-free-purchase");
  const after = await snapshot();
  console.log("credits before/after:", before.credits, "->", after.credits, "notice:", after.notice);
});

// --- modules tab ---
await step("modules tab", async () => {
  await page.locator('.shop-tabs [data-tab="modules"]').click();
  await sleep(1200);
  await parkPointer(page);
  await shot(page, "shop-modules-tab");
  const s = await snapshot();
  console.log("MODULES:", JSON.stringify({ tab: s.tab, count: s.cards.length, scroll: s.bodyScroll, sample: s.cards.slice(0, 6) }));
  const unaffordable = s.cards.filter((c) => c.btnDisabled);
  console.log("unaffordable/disabled module cards:", JSON.stringify(unaffordable.slice(0, 5)));
  if (unaffordable.length) {
    const id = unaffordable[0].id;
    await page.locator(`.shop-card[data-entry="${id}"]`).scrollIntoViewIfNeeded();
    await sleep(400);
    await parkPointer(page);
    await shot(page, "shop-unaffordable-card");
  }
  await page.locator(".shop-body").evaluate((el) => (el.scrollTop = el.scrollHeight));
  await sleep(500);
  await shot(page, "shop-modules-scrolled-bottom");
});

// --- try to buy something too expensive ---
await step("unaffordable purchase attempt", async () => {
  const s = await snapshot();
  const pricey = s.cards.find((c) => c.state === "buy" && c.free === "false" && !c.btnDisabled);
  if (!pricey) {
    console.log("no priced, enabled card to test the refusal path");
    return;
  }
  console.log("attempting:", JSON.stringify(pricey));
  await page.locator(`.shop-card[data-entry="${pricey.id}"] .shop-buy`).scrollIntoViewIfNeeded();
  await sleep(300);
  await page.locator(`.shop-card[data-entry="${pricey.id}"] .shop-buy`).click();
  await sleep(1800);
  await parkPointer(page);
  await shot(page, "shop-after-priced-purchase-attempt");
  console.log("notice:", (await snapshot()).notice, "credits:", (await snapshot()).credits);
});

// --- paints tab ---
await step("paints tab", async () => {
  await page.locator('.shop-tabs [data-tab="paints"]').click();
  await sleep(1200);
  await parkPointer(page);
  await shot(page, "shop-paints-tab");
  const s = await snapshot();
  console.log("PAINTS:", JSON.stringify({ count: s.cards.length, scroll: s.bodyScroll, sample: s.cards.slice(0, 6) }));
  const equip = page.locator(".shop-equip-btn").first();
  if (await equip.count()) {
    await equip.scrollIntoViewIfNeeded();
    await sleep(300);
    await shot(page, "shop-paint-equip-row");
    await equip.click();
    await sleep(1200);
    await parkPointer(page);
    await shot(page, "shop-paint-equipped");
  }
  await page.locator(".shop-body").evaluate((el) => (el.scrollTop = el.scrollHeight));
  await sleep(500);
  await shot(page, "shop-paints-scrolled-bottom");
});

await step("close shop", async () => {
  await page.locator(".shop-close").click();
  await page.locator(".lobby-overlay").waitFor({ state: "visible", timeout: 30000 });
  await sleep(1200);
  await parkPointer(page);
  await shot(page, "lobby-after-shop");
});

console.log("--- console tail ---");
console.log(logs.filter((l) => !l.includes("instanced mesh")).slice(-10).join("\n"));
await close(ctx);
