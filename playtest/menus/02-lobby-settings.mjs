// Phase 2 — lobby root, every mode drawer, the settings screen end to end.
import { launch, close, shot, sleep, bootToLobby, parkPointer } from "./lib.mjs";

const { ctx, page, logs } = await launch({ headless: process.env.SA_HEADLESS === "1" });
const sawPrompt = await bootToLobby(page);
console.log("fullscreen prompt shown again on relaunch:", sawPrompt);

const lobby = page.locator(".lobby-overlay");
await parkPointer(page);
await shot(page, "lobby-root");

// The header line-up (account chip / log out / gear) and the player count.
console.log(
  "header:",
  JSON.stringify(
    await page.evaluate(() => ({
      account: document.querySelector(".sa-menu-account")?.textContent,
      online: document.querySelector(".sa-menu-online-count")?.textContent,
      offlineBadge: document.querySelector(".sa-menu-offline-badge")?.className,
      title: document.querySelector(".sa-screen-title")?.textContent,
      subtitle: document.querySelector(".sa-menu-subtitle")?.textContent,
    })),
  ),
);

// Touch-target audit of every lobby control.
const targets = await page.evaluate(() => {
  const out = [];
  for (const el of document.querySelectorAll(
    ".lobby-overlay button, .lobby-overlay a, .lobby-overlay .sa-screen-chip",
  )) {
    const r = el.getBoundingClientRect();
    if (r.width === 0) continue;
    out.push({
      label: (el.textContent || "").trim().slice(0, 30),
      w: Math.round(r.width),
      h: Math.round(r.height),
      hidden: el.closest("[hidden]") !== null,
    });
  }
  return out;
});
console.log("lobby touch targets:", JSON.stringify(targets));

// --- every mode drawer ---
for (const group of ["Deathmatch", "Team Deathmatch", "Capture the Flag"]) {
  const slug = group.toLowerCase().replace(/\s+/g, "-");
  await lobby.locator(`.sa-menu-category[data-lobby-action="${group.toLowerCase()}"]`).click();
  await sleep(700);
  await parkPointer(page);
  await shot(page, `lobby-drawer-${slug}`);
  const cards = await page.evaluate(() =>
    [...document.querySelectorAll(".sa-menu-group:not([hidden]) .sa-menu-card")].map((c) => ({
      mode: c.dataset.gamemode,
      label: c.querySelector(".sa-menu-card-label")?.textContent,
      blurb: c.querySelector(".sa-menu-card-blurb")?.textContent,
      disabled: c.disabled,
      h: Math.round(c.getBoundingClientRect().height),
    })),
  );
  console.log(`${group} cards:`, JSON.stringify(cards));
  // Back out to the root.
  await lobby.locator(".sa-menu-group:not([hidden]) .sa-menu-back").click();
  await sleep(600);
}
await parkPointer(page);
await shot(page, "lobby-root-after-drawers");

// --- pressed / hover state on a destination ---
await lobby.locator('[data-lobby-action="hangar"]').hover();
await sleep(300);
await shot(page, "lobby-hangar-hover");
await parkPointer(page);

// --- settings ---
await lobby.locator("[data-lobby-settings]").click();
const settings = page.locator(".settings-overlay");
await settings.waitFor({ state: "visible" });
await sleep(900);
await parkPointer(page);
await shot(page, "settings-top");

const groups = await page.evaluate(() =>
  [...document.querySelectorAll(".sa-settings-group")].map((g) => g.dataset.group),
);
console.log("settings groups:", JSON.stringify(groups));
console.log(
  "settings scroll:",
  JSON.stringify(
    await page.evaluate(() => {
      const el = document.querySelector(".sa-settings-groups");
      return el ? { clientH: el.clientHeight, scrollH: el.scrollHeight } : null;
    }),
  ),
);

for (const g of groups) {
  await page.locator(`.sa-settings-group[data-group="${g}"]`).scrollIntoViewIfNeeded();
  await sleep(400);
  await parkPointer(page);
  await shot(page, `settings-group-${g}`);
}

// Toggle something harmless: haptics off, shot, back on.
const haptics = page.locator('[data-setting="haptics"]');
if (await haptics.count()) {
  await haptics.scrollIntoViewIfNeeded();
  await sleep(300);
  await shot(page, "settings-haptics-before");
  await haptics.click();
  await sleep(400);
  await parkPointer(page);
  await shot(page, "settings-haptics-toggled");
  await haptics.click();
  await sleep(400);
  await shot(page, "settings-haptics-restored");
}

// A slider: drag master volume, then put it back.
const vol = page.locator('[data-setting="volume.master"]');
if (await vol.count()) {
  await vol.scrollIntoViewIfNeeded();
  const before = await vol.inputValue();
  await vol.fill("0.35");
  await vol.dispatchEvent("input");
  await sleep(400);
  await parkPointer(page);
  await shot(page, "settings-volume-changed");
  await vol.fill(before);
  await vol.dispatchEvent("input");
  await sleep(300);
}

// Bottom of the sheet: Back / Reload content / Reset display.
await page.locator("[data-settings-close]").scrollIntoViewIfNeeded();
await sleep(400);
await parkPointer(page);
await shot(page, "settings-bottom-actions");

await page.locator("[data-settings-close]").click();
await page.locator(".lobby-overlay").waitFor({ state: "visible" });
await sleep(1200);
await parkPointer(page);
await shot(page, "lobby-back-from-settings");

console.log("--- console tail ---");
console.log(logs.slice(-12).join("\n"));
await close(ctx);
