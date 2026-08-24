// Phase 7 — the states a fresh, server-less or logged-out player sees:
//   a) the auth gate's "Skip (offline practice)" path,
//   b) the lobby's SERVER OFFLINE badge and "Playing offline" chip.
// Runs in a throwaway context so it cannot disturb the registered account.
import { launch, close, shot, sleep, parkPointer } from "./lib.mjs";

const headless = process.env.SA_HEADLESS === "1";

// ---------- a) Skip to offline practice from the auth gate ----------
{
  const { ctx, page } = await launch({ persistent: false, headless });
  await page.goto("http://localhost:5173/?login=1", { waitUntil: "commit" });
  const prompt = page.locator(".sa-fullscreen-prompt");
  await prompt.waitFor({ state: "visible", timeout: 60000 });
  await prompt.getByText("Not now", { exact: true }).click();
  const auth = page.locator(".auth-overlay");
  await auth.waitFor({ state: "visible", timeout: 60000 });
  await sleep(1500);
  await parkPointer(page);
  await shot(page, "auth-fresh-visitor");
  await auth.getByText("Skip (offline practice)", { exact: true }).click();
  await page.locator(".lobby-overlay").waitFor({ state: "visible", timeout: 60000 });
  await sleep(2500);
  await parkPointer(page);
  await shot(page, "lobby-offline-practice-after-skip");
  console.log(
    "skip lobby header:",
    JSON.stringify(
      await page.evaluate(() => ({
        chip: document.querySelector(".sa-menu-account")?.textContent,
        chipClass: document.querySelector(".sa-menu-account")?.className,
        links: [...document.querySelectorAll(".sa-screen-header a")].map((a) => a.textContent),
        badgeVisible: document.querySelector(".sa-menu-offline-badge")?.classList.contains("visible"),
        online: document.querySelector(".sa-menu-online-count")?.textContent,
        disabledModeCards: [...document.querySelectorAll(".sa-menu-card")].filter((c) => c.disabled).length,
      })),
    ),
  );
  // the guest upgrade / login link from the lobby
  const link = page.getByText("Log in / Sign up", { exact: true });
  if (await link.count()) {
    await link.first().click();
    await sleep(1200);
    await parkPointer(page);
    await shot(page, "auth-reopened-from-lobby-link");
  }
  await close(ctx);
}

// ---------- b) Server unreachable ----------
{
  const { ctx, page } = await launch({ persistent: false, headless });
  await page.route("**/health*", (route) => route.abort());
  await page.goto("http://localhost:5173/?login=1", { waitUntil: "commit" });
  const prompt = page.locator(".sa-fullscreen-prompt");
  await prompt.waitFor({ state: "visible", timeout: 60000 });
  await sleep(400);
  await shot(page, "fullscreen-prompt-offline-boot");
  await prompt.getByText("Not now", { exact: true }).click();
  // The boot screen holds its bad news for a beat — catch it.
  for (let i = 0; i < 40; i++) {
    const note = await page.evaluate(() => document.querySelector("[data-boot-note]")?.textContent ?? "");
    if (note) {
      await shot(page, "boot-server-offline-note");
      break;
    }
    await sleep(700);
  }
  await page.locator(".lobby-overlay").waitFor({ state: "visible", timeout: 90000 });
  await sleep(2500);
  await parkPointer(page);
  await shot(page, "lobby-server-offline-badge");
  console.log(
    "offline lobby:",
    JSON.stringify(
      await page.evaluate(() => ({
        badge: document.querySelector(".sa-menu-offline-badge")?.textContent,
        badgeVisible: document.querySelector(".sa-menu-offline-badge")?.classList.contains("visible"),
        chip: document.querySelector(".sa-menu-account")?.textContent,
        online: document.querySelector(".sa-menu-online-count")?.textContent,
        modeTitles: [...document.querySelectorAll(".sa-menu-card")].map((c) => c.title).slice(0, 3),
        disabled: [...document.querySelectorAll(".sa-menu-card")].filter((c) => c.disabled).length,
      })),
    ),
  );
  // A drawer while offline
  await page.locator('.sa-menu-category[data-lobby-action="deathmatch"]').click();
  await sleep(700);
  await parkPointer(page);
  await shot(page, "lobby-offline-drawer");
  // Hangar offline
  await page.locator(".sa-menu-group:not([hidden]) .sa-menu-back").click();
  await sleep(600);
  await page.locator('[data-lobby-action="hangar"]').click();
  await sleep(4000);
  await parkPointer(page);
  await shot(page, "hangar-offline-mode");
  console.log(
    "hangar offline:",
    await page.evaluate(() => ({
      err: document.querySelector(".hangar-error")?.textContent ?? null,
      ship: document.querySelector(".hangar-ship-name")?.textContent ?? null,
      slots: document.querySelectorAll(".hangar-slot").length,
    })),
  );
  await close(ctx);
}
