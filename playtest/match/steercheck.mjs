// Why does a touch drag on the canvas not steer? Instrument the pointer stream.
import { launchBrowser, openClient, dismissFullscreen, ensureAccount, shot, sleep, tapEl, readState } from "./rig.mjs";
import { Pilot } from "./pilot.mjs";

const browser = await launchBrowser();
const A = await openClient(browser, "steercheck");
await dismissFullscreen(A);
await ensureAccount(A, "playtest-match-a", "playtest1234");
await tapEl(A, A.page.locator('.sa-menu-category[data-lobby-action="team deathmatch"]'));
await sleep(600);
await tapEl(A, A.page.locator('.sa-menu-card[data-gamemode="gamemode.practice-bots"]'));
await A.page.locator(".hud-modules .hud-module-btn").first().waitFor({ state: "visible", timeout: 180000 });
await sleep(6000);

console.log(
  "css:",
  JSON.stringify(
    await A.page.evaluate(() => {
      const c = document.querySelector("#renderCanvas");
      const cs = getComputedStyle(c);
      const hud = document.querySelector(".hud-root");
      return {
        canvasTouchAction: cs.touchAction,
        canvasOverscroll: cs.overscrollBehavior,
        bodyTouchAction: getComputedStyle(document.body).touchAction,
        htmlTouchAction: getComputedStyle(document.documentElement).touchAction,
        hudTouchAction: hud ? getComputedStyle(hud).touchAction : null,
        bodyOverflow: getComputedStyle(document.body).overflow,
        docScrollable: document.documentElement.scrollHeight > document.documentElement.clientHeight,
        elAt: (() => {
          const e = document.elementFromPoint(300, 210);
          return e ? `${e.tagName}#${e.id}.${e.className}` : null;
        })(),
      };
    }),
    null,
    1,
  ),
);

// Log every pointer event the canvas and document see.
await A.page.evaluate(() => {
  window.__ptr = [];
  const rec = (tag) => (e) =>
    window.__ptr.push(`${tag}:${e.type} id=${e.pointerId} type=${e.pointerType} cancelable=${e.cancelable}`);
  for (const t of ["pointerdown", "pointermove", "pointerup", "pointercancel", "lostpointercapture"]) {
    document.querySelector("#renderCanvas").addEventListener(t, rec("canvas"), true);
  }
  for (const t of ["touchstart", "touchmove", "touchend", "touchcancel"]) {
    document.querySelector("#renderCanvas").addEventListener(t, (e) => window.__ptr.push(`canvas:${t} cancelable=${e.cancelable}`), true);
  }
});

const p = new Pilot(A);
await p.findSteerOrigin();
const before = await readState(A.page);
await p.c.touch.down(1, p.steerOrigin.x, p.steerOrigin.y);
await sleep(80);
for (let i = 1; i <= 20; i++) {
  await p.c.touch.moveMany([[1, p.steerOrigin.x + Math.min(95, i * 8), p.steerOrigin.y]]);
  await sleep(100);
}
const mid = await readState(A.page);
console.log("heading", before.me?.heading?.toFixed(3), "->", mid.me?.heading?.toFixed(3));
console.log(
  "steer widget:",
  await A.page.evaluate(() => {
    const v = document.querySelector(".hud-relative-steer");
    return { hidden: v?.hidden, cls: v?.className, style: v?.getAttribute("style") };
  }),
);
const events = await A.page.evaluate(() => window.__ptr.slice(0, 40));
console.log("pointer stream:\n  " + events.join("\n  "));
await shot(A.page, "sc-drag");

// Second attempt: hold still for 400ms before moving (defeats a fling/scroll heuristic).
await p.c.touch.up(1);
await sleep(600);
await A.page.evaluate(() => (window.__ptr = []));
const h0 = (await readState(A.page)).me?.heading;
await p.c.touch.down(1, p.steerOrigin.x, p.steerOrigin.y);
await sleep(500);
for (let i = 1; i <= 25; i++) {
  await p.c.touch.moveMany([[1, p.steerOrigin.x + 95, p.steerOrigin.y]]);
  await sleep(110);
}
const h1 = (await readState(A.page)).me?.heading;
console.log("slow-start heading", h0?.toFixed(3), "->", h1?.toFixed(3));
console.log("pointer stream 2:\n  " + (await A.page.evaluate(() => window.__ptr.slice(0, 25))).join("\n  "));
await p.allStop();
await browser.close();
