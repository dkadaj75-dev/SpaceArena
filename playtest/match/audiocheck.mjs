// Audio cannot be heard from here, so instrument the mixer instead: wrap
// AudioManager.play / playLoop / stopLoop and record what each held trigger
// asks for. Autocannon should be a short one-shot per burst; the sustained
// beam should open a loop and hold it while the trigger is down.
import fs from "node:fs";
import path from "node:path";
import { launchBrowser, openClient, dismissFullscreen, ensureAccount, settle, sleep, tapEl, shot, LOGS } from "./rig.mjs";
import { Pilot } from "./pilot.mjs";

const browser = await launchBrowser();
const A = await openClient(browser, "audiocheck");
await dismissFullscreen(A);
await ensureAccount(A, "playtest-match-a", "playtest1234");

async function fit(modules) {
  await tapEl(A, A.page.locator('.sa-menu-destination[data-lobby-action="hangar"]'));
  await A.page.locator(".hangar-panel").waitFor({ state: "visible", timeout: 60000 });
  await settle(A.page);
  for (let i = 0; i < modules.length; i++) {
    const slot = A.page.locator('.hangar-slot[data-kind="hardpoint"]').nth(i);
    await tapEl(A, slot);
    await sleep(1600);
    for (let attempt = 0; attempt < 3; attempt++) {
      const card = A.page.locator(`.hangar-card[data-module="${modules[i]}"]`).first();
      if (!(await card.count())) { console.log(`  ${modules[i]} not offered for hp${i}`); break; }
      await tapEl(A, card);
      await sleep(1200);
      if ((await slot.getAttribute("data-module")) === modules[i]) break;
      console.log(`  retry hp${i} (got ${await slot.getAttribute("data-module")})`);
      await tapEl(A, slot);
      await sleep(1600);
    }
    console.log(`  hp${i} -> ${await slot.getAttribute("data-module")}`);
  }
  await tapEl(A, A.page.locator(".hangar-close"));
  await A.page.locator(".lobby-overlay").waitFor({ state: "visible", timeout: 30000 });
  await settle(A.page);
}
await fit(["module.beamlaser-mk1", "module.kinetic-mk1"]);

await tapEl(A, A.page.locator('.sa-menu-category[data-lobby-action="team deathmatch"]'));
await sleep(500);
await tapEl(A, A.page.locator('.sa-menu-card[data-gamemode="gamemode.practice-bots"]'));
await A.page.locator(".hud-modules .hud-module-btn").first().waitFor({ state: "visible", timeout: 200000 });
await sleep(7000);

await A.page.evaluate(() => {
  const am = window.__debug.audio;
  window.__snd = [];
  const t0 = performance.now();
  for (const m of ["play", "playLoop", "stopLoop"]) {
    const orig = am[m].bind(am);
    am[m] = (...args) => {
      window.__snd.push({ t: +(performance.now() - t0).toFixed(0), m, args: args.map((a) => String(a)) });
      return orig(...args);
    };
  }
});

const p = new Pilot(A);
await p.findSteerOrigin();
p.goal = "close";

const buttons = await p.listModules();
console.log("HUD buttons:", JSON.stringify(buttons.map((b) => `${b.side}/${b.slot}/${b.type}`)));

const sample = async (label, slot, ms) => {
  await A.page.evaluate(() => (window.__snd.length = 0));
  await p.holdWeapon(slot);
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await p.step().catch(() => {});
    await sleep(120);
  }
  await p.releaseWeapon(slot);
  await sleep(600);
  const snd = await A.page.evaluate(() => window.__snd.slice());
  const byId = {};
  for (const e of snd) {
    const key = `${e.m}(${e.args.slice(0, 2).join(",")})`;
    byId[key] = (byId[key] ?? 0) + 1;
  }
  console.log(`\n=== ${label} — trigger held ${ms}ms ===`);
  console.log("  calls:", JSON.stringify(byId, null, 1));
  console.log("  first 12 events:", JSON.stringify(snd.slice(0, 12)));
  const after = await A.page.evaluate(() => {
    const am = window.__debug.audio;
    return { loopsRunning: am.loops ? am.loops.size : "n/a" };
  });
  console.log("  loops still running after release:", JSON.stringify(after));
  return { label, byId, sample: snd.slice(0, 30) };
};

const results = [];
results.push(await sample("SUSTAINED BEAM (beamlaser-mk1, slot 01)", "01", 6000));
await sleep(1500);
results.push(await sample("AUTOCANNON (kinetic-mk1, slot 02)", "02", 6000));

await shot(A.page, "audio-final");
fs.writeFileSync(path.join(LOGS, "audio-cues.json"), JSON.stringify(results, null, 1));
await p.allStop();
await browser.close();
