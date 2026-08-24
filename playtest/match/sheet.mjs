// Contact sheet: node sheet.mjs <out.png> <cols> <file...>
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const [out, colsArg, ...files] = process.argv.slice(2);
const cols = Number(colsArg);
const CELL = 300;
const rows = Math.ceil(files.length / cols);

const imgs = files
  .map((f) => {
    const p = path.resolve(f);
    const b64 = fs.readFileSync(p).toString("base64");
    return `<div class="c"><img src="data:image/png;base64,${b64}"><span>${path.basename(p).replace(/\.png$/, "")}</span></div>`;
  })
  .join("");

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: cols * CELL, height: rows * (CELL + 18) } });
await page.setContent(`<style>
 body{margin:0;background:#111;display:grid;grid-template-columns:repeat(${cols},${CELL}px);}
 .c{position:relative;width:${CELL}px;height:${CELL + 18}px;overflow:hidden}
 .c img{width:${CELL}px;height:${CELL}px;object-fit:cover;display:block}
 .c span{display:block;font:10px monospace;color:#8cf;background:#000;padding:2px 3px;white-space:nowrap;overflow:hidden}
</style>${imgs}`);
await page.waitForTimeout(600);
await page.screenshot({ path: path.resolve(out), fullPage: true });
console.log(path.resolve(out));
await browser.close();
