// Crop/zoom a shot for close inspection: node crop.mjs <file> <x> <y> <w> <h> [scale]
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const [file, x, y, w, h, scale = "2"] = process.argv.slice(2);
const abs = path.resolve(file);
const data = fs.readFileSync(abs).toString("base64");
const S = Number(scale);
const W = Number(w);
const H = Number(h);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: Math.round(W * S), height: Math.round(H * S) } });
await page.setContent(
  `<body style="margin:0;overflow:hidden;background:#000">
   <img src="data:image/png;base64,${data}"
        style="position:absolute;left:${-Number(x) * S}px;top:${-Number(y) * S}px;transform-origin:0 0;transform:scale(${S});image-rendering:auto">
   </body>`,
);
await page.waitForTimeout(400);
const out = abs.replace(/\.png$/, `-crop-${x}_${y}.png`);
await page.screenshot({ path: out });
console.log(out);
await browser.close();
