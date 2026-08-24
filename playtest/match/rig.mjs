// Playtest rig: two phone-shaped clients, real touch input over CDP.
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

export const BASE = "http://localhost:5173";
const ROOT = path.resolve(process.cwd(), "playtest/match");
export const SHOTS = path.join(ROOT, "shots");
export const LOGS = path.join(ROOT, "logs");
fs.mkdirSync(SHOTS, { recursive: true });
fs.mkdirSync(LOGS, { recursive: true });

export const DEVICE = {
  viewport: { width: 915, height: 412 },
  deviceScaleFactor: 2.625,
  isMobile: true,
  hasTouch: true,
  userAgent:
    "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.126 Mobile Safari/537.36",
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- screenshots
let counter = Number(process.env.SHOT_START ?? 0);
export function shotCounter() {
  return counter;
}
export async function shot(page, name) {
  counter += 1;
  const file = path.join(SHOTS, `${String(counter).padStart(3, "0")}-${name}.png`);
  try {
    await page.screenshot({ path: file, timeout: 30000 });
    console.log(`  [shot] ${path.basename(file)}`);
  } catch (e) {
    console.log(`  [shot FAILED] ${name}: ${e.message.split("\n")[0]}`);
  }
  return file;
}

// ------------------------------------------------------------------- browser
export async function launchBrowser() {
  // Headless SwiftShader renders the menu at ~0.7 fps on this box (see REPORT),
  // so the playtest drives a real GPU in a headed window.
  return chromium.launch({
    headless: false,
    args: ["--disable-dev-shm-usage", "--autoplay-policy=no-user-gesture-required", "--window-size=960,520"],
  });
}

/** Wait until the page's rAF loop is healthy — boot/asset work blocks input. */
export async function settle(page, { minFps = 20, windows = 2, maxMs = 120000 } = {}) {
  const start = Date.now();
  let good = 0;
  let last = 0;
  while (Date.now() - start < maxMs) {
    const fps = await page
      .evaluate(
        () =>
          new Promise((res) => {
            const t = performance.now();
            let f = 0;
            const tick = () => {
              f++;
              if (performance.now() - t > 800) return res(f / ((performance.now() - t) / 1000));
              requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
          }),
      )
      .catch(() => 0);
    last = fps;
    good = fps >= minFps ? good + 1 : 0;
    if (good >= windows) return fps;
  }
  console.log(`  [settle timed out at ${last.toFixed(1)} fps]`);
  return last;
}

// --------------------------------------------------------------- touch driver
/**
 * Multi-finger touch over CDP, which is what a phone actually sends: the app's
 * pointer captures and per-pointer trigger holds all behave for real.
 * CDP diffs the supplied point set against the previous one, so every call
 * sends the FULL set of live fingers.
 */
export class Touch {
  constructor(cdp) {
    this.cdp = cdp;
    this.points = new Map();
  }
  get list() {
    return [...this.points.values()].map((p) => ({ x: p.x, y: p.y, id: p.id, radiusX: 6, radiusY: 6, force: 1 }));
  }
  async send(type) {
    await this.cdp.send("Input.dispatchTouchEvent", { type, touchPoints: this.list, modifiers: 0 });
  }
  async down(id, x, y) {
    this.points.set(id, { id, x, y });
    await this.send("touchStart");
  }
  async move(id, x, y) {
    const p = this.points.get(id);
    if (!p) return;
    p.x = x;
    p.y = y;
    await this.send("touchMove");
  }
  /** Move several fingers in one event, the way a real two-thumb grip does. */
  async moveMany(updates) {
    let changed = false;
    for (const [id, x, y] of updates) {
      const p = this.points.get(id);
      if (!p) continue;
      if (p.x !== x || p.y !== y) changed = true;
      p.x = x;
      p.y = y;
    }
    if (changed) await this.send("touchMove");
  }
  async up(id) {
    if (!this.points.has(id)) return;
    this.points.delete(id);
    await this.send("touchEnd");
  }
  async releaseAll() {
    for (const id of [...this.points.keys()]) await this.up(id);
  }
  async tap(x, y, id = 90, holdMs = 60) {
    await this.down(id, x, y);
    await sleep(holdMs);
    await this.up(id);
  }
  isDown(id) {
    return this.points.has(id);
  }
}

/** Centre of a locator, in CSS viewport pixels. */
export async function centreOf(locator) {
  const b = await locator.boundingBox();
  return b ? { x: b.x + b.width / 2, y: b.y + b.height / 2, box: b } : null;
}

/**
 * Tap a locator with a real finger, scrolling its container first when the
 * control sits outside the 915x412 viewport (which several menu forms do).
 * Returns "tap" or "click" so the caller can record when a finger could not
 * reach the control.
 */
export async function tapEl(c, locator, { holdMs = 60, id = 90 } = {}) {
  const vh = DEVICE.viewport.height;
  const vw = DEVICE.viewport.width;
  let pt = await centreOf(locator);
  if (!pt || pt.y < 0 || pt.y > vh || pt.x < 0 || pt.x > vw) {
    await locator.evaluate((el) => el.scrollIntoView({ block: "center", inline: "center" })).catch(() => {});
    await sleep(300);
    pt = await centreOf(locator);
  }
  if (pt && pt.y >= 0 && pt.y <= vh && pt.x >= 0 && pt.x <= vw) {
    await c.touch.tap(pt.x, pt.y, id, holdMs);
    return "tap";
  }
  await locator.evaluate((el) => el.click());
  return "click";
}

// ---------------------------------------------------------------- one client
export async function openClient(browser, tag) {
  const ctx = await browser.newContext({ ...DEVICE });
  const page = await ctx.newPage();
  const logFile = path.join(LOGS, `console-${tag}.log`);
  const stream = fs.createWriteStream(logFile, { flags: "a" });
  const counts = { error: 0, warning: 0, log: 0, pageerror: 0 };
  const note = (s) => stream.write(`[${new Date().toISOString()}] ${s}\n`);
  page.on("console", (m) => {
    counts[m.type()] = (counts[m.type()] ?? 0) + 1;
    note(`${m.type()}: ${m.text()}`);
  });
  page.on("pageerror", (e) => {
    counts.pageerror += 1;
    note(`pageerror: ${e.message}`);
  });
  page.on("requestfailed", (r) => note(`requestfailed: ${r.url()} :: ${r.failure()?.errorText}`));

  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Input.setIgnoreInputEvents", { ignore: false }).catch(() => {});
  const touch = new Touch(cdp);

  await page.goto(`${BASE}/?login=1`, { waitUntil: "domcontentloaded" });
  await page.locator(".sa-fullscreen-prompt").waitFor({ state: "visible", timeout: 90000 });
  await settle(page);
  return { tag, ctx, page, cdp, touch, logFile, counts, note };
}

export async function dismissFullscreen(c) {
  const p = c.page.locator(".sa-fullscreen-prompt");
  if (await p.isVisible().catch(() => false)) {
    const pt = await centreOf(p.locator(".sa-fullscreen-prompt-skip"));
    await c.touch.tap(pt.x, pt.y);
    await p.waitFor({ state: "hidden", timeout: 60000 });
  }
  await settle(c.page);
}

/** Register the account; if the nickname already exists, log in instead. */
export async function ensureAccount(c, nickname, password) {
  const { page, touch } = c;
  const auth = page.locator(".auth-overlay");
  await auth.waitFor({ state: "visible", timeout: 60000 });
  const toggle = auth.getByText("Log in / Register", { exact: true });
  await tapEl(c, toggle);
  await sleep(400);

  const tab = (name) => auth.locator(".sa-screen-tab", { hasText: name });
  const panelFor = (name) => auth.locator(".sa-screen-panel").nth(name === "Register" ? 1 : 0);

  const submit = async (which) => {
    await tapEl(c, tab(which));
    await sleep(300);
    const panel = panelFor(which);
    await panel.locator("input[type=text]").fill(nickname);
    await panel.locator("input[type=password]").fill(password);
    const btn = panel.getByRole("button", { name: which, exact: true });
    const how = await tapEl(c, btn);
    if (how === "click") console.log(`  [${c.tag}] ${which} button unreachable by finger — fell back to el.click()`);
  };
  const doRegister = () => submit("Register");
  const doLogin = () => submit("Log In");

  await doRegister();
  const lobby = page.locator(".lobby-overlay");
  const ok = await lobby.waitFor({ state: "visible", timeout: 25000 }).then(
    () => true,
    () => false,
  );
  if (ok) {
    console.log(`  [${c.tag}] registered ${nickname}`);
  } else {
    const err = await auth.locator(".sa-screen-error, .auth-error").first().textContent().catch(() => "");
    console.log(`  [${c.tag}] register said "${(err ?? "").trim()}" — logging in instead`);
    await doLogin();
    await lobby.waitFor({ state: "visible", timeout: 60000 });
    console.log(`  [${c.tag}] logged in as ${nickname}`);
  }
  await settle(page);
}

/** Read the live match/session state the HUD is drawing from. */
export async function readState(page) {
  return page.evaluate(() => {
    const d = window.__debug;
    const s = d?.session;
    if (!s) return { live: false };
    const snap = s.curSnapshot;
    const me = snap?.ships?.find((x) => x.id === s.playerId);
    const ships = (snap?.ships ?? []).map((x) => ({
      id: x.id,
      team: x.team,
      x: x.pos?.x,
      z: x.pos?.z,
      y: x.pos?.y,
      hull: x.hull,
      shield: x.shield,
      alive: x.alive,
    }));
    const steer = document.querySelector(".hud-relative-steer");
    return {
      live: true,
      playerId: s.playerId,
      arenaId: s.arenaId,
      phase: snap?.phase,
      elapsed: snap?.elapsed,
      fps: d.engine?.getFps?.() ?? null,
      steerActive: steer ? steer.classList.contains("active") : false,
      hudThrottle: document.querySelector(".hud-throttle-readout")?.textContent ?? "",
      hudSpeed: document.querySelector(".hud-speed-value")?.textContent ?? "",
      notifications: (document.querySelector(".hud-notifications")?.textContent ?? "").trim(),
      killFeed: (document.querySelector(".hud-kill-feed")?.textContent ?? "").trim(),
      resultsUp: !!document.querySelector(".hud-results.visible"),
      me: me
        ? {
            id: me.id,
            team: me.team,
            x: me.pos?.x,
            y: me.pos?.y,
            z: me.pos?.z,
            heading: me.heading,
            pitch: me.pitch,
            hull: me.hull,
            hullMax: me.hullMax,
            throttle: me.throttle,
            locked: me.locked,
            targetId: me.targetId,
            launchHold: me.launchHold,
            launchLocked: me.launchLocked,
            modules: (me.modules ?? []).map((m) => ({
              id: m.moduleId,
              hp: m.hardpointIndex,
              state: m.state,
              ammo: m.rounds,
            })),
          }
        : null,
      ships,
      ping: s.ping ?? s.rtt ?? null,
    };
  });
}
