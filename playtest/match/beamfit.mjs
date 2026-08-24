// Can account A fit the Sustained Beam at all? List what each hardpoint offers.
import { launchBrowser, openClient, dismissFullscreen, ensureAccount, settle, sleep, tapEl, shot } from "./rig.mjs";

const who = process.argv[2] ?? "playtest-match-a";
const browser = await launchBrowser();
const A = await openClient(browser, "beamfit");
await dismissFullscreen(A);
await ensureAccount(A, who, "playtest1234");
await tapEl(A, A.page.locator('.sa-menu-destination[data-lobby-action="hangar"]'));
await A.page.locator(".hangar-panel").waitFor({ state: "visible", timeout: 60000 });
await settle(A.page);

const hp = await A.page.locator('.hangar-slot[data-kind="hardpoint"]').evaluateAll((els) =>
  els.map((e) => ({ module: e.dataset.module, socket: e.dataset.socket, label: e.querySelector(".hangar-slot-label")?.textContent })),
);
console.log(`${who} hardpoints:`, JSON.stringify(hp, null, 1));
console.log("ship:", await A.page.locator(".hangar-ship-name").textContent().catch(() => "?"));

for (let i = 0; i < hp.length; i++) {
  const slot = A.page.locator('.hangar-slot[data-kind="hardpoint"]').nth(i);
  await tapEl(A, slot);
  await sleep(1800);
  const cards = await A.page.locator(".hangar-card").evaluateAll((els) =>
    els.map((e) => ({ m: e.dataset.module, disabled: e.disabled, fitted: e.classList.contains("fitted"), unavailable: e.classList.contains("unavailable") })),
  );
  const beam = cards.find((c) => c.m === "module.beamlaser-mk1");
  console.log(`\nhp${i} (${hp[i].socket}) offers ${cards.length} cards; beamlaser-mk1 -> ${JSON.stringify(beam)}`);
  console.log("  enabled cards:", cards.filter((c) => !c.disabled).map((c) => c.m).join(", "));
  if (beam && !beam.disabled) {
    const card = A.page.locator('.hangar-card[data-module="module.beamlaser-mk1"]').first();
    const box = await card.boundingBox();
    console.log("  beam card box:", JSON.stringify(box));
    if (box) {
      await A.touch.tap(box.x + box.width / 2, box.y + box.height / 2, 92, 70);
      await sleep(1500);
      console.log(`  after tap hp${i} -> ${await slot.getAttribute("data-module")}`);
    }
  }
  await shot(A.page, `bf-hp${i}`);
}
await browser.close();
