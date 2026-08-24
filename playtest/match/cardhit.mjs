// What is actually on top of each module card in the sheet?
import { launchBrowser, openClient, dismissFullscreen, ensureAccount, settle, sleep, tapEl, shot } from "./rig.mjs";

const browser = await launchBrowser();
const A = await openClient(browser, "cardhit");
await dismissFullscreen(A);
await ensureAccount(A, "playtest-match-a", "playtest1234");
await tapEl(A, A.page.locator('.sa-menu-destination[data-lobby-action="hangar"]'));
await A.page.locator(".hangar-panel").waitFor({ state: "visible", timeout: 60000 });
await settle(A.page);
await tapEl(A, A.page.locator('.hangar-slot[data-kind="hardpoint"]').first());
await sleep(1800);

const probe = await A.page.evaluate(() => {
  const out = [];
  for (const card of document.querySelectorAll(".hangar-card")) {
    const r = card.getBoundingClientRect();
    if (r.right < 0 || r.left > innerWidth || r.bottom < 0 || r.top > innerHeight) continue;
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    const top = document.elementFromPoint(cx, cy);
    out.push({
      module: card.dataset.module,
      box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      point: [Math.round(cx), Math.round(cy)],
      topEl: top ? `${top.tagName}.${(top.className || "").toString().slice(0, 60)}` : null,
      reachesCard: top ? !!top.closest(".hangar-card") : false,
      topCard: top?.closest?.(".hangar-card")?.dataset?.module ?? null,
    });
  }
  return out;
});
console.log("card hit-test:");
for (const c of probe) console.log(` ${String(c.module).padEnd(26)} box=${JSON.stringify(c.box)} pt=${JSON.stringify(c.point)} top=${c.topEl} -> ${c.topCard}`);

// What sits over the blocked region?
const blocked = probe.find((c) => c.topCard !== c.module);
if (blocked) {
  const chain = await A.page.evaluate(
    ([x, y]) => {
      const els = document.elementsFromPoint(x, y);
      return els.slice(0, 6).map((e) => {
        const r = e.getBoundingClientRect();
        const cs = getComputedStyle(e);
        return `${e.tagName}.${(e.className || "").toString().slice(0, 50)} [${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)},${Math.round(r.height)}] z=${cs.zIndex} pe=${cs.pointerEvents}`;
      });
    },
    blocked.point,
  );
  console.log(`\nstack at ${JSON.stringify(blocked.point)} (over ${blocked.module}):`);
  for (const c of chain) console.log("  " + c);
}
await shot(A.page, "ch-sheet");
await browser.close();
