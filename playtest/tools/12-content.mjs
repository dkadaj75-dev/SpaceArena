import { launch, openShell, shot, resetCounter, goTo } from "./lib.mjs";

const { browser, page, errors } = await launch();
resetCounter(42);

async function scrollTo(y) {
  await page.evaluate((v) => { document.querySelector(".ed-inspector-body").scrollTop = v; }, y);
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
  await page.waitForTimeout(600);
  return r;
}
async function openAll() {
  await page.evaluate(() => { for (const d of document.querySelectorAll(".ed-inspector-body details")) d.open = true; });
  await page.waitForTimeout(700);
}
async function pickSelect(idx, value) {
  const r = await page.evaluate(({ i, v }) => {
    const s = document.querySelectorAll(".ed-inspector-body select")[i];
    if (!s) return null;
    const opt = [...s.options].find((o) => o.text === v || o.value === v);
    if (!opt) return `no option ${v}`;
    s.value = opt.value;
    s.dispatchEvent(new Event("change", { bubbles: true }));
    return opt.text;
  }, { i: idx, v: value });
  await page.waitForTimeout(2000);
  return r;
}
async function metrics(label) {
  const m = await page.evaluate(() => {
    const b = document.querySelector(".ed-inspector-body");
    const inputs = [...b.querySelectorAll("input, select, button")];
    const small = inputs.filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.height < 28 || r.width < 28); });
    return {
      scrollH: b.scrollHeight, clientH: b.clientHeight,
      hOverflow: b.scrollWidth > b.clientWidth ? `${b.scrollWidth}>${b.clientWidth}` : "none",
      controls: inputs.length, subMinTargets: small.length,
      smallest: small.slice(0, 4).map((e) => { const r = e.getBoundingClientRect(); return `${e.tagName}:${Math.round(r.width)}x${Math.round(r.height)}`; }),
    };
  });
  console.log(`  METRICS ${label}:`, JSON.stringify(m));
  return m;
}

try {
  await openShell(page);

  // ---------------- ASSETS ----------------
  await goTo(page, "Content", "Assets");
  await shot(page, "assets-default-asteroid");
  await metrics("Assets");
  await openSection("shape");
  await shot(page, "assets-shape-section");
  await openSection("collision");
  await shot(page, "assets-collision-bounds");
  await openSection("surface");
  await shot(page, "assets-surface-render");
  console.log("asteroid ->", await pickSelect(0, "Twin Lobe"));
  await scrollTo(0);
  await shot(page, "assets-twin-lobe");

  // ---------------- ACTIONS ----------------
  await goTo(page, "Content", "Actions");
  await shot(page, "actions-default");
  await metrics("Actions");
  console.log("action ->", await pickSelect(0, "Play Shield Up Sound"));
  await shot(page, "actions-shield-up-sound");
  // kind dropdown options
  const kinds = await page.evaluate(() => [...document.querySelectorAll(".ed-inspector-body select")[1].options].map((o) => o.text));
  console.log("action kinds:", kinds.join(" | "));
  console.log("action kind ->", await pickSelect(1, kinds[1]));
  await shot(page, "actions-kind-switched-schema");

  // ---------------- NOTIFICATIONS ----------------
  await goTo(page, "Content", "Notifications");
  await shot(page, "notifications-default");
  await metrics("Notifications");
  console.log("notif ->", await pickSelect(0, "Fire Blocked"));
  await shot(page, "notifications-fire-blocked");
  // VALIDATION PROBE: type a non-numeric value into durationMs, screenshot, restore.
  const probe = await page.evaluate(() => {
    const nums = [...document.querySelectorAll(".ed-inspector-body input")];
    const t = nums.find((i) => /duration/i.test(i.previousElementSibling?.textContent || i.closest(".ed-row")?.textContent || ""));
    if (!t) return { ok: false };
    const before = t.value;
    t.focus();
    t.value = "-99999";
    t.dispatchEvent(new Event("input", { bubbles: true }));
    t.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, before, type: t.type };
  });
  console.log("validation probe:", JSON.stringify(probe));
  await page.waitForTimeout(1500);
  await shot(page, "notifications-validation-negative-duration");
  const status = await page.evaluate(() => ({
    badge: document.querySelector(".ed-status-count")?.textContent,
    title: document.querySelector(".ed-status")?.title,
    dirty: document.querySelector(".ed-dirty")?.textContent,
    warns: [...document.querySelectorAll(".ed-warn, .ed-callout")].map((e) => e.textContent.trim().slice(0, 90)),
  }));
  console.log("STATUS after invalid value:", JSON.stringify(status));
  // Problems panel with a live problem
  await goTo(page, "System", "Problems");
  await shot(page, "problems-panel-with-entry");
  console.log("problems text:", (await page.evaluate(() => document.querySelector(".ed-inspector-body")?.innerText.slice(0, 400))));
  // restore
  await goTo(page, "Content", "Notifications");
  await page.evaluate((v) => {
    const nums = [...document.querySelectorAll(".ed-inspector-body input")];
    const t = nums.find((i) => /duration/i.test(i.previousElementSibling?.textContent || i.closest(".ed-row")?.textContent || ""));
    if (t) { t.value = v; t.dispatchEvent(new Event("input", { bubbles: true })); t.dispatchEvent(new Event("change", { bubbles: true })); }
  }, probe.before);
  await page.waitForTimeout(800);
  console.log("restored durationMs to", probe.before);

  // ---------------- BOTS ----------------
  await goTo(page, "Content", "Bots");
  await shot(page, "bots-default-rookie");
  await metrics("Bots");
  await openSection("behaviors");
  await shot(page, "bots-behaviors-list");
  await openSection("flight");
  await shot(page, "bots-flight-section");
  await openSection("ctfWeights");
  await shot(page, "bots-ctf-weights");
  console.log("profile ->", await pickSelect(0, "Flag Runner"));
  await scrollTo(0);
  await shot(page, "bots-flag-runner");
  await openAll();
  await shot(page, "bots-all-sections-expanded");

  // ---------------- MODES ----------------
  await goTo(page, "Content", "Modes");
  await shot(page, "modes-default-duel");
  await metrics("Modes");
  await openSection("winCondition");
  await shot(page, "modes-win-condition");
  await openSection("^ctf$");
  await shot(page, "modes-ctf-section");
  console.log("mode ->", await pickSelect(0, "5v5 Capture the Flag"));
  await scrollTo(0);
  await shot(page, "modes-ctf-5v5");
  await openSection("shipPool");
  await shot(page, "modes-ship-pool-references");

  console.log("DONE content");
} catch (e) {
  console.log("ERR", e.stack);
  await shot(page, "error-content");
} finally {
  console.log("--- ERRORS ---\n" + errors.filter((e) => e.startsWith("[error]") || e.startsWith("[pageerror]")).slice(0, 15).join("\n"));
  await browser.close();
}
