import { expect, test } from "@playwright/test";

/**
 * Not a test — a screenshot rig for design iteration. Boots a practice match
 * and captures the flight HUD. Excluded from CI by the default test filter
 * (run explicitly with --grep @hudshot). Output path via HUD_SHOT_DIR.
 */

const shotW = Number(process.env["HUD_SHOT_W"] ?? 0);
const shotH = Number(process.env["HUD_SHOT_H"] ?? 0);
if (shotW > 0 && shotH > 0) test.use({ viewport: { width: shotW, height: shotH } });

test.setTimeout(600_000);

test("hud screenshot rig @hudshot", async ({ page }) => {
  const outDir = process.env["HUD_SHOT_DIR"] ?? "test-results";
  await page.goto("/?login=1");
  const fullscreenPrompt = page.locator(".sa-fullscreen-prompt");
  await expect(fullscreenPrompt).toBeVisible();
  if (process.env["HUD_SHOT_LAUNCH"]) {
    await page.screenshot({ path: `${outDir}/launch-prompt.png` });
    return;
  }
  await fullscreenPrompt.getByText("Not now", { exact: true }).click();
  const authOverlay = page.locator(".auth-overlay");
  await expect(authOverlay).toBeVisible();
  await authOverlay.getByRole("button", { name: "Play as Guest", exact: true }).click();
  const lobby = page.locator(".lobby-overlay");
  await expect(lobby).toBeVisible();
  if (process.env["HUD_SHOT_LOBBY"]) {
    await page.screenshot({ path: `${outDir}/lobby.png` });
    return;
  }
  // HUD_SHOT_SHOP: the shop, one shot per tab. Set it to a tab name
  // (ships/modules/paints) to capture only that one.
  if (process.env["HUD_SHOT_SHOP"]) {
    await lobby.getByRole("button", { name: "Shop", exact: true }).click();
    const shop = page.locator(".shop-overlay");
    await expect(shop).toBeVisible();
    const only = process.env["HUD_SHOT_SHOP"]!.toLowerCase();
    const tabs = ["ships", "modules", "paints"].filter((t) => only === "1" || only === t);
    for (const tab of tabs) {
      await shop.locator(`.sa-tab[data-tab="${tab}"]`).click();
      await expect(shop.locator(`.sa-tab[data-tab="${tab}"]`)).toHaveAttribute("aria-selected", "true");
      await page.screenshot({ path: `${outDir}/shop-${tab}.png`, fullPage: false });
    }
    return;
  }
  if (process.env["HUD_SHOT_SHIP"]) {
    await lobby.getByRole("button", { name: "Hangar", exact: true }).click();
    const hangar = page.locator(".hangar-panel");
    await expect(hangar).toBeVisible();
    // Hull choice lives on the 3D stage (2026-08-08): walk the bay with the
    // arrows, then take the hull in the viewer's top-right action slot — which
    // offers the purchase first for a hull this account has not bought.
    const stage = page.locator(".hangar-overlay > .hangar-stage");
    const shipName = stage.locator(".hangar-ship-name");
    const wanted = process.env["HUD_SHOT_SHIP"]!;
    for (let step = 0; step < 8; step++) {
      const seen = (await shipName.textContent()) ?? "";
      if (seen.includes(wanted)) break;
      await stage.locator(".hangar-stage-arrow.next").click();
      await expect(shipName).not.toHaveText(seen);
    }
    const buy = stage.getByRole("button", { name: /Buy/ });
    if (await buy.count()) await buy.click();
    const setMain = stage.getByRole("button", { name: "★ Set as main" });
    if (await setMain.count()) await setMain.click();
    await page.locator(".hangar-close").click();
    await expect(lobby).toBeVisible();
  }
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

  // HUD_SHOT_MVP: run the match out and capture the MVP hero shot, which is
  // where the staged hull's screen placement is judged.
  if (!process.env["HUD_SHOT_MVP"]) return;
  await page.evaluate(async () => {
    const debug = (window as unknown as {
      __debug: { forceFrame(dtMs?: number): void; session?: { playerId: number; curSnapshot: { ships: { id: number; team: number }[] }; order(o: unknown): void } };
    }).__debug;
    for (let i = 0; i < 6000; i++) {
      const session = debug.session;
      if (session) {
        const me = session.curSnapshot.ships.find((sh) => sh.id === session.playerId);
        if (me) session.order({ kind: "flight", throttle: 0.6, turn: 0.2, boost: false, fire: true });
      }
      debug.forceFrame(166);
      if (i % 20 === 19) {
        if (document.querySelector(".hud-results.visible")) break;
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    // Past the 3s outcome banner into the MVP beat.
    for (let i = 0; i < 100; i++) {
      debug.forceFrame(50);
      if (i % 10 === 9) await new Promise((r) => setTimeout(r, 0));
    }
  });
  await expect(page.locator(".hud-results")).toHaveClass(/hud-results--mvp/, { timeout: 20000 });
  await page.screenshot({ path: `${outDir}/mvp.png` });
});
