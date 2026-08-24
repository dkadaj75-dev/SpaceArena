// Recon: two accounts, into one online Duel, dump the HUD so the pilot loop
// can be written against real selectors.
import fs from "node:fs";
import path from "node:path";
import { launchBrowser, openClient, dismissFullscreen, ensureAccount, settle, shot, sleep, centreOf, tapEl, readState, LOGS } from "./rig.mjs";

const PASS = "playtest1234";
const browser = await launchBrowser();

console.log("== opening clients ==");
const A = await openClient(browser, "a");
const B = await openClient(browser, "b");
await Promise.all([dismissFullscreen(A), dismissFullscreen(B)]);
await shot(A.page, "a-auth-screen");
await Promise.all([ensureAccount(A, "playtest-match-a", PASS), ensureAccount(B, "playtest-match-b", PASS)]);

await shot(A.page, "a-lobby-root");
await shot(B.page, "b-lobby-root");

const cats = await A.page.locator(".sa-menu-category").evaluateAll((els) =>
  els.map((e) => ({ action: e.dataset.lobbyAction, text: e.innerText.replace(/\n/g, " | ") })),
);
console.log("categories:", JSON.stringify(cats));

// Open every drawer once for the menu documentation.
for (const c of cats) {
  const cat = A.page.locator(`.sa-menu-category[data-lobby-action="${c.action}"]`);
  await tapEl(A, cat);
  await sleep(700);
  const cards = await A.page.locator(".sa-menu-group:not([hidden]) .sa-menu-card").evaluateAll((els) =>
    els.map((e) => ({ gm: e.dataset.gamemode, text: e.innerText.replace(/\n/g, " | "), disabled: e.disabled })),
  );
  console.log(`  drawer "${c.action}":`, JSON.stringify(cards));
  await shot(A.page, `a-menu-${c.action.replace(/\s+/g, "-")}`);
  const back = A.page.locator(".sa-menu-group:not([hidden]) .sa-menu-back");
  if (await back.count()) await tapEl(A, back);
  await sleep(500);
}

// ------------------------------------------------------------------ queue duel
async function queue(c, category, gamemode) {
  await tapEl(c, c.page.locator(`.sa-menu-category[data-lobby-action="${category}"]`));
  await sleep(600);
  await tapEl(c, c.page.locator(`.sa-menu-card[data-gamemode="${gamemode}"]`));
}

console.log("== queueing duel on both ==");
await Promise.all([queue(A, "deathmatch", "gamemode.duel-1v1"), queue(B, "deathmatch", "gamemode.duel-1v1")]);
await sleep(900);
await shot(A.page, "a-duel-searching");
await shot(B.page, "b-duel-searching");
const loadingText = await A.page.locator(".sa-match-loading").innerText().catch(() => "(gone)");
console.log("A loading card:\n" + loadingText);

// Wait for the HUD.
await A.page.locator(".hud-modules .hud-module-btn").first().waitFor({ state: "visible", timeout: 120000 });
await B.page.locator(".hud-modules .hud-module-btn").first().waitFor({ state: "visible", timeout: 120000 });
console.log("== HUD up ==");
await sleep(1500);
await shot(A.page, "a-duel-hud-first");
await shot(B.page, "b-duel-hud-first");

const dump = await A.page.evaluate(() => {
  const walk = (el, depth = 0) => {
    if (depth > 4) return [];
    const out = [];
    for (const ch of el.children) {
      const r = ch.getBoundingClientRect();
      out.push({
        d: depth,
        tag: ch.tagName.toLowerCase(),
        cls: ch.className?.baseVal ?? String(ch.className ?? ""),
        data: { ...ch.dataset },
        text: (ch.textContent ?? "").trim().slice(0, 40),
        box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
        hidden: ch.hidden || getComputedStyle(ch).display === "none",
      });
      out.push(...walk(ch, depth + 1));
    }
    return out;
  };
  const root = document.querySelector(".hud-root") ?? document.body;
  return walk(root);
});
fs.writeFileSync(path.join(LOGS, "hud-dom.json"), JSON.stringify(dump, null, 1));
console.log("hud dom rows:", dump.length, "->", path.join(LOGS, "hud-dom.json"));
for (const r of dump.filter((x) => !x.hidden && x.box[2] > 0)) {
  console.log(`${" ".repeat(r.d)}${r.tag}.${r.cls} ${JSON.stringify(r.data)} [${r.box}] ${r.text ? JSON.stringify(r.text) : ""}`);
}

console.log("state A:", JSON.stringify(await readState(A.page), null, 1).slice(0, 2500));

fs.writeFileSync(path.join(LOGS, "recon-done.txt"), new Date().toISOString());
await browser.close();
