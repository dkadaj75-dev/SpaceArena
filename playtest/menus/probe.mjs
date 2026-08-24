import { launch, close, sleep } from "./lib.mjs";

const { ctx, page, logs } = await launch({ headless: process.env.SA_HEADFUL !== "1" });
await page.goto("http://localhost:5173/?login=1", { waitUntil: "commit" });
for (let i = 0; i < 20; i++) {
  await sleep(3000);
  const state = await page.evaluate(() => {
    const vis = (el) => {
      if (!el) return false;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return cs.display !== "none" && cs.visibility !== "hidden" && r.width > 0 && r.height > 0;
    };
    const q = (s) => document.querySelector(s);
    return {
      t: Math.round(performance.now() / 100) / 10,
      boot: q("#sa-boot") ? q("#sa-boot").dataset.phase + "/" + (q("#sa-boot").dataset.state ?? "-") : "gone",
      bootNote: q("[data-boot-note]")?.textContent ?? "",
      bootSub: q("[data-boot-sub]")?.textContent ?? "",
      prompt: vis(q(".sa-fullscreen-prompt")),
      auth: q(".auth-overlay") ? (vis(q(".auth-overlay")) ? "visible" : "hidden") : "absent",
      lobby: q(".lobby-overlay") ? (vis(q(".lobby-overlay")) ? "visible" : "hidden") : "absent",
      canvas: [q("#renderCanvas")?.width, q("#renderCanvas")?.height],
    };
  });
  console.log(JSON.stringify(state));
  if (state.auth === "visible" || state.lobby === "visible") break;
}
console.log("--- logs ---");
console.log(logs.join("\n"));
await close(ctx);
