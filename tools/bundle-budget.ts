/**
 * Bundle budget gate (ROADMAP §11 6.2).
 *
 *   npm run build && npm run bundle:budget
 *
 * The roadmap's budget is "< 5 MB initial, editor chunk excluded". "Initial" is
 * defined here as *what the browser must fetch before the first frame*: every JS
 * chunk the built `index.html` names, either as an entry `<script type=module>`
 * or as a `<link rel=modulepreload>`. Anything Rollup emitted that index.html
 * does NOT name is reached through a dynamic `import()` and is therefore lazy —
 * which is exactly what the dev editor chunk is (`main.ts` imports
 * `./editor/EditorShell.js` behind the F10 key).
 *
 * The editor is checked twice, because "excluded from the budget" must never
 * become a way to smuggle it into the shell (§11 6.3):
 *
 *   1. By NAME. Rollup names the lazy chunk after the dynamically imported
 *      module (`EditorShell-*.js`). Such a chunk that index.html *references* is
 *      eagerly loaded, so the gate FAILS rather than quietly excusing it; one
 *      nothing references is lazy, and excluded from the budget as before.
 *   2. By CONTENT. Every initial chunk is scanned for `/__editor/` — a string
 *      literal that exists nowhere but client/src/editor/** and survives
 *      minification. That catches the subtler regression where editor modules
 *      get merged into an initial chunk and the name signal disappears entirely.
 *
 * In a correct production build neither fires: main.ts guards the editor behind
 * `import.meta.env.DEV`, so Rollup tree-shakes the branch and no editor chunk is
 * emitted at all.
 *
 * The budget is measured on GZIP size — that is what is actually shipped over
 * the wire — using the same level (9) a CDN would use. Raw sizes are printed too
 * because they are what the browser has to parse.
 *
 * Exits 1 (with a readable table) when the initial payload is over budget or
 * when editor code reached it.
 */
import { gzipSync } from "node:zlib";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIST = fileURLToPath(new URL("../client/dist/", import.meta.url));
const ASSETS = path.join(DIST, "assets");

/**
 * Initial-JS gzip budget. ROADMAP §11 6.2 says "< 5 MB initial, editor chunk
 * excluded". Measured 2026-07 after the §11 6.3 chunk split: 1.43 MB gzip
 * (6.39 MB raw) across three chunks, so today's build passes with ~3.5 MB of
 * headroom.
 */
const BUDGET_GZIP_BYTES = 5 * 1024 * 1024;

/**
 * Advisory ceiling on the raw (pre-gzip) initial payload. NOT a gate: the
 * roadmap budget is the gzip one, and `babylon-core` alone is ~6.1 MB raw —
 * Babylon's module graph has cycles, so subdividing it risks
 * temporal-dead-zone crashes for a caching win we do not need. Printed as a
 * warning so the number stays visible.
 */
const ADVISORY_RAW_BYTES = 7 * 1024 * 1024;

/** A chunk whose name marks it as the lazily-imported dev editor bundle. */
const EDITOR_CHUNK = /editor/i;

/**
 * A string literal present in every editor module (`fetch("/__editor/save")`,
 * `"/__editor/list-models"`) and nowhere else in client/src. Minification keeps
 * string literals intact, so finding it inside an initial chunk proves editor
 * code shipped in the shell.
 */
const EDITOR_CODE_MARKER = "/__editor/";

interface Chunk {
  file: string;
  raw: number;
  gzip: number;
  initial: boolean;
  reason: string;
}

function fail(message: string): never {
  console.error(`\n✖ bundle:budget — ${message}\n`);
  process.exit(1);
}

function readIndexHtml(): string {
  try {
    return readFileSync(path.join(DIST, "index.html"), "utf8");
  } catch {
    return fail(`no build found at ${DIST} — run \`npm run build\` first`);
  }
}

/** Every `/assets/*.js` path index.html names as an entry or a modulepreload. */
function referencedChunks(html: string): Set<string> {
  const refs = new Set<string>();
  for (const match of html.matchAll(/(?:src|href)\s*=\s*["']([^"']+\.js)["']/g)) {
    refs.add(path.basename(match[1]!));
  }
  return refs;
}

function humanBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${n} B`;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function padStart(text: string, width: number): string {
  return text.length >= width ? text : " ".repeat(width - text.length) + text;
}

function main(): void {
  const html = readIndexHtml();
  const referenced = referencedChunks(html);

  let files: string[];
  try {
    files = readdirSync(ASSETS).filter((f) => f.endsWith(".js"));
  } catch {
    return fail(`no assets directory at ${ASSETS} — run \`npm run build\` first`);
  }
  if (files.length === 0) fail(`no JS chunks in ${ASSETS} — did the build succeed?`);

  /** Chunk basenames that carry editor code, whatever they are named. */
  const editorCodeChunks = new Set<string>();

  const chunks: Chunk[] = files
    .map((file) => {
      const abs = path.join(ASSETS, file);
      const bytes = readFileSync(abs);
      const isReferenced = referenced.has(file);
      const isEditorNamed = EDITOR_CHUNK.test(file);
      if (isEditorNamed || bytes.includes(EDITOR_CODE_MARKER)) editorCodeChunks.add(file);
      // An editor-named chunk index.html references is NOT excused — it is
      // eagerly loaded, which is precisely the regression this gate exists to
      // catch. It stays in the "initial" set so the failure below is specific.
      return {
        file,
        raw: statSync(abs).size,
        gzip: gzipSync(bytes, { level: 9 }).length,
        initial: isReferenced,
        reason: isReferenced ? (isEditorNamed ? "INITIAL (editor!)" : "initial") : isEditorNamed ? "lazy (editor)" : "lazy (dynamic import)",
      };
    })
    .sort((a, b) => b.gzip - a.gzip);

  const initial = chunks.filter((c) => c.initial);
  if (initial.length === 0) fail("index.html references no JS chunk — the gate would be vacuous");

  const totalRaw = initial.reduce((sum, c) => sum + c.raw, 0);
  const totalGzip = initial.reduce((sum, c) => sum + c.gzip, 0);

  const nameWidth = Math.max(12, ...chunks.map((c) => c.file.length));
  console.log("\nBundle budget (ROADMAP 6.2) — client/dist\n");
  console.log(`  ${pad("chunk", nameWidth)}  ${padStart("raw", 10)}  ${padStart("gzip", 10)}   role`);
  console.log(`  ${"-".repeat(nameWidth)}  ${"-".repeat(10)}  ${"-".repeat(10)}   ----`);
  for (const c of chunks) {
    console.log(
      `  ${pad(c.file, nameWidth)}  ${padStart(humanBytes(c.raw), 10)}  ${padStart(humanBytes(c.gzip), 10)}   ${c.reason}`,
    );
  }
  console.log(`  ${"-".repeat(nameWidth)}  ${"-".repeat(10)}  ${"-".repeat(10)}`);
  console.log(
    `  ${pad(`INITIAL (${initial.length} chunk${initial.length === 1 ? "" : "s"})`, nameWidth)}  ` +
      `${padStart(humanBytes(totalRaw), 10)}  ${padStart(humanBytes(totalGzip), 10)}\n`,
  );

  // Hard gate: no editor code in the initial payload, by chunk name or by
  // content marker. See the module header for why both checks exist.
  const leaked = initial.filter((c) => editorCodeChunks.has(c.file));
  if (leaked.length > 0) {
    fail(
      `the dev editor is in the INITIAL payload — index.html eagerly loads ${leaked.map((c) => c.file).join(", ")}. ` +
        `The editor must stay behind the lazy \`import("./editor/EditorShell.js")\` in main.ts ` +
        `(and behind \`import.meta.env.DEV\`). Check manualChunks in client/vite.config.ts.`,
    );
  }
  const lazyEditor = chunks.filter((c) => editorCodeChunks.has(c.file));
  console.log(
    lazyEditor.length > 0
      ? `  editor code: ${lazyEditor.map((c) => c.file).join(", ")} — lazy, excluded from the budget.`
      : "  editor code: absent from the build (DEV-gated in main.ts and tree-shaken).",
  );

  if (totalRaw > ADVISORY_RAW_BYTES) {
    console.warn(
      `  ⚠ raw initial payload ${humanBytes(totalRaw)} exceeds the advisory ${humanBytes(ADVISORY_RAW_BYTES)}. ` +
        `babylon-core is the whole of it; Babylon's module graph has cycles, so it stays one chunk. Not a gate.`,
    );
  }

  const usedPct = ((totalGzip / BUDGET_GZIP_BYTES) * 100).toFixed(1);
  if (totalGzip > BUDGET_GZIP_BYTES) {
    fail(
      `initial JS is ${humanBytes(totalGzip)} gzip, over the ${humanBytes(BUDGET_GZIP_BYTES)} budget ` +
        `(${usedPct}% of budget). Split a chunk or lazy-load it.`,
    );
  }
  console.log(`✔ bundle:budget OK — ${humanBytes(totalGzip)} gzip of ${humanBytes(BUDGET_GZIP_BYTES)} (${usedPct}%)\n`);
}

main();
