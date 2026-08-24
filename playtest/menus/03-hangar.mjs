// Phase 3 — the Hangar: every hull, the slot grid, the module sheet, skins,
// upgrades, and the buy / set-as-main control.
import { launch, close, shot, sleep, bootToLobby, parkPointer } from "./lib.mjs";

const { ctx, page, logs } = await launch({ headless: process.env.SA_HEADLESS === "1" });

async function step(name, fn) {
  try {
    await fn();
  } catch (err) {
    console.log(`!! step "${name}" failed: ${String(err).split("\n")[0]}`);
  }
}

const outline = () =>
  page.evaluate(() => {
    const panel = document.querySelector(".hangar-panel");
    if (!panel) return null;
    const txt = (s) => document.querySelector(s)?.textContent?.trim() ?? null;
    return {
      shipName: txt(".hangar-ship-name"),
      shipClass: txt(".hangar-ship-class"),
      badge: txt(".hangar-stage-badge"),
      stageAction: [...document.querySelectorAll(".hangar-stage-action button")].map((b) =>
        b.textContent.trim(),
      ),
      dots: document.querySelectorAll(".hangar-ship-dot").length,
      activeDot: [...document.querySelectorAll(".hangar-ship-dot")].findIndex((d) =>
        d.classList.contains("active"),
      ),
      slots: [...document.querySelectorAll(".hangar-slot")].map((s) => ({
        socket: s.dataset.socket,
        kind: s.dataset.kind,
        module: s.dataset.module || null,
        label: s.querySelector(".hangar-slot-label")?.textContent,
        disabled: s.disabled,
        box: [Math.round(s.getBoundingClientRect().width), Math.round(s.getBoundingClientRect().height)],
      })),
      skins: [...document.querySelectorAll("[data-cosmetic]")].map((b) => ({
        id: b.dataset.cosmetic,
        label: b.textContent.trim(),
        w: Math.round(b.getBoundingClientRect().width),
        h: Math.round(b.getBoundingClientRect().height),
      })),
      upgrades: [...document.querySelectorAll(".hangar-upgrade-row")].map((r) => r.textContent.trim()),
      power: txt(".hangar-power-text"),
      hint: txt(".hangar-hint"),
      error: txt(".hangar-error"),
      panelScroll: (() => {
        const p = document.querySelector(".hangar-panel");
        return p ? { clientH: p.clientHeight, scrollH: p.scrollHeight } : null;
      })(),
    };
  });

await bootToLobby(page);
await parkPointer(page);

await page.locator('.lobby-overlay [data-lobby-action="hangar"]').click();
await page.locator(".hangar-panel").waitFor({ state: "visible", timeout: 60000 });
await sleep(3500);
await parkPointer(page);
await shot(page, "hangar-open-default-hull");
console.log("hangar outline:", JSON.stringify(await outline(), null, 1));

// --- walk every hull with the next arrow ---
const dots = await page.locator(".hangar-ship-dot").count();
console.log("hull count:", dots);
for (let i = 1; i < dots; i++) {
  await step(`hull ${i}`, async () => {
    await page.locator(".hangar-stage-arrow.next").click();
    await sleep(2600);
    await parkPointer(page);
    const o = await outline();
    const slug = (o?.shipName ?? `hull${i}`).toLowerCase().replace(/[^a-z0-9]+/g, "-");
    await shot(page, `hangar-hull-${i}-${slug}`);
    console.log(`hull ${i}:`, JSON.stringify({ name: o?.shipName, cls: o?.shipClass, badge: o?.badge, action: o?.stageAction, skins: o?.skins?.length }));
  });
}

// --- the prev arrow and a direct dot tap ---
await step("prev arrow", async () => {
  await page.locator(".hangar-stage-arrow.prev").click();
  await sleep(2400);
  await parkPointer(page);
  await shot(page, "hangar-prev-arrow");
});
await step("dot jump", async () => {
  await page.locator(".hangar-ship-dot").first().click();
  await sleep(2600);
  await parkPointer(page);
  await shot(page, "hangar-dot-jump-first-hull");
  console.log("after dot jump:", JSON.stringify(await outline()));
});

