import { launch, boot, shot, resetCounter, openDesignerViaSettings, clickDesignerButton, goTo, setSheet, tapSheetHandle, canvasAlive } from "./lib.mjs";

const { browser, page, errors } = await launch();
resetCounter(0);
try {
  await boot(page);
  await shot(page, "lobby-landscape-915x412");
  console.log("CANVAS", JSON.stringify(await canvasAlive(page)));

  await openDesignerViaSettings(page);
  await shot(page, "settings-screen");
  await page.evaluate(() => document.querySelector("[data-settings-designer]").scrollIntoView({ block: "center" }));
  await page.waitForTimeout(600);
  await shot(page, "settings-constellation-designer-button");

  await clickDesignerButton(page);
  await page.waitForSelector("#space-arena-editor");
  await page.waitForTimeout(2500);
  await shot(page, "shell-open-map-default");

  // --- layout metrics: is the phone bottom-sheet CSS active at 915px? ---
  const layout = await page.evaluate(() => {
    const ed = document.getElementById("space-arena-editor");
    const insp = document.querySelector(".ed-inspector");
    const handle = document.querySelector(".ed-sheet-handle");
    const body = document.querySelector(".ed-inspector-body");
    const topbar = document.querySelector(".ed-topbar");
    const toolrow = document.querySelector(".ed-toolrow");
    const r = (e) => (e ? (({ x, y, width, height }) => ({ x, y, w: width, h: height }))(e.getBoundingClientRect()) : null);
    return {
      viewport: [innerWidth, innerHeight],
      mobileSheetMediaMatches: matchMedia("(max-width: 720px)").matches,
      sheetAttr: ed?.dataset.sheet,
      inspector: r(insp),
      inspectorBody: r(body),
      bodyScrollH: body?.scrollHeight,
      bodyClientH: body?.clientHeight,
      handleDisplay: handle ? getComputedStyle(handle).display : "missing",
      handleRect: r(handle),
      topbar: r(topbar), topbarH: topbar?.getBoundingClientRect().height,
      toolrow: r(toolrow),
      gridCols: ed ? getComputedStyle(ed).gridTemplateColumns : null,
    };
  });
  console.log("LAYOUT", JSON.stringify(layout, null, 1));

  // Try cycling the sheet via the handle (the documented touch affordance).
  for (const i of [1, 2, 3]) {
    const s = await tapSheetHandle(page);
    const h = await page.evaluate(() => document.querySelector(".ed-inspector")?.getBoundingClientRect().height);
    console.log(`sheet tap ${i} -> data-sheet=${s} inspectorHeight=${h}`);
    await shot(page, `sheet-state-${s}`);
  }
  await setSheet(page, "half");

  // Hit-target audit of the two nav rows
  const nav = await page.evaluate(() => {
    const m = (sel) => [...document.querySelectorAll(sel)].map((b) => {
      const r = b.getBoundingClientRect();
      return { t: b.textContent.trim(), w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x) };
    });
    const tr = document.querySelector(".ed-toolrow");
    return { groups: m(".ed-nav-group"), tools: m(".ed-toolrow .ed-tab"),
      toolrowScroll: tr ? { sw: tr.scrollWidth, cw: tr.clientWidth } : null,
      topbarBtns: m(".ed-topbar-right button") };
  });
  console.log("NAV", JSON.stringify(nav, null, 1));

  // ---- MAP ----
  await goTo(page, "World", "Map");
  await shot(page, "map-default");
  // Expand the asset browser + first sections
  await page.evaluate(() => {
    const b = document.querySelector(".ed-inspector-body");
    b.scrollTop = 0;
  });
  await shot(page, "map-toolbar-layers");
  await page.evaluate(() => { document.querySelector(".ed-inspector-body").scrollTop = 300; });
  await page.waitForTimeout(400);
  await shot(page, "map-asset-browser-props");
  await page.evaluate(() => { document.querySelector(".ed-inspector-body").scrollTop = 700; });
  await page.waitForTimeout(400);
  await shot(page, "map-asteroid-palette");
  // Open a placement record's details
  const opened = await page.evaluate(() => {
    const ds = [...document.querySelectorAll(".ed-inspector-body details")];
    const t = ds.find((d) => /asteroidPlacements 1/i.test(d.querySelector("summary")?.textContent || ""));
    if (t) { t.open = true; t.scrollIntoView({ block: "center" }); return true; }
    return false;
  });
  await page.waitForTimeout(600);
  console.log("opened placement detail:", opened);
  await shot(page, "map-placement-record-expanded");
  // Deep sections: lighting / render / skybox
  await page.evaluate(() => {
    const ds = [...document.querySelectorAll(".ed-inspector-body details")];
    for (const d of ds) if (/lighting|render|skybox|sun|star|boundaryShield/i.test(d.querySelector("summary")?.textContent || "")) d.open = true;
    const t = ds.find((d) => /skybox/i.test(d.querySelector("summary")?.textContent || ""));
    t?.scrollIntoView({ block: "center" });
  });
  await page.waitForTimeout(600);
  await shot(page, "map-lighting-render-skybox");

  // Layer visibility toggles (non-destructive view-state only)
  await page.evaluate(() => { document.querySelector(".ed-inspector-body").scrollTop = 0; });
  await page.waitForTimeout(300);
  const layerBox = await page.evaluate(() => {
    const c = document.querySelector(".ed-layer-row .ed-check input");
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  });
  console.log("layer checkbox hit target:", JSON.stringify(layerBox));

  // ---- INSPECTOR ----
  await goTo(page, "World", "Inspector");
  await shot(page, "inspector-default");
  await page.evaluate(() => { document.querySelector(".ed-inspector-body").scrollTop = 500; });
  await page.waitForTimeout(400);
  await shot(page, "inspector-scrolled-placements");

  console.log("DONE world");
} catch (e) {
  console.log("ERR", e.stack);
  await shot(page, "error-world");
} finally {
  console.log("--- CONSOLE ---\n" + errors.slice(0, 12).join("\n"));
  await browser.close();
}
