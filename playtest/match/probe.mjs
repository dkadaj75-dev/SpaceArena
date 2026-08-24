// Boot probe: verify WebGL renders headless, register one account, reach lobby.
import { launch, bootAndRegister, dismissFullscreen, register, shot, sleep } from "./lib.mjs";

const HEADLESS = process.env.HEADED ? false : true;

const browser = await launch(HEADLESS);
const nick = `probe-${Date.now().toString(36)}`;
const { page, log, ctx } = await bootAndRegister(browser, nick, "playtest1234", "probe");

console.log("fullscreen prompt visible");
await shot(page, "probe-fullscreen-prompt");
await dismissFullscreen(page);
await sleep(1500);
await shot(page, "probe-auth");
await register(page, nick, "playtest1234");
console.log("registered:", nick);
await sleep(3000);
await shot(page, "probe-lobby");

// Renderer / canvas health.
const info = await page.evaluate(() => {
  const c = document.querySelector("#renderCanvas");
  const dbg = window.__debug;
  const eng = dbg?.engine;
  let gl = null;
  try {
    gl = eng?._gl ?? null;
  } catch {}
  const rect = c?.getBoundingClientRect();
  const mid = rect ? document.elementFromPoint(rect.width / 2, rect.height / 2) : null;
  return {
    hasDebug: !!dbg,
    canvas: c ? { w: c.width, h: c.height, cw: c.clientWidth, ch: c.clientHeight } : null,
    engineName: eng?.constructor?.name ?? null,
    renderWidth: eng?.getRenderWidth?.() ?? null,
    renderHeight: eng?.getRenderHeight?.() ?? null,
    fps: eng?.getFps?.() ?? null,
    glRenderer: gl ? gl.getParameter(gl.RENDERER) : null,
    meshCount: dbg?.meshCount?.() ?? null,
    elementAtCenter: mid ? `${mid.tagName}.${mid.className}` : null,
    modes: [...document.querySelectorAll(".sa-menu-category")].map((b) => b.dataset.lobbyAction),
  };
});
console.log(JSON.stringify(info, null, 2));
console.log("console log:", log.file);

await ctx.close();
await browser.close();
