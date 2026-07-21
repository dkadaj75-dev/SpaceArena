/**
 * Validates the entire content pack against the Zod schemas and resolves all
 * cross-references. Run via tsx (see root script "validate:content").
 *
 *   npm run validate:content
 *
 * Exits 1 with readable errors (file, JSON path, message) on any failure.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { ConfigService, type ConfigError } from "@space-arena/shared";

const CONTENT_DIR = fileURLToPath(new URL("../content/", import.meta.url));
const MANIFEST = "manifest.json";

async function fsLoader(relPath: string): Promise<unknown> {
  const abs = path.join(CONTENT_DIR, relPath);
  const text = await readFile(abs, "utf8");
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`invalid JSON: ${(err as Error).message}`);
  }
}

function printErrors(errors: ConfigError[]): void {
  console.error(`\n✖ ${errors.length} content problem(s):\n`);
  for (const e of errors) {
    const loc = e.path ? `${e.file} → ${e.path}` : e.file;
    console.error(`  • ${loc}\n      ${e.message}`);
  }
  console.error("");
}

async function main(): Promise<void> {
  const service = new ConfigService(fsLoader);
  const result = await service.load(MANIFEST);

  if (!result.ok) {
    printErrors(result.errors);
    console.error("validate:content FAILED");
    process.exit(1);
  }

  const total = Object.values(result.counts).reduce((a, b) => a + (b ?? 0), 0);
  const breakdown = Object.entries(result.counts)
    .map(([type, n]) => `${type}=${n}`)
    .join(", ");
  console.log(`✔ validate:content OK — ${total} configs loaded (${breakdown})`);
}

main().catch((err) => {
  console.error("validate:content crashed:", err);
  process.exit(1);
});
