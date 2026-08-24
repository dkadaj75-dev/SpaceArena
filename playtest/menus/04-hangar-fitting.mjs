// Phase 3b — the owned hull: slot tiles, the module sheet, skins, upgrades,
// then buying a free hull and making it main.
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
await page.locator('.lobby-overlay [data-lobby-action="hangar"]').click();
await page.locator(".hangar-panel").waitFor({ state: "visible", timeout: 60000 });
await sleep(3500);
await parkPointer(page);

// --- why the hull dots are hard to hit ---
console.log(
  "dot geometry:",
  JSON.stringify(
    await page.evaluate(() => {
      const dots = [...document.querySelectorAll(".hangar-ship-dot")];
      return dots.map((d) => {
        const r = d.getBoundingClientRect();
        const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return {
          w: Math.round(r.width),
          h: Math.round(r.height),
          x: Math.round(r.x),
          y: Math.round(r.y),
          tag: d.tagName,
          topAtCentre: el ? `${el.tagName}.${el.className}` : null,
        };
      });
    }),
  ),
);
console.log(
  "hull label geometry:",
  JSON.stringify(
    await page.evaluate(() => {
      const r = document.querySelector(".hangar-ship-readout")?.getBoundingClientRect();
      const d = document.querySelector(".hangar-ship-dots")?.getBoundingClientRect();
      return { readout: r && [r.x, r.y, r.width, r.height].map(Math.round), dots: d && [d.x, d.y, d.width, d.height].map(Math.round) };
    }),
  ),
);

// --- slot tiles: label truncation audit ---
console.log(
  "slot tiles:",
  JSON.stringify(
    await page.evaluate(() =>
      [...document.querySelectorAll(".hangar-slot")].map((s) => {
        const lab = s.querySelector(".hangar-slot-label");
        const soc = s.querySelector(".hangar-slot-socket");
        return {
          socket: s.dataset.socket,
          kind: s.dataset.kind,
          label: lab?.textContent,
          labelClipped: lab ? lab.scrollWidth > lab.clientWidth + 1 : null,
          socketText: soc?.textContent,
          socketOverflows: soc ? soc.getBoundingClientRect().width > s.getBoundingClientRect().width : null,
          box: [Math.round(s.getBoundingClientRect().width), Math.round(s.getBoundingClientRect().height)],
        };
      }),
    ),
  ),
);

await shot(page, "hangar-owned-hull-overview");

// --- module sheet on a WEAPON hardpoint ---
await step("weapon sheet", async () => {
  const slot = page.locator('.hangar-slot[data-kind="weapon"]').first();
  const target = (await slot.count()) ? slot : page.locator(".hangar-slot").first();
  await target.click();
  await page.locator(".hangar-sheet").waitFor({ state: "visible", timeout: 20000 });
  await sleep(1000);
  await parkPointer(page);
  await shot(page, "hangar-sheet-weapon-open");

  const info = await page.evaluate(() => {
    const sheet = document.querySelector(".hangar-sheet");
    const body = document.querySelector(".hangar-deck-body") ?? sheet;
    const cards = [...document.querySelectorAll(".hangar-sheet [data-module]")];
    return {
      sheetBox: sheet && [Math.round(sheet.getBoundingClientRect().width), Math.round(sheet.getBoundingClientRect().height)],
      bodyScroll: body && { clientW: body.clientWidth, scrollW: body.scrollWidth, clientH: body.clientHeight, scrollH: body.scrollHeight },
      count: cards.length,
      cards: cards.slice(0, 8).map((b) => ({
        id: b.dataset.module,
        name: b.querySelector(".hangar-card-name")?.textContent,
        stats: [...b.querySelectorAll(".hangar-card-stat")].map((s) => s.textContent.trim()),
        disabled: b.disabled,
        selected: b.className,
        box: [Math.round(b.getBoundingClientRect().width), Math.round(b.getBoundingClientRect().height)],
      })),
    };
  });
  console.log("weapon sheet:", JSON.stringify(info, null, 1));

  // hover -> before/after preview
  const card = page.locator(".hangar-sheet [data-module]").nth(2);
  await card.hover();
  await sleep(800);
  await shot(page, "hangar-sheet-card-hover-preview");
  console.log("compare readout:", await page.evaluate(() => document.querySelector(".hangar-compare")?.textContent?.trim() ?? null));

  await card.click();
  await sleep(1500);
  await parkPointer(page);
  await shot(page, "hangar-sheet-card-selected");

  // scroll the card deck if it scrolls
  await step("scroll deck", async () => {
    await page.locator(".hangar-deck-body").evaluate((el) => (el.scrollTop = el.scrollHeight));
    await sleep(500);
    await shot(page, "hangar-sheet-deck-scrolled");
  });

  await page.locator(".hangar-sheet-clear").click();
  await sleep(1200);
  await parkPointer(page);
  await shot(page, "hangar-sheet-slot-cleared");
  console.log("power after clear:", await page.evaluate(() => document.querySelector(".hangar-power-text")?.textContent));

  // put a module back and close
  await page.locator(".hangar-sheet [data-module]").nth(1).click();
  await sleep(1200);
  await shot(page, "hangar-sheet-refitted");
  await page.locator(".hangar-sheet-done").click();
  await sleep(1000);
  await parkPointer(page);
  await shot(page, "hangar-after-fitting");
});