// --- the module sheet on the first fittable slot ---
await step("module sheet", async () => {
  const slot = page.locator(".hangar-slot:not([disabled])").first();
  await slot.scrollIntoViewIfNeeded();
  await sleep(300);
  await shot(page, "hangar-slots-before-sheet");
  await slot.click();
  await page.locator(".hangar-sheet").waitFor({ state: "visible", timeout: 20000 });
  await sleep(900);
  await parkPointer(page);
  await shot(page, "hangar-module-sheet-open");

  const cards = await page.evaluate(() =>
    [...document.querySelectorAll(".hangar-sheet [data-module]")].map((b) => ({
      id: b.dataset.module,
      name: b.querySelector(".hangar-card-name")?.textContent,
      disabled: b.disabled,
      cls: b.className,
      w: Math.round(b.getBoundingClientRect().width),
      h: Math.round(b.getBoundingClientRect().height),
    })),
  );
  console.log("sheet cards:", JSON.stringify(cards.slice(0, 12)), "total", cards.length);
  console.log(
    "sheet scroll:",
    JSON.stringify(
      await page.evaluate(() => {
        const b = document.querySelector(".hangar-deck-body") ?? document.querySelector(".hangar-sheet");
        return b ? { clientH: b.clientHeight, scrollH: b.scrollHeight, clientW: b.clientWidth, scrollW: b.scrollWidth } : null;
      }),
    ),
  );

  // hover a card -> the before/after compare readout
  const card = page.locator(".hangar-sheet [data-module]").nth(1);
  await card.hover();
  await sleep(700);
  await shot(page, "hangar-module-card-hover-compare");
  console.log(
    "compare:",
    await page.evaluate(() => document.querySelector(".hangar-compare")?.textContent?.trim() ?? null),
  );

  // select it
  await card.click();
  await sleep(1400);
  await parkPointer(page);
  await shot(page, "hangar-module-card-selected");
  console.log("after select:", JSON.stringify(await outline()));

  // clear slot
  await page.locator(".hangar-sheet-clear").hover();
  await sleep(300);
  await shot(page, "hangar-sheet-clear-hover");
  await page.locator(".hangar-sheet-clear").click();
  await sleep(1200);
  await parkPointer(page);
  await shot(page, "hangar-sheet-after-clear");

  // re-fit so the ship is not left stripped, then close the sheet
  await page.locator(".hangar-sheet [data-module]").nth(1).click();
  await sleep(1000);
  await page.locator(".hangar-sheet-done").click();
  await sleep(900);
  await parkPointer(page);
  await shot(page, "hangar-after-sheet-done");
});

// --- a second slot of a different kind ---
await step("second slot kind", async () => {
  const kinds = await page.evaluate(() =>
    [...document.querySelectorAll(".hangar-slot")].map((s) => s.dataset.kind),
  );
  const idx = kinds.findIndex((k, i) => i > 0 && k !== kinds[0]);
  if (idx < 0) return;
  await page.locator(".hangar-slot").nth(idx).click();
  await page.locator(".hangar-sheet").waitFor({ state: "visible" });
  await sleep(900);
  await parkPointer(page);
  await shot(page, `hangar-sheet-kind-${kinds[idx]}`);
  await page.locator(".hangar-sheet-done").click();
  await sleep(700);
});

// --- skins row ---
await step("skins", async () => {
  const skins = page.locator("[data-cosmetic]");
  const n = await skins.count();
  console.log("skins:", n);
  for (let i = 0; i < Math.min(n, 4); i++) {
    await skins.nth(i).scrollIntoViewIfNeeded();
    await skins.nth(i).click();
    await sleep(1600);
    await parkPointer(page);
    await shot(page, `hangar-skin-${i}`);
  }
});

// --- upgrades row ---
await step("upgrades", async () => {
  const up = page.locator(".hangar-upgrades");
  if (!(await up.count())) return;
  await up.scrollIntoViewIfNeeded();
  await sleep(400);
  await parkPointer(page);
  await shot(page, "hangar-upgrades-row");
  console.log("upgrades:", JSON.stringify(await page.evaluate(() =>
    [...document.querySelectorAll(".hangar-upgrade-row")].map((r) => r.textContent.trim()))));
  const btn = page.locator(".hangar-upgrade-row .hangar-btn").first();
  if (await btn.count()) {
    await btn.hover();
    await sleep(300);
    await shot(page, "hangar-upgrade-btn-hover");
  }
});

// --- a hull this account does not own: locked / buy state ---
await step("locked hull", async () => {
  for (let i = 0; i < 4; i++) {
    const o = await outline();
    const action = (o?.stageAction ?? []).join(" ");
    if (/buy/i.test(action)) {
      await parkPointer(page);
      await shot(page, "hangar-locked-hull-buy-state");
      console.log("locked hull:", JSON.stringify(o));
      return;
    }
    await page.locator(".hangar-stage-arrow.next").click();
    await sleep(2400);
  }
  console.log("no locked hull found — every hull is owned/free for this account");
});

// --- set as main ---
await step("set as main", async () => {
  const main = page.getByRole("button", { name: /Set as main/i });
  if (!(await main.count())) {
    console.log("no 'Set as main' button on the current hull");
    return;
  }
  await parkPointer(page);
  await shot(page, "hangar-before-set-as-main");
  await main.first().click();
  await sleep(1800);
  await parkPointer(page);
  await shot(page, "hangar-after-set-as-main");
  console.log("after set-as-main:", JSON.stringify(await outline()));
});

// --- close ---
await step("close", async () => {
  await page.locator(".hangar-close").click();
  await page.locator(".lobby-overlay").waitFor({ state: "visible", timeout: 30000 });
  await sleep(1500);
  await parkPointer(page);
  await shot(page, "lobby-back-from-hangar");
});

console.log("--- console tail ---");
console.log(logs.slice(-15).join("\n"));
await close(ctx);
