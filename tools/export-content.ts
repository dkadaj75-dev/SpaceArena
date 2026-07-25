/**
 * Export a content pack from disk into a single importable bundle (§11 6.7).
 *
 *   npx tsx tools/export-content.ts                        → content-pack.json
 *   npx tsx tools/export-content.ts --out packs/v7.json
 *   npx tsx tools/export-content.ts --dir /srv/content --stdout > pack.json
 *
 * The offline counterpart to `GET /api/admin/content/export`: same bundle shape,
 * same source hash, no running server needed. Author in the dev editors, export,
 * hand the file to whoever holds the production admin token.
 *
 * The pack is **validated before it is written**, so a broken bundle never
 * leaves the machine that made it — the first place a bad pack gets rejected
 * should be the author's terminal, not production.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { validateBundle, type ConfigError } from "@space-arena/shared";
import { exportBundleFrom } from "../server/src/content/packStore.js";

const DEFAULT_DIR = fileURLToPath(new URL("../content/", import.meta.url));
const DEFAULT_OUT = "content-pack.json";

interface Args {
  dir: string;
  out: string;
  stdout: boolean;
  skipValidate: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { dir: DEFAULT_DIR, out: DEFAULT_OUT, stdout: false, skipValidate: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dir") args.dir = path.resolve(argv[++i] ?? "");
    else if (arg === "--out" || arg === "-o") args.out = argv[++i] ?? DEFAULT_OUT;
    else if (arg === "--stdout") args.stdout = true;
    else if (arg === "--no-validate") args.skipValidate = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(
        [
          "usage: npx tsx tools/export-content.ts [options]",
          "",
          "  --dir <path>     content directory to export (default: repo content/)",
          "  --out <file>     output file (default: content-pack.json)",
          "  --stdout         write the bundle to stdout instead of a file",
          "  --no-validate    skip the pre-flight validation (not recommended)",
        ].join("\n"),
      );
      process.exit(0);
    } else {
      console.error(`unknown argument: ${arg}`);
      process.exit(1);
    }
  }
  return args;
}

function printErrors(errors: ConfigError[]): void {
  console.error(`\n✖ ${errors.length} content problem(s):\n`);
  for (const e of errors) console.error(`  • ${e.path ? `${e.file} → ${e.path}` : e.file}\n      ${e.message}`);
  console.error("");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const bundle = await exportBundleFrom(args.dir);

  if (!args.skipValidate) {
    const validation = await validateBundle(bundle);
    if (!validation.ok) {
      printErrors(validation.errors);
      console.error("export-content FAILED — fix the pack before exporting");
      process.exit(1);
    }
  }

  const json = `${JSON.stringify(bundle, null, 2)}\n`;
  if (args.stdout) {
    process.stdout.write(json);
    return;
  }

  const outPath = path.resolve(args.out);
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, json, "utf8");

  const bytes = Buffer.byteLength(json);
  console.log(
    `✔ exported ${bundle.packId} v${bundle.packVersion} — ${Object.keys(bundle.files).length} files, ` +
      `${(bytes / 1024).toFixed(1)} kB → ${outPath}`,
  );
  console.log(`  protocolVersion ${bundle.protocolVersion}`);
  console.log(`  ${bundle.sourceHash}`);
}

main().catch((err) => {
  console.error("export-content crashed:", err);
  process.exit(1);
});
