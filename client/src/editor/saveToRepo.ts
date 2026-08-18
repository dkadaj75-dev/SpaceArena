import { contentPathFor, type AnyConfig, type ContentBundle } from "@space-arena/shared";

export interface RepoFileResult {
  path: string;
  kind: "save" | "delete";
  ok: boolean;
  /** Present only on failure — the dev server's own message. */
  error?: string;
}

export interface RepoSaveSummary {
  results: RepoFileResult[];
  saved: number;
  failed: number;
}

/** Just enough of {@link import("./DraftPackStore.js").DraftPackStore} to write it out. */
export interface RepoSaveSource {
  dirtyPaths(): string[];
  snapshot(): ContentBundle;
}

/**
 * Is the dev-only editor middleware reachable? `/__editor/*` exists solely in
 * `vite.config.ts`, so a production build answers with the SPA fallback (or a
 * 404) and "Save to repo" stays disabled. `list-models` is the read-only member
 * of the family, so probing costs nothing.
 */
export async function repoSaveAvailable(): Promise<boolean> {
  try {
    const response = await fetch("/__editor/list-models");
    if (!response.ok) return false;
    const body = (await response.json()) as { models?: unknown };
    return Array.isArray(body.models);
  } catch {
    return false;
  }
}

/**
 * Write every dirty draft file into the repo's `content/` tree through the dev
 * middleware: changed and new configs go to `/__editor/save`, configs the draft
 * dropped go to `/__editor/delete`.
 *
 * Each file is reported independently so a single rejected config does not hide
 * the ones that landed; the caller keeps the draft dirty whenever `failed > 0`.
 */
export async function saveDraftToRepo(draft: RepoSaveSource): Promise<RepoSaveSummary> {
  const bundle = draft.snapshot();
  const results: RepoFileResult[] = [];
  for (const path of draft.dirtyPaths()) {
    const config = bundle.files[path] as AnyConfig | undefined;
    results.push(config ? await save(config) : await remove(path));
  }
  return { results, saved: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
}

async function save(config: AnyConfig): Promise<RepoFileResult> {
  // The middleware insists the path be the one the config's own id implies, so
  // a renamed config lands at its NEW path (the old file is not swept up).
  const path = contentPathFor(config);
  return post("/__editor/save", { path, json: config }, path, "save");
}

async function remove(path: string): Promise<RepoFileResult> {
  return post("/__editor/delete", { path }, path, "delete");
}

async function post(url: string, body: unknown, path: string, kind: RepoFileResult["kind"]): Promise<RepoFileResult> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) return { path, kind, ok: false, error: await response.text() };
    return { path, kind, ok: true };
  } catch (error) {
    return { path, kind, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