// --- an internal/core slot sheet ---
await step("core sheet", async () => {
  const kinds = await page.evaluate(() => [...document.querySelectorAll(".hangar-slot")].map((s) => s.dataset.kind));
  const idx = kinds.findIndex((k) => k !== "weapon");
  if (idx < 0) return;
  await page.locator(".hangar-slot").nth(idx).click();
  await page.locator(".hangar-sheet").waitFor({ state: "visible" });
  await sleep(1000);
  await parkPointer(page);
  await shot(page, `hangar-sheet-core-${kinds[idx]}`);
  await page.locator(".hangar-sheet-done").click();
  await sleep(800);
});

// --- skins ---
await step("skins", async () => {
  const skins = page.locator("[data-cosmetic]");
  const n = await skins.count();
  console.log("skin swatches:", n);
  console.log(
    "skin geometry:",
    JSON.stringify(
      await page.evaluate(() =>
        [...document.querySelectorAll("[data-cosmetic]")].slice(0, 4).map((b) => {
          const r = b.getBoundingClientRect();
          return { id: b.dataset.cosmetic, w: Math.round(r.width), h: Math.round(r.height), title: b.title };
        }),
      ),
    ),
  );
  for (const i of [1, 4, 7].filter((i) => i < n)) {
    await skins.nth(i).click();
    await sleep(1800);
    await parkPointer(page);
    await shot(page, `hangar-skin-index-${i}`);
  }
  // back to the first
  await skins.nth(0).click();
  await sleep(1500);
});

// --- upgrades ---
await step("upgrades", async () => {
  await shot(page, "hangar-upgrades-visible");
  console.log(
    "upgrade rows:",
    JSON.stringify(
      await page.evaluate(() =>
        [...document.querySelectorAll(".hangar-upgrade-row")].map((r) => ({
          text: r.textContent.trim(),
          btn: r.querySelector("button")?.textContent?.trim(),
          disabled: r.querySelector("button")?.disabled,
          box: (() => {
            const b = r.querySelector("button");
            if (!b) return null;
            const bb = b.getBoundingClientRect();
            return [Math.round(bb.width), Math.round(bb.height)];
          })(),
        })),
      ),
    ),
  );
  const btn = page.locator(".hangar-upgrade-row button").first();
  if (await btn.count()) {
    await btn.click();
    await sleep(1500);
    await parkPointer(page);
    await shot(page, "hangar-after-upgrade-purchase");
    console.log("upgrade rows after:", await page.evaluate(() =>
      [...document.querySelectorAll(".hangar-upgrade-row")].map((r) => r.textContent.trim()).join(" | ")));
    console.log("error line:", await page.evaluate(() => document.querySelector(".hangar-error")?.textContent ?? null));
  }
});

// --- buy a free hull, then set it as main ---
await step("buy hull", async () => {
  await page.locator(".hangar-stage-arrow.next").click();
  await sleep(2600);
  await parkPointer(page);
  await shot(page, "hangar-locked-hull-before-buy");
  const buy = page.getByRole("button", { name: /Buy/i });
  if (!(await buy.count())) {
    console.log("no buy button on this hull");
    return;
  }
  await buy.first().click();
  await sleep(2600);
  await parkPointer(page);
  await shot(page, "hangar-hull-after-buy");
  console.log(
    "after buy:",
    JSON.stringify(
      await page.evaluate(() => ({
        action: [...document.querySelectorAll(".hangar-stage-action button")].map((b) => b.textContent.trim()),
        badge: document.querySelector(".hangar-stage-badge")?.textContent ?? null,
        slots: document.querySelectorAll(".hangar-slot").length,
        skins: document.querySelectorAll("[data-cosmetic]").length,
      })),
    ),
  );
  const main = page.getByRole("button", { name: /Set as main/i });
  if (await main.count()) {
    await shot(page, "hangar-set-as-main-available");
    await main.first().click();
    await sleep(2200);
    await parkPointer(page);
    await shot(page, "hangar-after-set-as-main");
  }
});

await step("close", async () => {
  await page.locator(".hangar-close").click();
  await page.locator(".lobby-overlay").waitFor({ state: "visible", timeout: 30000 });
  await sleep(1500);
  await parkPointer(page);
  await shot(page, "lobby-after-hangar-changes");
  console.log("lobby credits:", await page.evaluate(() => document.querySelector(".sa-menu-account")?.textContent));
});

console.log("--- console tail ---");
console.log(logs.filter((l) => !l.includes("instanced mesh")).slice(-15).join("\n"));
await close(ctx);
