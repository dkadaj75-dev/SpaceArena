// Why does tapping the Sustained Beam card equip the Pulse Laser instead?
import { launchBrowser, openClient, dismissFullscreen, ensureAccount, sleep, tapEl, shot, centreOf } from "./rig.mjs";

const browser = await launchBrowser();
const A = await openClient(browser, "hangarcheck");
await dismissFullscreen(A);
await ensureAccount(A, "playtest-match-b", "playtest1234");
await tapEl(A, A.page.locator('.sa-menu-destination[data-lobby-action="hangar"]'));
await A.page.locator(".hangar-panel").waitFor({ state: "visible", timeout: 60000 });
await sleep(2500);

const slot = A.page.locator('.hangar-slot[data-kind="hardpoint"]').first();
console.log("slot before:", await slot.getAttribute("data-module"));
await tapEl(A, slot);
await sleep(1200);
await shot(A.page, "hc-sheet-open");

const cards = await A.page.locator(".hangar-card").evaluateAll((els) =>
  els.map((e) => {
    const r = e.getBoundingClientRect();
    return {
      mod: e.dataset.module,
      disabled: e.disabled,
      cls: e.className,
      box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      inView: r.x >= 0 && r.right <= 915 && r.y >= 0 && r.bottom <= 412,
    };
  }),
);
console.log("cards:\n" + cards.map((c) => ` ${c.mod} ${JSON.stringify(c.box)} inView=${c.inView} ${c.disabled ? "DISABLED" : ""} ${c.cls}`).join("\n"));

const want = "module.beamlaser-mk1";
const target = A.page.locator(`.hangar-card[data-module="${want}"]`);
console.log("target count:", await target.count());
console.log("box before scroll:", await target.first().boundingBox());
await target.first().evaluate((el) => el.scrollIntoView({ block: "center", inline: "center" }));
await sleep(900);
const boxAfter = await target.first().boundingBox();
console.log("box after scroll:", boxAfter);
await shot(A.page, "hc-scrolled");

// What is actually under that point at tap time?
const under = await A.page.evaluate(
  ([x, y]) => {
    const el = document.elementFromPoint(x, y);
    const card = el?.closest?.(".hangar-card");
    return { el: el ? `${el.tagName}.${el.className}` : null, card: card?.dataset?.module ?? null };
  },
  [boxAfter.x + boxAfter.width / 2, boxAfter.y + boxAfter.height / 2],
);
console.log("element under the target centre:", JSON.stringify(under));

await A.touch.tap(boxAfter.x + boxAfter.width / 2, boxAfter.y + boxAfter.height / 2, 90, 60);
await sleep(1500);
console.log("slot after tap:", await slot.getAttribute("data-module"));
await shot(A.page, "hc-after-tap");

// Second try: measure again immediately before the tap (no scroll in between).
await tapEl(A, slot);
await sleep(1000);
const b2 = await A.page.locator(`.hangar-card[data-module="${want}"]`).first().boundingBox();
const under2 = await A.page.evaluate(
  ([x, y]) => document.elementFromPoint(x, y)?.closest?.(".hangar-card")?.dataset?.module ?? null,
  [b2.x + b2.width / 2, b2.y + b2.height / 2],
);
console.log("second attempt box:", b2, "under:", under2);
await A.touch.tap(b2.x + b2.width / 2, b2.y + b2.height / 2, 91, 60);
await sleep(1500);
console.log("slot after second tap:", await slot.getAttribute("data-module"));
await shot(A.page, "hc-after-tap2");
await browser.close();
