import { readFile } from "node:fs/promises";
import path from "node:path";
import { ConfigService } from "@space-arena/shared";
import { getEnv } from "./env.js";

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

/**
 * Directory holding the content pack. `CONTENT_DIR` env, defaulting to the
 * repo-root `content/` — the same path the Express `/content/*` handler serves
 * and the same one the Vite dev middleware mirrors, so the server-side
 * simulation and the browser always read identical bytes.
 */
export function contentDir(): string {
  return getEnv().contentDir;
}

/** fs loader for ConfigService.load(), reading JSON relative to {@link contentDir}. */
export async function fsLoader(relPath: string): Promise<unknown> {
  const abs = path.join(contentDir(), relPath);
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
