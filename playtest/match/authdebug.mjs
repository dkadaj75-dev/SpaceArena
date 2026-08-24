import { launchBrowser, openClient, dismissFullscreen, settle, shot, sleep, centreOf } from "./rig.mjs";

const browser = await launchBrowser();
const A = await openClient(browser, "authdebug");
await dismissFullscreen(A);
const { page, touch } = A;
const auth = page.locator(".auth-overlay");
await auth.waitFor({ state: "visible" });
await shot(page, "dbg-auth-0");

const toggle = auth.getByText("Log in / Register", { exact: true });
const t = await centreOf(toggle);
console.log("toggle box", t);
await touch.tap(t.x, t.y);
await sleep(800);
await shot(page, "dbg-auth-1-expanded");
console.log(
  "forms open:",
  await page.locator(".sa-screen-forms").evaluate((e) => e.className),
);
const panels = await page.locator(".auth-overlay .sa-screen-panel").evaluateAll((els) =>
  els.map((e) => ({ display: getComputedStyle(e).display, inputs: [...e.querySelectorAll("input")].map((i) => i.type + ":" + i.placeholder), btn: e.querySelector("button")?.textContent })),
);
console.log("panels", JSON.stringify(panels, null, 1));

const rt = await centreOf(page.locator(".sa-screen-tab", { hasText: "Register" }));
console.log("register tab", rt);
await touch.tap(rt.x, rt.y);
await sleep(600);
await shot(page, "dbg-auth-2-register-tab");

const panel = page.locator(".auth-overlay .sa-screen-panel").nth(1);
await panel.locator("input[type=text]").fill("playtest-match-a");
await panel.locator("input[type=password]").fill("playtest1234");
await shot(page, "dbg-auth-3-filled");
const rb = await centreOf(panel.getByRole("button", { name: "Register", exact: true }));
console.log("register btn", rb);
await touch.tap(rb.x, rb.y);
await sleep(4000);
await shot(page, "dbg-auth-4-after-register");
console.log("error text:", JSON.stringify(await page.locator(".sa-screen-error").allTextContents()));
console.log("lobby visible:", await page.locator(".lobby-overlay").isVisible());
console.log(
  "auth state:",
  await page.evaluate(() => JSON.stringify(window.__debug?.session ? "insession" : "noSession")),
);
await sleep(2000);
await browser.close();
