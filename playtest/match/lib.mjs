// Shared rig for the "match" playtest agent. Not part of the game build.
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

export const BASE = "http://localhost:5173";
export const SHOTS = path.resolve(process.cwd(), "playtest/match/shots");
export const LOGS = path.resolve(process.cwd(), "playtest/match/logs");

export const DEVICE = {
  viewport: { width: 915, height: 412 },
  deviceScaleFactor: 2.625,
  isMobile: true,
  hasTouch: true,
  userAgent:
    "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.126 Mobile Safari/537.36",
};

export const LAUNCH_ARGS = [
  "--use-angle=swiftshader",
  "--enable-unsafe-swiftshader",
  "--use-gl=angle",
  "--ignore-gpu-blocklist",
  "--enable-webgl",
  "--disable-dev-shm-usage",
  "--autoplay-policy=no-user-gesture-required",
];

fs.mkdirSync(SHOTS, { recursive: true });
fs.mkdirSync(LOGS, { recursive: true });

let shotN = 0;
export function nextShotIndex(n) {
  shotN = n;
}
export async function shot(page, name, opts = {}) {
  shotN += 1;
  const file = path.join(SHOTS, `${String(shotN).padStart(3, "0")}-${name}.png`);
  await page.screenshot({ path: file, ...opts });
  console.log(`  [shot] ${path.basename(file)}`);
  return file;
}

export async function launch(headless = true) {
  return chromium.launch({ headless, args: LAUNCH_ARGS });
}

/** A named console/error log sink per context. */
export function attachLog(page, tag) {
  const file = path.join(LOGS, `console-${tag}.log`);
  const stream = fs.createWriteStream(file, { flags: "a" });
  const write = (line) => stream.write(`[${new Date().toISOString()}] ${line}\n`);
  page.on("console", (msg) => write(`${msg.type()}: ${msg.text()}`));
  page.on("pageerror", (err) => write(`pageerror: ${err.message}`));
  page.on("requestfailed", (r) => write(`requestfailed: ${r.url()} :: ${r.failure()?.errorText}`));
  return { file, write, close: () => stream.end() };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Boot to the lobby as a freshly registered account. */
export async function bootAndRegister(browser, nickname, password, tag) {
  const ctx = await browser.newContext({ ...DEVICE });
  const page = await ctx.newPage();
  const log = attachLog(page, tag);
  await page.goto(`${BASE}/?login=1`, { waitUntil: "domcontentloaded" });

  const prompt = page.locator(".sa-fullscreen-prompt");
  await prompt.waitFor({ state: "visible", timeout: 60000 });
  return { ctx, page, log, prompt, nickname, password, tag };
}

export async function dismissFullscreen(page) {
  const prompt = page.locator(".sa-fullscreen-prompt");
  if (await prompt.isVisible().catch(() => false)) {
    await prompt.getByText("Not now", { exact: true }).click();
    await prompt.waitFor({ state: "hidden", timeout: 15000 });
  }
}

export async function register(page, nickname, password) {
  const auth = page.locator(".auth-overlay");
  await auth.waitFor({ state: "visible", timeout: 30000 });
  // Expand the forms and pick the Register tab.
  await auth.getByText("Log in / Register", { exact: true }).click();
  await page.locator(".sa-screen-tab", { hasText: "Register" }).click();
  const panel = page.locator(".auth-overlay .sa-screen-panel").nth(1);
  await panel.locator("input[type=text]").fill(nickname);
  await panel.locator("input[type=password]").fill(password);
  await panel.getByRole("button", { name: "Register", exact: true }).click();
  await page.locator(".lobby-overlay").waitFor({ state: "visible", timeout: 60000 });
}
