import { launch, openShell, goTo, setSheet } from "./lib.mjs";

const { browser, page, errors } = await launch();
try {
  await openShell(page);
  const groups = await page.evaluate(() =>
    [...document.querySelectorAll(".ed-nav-group")].map((b) => b.textContent.trim()));
  console.log("GROUPS:", groups.join(", "));

  for (const g of groups) {
    await goTo(page, g);
    const tools = await page.evaluate(() =>
      [...document.querySelectorAll(".ed-toolrow .ed-tab")].map((b) => b.textContent.trim()));
    console.log(`\n=== GROUP ${g} -> tools: ${tools.join(", ")}`);
    for (const t of tools) {
      await goTo(page, g, t);
      await setSheet(page, "full");
      const info = await page.evaluate(() => {
        const body = document.querySelector(".ed-inspector-body");
        if (!body) return { err: "no body" };
        const q = (s) => [...body.querySelectorAll(s)];
        return {
          scrollH: body.scrollHeight,
          clientH: body.clientHeight,
          overflowX: body.scrollWidth > body.clientWidth ? `${body.scrollWidth}>${body.clientWidth}` : "none",
          sections: q(".ed-map-section-title, .ed-section-title, h3, h4, summary, legend").map((e) => e.textContent.trim().slice(0, 40)),
          buttons: q("button").map((b) => (b.textContent || b.title || "").trim().slice(0, 30)).filter(Boolean),
          selects: q("select").map((s) => ({ n: s.options.length, first: s.options[0]?.text?.slice(0, 25) })),
          inputs: q("input").length,
          details: q("details").length,
          listRows: q(".ed-list-row, .ed-record, li, .ed-row").length,
          canvases: q("canvas").length,
          textPreview: (body.innerText || "").replace(/\s+/g, " ").slice(0, 260),
        };
      });
      console.log(`\n--- ${g}/${t} ---`);
      console.log(JSON.stringify(info));
    }
  }
} catch (e) {
  console.log("ERR", e.stack);
} finally {
  console.log("\n--- CONSOLE ---\n" + errors.slice(0, 15).join("\n"));
  await browser.close();
}
