// Play one online match with two real accounts and screenshot every stage.
//   node playtest/match/playmatch.mjs duel|tdm|ctf
import fs from "node:fs";
import path from "node:path";
import {
  launchBrowser, openClient, dismissFullscreen, ensureAccount, settle, shot, sleep,
  tapEl, readState, LOGS,
} from "./rig.mjs";
import { Pilot } from "./pilot.mjs";

const MODES = {
  duel: { cat: "deathmatch", gm: "gamemode.duel-1v1", label: "Duel 1v1" },
  tdm: { cat: "team deathmatch", gm: "gamemode.practice-bots", label: "2v2 Team Deathmatch" },
  ctf: { cat: "capture the flag", gm: "gamemode.practice-ctf-5v5", label: "5v5 Capture the Flag" },
};
const modeKey = process.argv[2] ?? "duel";
const MODE = MODES[modeKey];
if (!MODE) throw new Error(`unknown mode ${modeKey}`);
const PASS = "playtest1234";
const P = (n) => `${modeKey}-${n}`;
const timeline = [];
const T0 = Date.now();
const mark = (s) => {
  const line = `+${((Date.now() - T0) / 1000).toFixed(1)}s  ${s}`;
  timeline.push(line);
  console.log(line);
};

let skipFlight = false;
async function beat(name, fn, { flight = false } = {}) {
  if (flight) {
    if (skipFlight || (await matchOver())) {
      skipFlight = true;
      mark(`~~ ${name} skipped — the match is already over`);
      return;
    }
  }
  mark(`>> ${name}`);
  try {
    await fn();
  } catch (e) {
    mark(`!! ${name} FAILED: ${e.message.split("\n")[0]}`);
  }
}

const browser = await launchBrowser();
const A = await openClient(browser, `${modeKey}-a`);
const B = await openClient(browser, `${modeKey}-b`);
await Promise.all([dismissFullscreen(A), dismissFullscreen(B)]);
await Promise.all([
  ensureAccount(A, "playtest-match-a", PASS),
  ensureAccount(B, "playtest-match-b", PASS),
]);
mark("both accounts in the lobby");

// ------------------------------------------------------------------ fitting
async function fit(c, modules) {
  if (!modules?.length) return;
  await tapEl(c, c.page.locator('.sa-menu-destination[data-lobby-action="hangar"]'));
  const panel = c.page.locator(".hangar-panel");
  await panel.waitFor({ state: "visible", timeout: 60000 });
  await settle(c.page);
  await shot(c.page, P(`${c.tag.slice(-1)}-hangar`));
  for (let i = 0; i < modules.length; i++) {
    const slot = c.page.locator('.hangar-slot[data-kind="hardpoint"]').nth(i);
    if (!(await slot.count())) {
      mark(`  hardpoint ${i} missing on ${c.tag}`);
      continue;
    }
    await tapEl(c, slot);
    await sleep(1600); // the card sheet slides in; measuring mid-slide taps the wrong card
    const card = c.page.locator(`.hangar-card[data-module="${modules[i]}"]`).first();
    if (!(await card.count())) {
      mark(`  ${modules[i]} not offered for hardpoint ${i} on ${c.tag}`);
      continue;
    }
    if (await card.isDisabled().catch(() => false)) {
      mark(`  ${modules[i]} is locked for ${c.tag}`);
      continue;
    }
    await tapEl(c, card);
    await sleep(1000);
    let landed = await slot.getAttribute("data-module");
    if (landed !== modules[i]) {
      mark(`  [!] ${c.tag} hardpoint ${i} wanted ${modules[i]} but got ${landed} — retrying`);
      await tapEl(c, slot);
      await sleep(1600);
      const again = c.page.locator(`.hangar-card[data-module="${modules[i]}"]`).first();
      if (await again.count()) await tapEl(c, again);
      await sleep(1000);
      landed = await slot.getAttribute("data-module");
    }
    mark(`  ${c.tag} hardpoint ${i} -> ${landed}${landed === modules[i] ? "" : "  [MISMATCH]"}`);
  }
  await shot(c.page, P(`${c.tag.slice(-1)}-hangar-fitted`));
  await tapEl(c, c.page.locator(".hangar-close"));
  await c.page.locator(".lobby-overlay").waitFor({ state: "visible", timeout: 30000 });
  await settle(c.page);
}

