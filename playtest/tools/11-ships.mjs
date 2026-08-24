import { launch, openShell, shot, resetCounter, goTo } from "./lib.mjs";

const { browser, page, errors } = await launch();
resetCounter(15);

const body = () => page.locator(".ed-inspector-body");
async function scrollTo(y) {
  await page.evaluate((v) => { document.querySelector(".ed-inspector-body").scrollTop = v; }, y);
  await page.waitForTimeout(500);
}
async function openSection(re) {
  return page.evaluate((r) => {
    const rx = new RegExp(r, "i");
    const ds = [...document.querySelectorAll(".ed-inspector-body details")];
    const t = ds.find((d) => rx.test(d.querySelector("summary")?.textContent || ""));
    if (t) { t.open = true; t.scrollIntoView({ block: "center" }); return t.querySelector("summary").textContent.trim(); }
    return null;
  }, re.source ?? re);
}
async function clickByText(sel, re) {
  return page.evaluate(({ s, r }) => {
    const rx = new RegExp(r, "i");
    const b = [...document.querySelectorAll(s)].find((x) => rx.test(x.textContent || ""));
    if (b) { b.scrollIntoView({ block: "center" }); b.click(); return b.textContent.trim(); }
    return null;
  }, { s: sel, r: re });
}
async function pickSelect(idx, value) {
  return page.evaluate(({ i, v }) => {
    const s = document.querySelectorAll(".ed-inspector-body select")[i];
    if (!s) return null;
    const opt = [...s.options].find((o) => o.text === v || o.value === v);
    if (!opt) return `no option ${v}`;
    s.value = opt.value;
    s.dispatchEvent(new Event("change", { bubbles: true }));
    return opt.text;
  }, { i: idx, v: value });
}

try {
  await openShell(page);

  // ================= SHIPS (ShipManagerModules -> ShipManager) =================
  await goTo(page, "Ships", "Ships");
  await page.waitForTimeout(2500);
  await shot(page, "ships-default-interceptor");

  const shipSel = await page.evaluate(() =>
    [...document.querySelectorAll(".ed-inspector-body select")[0].options].map((o) => o.text));
  console.log("SHIPS:", shipSel.join(", "));

  // Socket list + selected socket panel
  const socketBtns = await page.evaluate(() =>
    [...document.querySelectorAll(".ed-inspector-body button")].filter((b) => /^[◆◇✦]/.test(b.textContent.trim()))
      .map((b) => { const r = b.getBoundingClientRect(); return { t: b.textContent.trim().slice(0, 34), w: Math.round(r.width), h: Math.round(r.height) }; }));
  console.log("SOCKETS:", JSON.stringify(socketBtns, null, 0));

  await scrollTo(0);
  await shot(page, "ships-toolbar-top");
  const sec1 = await openSection(/Ship model \(GLB\)/);
  console.log("sec:", sec1);
  await shot(page, "ships-model-glb-section");
  await openSection(/Sockets/);
  await shot(page, "ships-sockets-list");

  const picked = await clickByText(".ed-inspector-body button", "hp-wing-l");
  console.log("socket picked:", picked);
  await page.waitForTimeout(1500);
  await shot(page, "ships-socket-selected-hp-wing-l");

  await openSection(/Selected socket/);
  await shot(page, "ships-selected-socket-form");

  await openSection(/Default fitting/);
  await shot(page, "ships-default-fitting");

  await openSection(/Combat role profile/);
  await shot(page, "ships-combat-role-profile");

  await openSection(/Signal simulator/);
  await shot(page, "ships-signal-simulator");

  await openSection(/Core stats/);
  await page.waitForTimeout(500);
  await shot(page, "ships-core-stats-schema-form");
  await openSection(/^hull$/);
  await shot(page, "ships-core-stats-hull-expanded");

  // 3D preview + draggable socket markers per ship
  for (const name of ["Brawler", "Starpiercer", "Talon"]) {
    const r = await pickSelect(0, name);
    console.log("ship ->", r);
    await page.waitForTimeout(3500);
    await scrollTo(0);
    await shot(page, `ships-3d-preview-${name.toLowerCase()}`);
  }
  // Back to Interceptor and show the marker overlay in the viewport
  await pickSelect(0, "Interceptor");
  await page.waitForTimeout(3000);
  await shot(page, "ships-3d-preview-interceptor-markers");

  // Toggle "Show fitted modules" (view-state only)
  const tg = await clickByText(".ed-inspector-body button, .ed-toolbar button", "Show fitted modules");
  console.log("toggle:", tg);
  await page.waitForTimeout(2500);
  await shot(page, "ships-fitted-modules-hidden");
  await clickByText(".ed-inspector-body button, .ed-toolbar button", "Show fitted modules");
  await page.waitForTimeout(2000);

  // ================= SKINS =================
  await goTo(page, "Ships", "Skins");
  await page.waitForTimeout(3000);
  await shot(page, "skins-default");
  await scrollTo(200);
  await shot(page, "skins-body-canopy-sections");
  await scrollTo(420);
  await shot(page, "skins-propulsion-emissive");
  const sk = await pickSelect(1, "Tiger");
  console.log("skin ->", sk);
  await page.waitForTimeout(3000);
  await scrollTo(0);
  await shot(page, "skins-tiger-preview");
  const sk2 = await pickSelect(1, "Zebra");
  console.log("skin ->", sk2);
  await page.waitForTimeout(3000);
  await shot(page, "skins-zebra-preview");

  // ================= MODULES =================
  await goTo(page, "Ships", "Modules");
  await page.waitForTimeout(2500);
  await shot(page, "modules-default-pulse-laser");
  await openSection(/^render$/);
  await shot(page, "modules-render-section");
  await openSection(/^fire$/);
  await shot(page, "modules-fire-section");
  await openSection(/^projectile$/);
  await shot(page, "modules-projectile-section");
  const md = await pickSelect(0, "Deflector Shield Mk I");
  console.log("module ->", md);
  await page.waitForTimeout(2000);
  await scrollTo(0);
  await shot(page, "modules-deflector-shield");
  await openSection(/mitigation/);
  await shot(page, "modules-mitigation-section");

  console.log("DONE ships");
} catch (e) {
  console.log("ERR", e.stack);
  await shot(page, "error-ships");
} finally {
  console.log("--- CONSOLE ---\n" + errors.filter((e) => e.startsWith("[error]") || e.startsWith("[pageerror]")).slice(0, 15).join("\n"));
  await browser.close();
}
