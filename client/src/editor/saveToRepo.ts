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

/** Where the probe above has got to. Kept explicit so "checking" never reads as "broken". */
export type RepoAvailability = "checking" | "available" | "unavailable";

/** Everything the toolbar needs to draw one trustworthy Save control. */
export interface SaveActionState {
  label: string;
  disabled: boolean;
  /** Tooltip. Always says WHY when the button cannot be pressed. */
  title: string;
  /** Visible one-liner beside the button; null when nothing needs explaining. */
  hint: string | null;
  /** Promote "Download draft" — the only durable save left when repo save is out. */
  fallback: boolean;
  /** Dirty-state badge text. */
  status: string;
  /** Badge state for CSS / `data-` hooks: nothing to save, saved, or pending. */
  tone: "clean" | "saved" | "dirty";
}

const UNAVAILABLE_WHY =
  "Saving to the repo needs the Vite dev server (npm run dev) — this build serves no /__editor endpoint. "
  + "Use “Download draft” to keep this work; the draft also stays in this browser until you discard it.";

/**
 * The single source of truth for how Save presents itself.
 *
 * Split out of `ConstellationApp` because the old failure was invisible: the
 * button silently sat `disabled` with a tooltip nobody hovers, in a footer that
 * scrolls sideways. A disabled control that cannot say why it is disabled is
 * indistinguishable from a broken editor, which is how a draft gets lost.
 *
 * @param savedSinceEdit the draft was written to the repo and not touched since
 *   — it is still "dirty" against the loaded pack (publish is a separate step),
 *   but nothing is at risk, so the badge must not keep crying unsaved.
 */
export function saveActionState(
  availability: RepoAvailability,
  dirtyCount: number,
  savedSinceEdit = false,
): SaveActionState {
  const dirty = dirtyCount > 0;
  const status = !dirty
    ? "No changes"
    : savedSinceEdit
      ? `Saved to repo · ${dirtyCount} file(s) ahead of the live pack`
      : `${dirtyCount} unsaved change(s)`;
  const tone: SaveActionState["tone"] = !dirty ? "clean" : savedSinceEdit ? "saved" : "dirty";

  if (availability === "checking") {
    return { label: "Save to repo", disabled: true, title: "Checking whether the dev server's /__editor endpoint is reachable…", hint: null, fallback: false, status, tone };
  }
  if (availability === "unavailable") {
    return {
      label: "Save to repo — unavailable",
      disabled: true,
      title: UNAVAILABLE_WHY,
      hint: "Repo save needs `npm run dev`. Use Download draft to keep this work.",
      fallback: true,
      status,
      tone,
    };
  }
  if (!dirty) {
    return { label: "Save to repo", disabled: true, title: "Nothing to save — the draft matches the files on disk.", hint: null, fallback: false, status, tone };
  }
  if (savedSinceEdit) {
    return { label: "Saved to repo", disabled: true, title: "Every changed file is already written to content/. Publish separately to take it live.", hint: null, fallback: false, status, tone };
  }
  return {
    label: `Save to repo · ${dirtyCount}`,
    disabled: false,
    title: "Write every changed file into the repo's content/ directory.",
    hint: null,
    fallback: false,
    status,
    tone,
  };
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