const FIT_A = process.env.FIT_A ? process.env.FIT_A.split(",") : null;
const FIT_B = process.env.FIT_B ? process.env.FIT_B.split(",") : null;
if (FIT_A) await beat("fit A", () => fit(A, FIT_A));
if (FIT_B) await beat("fit B", () => fit(B, FIT_B));

// -------------------------------------------------------------------- queue
await shot(A.page, P("a-lobby"));
async function queue(c) {
  await tapEl(c, c.page.locator(`.sa-menu-category[data-lobby-action="${MODE.cat}"]`));
  await sleep(450);
  await tapEl(c, c.page.locator(`.sa-menu-card[data-gamemode="${MODE.gm}"]`));
}
// The drawer itself, documented once from A before the timed queue below.
await tapEl(A, A.page.locator(`.sa-menu-category[data-lobby-action="${MODE.cat}"]`));
await sleep(700);
await shot(A.page, P("a-mode-drawer"));
await tapEl(A, A.page.locator(".sa-menu-group:not([hidden]) .sa-menu-back"));
await sleep(600);
// A queues first so the genuine "searching for pilots" state is on screen, but
// B has to follow INSIDE the 10 s bot-backfill window — otherwise the room
// backfills with bots and locks, and the two accounts end up in separate rooms.
await beat(`queue ${MODE.label} — B follows A inside the 10 s backfill window`, async () => {
  await queue(A);
  const solo = await A.page.locator(".sa-match-loading").innerText().catch(() => "(gone)");
  mark("A search card while alone: " + solo.replace(/\n/g, " | "));
  await sleep(1100);
  await queue(B);
  mark(`   B queued ${((Date.now() - T0) / 1000).toFixed(1)}s in`);
  await shot(A.page, P("a-searching"));
  await shot(B.page, P("b-searching"));
});

await beat("wait for the HUD on both", async () => {
  await Promise.all([
    A.page.locator(".hud-modules .hud-module-btn").first().waitFor({ state: "visible", timeout: 180000 }),
    B.page.locator(".hud-modules .hud-module-btn").first().waitFor({ state: "visible", timeout: 180000 }),
  ]);
});
await shot(A.page, P("a-match-in"));
await shot(B.page, P("b-match-in"));

const roster = await readState(A.page);
mark(`roster: ${roster.ships.length} ships, arena=${roster.arenaId}, A=${roster.playerId} team=${roster.me?.team}`);
mark(`A fit: ${(roster.me?.modules ?? []).map((m) => m.id).join(", ")}`);
const rosterB = await readState(B.page);
mark(`B=${rosterB.playerId} team=${rosterB.me?.team}`);
mark(`B fit: ${(rosterB.me?.modules ?? []).map((m) => m.id).join(", ")}`);
mark(`teams: ${JSON.stringify(roster.ships.map((s) => `${s.id}:t${s.team}`))}`);

// ------------------------------------------------------------------- pilots
const pa = new Pilot(A);
const pb = new Pilot(B);
await pa.findSteerOrigin();
await pb.findSteerOrigin();

const B_FIRE_DELAY = Number(process.env.B_FIRE_DELAY_MS ?? 45000);
let bAlive = true;
const bLoop = (async () => {
  await sleep(2500);
  while (bAlive) {
    if (Date.now() - T0 > B_FIRE_DELAY && !pb.c.touch.isDown(3)) {
      await pb.holdWeapon("01").catch(() => {});
      await pb.holdWeapon("02").catch(() => {});
    }
    await pb.step().catch(() => {});
    await sleep(120);
  }
})();

