// VFX at a pinned quality tier, one client only so the GPU is not shared.
import fs from "node:fs";
import path from "node:path";
import { launchBrowser, openClient, dismissFullscreen, ensureAccount, settle, shot, sleep, tapEl, readState, centreOf, LOGS } from "./rig.mjs";
import { Pilot } from "./pilot.mjs";

const TIER = process.env.TIER ?? "HIGH";
const T0 = Date.now();
const log = [];
const mark = (s) => {
  const line = `+${((Date.now() - T0) / 1000).toFixed(1)}s ${s}`;
  log.push(line);
  console.log(line);
};

const browser = await launchBrowser();
const A = await openClient(browser, "vfxhq");
await dismissFullscreen(A);
await ensureAccount(A, "playtest-match-a", "playtest1234");

mark(`auto-picked tier before anything: ${await A.page.evaluate(() => window.__debug?.quality?.currentTier)}`);

// Pin the tier through the real settings screen, the way a player would.
await tapEl(A, A.page.locator(".sa-menu-settings-btn, [data-lobby-action='settings'], .hud-settings-btn").first()).catch(() => {});
if (!(await A.page.locator(".settings-overlay").isVisible().catch(() => false))) {
  await A.page.evaluate(() => window.__debug.openSettings());
  await sleep(1200);
}
const tierBtn = A.page.locator(".settings-overlay button", { hasText: new RegExp(`^${TIER}$`, "i") }).first();
if (await tierBtn.count()) {
  await tapEl(A, tierBtn);
  await sleep(900);
  mark(`pinned tier via settings: ${await A.page.evaluate(() => window.__debug?.quality?.currentTier)}`);
} else {
  mark("tier button not found — falling back to the debug hook");
  await A.page.evaluate((t) => window.__debug.quality.setTier(t.toLowerCase(), { persist: true }), TIER);
}
await shot(A.page, "hq-settings-quality");
const close = A.page.locator("[data-settings-close]").first();
if (await close.count()) await tapEl(A, close);
await sleep(1200);

async function fit(modules) {
  await tapEl(A, A.page.locator('.sa-menu-destination[data-lobby-action="hangar"]'));
  await A.page.locator(".hangar-panel").waitFor({ state: "visible", timeout: 60000 });
  await settle(A.page);
  for (let i = 0; i < modules.length; i++) {
    const slot = A.page.locator('.hangar-slot[data-kind="hardpoint"]').nth(i);
    await tapEl(A, slot);
    await sleep(1600);
    const card = A.page.locator(`.hangar-card[data-module="${modules[i]}"]`).first();
    if (await card.count()) await tapEl(A, card);
    await sleep(1100);
    mark(`  hp${i} -> ${await slot.getAttribute("data-module")}`);
  }
  await tapEl(A, A.page.locator(".hangar-close"));
  await A.page.locator(".lobby-overlay").waitFor({ state: "visible", timeout: 30000 });
  await settle(A.page);
}
await fit(["module.kinetic-mk1", "module.shield-mk1"]);

await tapEl(A, A.page.locator('.sa-menu-category[data-lobby-action="team deathmatch"]'));
await sleep(500);
await tapEl(A, A.page.locator('.sa-menu-card[data-gamemode="gamemode.practice-bots-5v5"]'));
await A.page.locator(".hud-modules .hud-module-btn").first().waitFor({ state: "visible", timeout: 200000 });
await sleep(7000);
mark(`tier in match: ${await A.page.evaluate(() => window.__debug?.quality?.currentTier)}`);
mark(`fps: ${await A.page.evaluate(() => window.__debug?.engine?.getFps?.().toFixed(1))}`);

const p = new Pilot(A);
await p.findSteerOrigin();

let n = 0;
const near = async (tag, clip) => {
  n += 1;
  const f = path.join(process.cwd(), "playtest/match/shots", `h${String(n).padStart(3, "0")}-${tag}.png`);
  await A.page.screenshot({ path: f, clip: clip ?? { x: 230, y: 20, width: 470, height: 370 } }).catch(() => {});
};

async function deployShield() {
  const held = [...A.touch.points.entries()].map(([id, pt]) => [id, pt.x, pt.y]);
  for (const [id] of held) await A.touch.up(id);
  await sleep(220);
  const btn = A.page.locator(".hud-module-btn").filter({ has: A.page.locator('.slot-type:text-is("SHIELD")') }).first();
  if (await btn.count()) {
    const pt = await centreOf(btn);
    if (pt) await A.touch.tap(pt.x, pt.y, 60, 90);
  }
  await sleep(350);
  for (const [id, x, y] of held) await A.touch.down(id, x, y);
  return A.page.evaluate(() => {
    const s = window.__debug.session;
    const me = s.curSnapshot.ships.find((x) => x.id === s.playerId);
    return me?.modules?.find((m) => m.moduleId.includes("shield"))?.state ?? "n/a";
  });
}

mark(`shield -> ${await deployShield()}`);
await shot(A.page, "hq-shield-up-full");
await near("shield-up");

p.goal = "close";
await p.holdWeapon("01");
let lastSh = "";
for (let i = 0; i < 120; i++) {
  const st = await p.step().catch(() => null);
  const sh = await A.page
    .evaluate(() => {
      const s = window.__debug?.session;
      const me = s?.curSnapshot.ships.find((x) => x.id === s.playerId);
      return me?.modules?.find((m) => m.moduleId.includes("shield"))?.state ?? "n/a";
    })
    .catch(() => "?");
  if (sh !== lastSh) {
    mark(`  shield ${lastSh} -> ${sh}  hull=${st?.me?.hull?.toFixed(0)} dist=${st?.dist?.toFixed(0)} fps=${st?.fps?.toFixed(0)}`);
    lastSh = sh;
    // Photograph the transition frames densely: assemble and shatter both live here.
    for (let k = 0; k < 4; k++) {
      await near(`t${String(i).padStart(3, "0")}-${k}-${sh}`);
      await sleep(90);
    }
  }
  await near(`f${String(i).padStart(3, "0")}-${sh}`);
  if (sh === "retracted" && i % 4 === 0) await deployShield();
  await sleep(130);
}

await shot(A.page, "hq-final");
mark(`console: ${JSON.stringify(A.counts)}`);
fs.writeFileSync(path.join(LOGS, "timeline-vfxhq.txt"), log.join("\n"));
await p.allStop();
await browser.close();
