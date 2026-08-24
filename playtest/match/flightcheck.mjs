// One client, one online match, and a control-by-control audit of the HUD.
import { launchBrowser, openClient, dismissFullscreen, ensureAccount, shot, sleep, tapEl, readState } from "./rig.mjs";
import { Pilot } from "./pilot.mjs";

const browser = await launchBrowser();
const A = await openClient(browser, "flightcheck");
await dismissFullscreen(A);
await ensureAccount(A, "playtest-match-a", "playtest1234");
console.log("in lobby");

await tapEl(A, A.page.locator('.sa-menu-category[data-lobby-action="team deathmatch"]'));
await sleep(600);
await tapEl(A, A.page.locator('.sa-menu-card[data-gamemode="gamemode.practice-bots"]'));
await A.page.locator(".hud-modules .hud-module-btn").first().waitFor({ state: "visible", timeout: 180000 });
console.log("HUD up");
await sleep(6000); // let the countdown finish

const p = new Pilot(A);
await p.findSteerOrigin();

const st0 = await readState(A.page);
console.log("keys on a snapshot ship:", Object.keys(st0.ships[0] ?? {}));
const raw = await A.page.evaluate(() => {
  const s = window.__debug.session;
  const me = s.curSnapshot.ships.find((x) => x.id === s.playerId);
  return Object.fromEntries(Object.entries(me).map(([k, v]) => [k, typeof v === "object" ? JSON.stringify(v) : v]));
});
console.log("raw me:", JSON.stringify(raw, null, 1).slice(0, 1200));

const probe = async (label) => {
  const s = await A.page.evaluate(() => {
    const d = window.__debug.session;
    const me = d.curSnapshot.ships.find((x) => x.id === d.playerId);
    const hudThr = document.querySelector(".hud-throttle-readout")?.textContent;
    const hudSpd = document.querySelector(".hud-speed-value")?.textContent;
    return {
      x: +me.pos.x.toFixed(1), y: +me.pos.y.toFixed(1), z: +me.pos.z.toFixed(1),
      heading: +me.heading.toFixed(2), pitch: +me.pitch.toFixed(2),
      throttle: me.throttle, hull: +me.hull.toFixed(0),
      launchLocked: me.launchLocked, launchHold: me.launchHold,
      hudThr, hudSpd,
      mods: me.modules?.map((m) => `${m.moduleId.replace("module.", "")}:${m.state}`).join(" "),
    };
  });
  console.log(`${label.padEnd(26)} ${JSON.stringify(s)}`);
  return s;
};

await probe("baseline");

// --- throttle ------------------------------------------------------------
console.log("\n-- throttle lever --");
await p.pressSteer();
await p.setThrottle(1.0);
await sleep(1500);
await probe("after drag to 100%");
await sleep(3000);
await probe("3s later");
await shot(A.page, "fc-throttle-full");

// --- steering ------------------------------------------------------------
console.log("\n-- steering (hold the stick hard right) --");
const h0 = (await probe("before turn")).heading;
for (let i = 0; i < 25; i++) {
  await p.c.touch.moveMany([[1, p.steerOrigin.x + 95, p.steerOrigin.y]]);
  await sleep(120);
}
const h1 = (await probe("after 3s hard right")).heading;
console.log("heading delta:", (h1 - h0).toFixed(2));
await shot(A.page, "fc-turning");

console.log("\n-- pitch (stick hard up) --");
const pt0 = (await probe("before pitch")).pitch;
for (let i = 0; i < 25; i++) {
  await p.c.touch.moveMany([[1, p.steerOrigin.x, p.steerOrigin.y - 95]]);
  await sleep(120);
}
const pt1 = (await probe("after 3s stick up")).pitch;
console.log("pitch delta:", (pt1 - pt0).toFixed(2), "(positive = climbing)");
await p.c.touch.moveMany([[1, p.steerOrigin.x, p.steerOrigin.y]]);

// --- boost ---------------------------------------------------------------
console.log("\n-- boost --");
const b0 = await probe("before boost");
await p.tapControl(".hud-boost-btn");
await sleep(2000);
const b1 = await probe("after boost tap");
console.log("boost btn class:", await A.page.locator(".hud-boost-btn").getAttribute("class"));
const d0 = Math.hypot(b0.x, b0.z), d1 = Math.hypot(b1.x, b1.z);
console.log("moved", Math.hypot(b1.x - b0.x, b1.y - b0.y, b1.z - b0.z).toFixed(1), "m in 2s");
await shot(A.page, "fc-boost");

// --- weapons -------------------------------------------------------------
console.log("\n-- weapon triggers --");
const slots = await A.page.locator('.hud-module-btn[data-side="weapons"]').evaluateAll((els) =>
  els.map((e) => ({ slot: e.dataset.slot, cls: e.className, text: e.innerText.replace(/\n/g, "/") })),
);
console.log("weapon buttons:", JSON.stringify(slots, null, 1));
for (const s of slots) {
  await p.holdWeapon(s.slot);
  await sleep(2500);
  const cls = await A.page.locator(`.hud-module-btn[data-slot="${s.slot}"]`).getAttribute("class");
  console.log(`  slot ${s.slot} while held: ${cls}`);
  await probe(`  firing ${s.slot}`);
  await p.releaseWeapon(s.slot);
  await sleep(500);
}

// --- jettison ------------------------------------------------------------
console.log("\n-- jettison --");
console.log("before:", await A.page.locator(".hud-jettison-btn").getAttribute("class"));
await p.tapControl(".hud-jettison-btn");
await sleep(1500);
console.log("after :", await A.page.locator(".hud-jettison-btn").getAttribute("class"));
await probe("after jettison");

await p.allStop();
await shot(A.page, "fc-final");
await browser.close();