const snap = (n) => shot(A.page, P(`a-${n}`));
const snapB = (n) => shot(B.page, P(`b-${n}`));
let closeN = 0;
/** Tight crop on the fight so impact VFX is legible at phone scale. */
const closeup = async (page, n) => {
  closeN += 1;
  const file = path.join(
    process.cwd(),
    "playtest/match/shots",
    `c${String(closeN).padStart(3, "0")}-${P(n)}-closeup.png`,
  );
  await page.screenshot({ path: file, clip: { x: 250, y: 40, width: 430, height: 330 } }).catch(() => {});
};
/** True once the match is over — the remaining flight beats are moot. */
const matchOver = async () => A.page.locator(".hud-results").isVisible().catch(() => false);

// ------------------------------------------------------------------- beats
// Order matters: a Duel ends on the FIRST kill (eliminationEndsMatch), so the
// non-combat tour has to happen before anything can shoot the match out.

await beat("module inventory on the HUD", async () => {
  mark(`   A buttons: ${JSON.stringify(await pa.listModules())}`);
  mark(`   B buttons: ${JSON.stringify(await pb.listModules())}`);
});

await beat("countdown / first seconds", async () => {
  await pa.fly(2200);
  await snap("countdown");
  await pa.fly(3000);
  await snap("early-flight");
  const speed = await A.page.locator(".hud-speed-value").innerText().catch(() => "");
  const thr = await A.page.locator(".hud-throttle-readout").innerText().catch(() => "");
  mark(`   speed readout "${speed}" throttle "${thr}"`);
}, { flight: true });

await beat("engage: close and hold both triggers", async () => {
  pa.goal = "chase";
  let shotAt = 0;
  await pa.fly(30000, async (st) => {
    if (!st?.me) return;
    if (st.dist !== undefined && st.dist < 220) {
      await pa.holdWeapon("01");
      await pa.holdWeapon("02");
    }
    if (Date.now() - shotAt > 4500) {
      shotAt = Date.now();
      mark(`   dist=${st.dist?.toFixed(0)} hull=${st.me.hull?.toFixed(0)} locked=${st.me.locked} spd=${st.hudSpeed} thr=${st.hudThrottle} fps=${st.fps?.toFixed(0)} steer=${st.steerActive}`);
      await snap(`firing-${Math.round((Date.now() - T0) / 1000)}s`);
      await closeup(A.page, `firing-${Math.round((Date.now() - T0) / 1000)}s`);
    }
  });
}, { flight: true });

await beat("shield up — hex bubble assemble / absorb / shatter", async () => {
  pa.goal = "close";
  const r = await pa.toggleModule("SHIELD");
  mark(`   shield toggle: ${JSON.stringify(r)}`);
  await snap("shield-deploying");
  await closeup(A.page, "shield-deploying");
  await pa.fly(900);
  await snap("shield-up");
  await closeup(A.page, "shield-up");
  // Sit in B's line of fire and photograph every absorb frame.
  for (let i = 0; i < 16; i++) {
    await closeup(A.page, `shield-${String(i).padStart(2, "0")}`);
    await pa.fly(420);
  }
  await snap("shield-after");
}, { flight: true });

await beat("VFX burst: point blank, rapid frames", async () => {
  pa.goal = "close";
  await pa.holdWeapon("01");
  await pa.holdWeapon("02");
  for (let i = 0; i < 16; i++) {
    await closeup(A.page, `vfx-${String(i).padStart(2, "0")}`);
    await pa.fly(420);
  }
  await snap("vfx-wide");
  await snapB("vfx-wide-other-side");
  await closeup(B.page, "vfx-other-side");
}, { flight: true });

await beat("take hits and die", async () => {
  pa.goal = "hold";
  pb.goal = "close";
  await pa.releaseWeapons();
  let died = false;
  let lowShot = false;
  await pa.fly(50000, async (st) => {
    if (!st?.me) return;
    if (!lowShot && st.me.hull > 0 && st.me.hull < 45) {
      lowShot = true;
      await snap("taking-hits-low-hull");
      await closeup(A.page, "taking-hits-low-hull");
    }
    if (st.me.hull <= 0 && !died) {
      died = true;
      mark(`   DIED at +${((Date.now() - T0) / 1000).toFixed(0)}s`);
      await snap("death");
    }
  });
  const st = await readState(A.page);
  mark(`   hull now ${st.me?.hull}, phase ${st.phase}, launchHold ${st.me?.launchHold}`);
  await snap("after-death");
}, { flight: true });

