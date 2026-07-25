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

/** Build an fs loader for ConfigService.load(), reading JSON relative to `dir`. */
export function fsLoaderFor(dir: string): (relPath: string) => Promise<unknown> {
  return async (relPath: string): Promise<unknown> => {
    const abs = path.join(dir, relPath);
    const text = await readFile(abs, "utf8");
    try {
      return JSON.parse(text);
    } catch (err) {
      throw new Error(`invalid JSON in ${relPath}: ${(err as Error).message}`);
    }
  };
}

/** fs loader for ConfigService.load(), reading JSON relative to {@link contentDir}. */
export async function fsLoader(relPath: string): Promise<unknown> {
  return fsLoaderFor(contentDir())(relPath);
}

/**
 * Build + load a ConfigService from `dir` (fail fast on invalid content). Used
 * at boot and again after a content-pack import swaps the directory in place
 * (ROADMAP §11 6.7) — same code path, so a hot reload can never be laxer than a
 * cold start.
 */
export async function loadContentFrom(dir: string): Promise<ConfigService> {
  const cs = new ConfigService(fsLoaderFor(dir));
  const result = await cs.load("manifest.json");
  if (!result.ok) {
    const detail = result.errors
      .map((e) => `  • ${e.file}${e.path ? ` → ${e.path}` : ""}: ${e.message}`)
      .join("\n");
    throw new Error(`content validation failed:\n${detail}`);
  }
  return cs;
}

/** Build + load a ConfigService from the configured content dir. */
export async function loadContent(): Promise<ConfigService> {
  return loadContentFrom(contentDir());
}
