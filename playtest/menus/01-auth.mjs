// Phase 1 — boot sequence + auth screen, ending registered as "playtest-menus".
import { launch, close, shot, sleep, canvasAlive, resetSeq } from "./lib.mjs";

// Headful is the only mode where the render loop ticks on this machine — see
// REPORT.md "harness notes".
const HEADLESS = process.env.SA_HEADLESS === "1";
resetSeq(1);

const { ctx, page, logs } = await launch({ headless: HEADLESS });

console.log("navigating…");
await page.goto("http://localhost:5173/?login=1", { waitUntil: "commit" });
await sleep(250);
await shot(page, "boot-publisher-card");

// --- fullscreen prompt (arrives while the publisher card is still up) ---
const prompt = page.locator(".sa-fullscreen-prompt");
await prompt.waitFor({ state: "visible", timeout: 60000 });
await sleep(600);
await shot(page, "fullscreen-prompt");
await prompt.getByText("Not now", { exact: true }).click();
await sleep(300);
await shot(page, "boot-after-prompt-dismissed");

// --- watch the launch sequence through to the auth gate ---
const auth = page.locator(".auth-overlay");
let sawTitle = false;
for (let i = 0; i < 90; i++) {
  const phase = await page.evaluate(
    () => document.getElementById("sa-boot")?.dataset.phase ?? "gone",
  );
  if (phase === "title" && !sawTitle) {
    sawTitle = true;
    await sleep(400);
    await shot(page, "boot-title-card");
  }
  if (await auth.isVisible()) break;
  await sleep(1000);
}
await auth.waitFor({ state: "visible", timeout: 60000 });
await sleep(1500);
await shot(page, "auth-collapsed-guest");
console.log("canvas@auth:", JSON.stringify(await canvasAlive(page)));

// expand the login/register panel
await auth.getByText("Log in / Register", { exact: true }).click();
await sleep(500);
await shot(page, "auth-expanded-login-tab");

// login validation error (empty identifier)
await auth.locator(".sa-screen-panel").first().getByRole("button", { name: "Log In" }).click();
await sleep(400);
await shot(page, "auth-login-validation-error");

// login with wrong credentials -> server error
const loginPanel = auth.locator(".sa-screen-panel").first();
await loginPanel.locator("input").first().fill("no-such-pilot-xyz");
await loginPanel.locator('input[type="password"]').fill("wrongpassword");
await sleep(200);
await shot(page, "auth-login-filled");
await loginPanel.getByRole("button", { name: "Log In" }).click();
await sleep(1500);
await shot(page, "auth-login-server-error");

// register tab
await auth.getByRole("button", { name: "Register", exact: true }).first().click();
await sleep(400);
await shot(page, "auth-register-tab-empty");

const regPanel = auth.locator(".sa-screen-panel").nth(1);
// validation: no nickname
await regPanel.getByRole("button", { name: "Register" }).click();
await sleep(400);
await shot(page, "auth-register-validation-no-nickname");

// validation: short password (server-side rule)
await regPanel.locator("input").nth(0).fill("playtest-menus");
await regPanel.locator('input[type="password"]').fill("short");
await sleep(200);
await shot(page, "auth-register-filled-short-password");
await regPanel.getByRole("button", { name: "Register" }).click();
await sleep(1500);
await shot(page, "auth-register-short-password-error");

// real registration
await regPanel.locator('input[type="password"]').fill("playtest-menus-8");
await sleep(200);
await shot(page, "auth-register-ready");
await regPanel.getByRole("button", { name: "Register" }).click();

const lobby = page.locator(".lobby-overlay");
await lobby.waitFor({ state: "visible", timeout: 30000 });
await sleep(2500);
await shot(page, "lobby-after-register");
console.log("canvas@lobby:", JSON.stringify(await canvasAlive(page)));

console.log("--- console tail ---");
console.log(logs.slice(-25).join("\n"));
await close(ctx);
