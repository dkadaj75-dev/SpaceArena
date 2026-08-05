import { expect, test } from "@playwright/test";

/**
 * Not a test — a screenshot rig for design iteration. Boots a practice match
 * and captures the flight HUD. Excluded from CI by the default test filter
 * (run explicitly with --grep @hudshot). Output path via HUD_SHOT_DIR.
 */

test("hud screenshot rig @hudshot", async ({ page }) => {
  const outDir = process.env["HUD_SHOT_DIR"] ?? "test-results";
  await page.goto("/?login=1");
  const fullscreenPrompt = page.locator(".sa-fullscreen-prompt");
  await expect(fullscreenPrompt).toBeVisible();
  await fullscreenPrompt.getByText("Not now", { exact: true }).click();
  const authOverlay = page.locator(".auth-overlay");
  await expect(authOverlay).toBeVisible();
  await authOverlay.getByRole("button", { name: "Play as Guest", exact: true }).click();
  const lobby = page.locator(".lobby-overlay");
  await expect(lobby).toBeVisible();
  await lobby.getByRole("button", { name: /Practice/ }).first().click();
  await expect(lobby).toBeHidden();
  // Let the loading screen resolve and the countdown finish into live HUD.
  await expect(page.locator(".hud-modules .hud-module-btn").first()).toBeVisible({ timeout: 30000 });
  await page.evaluate(async () => {
    const debug = (window as unknown as { __debug: { forceFrame(dtMs?: number): void } }).__debug;
    for (let i = 0; i < 120; i++) {
      debug.forceFrame(50);
      if (i % 10 === 9) await new Promise((r) => setTimeout(r, 0));
    }
  });
  await page.screenshot({ path: `${outDir}/hud-full.png` });
  const size = page.viewportSize()!;
  await page.screenshot({
    path: `${outDir}/hud-cluster.png`,
    clip: { x: size.width * 0.5, y: size.height * 0.45, width: size.width * 0.5, height: size.height * 0.55 },
  });
});
