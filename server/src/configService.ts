import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ConfigService } from "@space-arena/shared";

/**
 * Process-wide {@link ConfigService} singleton. Set once at boot (index.ts, fs
 * loader) or by tests (object loader); rooms read it via {@link getConfigService}
 * so the room class needs no constructor injection through Colyseus.
 */
let instance: ConfigService | null = null;

export function setConfigService(cs: ConfigService): void {
  instance = cs;
}

export function getConfigService(): ConfigService {
  if (!instance) throw new Error("ConfigService not initialized — call setConfigService() at boot");
  return instance;
}

/** Directory holding the content pack (repo-root `content/`). */
export const CONTENT_DIR = fileURLToPath(new URL("../../content/", import.meta.url));

/** fs loader for ConfigService.load(), reading JSON relative to {@link CONTENT_DIR}. */
export async function fsLoader(relPath: string): Promise<unknown> {
  const abs = path.join(CONTENT_DIR, relPath);
  const text = await readFile(abs, "utf8");
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`invalid JSON in ${relPath}: ${(err as Error).message}`);
  }
}

/** Build + load a ConfigService from the content dir (fail fast on invalid content). */
export async function loadContent(): Promise<ConfigService> {
  const cs = new ConfigService(fsLoader);
  const result = await cs.load("manifest.json");
  if (!result.ok) {
    const detail = result.errors
      .map((e) => `  • ${e.file}${e.path ? ` → ${e.path}` : ""}: ${e.message}`)
      .join("\n");
    throw new Error(`content validation failed:\n${detail}`);
  }
  return cs;
}
