import { launch, openShell, shot, resetCounter, goTo } from "./lib.mjs";

const { browser, page, errors } = await launch();
resetCounter(97);

async function seek(re, label) {
  const hit = await page.evaluate((rs) => {
    const rx = new RegExp(rs, "i");
    const body = document.querySelector(".ed-inspector-body");
    const cands = [...body.querySelectorAll("details, .ed-map-section, .ed-map-section-title, summary")];
    const t = cands.find((d) => rx.test(d.textContent || ""));
    if (!t) return null;
    if (t.tagName === "DETAILS") t.open = true;
    t.scrollIntoView({ block: "start" });
    return t.textContent.trim().slice(0, 50);
  }, re);
  await page.waitForTimeout(800);
  await shot(page, label);
  return hit;
}

try {
  await openShell(page);
  await goTo(page, "World", "Map");
  await page.waitForTimeout(3000);

  // Chrome budget: how much of the 412px screen is left for form content?
  const budget = await page.evaluate(() => {
    const r = (s) => { const e = document.querySelector(s); return e ? Math.round(e.getBoundingClientRect().height) : 0; };
    const body = document.querySelector(".ed-inspector-body");
    const sticky = [...body.querySelectorAll("*")].find((e) => getComputedStyle(e).position === "sticky");
    return {
      screen: innerHeight, topbar: r(".ed-topbar"), toolrow: r(".ed-toolrow"),
      inspectorHead: r(".ed-inspector-head"), inspectorBody: r(".ed-inspector-body"),
      stickyToolbar: sticky ? Math.round(sticky.getBoundingClientRect().height) : 0,
      stickyClass: sticky ? String(sticky.className).slice(0, 40) : "none",
    };
  });
  budget.formVisible = budget.inspectorBody - budget.stickyToolbar;
  budget.chromePct = Math.round(100 * (budget.screen - budget.formVisible) / budget.screen);
  console.log("CHROME BUDGET (Map):", JSON.stringify(budget));

  console.log(await seek("Layers", "map-layers-section"));
  console.log(await seek("Asset browser", "map-asset-browser"));
  console.log(await seek("Props \\(25\\)", "map-props-palette-25"));
  console.log(await seek("Asteroids \\(6\\)", "map-asteroids-palette-6"));
  console.log(await seek("Transforms", "map-transforms-gizmo"));
  console.log(await seek("List of asteroidPlacements", "map-placements-list-46"));
  console.log(await seek("List of spawnPoints", "map-spawnpoints-list"));
  console.log(await seek("List of flagBases", "map-flagbases-list"));
  console.log(await seek("navGraph", "map-navgraph"));
  console.log(await seek("skybox", "map-skybox-section"));

  // Prop palette hit targets
  const palette = await page.evaluate(() => {
    const btns = [...document.querySelectorAll(".ed-inspector-body button")].filter((b) => /·/.test(b.textContent));
    return btns.slice(0, 5).map((b) => { const r = b.getBoundingClientRect(); return { t: b.textContent.trim().slice(0, 30), w: Math.round(r.width), h: Math.round(r.height) }; });
  });
  console.log("prop palette buttons:", JSON.stringify(palette));

  // Switch arena to prove the selector works
  const arena = await page.evaluate(() => {
    const s = document.querySelector(".ed-inspector-body select");
    const o = [...s.options].find((x) => /Lunar Rift/i.test(x.text));
    if (o) { s.value = o.value; s.dispatchEvent(new Event("change", { bubbles: true })); return o.text; }
    return null;
  });
  console.log("arena ->", arena);
  await page.waitForTimeout(5000);
  await shot(page, "map-arena-switched-lunar-rift");

  console.log("DONE map fixup");
} catch (e) {
  console.log("ERR", e.stack);
  await shot(page, "error-map-fixup");
} finally {
  console.log("--- ERRORS ---\n" + errors.filter((e) => e.startsWith("[error]") || e.startsWith("[pageerror]")).slice(0, 10).join("\n"));
  await browser.close();
}
