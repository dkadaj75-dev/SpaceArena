import { expect, test } from "@playwright/test";

/**
 * SCRATCH screenshot rig for the hangar (@hudshot so default runs skip it).
 * Delete after the visual check.
 */
const OUT = process.env["HANGAR_SHOT_DIR"] ?? "test-results";
const PHASE = process.env["HANGAR_SHOT_PHASE"] ?? "before";
const BEFORE = PHASE === "before";

for (const [name, viewport] of [
  ["landscape", { width: 1280, height: 720 }],
  ["landscape-phone", { width: 812, height: 375 }],
  ["portrait", { width: 390, height: 844 }],
] as const) {
  test(`hangar ${name} @hudshot`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/?login=1");
    const prompt = page.locator(".sa-fullscreen-prompt");
    await expect(prompt).toBeVisible();
    await prompt.getByText("Not now", { exact: true }).click();
    const auth = page.locator(".auth-overlay");
    await expect(auth).toBeVisible();
    await auth.getByRole("button", { name: "Play as Guest", exact: true }).click();
    const lobby = page.locator(".lobby-overlay");
    await expect(lobby).toBeVisible();
    await lobby.getByRole("button", { name: "Hangar", exact: true }).click();
    const panel = page.locator(".hangar-panel");
    await expect(panel).toBeVisible();
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${OUT}/hangar-mainbtn-${PHASE}-${name}-open.png` });

    // Where "set as main" lives: the SHIP rail bay before, the stage after.
    if (BEFORE) {
      await panel.locator('.hangar-rail-btn[data-category="ship"]').click();
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${OUT}/hangar-mainbtn-${PHASE}-${name}-main.png` });
    }

    // Step to a hull the guest does NOT own — the locked / buy state.
    const stage = page.locator(".hangar-stage");
    const shipName = BEFORE
      ? page.locator(".hangar-ship-current .hangar-ship-name")
      : page.locator(".hangar-stage .hangar-ship-name");
    for (let i = 0; i < 4; i++) {
      const before = (await shipName.textContent()) ?? "";
      if (before.includes("Brawler")) break;
      await stage.locator(".hangar-stage-arrow.next").click();
      await expect(shipName).not.toHaveText(before);
      await page.waitForTimeout(500);
    }
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${OUT}/hangar-mainbtn-${PHASE}-${name}-locked.png` });

    if (BEFORE) return;
    // Bought but not the main: the same slot now offers "set as main".
    await stage.getByRole("button", { name: /Buy/ }).click();
    await expect(stage.getByRole("button", { name: "★ Set as main" })).toBeVisible();
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${OUT}/hangar-mainbtn-${PHASE}-${name}-setmain.png` });

    // Geometry contract: ≥44px touch target, clear of the arrows and BACK.
    const boxes = await page.evaluate(() => {
      const r = (sel: string): DOMRect | null => document.querySelector(sel)?.getBoundingClientRect() ?? null;
      return {
        action: r(".hangar-stage-btn"),
        prev: r(".hangar-stage-arrow.prev"),
        next: r(".hangar-stage-arrow.next"),
        close: r(".hangar-close"),
        railBack: r(".hangar-rail-btn.back"),
        gauges: r(".hangar-gauges"),
      };
    });
    // eslint-disable-next-line no-console
    console.log(`GEOM ${name} ${JSON.stringify(boxes)}`);

    await stage.getByRole("button", { name: "★ Set as main" }).click();
    await expect(stage.locator(".hangar-badge.main")).toBeVisible();
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${OUT}/hangar-mainbtn-${PHASE}-${name}-main.png` });
  });
}
