import { launch, boot, shot, openDesignerViaSettings, clickDesignerButton } from "./lib.mjs";
import { resetCounter } from "./lib.mjs";

const { browser, page, errors } = await launch();
resetCounter(100);
try {
  await boot(page);
  await openDesignerViaSettings(page);
  await page.locator("[data-settings-designer]").scrollIntoViewIfNeeded();
  await clickDesignerButton(page);
  await page.waitForTimeout(2000);

  const probe = await page.evaluate(() => {
    const ed = document.getElementById("space-arena-editor");
    const out = { found: !!ed };
    if (ed) {
      const cs = getComputedStyle(ed);
      const r = ed.getBoundingClientRect();
      out.rect = { x: r.x, y: r.y, w: r.width, h: r.height };
      out.style = { display: cs.display, visibility: cs.visibility, opacity: cs.opacity, zIndex: cs.zIndex, position: cs.position, pointerEvents: cs.pointerEvents };
      // What is on top at the shell's top bar?
      const top = document.elementFromPoint(Math.round(r.x + 60), Math.round(r.y + 20));
      out.topBarHitTest = top ? `${top.tagName}#${top.id}.${top.className}`.slice(0, 160) : "null";
    }
    // Full stacking list of body children
    out.bodyChildren = [...document.body.children].map((c) => {
      const cs = getComputedStyle(c);
      return { tag: c.tagName, id: c.id, cls: String(c.className).slice(0, 70), z: cs.zIndex, pos: cs.position, display: cs.display, vis: cs.visibility };
    });
    return out;
  });
  console.log(JSON.stringify(probe, null, 1));
} catch (e) {
  console.log("ERR", e.message);
} finally {
  await browser.close();
}
