import { launch, openShell, shot, resetCounter, goTo } from "./lib.mjs";

const { browser, page, errors } = await launch();
resetCounter(65);

async function scrollTo(y) {
  await page.evaluate((v) => { document.querySelector(".ed-inspector-body").scrollTop = v; }, y);
  await page.waitForTimeout(500);
}
async function scrollX(x) {
  await page.evaluate((v) => {
    const b = document.querySelector(".ed-inspector-body");
    b.scrollLeft = v;
    for (const e of b.querySelectorAll("*")) if (e.scrollWidth > e.clientWidth + 4) e.scrollLeft = v;
  }, x);
  await page.waitForTimeout(500);
}
async function openSection(re) {
  const r = await page.evaluate((rs) => {
    const rx = new RegExp(rs, "i");
    const ds = [...document.querySelectorAll(".ed-inspector-body details")];
    const t = ds.find((d) => rx.test(d.querySelector("summary")?.textContent || ""));
    if (t) { t.open = true; t.scrollIntoView({ block: "center" }); return t.querySelector("summary").textContent.trim().slice(0, 40); }
    return null;
  }, re);
  await page.waitForTimeout(700);
  return r;
}
async function metrics(label) {
  const m = await page.evaluate(() => {
    const b = document.querySelector(".ed-inspector-body");
    const ctrls = [...b.querySelectorAll("input, select, button")];
    const small = ctrls.filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.height < 28 || r.width < 28); });
    const wide = [...b.querySelectorAll("*")].filter((e) => e.scrollWidth > e.clientWidth + 4)
      .map((e) => `${e.tagName}.${String(e.className).slice(0, 26)}:${e.scrollWidth}>${e.clientWidth}`);
    return { scrollH: b.scrollHeight, clientH: b.clientHeight,
      hOverflow: b.scrollWidth > b.clientWidth ? `${b.scrollWidth}>${b.clientWidth}` : "none",
      innerHScrollers: wide.slice(0, 6), controls: ctrls.length,
      subMinTargets: small.length,
      smallest: [...new Set(small.map((e) => { const r = e.getBoundingClientRect(); return `${e.tagName}:${Math.round(r.width)}x${Math.round(r.height)}`; }))].slice(0, 6) };
  });
  console.log(`  METRICS ${label}:`, JSON.stringify(m));
  return m;
}

