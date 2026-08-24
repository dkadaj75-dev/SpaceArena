// Shared harness for the "menus" playtest agent.
// Persistent Chromium profile so the registered account survives between phase
// scripts; Samsung-phone landscape viewport for every shot.
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SHOTS = path.join(HERE, "shots");
const SEQ_FILE = path.join(HERE, ".seq.json");
const PROFILE = process.env.SA_PROFILE_DIR ||
  "C:/Users/kevin/AppData/Local/Temp/claude/D--WebCreation-SpaceArena/e8b67361-310d-46c5-b39c-476ea2a79911/scratchpad/menus-profile";

export const UA =
  "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";

export const VIEWPORT = { width: 915, height: 412 };

fs.mkdirSync(SHOTS, { recursive: true });

function nextSeq() {
  let n = 1;
  try {
    n = JSON.parse(fs.readFileSync(SEQ_FILE, "utf8")).n;
  } catch {}
  fs.writeFileSync(SEQ_FILE, JSON.stringify({ n: n + 1 }));
  return n;
}

export function resetSeq(n = 1) {
  fs.writeFileSync(SEQ_FILE, JSON.stringify({ n }));
}

/** Viewport screenshot with a zero-padded sequence prefix. */
export async function shot(page, name) {
  const seq = String(nextSeq()).padStart(3, "0");
  const file = path.join(SHOTS, `${seq}-${name}.png`);
  await page.screenshot({ path: file, timeout: 180000, animations: "allow" });
  console.log("  shot", `${seq}-${name}.png`);
  return file;
}

export async function launch({ persistent = true, headless = true } = {}) {
  // Headful uses the real GPU; headless has no compositor GPU here, so it
  // falls back to SwiftShader (too slow for this game's boot gate).
  const args = headless
    ? ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--use-gl=angle"]
    : ["--ignore-gpu-blocklist", "--enable-gpu-rasterization"];
  // rAF is throttled to zero in a window Windows thinks is occluded, which
  // stalls Babylon's render loop and wedges the boot gate on `diorama.ready()`.
  args.push(
    "--autoplay-policy=no-user-gesture-required",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling",
  );
  const opts = {
    headless,
    args,
    viewport: VIEWPORT,
    deviceScaleFactor: 2.625,
    isMobile: true,
    hasTouch: true,
    userAgent: UA,
    ignoreHTTPSErrors: true,
  };
  let ctx;
  if (persistent) {
    fs.mkdirSync(PROFILE, { recursive: true });
    ctx = await chromium.launchPersistentContext(PROFILE, opts);
  } else {
    const browser = await chromium.launch({ headless, args });
    ctx = await browser.newContext(opts);
    ctx.__browser = browser;
  }
  // Never let the localhost dev auto-login hijack our identity.
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem("sa.devLogin", "off");
    } catch {}
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  page.setDefaultTimeout(60000);
  const logs = [];
  page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
  return { ctx, page, logs };
}

export async function close(ctx) {
  if (ctx.__browser) await ctx.__browser.close();
  else await ctx.close();
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Boot the app and land on the lobby, dismissing the fullscreen offer if it is
 * shown. Returns whether the offer appeared this run.
 */
export async function bootToLobby(page, url = "http://localhost:5173/") {
  await page.goto(url, { waitUntil: "commit" });
  const prompt = page.locator(".sa-fullscreen-prompt");
  const lobby = page.locator(".lobby-overlay");
  let sawPrompt = false;
  for (let i = 0; i < 90; i++) {
    if (await prompt.isVisible().catch(() => false)) {
      sawPrompt = true;
      await prompt.getByText("Not now", { exact: true }).click();
    }
    if (await lobby.isVisible().catch(() => false)) break;
    await sleep(1000);
  }
  await lobby.waitFor({ state: "visible", timeout: 60000 });
  await sleep(2500);
  return sawPrompt;
}

/** Park the mouse off every control so no stray hover state leaks into a shot. */
export async function parkPointer(page) {
  await page.mouse.move(2, 2);
  await sleep(150);
}

/** Is the WebGL/WebGPU canvas actually drawing something other than black? */
export async function canvasAlive(page) {
  return page.evaluate(() => {
    const c = document.querySelector("#renderCanvas");
    if (!c) return { ok: false, why: "no canvas" };
    const r = c.getBoundingClientRect();
    const mid = document.elementFromPoint(r.width / 2, r.height / 2);
    return {
      ok: true,
      canvasSize: [c.width, c.height],
      rect: [Math.round(r.width), Math.round(r.height)],
      topElementAtCentre: mid ? `${mid.tagName}.${mid.className}` : null,
    };
  });
}
