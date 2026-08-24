import { launch, boot, shot, canvasAlive, openDesignerViaSettings, clickDesignerButton, shellNav } from "./lib.mjs";

const { browser, page, errors } = await launch();
try {
  await boot(page);
  console.log("CANVAS", JSON.stringify(await canvasAlive(page)));
  await shot(page, "lobby-after-boot");

  await openDesignerViaSettings(page);
  await shot(page, "settings-screen-top");

  // Scroll settings to the bottom to find the designer button.
  const present = await page.locator("[data-settings-designer]").count();
  console.log("designer button count:", present);
  if (present) {
    await page.locator("[data-settings-designer]").scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    await shot(page, "settings-designer-button");
    const box = await page.locator("[data-settings-designer]").boundingBox();
    console.log("designer btn box", JSON.stringify(box));
    await clickDesignerButton(page);
    await shot(page, "editor-shell-opened");
  } else {
    console.log("FALLBACK: dispatching F10");
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "F10", bubbles: true })));
    await page.waitForTimeout(3000);
    await shot(page, "editor-shell-opened-via-f10");
  }

  console.log("NAV", JSON.stringify(await shellNav(page), null, 1));
  const html = await page.evaluate(() => {
    const r = document.querySelector(".ed-root") || document.body.lastElementChild;
    return r ? r.outerHTML.slice(0, 4000) : "none";
  });
  console.log("---SHELL HTML---\n", html);
} catch (e) {
  console.log("ERROR", e.message);
  await shot(page, "error-state");
} finally {
  console.log("---CONSOLE---");
  console.log(errors.slice(0, 25).join("\n"));
  await browser.close();
}