await beat("respawn and fight on", async () => {
  pa.goal = "chase";
  await pa.holdWeapon("01");
  await pa.holdWeapon("02");
  let sawHold = false;
  await pa.fly(22000, async (st) => {
    if (st?.me?.launchHold && !sawHold) {
      sawHold = true;
      mark(`   launch hold ${st.me.launchHold}`);
      await snap("respawn-hold");
    }
  });
  await snap("respawned");
  await snapB("other-side-late");
}, { flight: true });

await beat("boost", async () => {
  pa.goal = "boundary";
  await pa.fly(1200);
  const before = await readState(A.page);
  const ok = await pa.tapControl(".hud-boost-btn");
  await pa.fly(1200);
  await snap("boost-on");
  const cls = await A.page.locator(".hud-boost-btn").getAttribute("class").catch(() => "");
  await pa.fly(2500);
  const after = await readState(A.page);
  mark(`   boost tapped=${ok} class="${cls}"`);
  mark(`   speed ${before.me?.speed ?? "?"} -> ${after.me?.speed ?? "?"}`);
  await snap("boost-held");
}, { flight: true });

await beat("jettison", async () => {
  const before = await A.page.locator(".hud-jettison-btn").getAttribute("class").catch(() => "");
  const ok = await pa.tapControl(".hud-jettison-btn");
  await pa.fly(700);
  await snap("jettison");
  await pa.fly(1500);
  const after = await A.page.locator(".hud-jettison-btn").getAttribute("class").catch(() => "");
  mark(`   jettison tapped=${ok} class before="${before}" after="${after}"`);
}, { flight: true });

await beat("HUD chrome: in-match scoreboard and pause/settings", async () => {
  pa.goal = "hold";
  await pa.fly(600);
  await pa.tapControl(".hud-scoreboard-btn");
  await sleep(1000);
  mark(`   scoreboard opened: ${await A.page.locator(".hud-scoreboard").isVisible().catch(() => false)}`);
  await snap("scoreboard-in-match");
  await pa.tapControl(".hud-scoreboard-btn");
  await sleep(700);
  await pa.tapControl(".hud-settings-btn");
  await sleep(1400);
  await snap("settings-in-match");
  mark(`   quit-to-menu offered in pause: ${await A.page.locator("[data-settings-quit]").count()}`);
  const close = A.page
    .locator(".settings-overlay .settings-close, .settings-overlay [data-settings-close], .settings-overlay .sa-screen-btn")
    .first();
  if (await close.count()) await tapEl(A, close);
  else await A.page.keyboard.press("Escape");
  await sleep(900);
  mark(`   settings still open after close: ${await A.page.locator(".settings-overlay").isVisible().catch(() => false)}`);
  await snap("back-in-match");
}, { flight: true });

await beat("boundary run — the shield wall and its warning", async () => {
  await pa.releaseWeapons();
  pa.goal = "boundary";
  let far = 0;
  let warned = false;
  let wall = false;
  let hullAtWarn = null;
  await pa.fly(30000, async (st) => {
    if (!st?.me) return;
    const r = Math.hypot(st.me.x, st.me.z, st.me.y ?? 0);
    if (r > far + 25) {
      far = r;
      mark(`   radius ${r.toFixed(0)} hull=${st.me.hull?.toFixed(0)} spd=${st.hudSpeed} thr=${st.hudThrottle}`);
    }
    if (!warned) {
      const warn = await A.page.locator(".hud-notifications").innerText().catch(() => "");
      if (warn.trim()) {
        warned = true;
        hullAtWarn = st.me.hull;
        mark(`   boundary notification at r=${r.toFixed(0)}: ${JSON.stringify(warn.trim())}`);
        await snap("boundary-warning");
        await closeup(A.page, "boundary-warning");
      }
    }
    if (r > 118 && !wall) {
      wall = true;
      await snap("boundary-wall");
      await closeup(A.page, "boundary-wall");
    }
  });
  await snap("boundary-end");
  const st = await readState(A.page);
  mark(`   furthest radius ${far.toFixed(0)}, hull ${st.me?.hull?.toFixed?.(0)} (was ${hullAtWarn?.toFixed?.(0)} at the warning)`);
}, { flight: true });

