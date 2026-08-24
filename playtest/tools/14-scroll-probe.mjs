import { launch, openShell, shot, resetCounter, goTo } from "./lib.mjs";

const { browser, page, errors } = await launch();
resetCounter(94);

async function probe(tool, group) {
  await goTo(page, group, tool);
  await page.waitForTimeout(2000);
  const before = await page.evaluate(() => {
    const b = document.querySelector(".ed-inspector-body");
    return { sh: b.scrollHeight, ch: b.clientHeight, overflowY: getComputedStyle(b).overflowY, st: b.scrollTop };
  });
  await page.evaluate(() => { document.querySelector(".ed-inspector-body").scrollTop = 600; });
  const t0 = await page.evaluate(() => document.querySelector(".ed-inspector-body").scrollTop);
  await page.waitForTimeout(1200);
  const t1 = await page.evaluate(() => document.querySelector(".ed-inspector-body").scrollTop);
  await page.waitForTimeout(3000);
  const t2 = await page.evaluate(() => document.querySelector(".ed-inspector-body").scrollTop);
  console.log(`${group}/${tool}: ${JSON.stringify(before)} setTo600 -> immediately=${t0} after1.2s=${t1} after4.2s=${t2} ${t2 === 0 && t0 === 600 ? "<<< SCROLL RESET" : ""}`);
  return { tool, before, t0, t1, t2 };
}

try {
  await openShell(page);
  const rows = [];
  rows.push(await probe("Map", "World"));
  rows.push(await probe("Inspector", "World"));
  rows.push(await probe("Ships", "Ships"));
  rows.push(await probe("Modules", "Ships"));
  rows.push(await probe("Bots", "Content"));
  rows.push(await probe("Theme", "System"));
  rows.push(await probe("Quality", "System"));

  // Visual proof on Map: scroll with a real wheel gesture over the panel, then shoot.
  await goTo(page, "World", "Map");
  await page.waitForTimeout(2000);
  await page.mouse.move(715, 300);
  for (let i = 0; i < 12; i += 1) { await page.mouse.wheel(0, 200); await page.waitForTimeout(120); }
  await page.waitForTimeout(400);
  const afterWheel = await page.evaluate(() => document.querySelector(".ed-inspector-body").scrollTop);
  console.log("Map after 12 wheel ticks, scrollTop =", afterWheel);
  await shot(page, "map-after-wheel-scroll");
  await page.waitForTimeout(4000);
  const later = await page.evaluate(() => document.querySelector(".ed-inspector-body").scrollTop);
  console.log("Map 4s later, scrollTop =", later);
  await shot(page, "map-wheel-scroll-4s-later");

  // Same gesture on Bots (a panel that does not track the scene)
  await goTo(page, "Content", "Bots");
  await page.waitForTimeout(1500);
  await page.mouse.move(715, 300);
  for (let i = 0; i < 8; i += 1) { await page.mouse.wheel(0, 200); await page.waitForTimeout(120); }
  console.log("Bots after wheel, scrollTop =", await page.evaluate(() => document.querySelector(".ed-inspector-body").scrollTop));
  await shot(page, "bots-after-wheel-scroll");

  console.log("\nSUMMARY", JSON.stringify(rows.map((r) => [r.tool, r.t0, r.t2]), null, 0));
} catch (e) {
  console.log("ERR", e.stack);
} finally {
  console.log("--- ERRORS ---\n" + errors.filter((e) => e.startsWith("[error]") || e.startsWith("[pageerror]")).slice(0, 10).join("\n"));
  await browser.close();
}
