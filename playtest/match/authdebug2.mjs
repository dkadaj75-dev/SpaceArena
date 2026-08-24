import { launchBrowser, openClient, dismissFullscreen, shot, sleep, centreOf } from "./rig.mjs";

const browser = await launchBrowser();
const A = await openClient(browser, "authdebug2");
await dismissFullscreen(A);
const { page, touch } = A;
const auth = page.locator(".auth-overlay");
await auth.waitFor({ state: "visible" });
const t = await centreOf(auth.getByText("Log in / Register", { exact: true }));
await touch.tap(t.x, t.y);
await sleep(600);

// Can a player reach the Register button at all?
const geom = await page.evaluate(() => {
  const overlay = document.querySelector(".auth-overlay");
  const cs = getComputedStyle(overlay);
  const reg = [...document.querySelectorAll(".sa-screen-tab")].find((e) => e.textContent === "Register");
  reg.click();
  const panel = document.querySelectorAll(".auth-overlay .sa-screen-panel")[1];
  const btn = panel.querySelector("button");
  return {
    viewport: [window.innerWidth, window.innerHeight],
    overlayOverflowY: cs.overflowY,
    overlayScrollH: overlay.scrollHeight,
    overlayClientH: overlay.clientHeight,
    bodyScrollH: document.body.scrollHeight,
    docScrollH: document.documentElement.scrollHeight,
    btnRect: (({ x, y, width, height }) => ({ x, y, width, height }))(btn.getBoundingClientRect()),
  };
});
console.log("geometry:", JSON.stringify(geom, null, 1));

// Try to scroll the overlay the way a thumb would.
await page.evaluate(() => document.querySelector(".auth-overlay").scrollTo(0, 999));
await sleep(300);
const after = await page.evaluate(() => {
  const overlay = document.querySelector(".auth-overlay");
  const panel = document.querySelectorAll(".auth-overlay .sa-screen-panel")[1];
  return { scrollTop: overlay.scrollTop, btnY: panel.querySelector("button").getBoundingClientRect().y };
});
console.log("after scrollTo:", after);
await shot(page, "dbg-auth-scroll-attempt");

// Swipe with a real finger.
await touch.down(5, 457, 380);
for (let i = 0; i < 10; i++) {
  await touch.move(5, 457, 380 - i * 20);
  await sleep(30);
}
await touch.up(5);
await sleep(500);
const after2 = await page.evaluate(() => {
  const panel = document.querySelectorAll(".auth-overlay .sa-screen-panel")[1];
  return { btnY: panel.querySelector("button").getBoundingClientRect().y, scrollTop: document.querySelector(".auth-overlay").scrollTop };
});
console.log("after swipe:", after2);
await shot(page, "dbg-auth-after-swipe");
await browser.close();