try {
  await openShell(page);

  // ---------------- TUNING ----------------
  await goTo(page, "Balance", "Tuning");
  await shot(page, "tuning-default");
  await metrics("Tuning");
  // The "find field" search box — type into it (a filter, not content)
  const found = await page.evaluate(() => {
    const i = document.querySelector(".ed-inspector-body input[type=search], .ed-inspector-body input");
    if (!i) return null;
    i.focus(); i.value = "camera";
    i.dispatchEvent(new Event("input", { bubbles: true }));
    return i.placeholder || i.type;
  });
  console.log("tuning find field:", found);
  await page.waitForTimeout(900);
  await shot(page, "tuning-find-field-filtered");
  await page.evaluate(() => {
    const i = document.querySelector(".ed-inspector-body input[type=search], .ed-inspector-body input");
    if (i) { i.value = ""; i.dispatchEvent(new Event("input", { bubbles: true })); }
  });
  await page.waitForTimeout(700);
  await openSection("Default Tuning");
  await shot(page, "tuning-default-tuning-expanded");
  await openSection("Default Tactical Camera");
  await shot(page, "tuning-tactical-camera-expanded");

  // ---------------- BALANCE WORKBENCH ----------------
  await goTo(page, "Balance", "Balance");
  await page.waitForTimeout(2500);
  await shot(page, "balance-workbench-default");
  const bm = await metrics("Balance");
  await shot(page, "balance-stat-comparison-table");
  await scrollX(400);
  await shot(page, "balance-stat-table-scrolled-right");
  await scrollX(0);
  await scrollTo(260);
  await shot(page, "balance-ttk-matrix");
  await scrollTo(480);
  await shot(page, "balance-custom-fit");
  await scrollTo(700);
  await shot(page, "balance-60s-engagement-simulator");
  // simulator canvas
  const canv = await page.evaluate(() => {
    const c = document.querySelector(".ed-inspector-body canvas");
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return { css: [Math.round(r.width), Math.round(r.height)], attr: [c.width, c.height] };
  });
  console.log("simulator canvas:", JSON.stringify(canv));
  // change the custom fit hull
  const fit = await page.evaluate(() => {
    const sels = [...document.querySelectorAll(".ed-inspector-body select")];
    const s = sels[0];
    const o = [...s.options].find((x) => /Brawler/i.test(x.text));
    if (o) { s.value = o.value; s.dispatchEvent(new Event("change", { bubbles: true })); return o.text; }
    return null;
  });
  console.log("balance hull ->", fit);
  await page.waitForTimeout(2500);
  await shot(page, "balance-custom-fit-brawler");

  // ---------------- THEME ----------------
  await goTo(page, "System", "Theme");
  await page.waitForTimeout(2000);
  await shot(page, "theme-default");
  await metrics("Theme");
  await openSection("colors");
  await shot(page, "theme-colors-swatches");
  await openSection("^hud$");
  await shot(page, "theme-hud-section");
  await openSection("moduleCluster");
  await shot(page, "theme-hud-modulecluster");
  await openSection("^landscape$");
  await shot(page, "theme-hud-landscape-overrides");
  await openSection("haptics");
  await shot(page, "theme-haptics-patterns");
  await openSection("^menu$");
  await shot(page, "theme-menu-backdrop");
  const colorInputs = await page.evaluate(() =>
    [...document.querySelectorAll('.ed-inspector-body input[type="color"]')].map((e) => {
      const r = e.getBoundingClientRect(); return `${Math.round(r.width)}x${Math.round(r.height)}`;
    }).slice(0, 8));
  console.log("theme color swatch sizes:", JSON.stringify(colorInputs));

  // ---------------- QUALITY ----------------
  await goTo(page, "System", "Quality");
  await shot(page, "quality-default-four-tiers");
  await metrics("Quality");
  await openSection("Low \\(budget phones\\)");
  await shot(page, "quality-low-tier-expanded");
  await openSection("^render$");
  await shot(page, "quality-low-render-fields");
  await openSection("Ultra");
  await shot(page, "quality-ultra-tier");

  // ---------------- CONSOLE ----------------
  await goTo(page, "System", "Console");
  await shot(page, "console-default-help");
  await metrics("Console");
  for (const [cmd, name] of [["help", "help"], ["ls ship", "ls-ship"], ["get ship.interceptor core", "get-ship-core"], ["bogus", "unknown-command"]]) {
    const ok = await page.evaluate((c) => {
      const i = document.querySelector(".ed-inspector-body input");
      if (!i) return false;
      i.focus(); i.value = c;
      i.dispatchEvent(new Event("input", { bubbles: true }));
      i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      const form = i.closest("form");
      if (form) form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      return true;
    }, cmd);
    await page.waitForTimeout(1200);
    console.log(`console "${cmd}" dispatched=${ok}`);
    await shot(page, `console-${name}`);
  }
  console.log("console tail:", await page.evaluate(() => document.querySelector(".ed-inspector-body")?.innerText.slice(-600)));

  // ---------------- PROBLEMS (clean) ----------------
  await goTo(page, "System", "Problems");
  await shot(page, "problems-panel-clean");

  // Top bar affordances
  const bar = await page.evaluate(() => {
    const m = (s) => [...document.querySelectorAll(s)].map((b) => { const r = b.getBoundingClientRect(); return { t: b.textContent.trim().slice(0, 20), w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x) }; });
    return { right: m(".ed-topbar-right button"), groups: m(".ed-nav-group"), tools: m(".ed-toolrow .ed-tab"),
      toolrowOverflow: (() => { const t = document.querySelector(".ed-toolrow"); return t ? `${t.scrollWidth}>${t.clientWidth}` : null; })() };
  });
  console.log("TOPBAR/System:", JSON.stringify(bar));
  await shot(page, "shell-topbar-system-group");

  console.log("DONE balance+system");
} catch (e) {
  console.log("ERR", e.stack);
  await shot(page, "error-balance-system");
} finally {
  console.log("--- ERRORS ---\n" + errors.filter((e) => e.startsWith("[error]") || e.startsWith("[pageerror]")).slice(0, 15).join("\n"));
  await browser.close();
}
