// Shared harness for the "tools" playtest agent.
// Samsung-phone LANDSCAPE profile, auto-login as dev admin on localhost.
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

export const SHOTS = path.resolve("D:/WebCreation/SpaceArena/SpaceArena/playtest/tools/shots");
fs.mkdirSync(SHOTS, { recursive: true });

const UA =
  "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";

export const DEVICE = {
  viewport: { width: 915, height: 412 },
  deviceScaleFactor: 2.625,
  isMobile: true,
  hasTouch: true,
  userAgent: UA,
};

let counter = 0;
export function resetCounter(n = 0) { counter = n; }

export async function shot(page, name) {
  counter += 1;
  const file = path.join(SHOTS, `${String(counter).padStart(2, "0")}-${name}.png`);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await page.screenshot({ path: file, timeout: 45000, animations: "disabled", caret: "initial" });
      console.log("  SHOT", path.basename(file));
      return file;
    } catch (e) {
      console.log(`  shot retry ${attempt} (${name}): ${e.message.split("\n")[0]}`);
      await page.waitForTimeout(1500);
    }
  }
  console.log("  SHOT FAILED", name);
  return null;
}

export async function launch() {
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--use-gl=angle",
      "--ignore-gpu-blocklist",
      "--enable-webgl",
    ],
  });
  const ctx = await browser.newContext(DEVICE);
  const page = await ctx.newPage();
  page.setDefaultTimeout(120000);
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") errors.push(`[${m.type()}] ${m.text().slice(0, 300)}`);
  });
  page.on("pageerror", (e) => errors.push(`[pageerror] ${String(e).slice(0, 300)}`));
  return { browser, ctx, page, errors };
}

/** Boot the game, dismiss the fullscreen prompt, land on the lobby. */
export async function boot(page) {
  await page.goto("http://localhost:5173", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(6000);
  // Dismiss "Go fullscreen?" — click "Not now" / "Got it" whichever is present.
  const dismissed = await page.evaluate(() => {
    const btns = [...document.querySelectorAll(".sa-fullscreen-prompt button")];
    const hit = btns.find((b) => /Not now|Got it/i.test(b.textContent || ""));
    if (hit) { hit.click(); return hit.textContent; }
    return null;
  });
  if (dismissed) console.log("  dismissed fullscreen prompt via", dismissed);
  // The lobby can arrive late (auth + asset preload). Poll rather than race it,
  // and keep re-dismissing the fullscreen prompt in case it shows up after.
  await page.waitForFunction(() => {
    const b = document.querySelector(".sa-fullscreen-prompt button");
    if (b && /Not now|Got it/i.test(b.textContent || "")) b.click();
    const g = document.querySelector("[data-lobby-settings]");
    return !!g && g.getBoundingClientRect().width > 0;
  }, null, { timeout: 120000, polling: 500 });
  await page.waitForTimeout(2500);
}

/** Is the WebGL canvas actually painting (not a black rectangle)? */
export async function canvasAlive(page) {
  return page.evaluate(() => {
    const c = document.querySelector("canvas");
    if (!c) return { ok: false, why: "no canvas" };
    const r = c.getBoundingClientRect();
    const mid = document.elementFromPoint(Math.round(r.width / 2), Math.round(r.height / 2));
    return {
      ok: true,
      size: [c.width, c.height],
      occludedBy: mid ? `${mid.tagName}.${mid.className}`.slice(0, 120) : "none",
      canvasIsTopMost: mid === c,
    };
  });
}

/** Open the designer via the Settings screen (no keyboard). */
// The lobby header re-renders on presence pushes, so Playwright's own
// visibility wait thrashes on it. Every wait below is a JS predicate instead.
export async function openDesignerViaSettings(page) {
  for (let i = 1; i <= 8; i += 1) {
    await page.evaluate(() => document.querySelector("[data-lobby-settings]")?.click());
    await page.waitForTimeout(2000);
    const ok = await page.evaluate(() => !!document.querySelector("[data-settings-designer]"));
    if (ok) return page;
    console.log(`  settings open retry ${i}`);
    await page.waitForTimeout(1500);
  }
  throw new Error("settings screen never exposed [data-settings-designer]");
}

/**
 * The Settings button calls EditorShell.toggle(), so a second click CLOSES the
 * shell. Click exactly once, then wait a long time — the shell is a dynamic
 * import and EditorStage warm-up is slow under SwiftShader.
 */
export async function clickDesignerButton(page) {
  if (await page.evaluate(() => !!document.getElementById("space-arena-editor"))) return;
  await page.evaluate(() => {
    const b = document.querySelector("[data-settings-designer]");
    b.scrollIntoView({ block: "center" });
    b.click();
  });
  await page.waitForFunction(() => {
    const ed = document.getElementById("space-arena-editor");
    return !!ed && ed.getBoundingClientRect().width > 0 && !!document.querySelector(".ed-inspector-body");
  }, null, { timeout: 120000, polling: 500 });
  await page.waitForTimeout(3000);
}

/** Full path: boot -> settings -> designer shell open. */
export async function openShell(page) {
  await boot(page);
  await openDesignerViaSettings(page);
  await clickDesignerButton(page);
  await page.waitForTimeout(1500);
}

/** Switch category group then tool, by visible label. */
export async function goTo(page, group, tool) {
  await page.evaluate((g) => {
    const b = [...document.querySelectorAll(".ed-nav-group")].find((x) => x.textContent.trim() === g);
    if (b) b.click();
  }, group);
  await page.waitForTimeout(600);
  if (tool) {
    await page.evaluate((t) => {
      const b = [...document.querySelectorAll(".ed-toolrow .ed-tab")].find((x) => x.textContent.trim() === t);
      if (b) b.click();
    }, tool);
    await page.waitForTimeout(2500);
  }
}

/** Expand the bottom sheet to its tallest state so panels are readable. */
export async function setSheet(page, state) {
  await page.evaluate((s) => {
    const ed = document.getElementById("space-arena-editor");
    if (ed) ed.dataset.sheet = s;
  }, state);
  await page.waitForTimeout(700);
}

/** Cycle the sheet by tapping the drag handle (the real touch affordance). */
export async function tapSheetHandle(page) {
  await page.evaluate(() => document.querySelector(".ed-sheet-handle")?.click());
  await page.waitForTimeout(700);
  return page.evaluate(() => document.getElementById("space-arena-editor")?.dataset.sheet);
}

/** Read the shell's category row + tool row. */
export async function shellNav(page) {
  return page.evaluate(() => {
    const root = document.querySelector(".ed-root, [class*='ed-root']") || document.querySelector(".ed-shell");
    const groups = [...document.querySelectorAll(".ed-groups .ed-tab, .ed-groups button")].map((b) => ({
      label: b.textContent, active: b.classList.contains("is-active"),
    }));
    const tools = [...document.querySelectorAll(".ed-toolrow .ed-tab")].map((b) => ({
      label: b.textContent, active: b.classList.contains("is-active"),
    }));
    return { hasRoot: !!root, groups, tools };
  });
}