await beat("kill feed / match status / toasts", async () => {
  const feed = await A.page.locator(".hud-kill-feed").innerText().catch(() => "");
  const status = await A.page.locator(".hud-match-status").innerText().catch(() => "");
  const notes = await A.page.locator(".hud-notifications").innerText().catch(() => "");
  mark(`   kill feed: ${JSON.stringify(feed.trim())}`);
  mark(`   match status: ${JSON.stringify(status.replace(/\n/g, " "))}`);
  mark(`   notifications: ${JSON.stringify(notes.trim())}`);
  if (feed.trim()) await snap("kill-feed");
});

// ---------------------------------------------------------- finish or leave
await beat("play out or leave", async () => {
  const results = A.page.locator(".hud-results");
  const deadline = Date.now() + Number(process.env.PLAYOUT_MS ?? 120000);
  pa.goal = "chase";
  while (Date.now() < deadline) {
    if (await results.isVisible().catch(() => false)) break;
    await pa.fly(4000);
  }
  if (await results.isVisible().catch(() => false)) {
    mark("   match ended on its own");
    await snap("results-outcome");
    await snapB("results-outcome-other-side");
    mark(`   outcome tag: ${await A.page.locator(".hud-results-outcome-tag").getAttribute("data-outcome").catch(() => null)}`);
    await sleep(4500);
    await snap("results-mvp");
    mark(`   results panel: ${JSON.stringify((await A.page.locator(".hud-results-panel").innerText().catch(() => "")).replace(/\n/g, " | "))}`);
    const next = A.page.locator("[data-results-action='next']");
    let taps = 0;
    while ((await next.count()) && taps < 3) {
      taps += 1;
      await tapEl(A, next);
      await sleep(1600);
      if (await A.page.locator(".hud-scoreboard").isVisible().catch(() => false)) break;
    }
    const sb = await A.page.locator(".hud-scoreboard").isVisible().catch(() => false);
    mark(`   NEXT taps needed to reach the scoreboard: ${taps} (reached=${sb})`);
    await snap("results-scoreboard");
    const menu = A.page.locator("[data-results-action='menu']").first();
    if (await menu.count()) await tapEl(A, menu);
    await sleep(2500);
    await snap("back-to-lobby");
  } else {
    mark("   still live — leaving through the pause menu");
    await pa.allStop();
    await pa.tapControl(".hud-settings-btn");
    await sleep(1200);
    await snap("pause-to-quit");
    const quit = A.page.locator("[data-settings-quit]");
    if (await quit.count()) await tapEl(A, quit);
    await sleep(3000);
    await snap("after-quit");
    mark(`   back at the lobby: ${await A.page.locator(".lobby-overlay").isVisible().catch(() => false)}`);
  }
});

bAlive = false;
await bLoop.catch(() => {});
await pa.allStop();
await pb.allStop();
await sleep(1500);
await shot(A.page, P("a-final"));

mark(`pilot A: flew ${pa.flown.toFixed(0)} m from spawn, steer re-taken ${pa.steerDrops}x, ${pa.tick} ticks`);
mark(`pilot B: flew ${pb.flown.toFixed(0)} m from spawn, steer re-taken ${pb.steerDrops}x, ${pb.tick} ticks`);
mark(`console counts A: ${JSON.stringify(A.counts)}`);
mark(`console counts B: ${JSON.stringify(B.counts)}`);
fs.writeFileSync(
  path.join(LOGS, `timeline-${modeKey}.txt`),
  timeline.join("\n") + "\n\n--- pilot A events ---\n" + pa.events.join("\n"),
);
await browser.close();
console.log("done:", modeKey);
