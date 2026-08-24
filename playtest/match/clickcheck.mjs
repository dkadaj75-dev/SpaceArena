// Hypothesis: HUD controls wired to `click` (SHIELD/other toggle modules, the
// SCORE button, the settings gear) do not respond while a second finger — the
// steering thumb — is already on the screen, because Chrome suppresses the
// synthesized click during a multi-touch gesture. The pointerdown-driven
// controls (weapon triggers, BOOST, JETTISON) are unaffected.
import { launchBrowser, openClient, dismissFullscreen, ensureAccount, sleep, tapEl, shot, centreOf } from "./rig.mjs";
import { Pilot } from "./pilot.mjs";

const browser = await launchBrowser();
const A = await openClient(browser, "clickcheck");
await dismissFullscreen(A);
await ensureAccount(A, "playtest-match-a", "playtest1234");
await tapEl(A, A.page.locator('.sa-menu-category[data-lobby-action="team deathmatch"]'));
await sleep(600);
await tapEl(A, A.page.locator('.sa-menu-card[data-gamemode="gamemode.practice-bots"]'));
await A.page.locator(".hud-modules .hud-module-btn").first().waitFor({ state: "visible", timeout: 180000 });
await sleep(7000);

const p = new Pilot(A);
await p.findSteerOrigin();

const shieldBtn = A.page.locator(".hud-module-btn").filter({ has: A.page.locator('.slot-type:text-is("SHIELD")') }).first();

const state = async () => ({
  shield: (await shieldBtn.getAttribute("class").catch(() => "")).match(/state-\w+/)?.[0] ?? "none",
  simShield: await A.page.evaluate(() => {
    const s = window.__debug.session;
    const me = s.curSnapshot.ships.find((x) => x.id === s.playerId);
    return me?.modules?.find((m) => m.moduleId.includes("shield"))?.state ?? "n/a";
  }),
  scoreboard: await A.page.locator(".hud-scoreboard").isVisible().catch(() => false),
  settings: await A.page.locator(".settings-overlay").isVisible().catch(() => false),
});

const tapAt = async (locator, id) => {
  const c = await centreOf(locator);
  if (!c) return console.log("   (control not on screen)");
  await A.touch.tap(c.x, c.y, id, 80);
  await sleep(1200);
};

async function trial(label) {
  console.log(`\n=== ${label} (fingers down: ${[...A.touch.points.keys()].join(",") || "none"}) ===`);
  console.log("  before:", JSON.stringify(await state()));

  await tapAt(shieldBtn, 51);
  console.log("  after SHIELD tap :", JSON.stringify(await state()));

  await tapAt(A.page.locator(".hud-scoreboard-btn"), 52);
  console.log("  after SCORE tap  :", JSON.stringify(await state()));
  if (await A.page.locator(".hud-scoreboard").isVisible().catch(() => false)) {
    await tapAt(A.page.locator(".hud-scoreboard-btn"), 53);
  }

  await tapAt(A.page.locator(".hud-settings-btn"), 54);
  const s = await state();
  console.log("  after GEAR tap   :", JSON.stringify(s));
  if (s.settings) {
    await shot(A.page, `cc-settings-${label.replace(/\W+/g, "-")}`);
    console.log("  quit-to-menu present:", await A.page.locator("[data-settings-quit]").count());
    // "Resume match" is the only way out on touch. It is click-bound too, so
    // lift every finger before pressing it or the overlay stays put.
    const held = [...A.touch.points.entries()].map(([id, pt]) => [id, pt.x, pt.y]);
    for (const [id] of held) await A.touch.up(id);
    await sleep(300);
    await tapAt(A.page.locator("[data-settings-close]"), 56);
    console.log("  settings closed by Resume:", !(await A.page.locator(".settings-overlay").isVisible().catch(() => false)));
    for (const [id, x, y] of held) await A.touch.down(id, x, y);
    await sleep(300);
  }

  // Controls of the other kind, for contrast.
  const boost = A.page.locator(".hud-boost-btn");
  const bBefore = await boost.getAttribute("class");
  await tapAt(boost, 55);
  console.log(`  BOOST (pointerdown-driven): "${bBefore}" -> "${await boost.getAttribute("class")}"`);
}

await trial("no other finger down");

await p.pressSteer();
await sleep(400);
await trial("steering thumb held");

await p.allStop();
await sleep(600);
await trial("finger released again");

await browser.close();
