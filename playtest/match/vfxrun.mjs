// Combat VFX evidence run: A carries the autocannon + deflector, B carries the
// sustained beam + seeker missiles, and the two fly straight at each other so
// every impact effect lands in front of A's chase camera.
import fs from "node:fs";
import path from "node:path";
import { launchBrowser, openClient, dismissFullscreen, ensureAccount, settle, shot, sleep, tapEl, readState, centreOf, LOGS } from "./rig.mjs";
import { Pilot } from "./pilot.mjs";

const T0 = Date.now();
const log = [];
const mark = (s) => {
  const line = `+${((Date.now() - T0) / 1000).toFixed(1)}s ${s}`;
  log.push(line);
  console.log(line);
};

const browser = await launchBrowser();
const A = await openClient(browser, "vfx-a");
const B = await openClient(browser, "vfx-b");
await Promise.all([dismissFullscreen(A), dismissFullscreen(B)]);
await Promise.all([
  ensureAccount(A, "playtest-match-a", "playtest1234"),
  ensureAccount(B, "playtest-match-b", "playtest1234"),
]);

async function fit(c, modules) {
  await tapEl(c, c.page.locator('.sa-menu-destination[data-lobby-action="hangar"]'));
  await c.page.locator(".hangar-panel").waitFor({ state: "visible", timeout: 60000 });
  await settle(c.page);
  for (let i = 0; i < modules.length; i++) {
    const slot = c.page.locator('.hangar-slot[data-kind="hardpoint"]').nth(i);
    await tapEl(c, slot);
    await sleep(1600);
    const card = c.page.locator(`.hangar-card[data-module="${modules[i]}"]`).first();
    if (!(await card.count())) {
      mark(`  ${modules[i]} not offered on ${c.tag}`);
      continue;
    }
    await tapEl(c, card);
    await sleep(1100);
    mark(`  ${c.tag} hp${i} -> ${await slot.getAttribute("data-module")}`);
  }
  await tapEl(c, c.page.locator(".hangar-close"));
  await c.page.locator(".lobby-overlay").waitFor({ state: "visible", timeout: 30000 });
  await settle(c.page);
}
await fit(A, ["module.kinetic-mk1", "module.shield-mk1"]);
await fit(B, ["module.beamlaser-mk1", "module.missile-mk1"]);

const queue = async (c) => {
  await tapEl(c, c.page.locator('.sa-menu-category[data-lobby-action="team deathmatch"]'));
  await sleep(450);
  await tapEl(c, c.page.locator('.sa-menu-card[data-gamemode="gamemode.practice-bots"]'));
};
await queue(A);
await sleep(1100);
await queue(B);
await Promise.all([
  A.page.locator(".hud-modules .hud-module-btn").first().waitFor({ state: "visible", timeout: 180000 }),
  B.page.locator(".hud-modules .hud-module-btn").first().waitFor({ state: "visible", timeout: 180000 }),
]);
await sleep(6000);

const a = await readState(A.page);
const b = await readState(B.page);
mark(`A=${a.playerId} t${a.me?.team} ${a.me?.modules.map((m) => m.id).join(",")}`);
mark(`B=${b.playerId} t${b.me?.team} ${b.me?.modules.map((m) => m.id).join(",")}`);
mark(`same room: ${JSON.stringify(a.ships.map((s) => s.id)) === JSON.stringify(b.ships.map((s) => s.id)) && a.playerId !== b.playerId}`);

const pa = new Pilot(A);
const pb = new Pilot(B);
await pa.findSteerOrigin();
await pb.findSteerOrigin();

let n = 0;
const near = async (page, tag) => {
  n += 1;
  const f = path.join(process.cwd(), "playtest/match/shots", `v${String(n).padStart(3, "0")}-${tag}.png`);
  await page.screenshot({ path: f, clip: { x: 250, y: 30, width: 430, height: 340 } }).catch(() => {});
};

/** The shield toggle is click-bound, so every finger has to come off first. */
async function deployShield(p) {
  const held = [...p.c.touch.points.entries()].map(([id, pt]) => [id, pt.x, pt.y]);
  for (const [id] of held) await p.c.touch.up(id);
  await sleep(250);
  const btn = p.c.page.locator(".hud-module-btn").filter({ has: p.c.page.locator('.slot-type:text-is("SHIELD")') }).first();
  if (await btn.count()) {
    const pt = await centreOf(btn);
    if (pt) await p.c.touch.tap(pt.x, pt.y, 60, 90);
  }
  await sleep(400);
  const after = await p.c.page.evaluate(() => {
    const s = window.__debug.session;
    const me = s.curSnapshot.ships.find((x) => x.id === s.playerId);
    return me?.modules?.find((m) => m.moduleId.includes("shield"))?.state ?? "n/a";
  });
  for (const [id, x, y] of held) await p.c.touch.down(id, x, y);
  return after;
}

mark(`shield after deploy: ${await deployShield(pa)}`);
await shot(A.page, "vfx-shield-deployed");
await near(A.page, "shield-deployed");

// B closes and pours beam + missiles into A; A answers with the autocannon.
pb.goal = "close";
let bAlive = true;
const bLoop = (async () => {
  await pb.holdWeapon("01");
  await pb.holdWeapon("02");
  while (bAlive) {
    await pb.step().catch(() => {});
    await sleep(120);
  }
})();

pa.goal = "close";
await pa.holdWeapon("01");
await pa.holdWeapon("02");

let lastShield = "";
for (let i = 0; i < 70; i++) {
  const st = await pa.step().catch(() => null);
  const sh = await A.page
    .evaluate(() => {
      const s = window.__debug?.session;
      const me = s?.curSnapshot.ships.find((x) => x.id === s.playerId);
      return me?.modules?.find((m) => m.moduleId.includes("shield"))?.state ?? "n/a";
    })
    .catch(() => "?");
  if (sh !== lastShield) {
    mark(`   shield state -> ${sh} (hull ${st?.me?.hull?.toFixed(0)}, dist ${st?.dist?.toFixed(0)})`);
    lastShield = sh;
  }
  await near(A.page, `a-${String(i).padStart(2, "0")}-sh-${sh}`);
  if (i % 7 === 3) await near(B.page, `b-${String(i).padStart(2, "0")}`);
  // Re-raise the shield whenever the sim drops it, so the assemble and the
  // shatter both get photographed.
  if (sh === "retracted" && i % 5 === 0) mark(`   redeploy -> ${await deployShield(pa)}`);
  await sleep(180);
}

bAlive = false;
await bLoop.catch(() => {});
await shot(A.page, "vfx-final-a");
await shot(B.page, "vfx-final-b");
mark(`A console: ${JSON.stringify(A.counts)} / B: ${JSON.stringify(B.counts)}`);
fs.writeFileSync(path.join(LOGS, "timeline-vfx.txt"), log.join("\n"));
await pa.allStop();
await pb.allStop();
await browser.close();
