/**
 * The live content pack on disk (ROADMAP §11 6.7 / S6).
 *
 * One directory — the one `CONTENT_DIR` points at, the one `express.static`
 * serves at `/content/*`, the one ConfigService loads — is *the* pack. This
 * module is the only thing allowed to replace it, and it does so without
 * stopping the server:
 *
 * ```
 *   content.staging-<ts>/   ← written, fsynced, never yet visible
 *   content/                ← renamed to content.previous/
 *   content.staging-<ts>/   ← renamed to content/          (now live)
 * ```
 *
 * Two renames inside one directory on one volume. Between them the pack is
 * briefly absent, which is why the previous pack is moved rather than deleted:
 * if the second rename fails, the first is undone and the old pack is back
 * before the call returns. When both succeed, `content.previous/` stays put and
 * becomes the one-step rollback.
 *
 * ### Why not "write the files in place"
 *
 * Because a half-written pack is a *served* pack. `/content/*` is live traffic
 * and ConfigService reads the same bytes; there is no window in which a client
 * may fetch an arena that references an asteroid that has not landed yet.
 *
 * ### Windows
 *
 * `rename()` on a directory fails with EPERM/EBUSY on Windows if **any** handle
 * inside it is open — an in-flight `express.static` read, an editor with the
 * file open, an antivirus scanner mid-scan, or a shell whose cwd is inside it.
 * The swap therefore retries with backoff ({@link SWAP_RETRIES}), which clears
 * the transient cases (a static read lasts milliseconds). A *held* handle — a
 * process cwd, an open editor — is not transient and no retry count fixes it;
 * the import fails cleanly with the old pack still live, and the operator gets
 * told what to close. See docs/CONTENT.md.
 */
import { createHash } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import {
  MANIFEST_FILENAME,
  buildBundle,
  createLogger,
  isSafeContentPath,
  manifestFiles,
  validateBundle,
  type ConfigError,
  type ConfigService,
  type ContentBundle,
} from "@space-arena/shared";
import { contentDir, loadContentFrom, setConfigService } from "../configService.js";

const log = createLogger("ContentPack");

/** Directory-rename retry budget, and the pause between attempts (ms). */
export const SWAP_RETRIES = 12;
export const SWAP_RETRY_DELAY_MS = 120;

/** Errno values that mean "something still has this open, try again". */
const TRANSIENT_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY", "ENOTEMPTY", "EEXIST"]);

/** Suffix of the directory holding the pack that was live before the last import. */
export const PREVIOUS_SUFFIX = ".previous";

export interface ImportSuccess {
  ok: true;
  /** Pack identity now live. */
  packId: string;
  packVersion: number;
  sourceHash: string;
  /** Config counts per type, straight from the validating load. */
  counts: Record<string, number>;
  /** Number of JSON files written. */
  files: number;
  /** True when a `content.previous/` snapshot is now available for rollback. */
  rollbackAvailable: boolean;
}

export interface ImportFailure {
  ok: false;
  /** Where the import stopped: `validation` (nothing touched) or `swap` (rolled back). */
  stage: "validation" | "swap";
  /** Per-file problems in the same `{ file, path, message }` shape the editors show. */
  errors: ConfigError[];
}

export type ImportResult = ImportSuccess | ImportFailure;

/** Live pack identity, surfaced on `/health` so an operator can confirm a deploy-free update. */
export interface PackInfo {
  packId: string;
  packVersion: number;
  sourceHash: string;
  files: number;
  loadedAt: string;
  rollbackAvailable: boolean;
}

/**
 * Owns one content directory: export it, replace it, roll it back, and keep the
 * process-wide ConfigService pointed at whatever is currently live.
 */
export class ContentPackStore {
  /** Serializes import/rollback — two concurrent swaps would race on the same paths. */
  private busy: Promise<unknown> = Promise.resolve();
  private info: PackInfo | null = null;
  private readonly rename: (from: string, to: string) => Promise<void>;

  /**
   * @param dir the live content directory.
   * @param options.rename seam for the directory rename. Production uses
   *   {@link renameWithRetry}; tests inject a failing rename to exercise the
   *   mid-swap rollback path, which is otherwise unreachable without corrupting
   *   a real filesystem.
   */
  constructor(
    readonly dir: string,
    options: { rename?: (from: string, to: string) => Promise<void> } = {},
  ) {
    this.rename = options.rename ?? renameWithRetry;
  }

  /** Sibling directory holding the pack replaced by the most recent import. */
  get previousDir(): string {
    return this.dir + PREVIOUS_SUFFIX;
  }

  /** True when a one-step rollback is possible. */
  async hasPrevious(): Promise<boolean> {
    return isDirectory(this.previousDir);
  }

  /**
   * Read the live pack off disk into a bundle. Only files the manifest lists are
   * included, so an export is exactly what a server would load — not whatever
   * happens to be lying in the directory.
   */
  async exportBundle(): Promise<ContentBundle> {
    return exportBundleFrom(this.dir);
  }

  /** Cached identity of the live pack, computed on first use. */
  async packInfo(): Promise<PackInfo> {
    if (!this.info) {
      const bundle = await this.exportBundle();
      this.info = {
        packId: bundle.packId,
        packVersion: bundle.packVersion,
        sourceHash: bundle.sourceHash,
        files: Object.keys(bundle.files).length,
        loadedAt: new Date().toISOString(),
        rollbackAvailable: await this.hasPrevious(),
      };
    }
    return this.info;
  }

  /**
   * Validate a candidate bundle and, if it is perfect, make it the live pack.
   *
   * Order matters and is the whole safety argument: **validate entirely in
   * memory → stage to a new directory → swap → reload**. Nothing is written
   * until the pack is known-good, and nothing is live until it is fully written.
   */
  async importBundle(raw: unknown): Promise<ImportResult> {
    return this.serialize(async () => {
      const validation = await validateBundle(raw);
      if (!validation.ok || !validation.bundle) {
        return { ok: false, stage: "validation", errors: validation.errors };
      }
      const bundle = validation.bundle;

      const staging = `${this.dir}.staging-${Date.now()}`;
      try {
        await writePackTo(staging, bundle);
      } catch (err) {
        await rm(staging, { recursive: true, force: true }).catch(() => {});
        return {
          ok: false,
          stage: "swap",
          errors: [{ file: "<staging>", path: "", message: `failed to stage the pack: ${String(err)}` }],
        };
      }

      try {
        await this.swapIn(staging);
      } catch (err) {
        await rm(staging, { recursive: true, force: true }).catch(() => {});
        return { ok: false, stage: "swap", errors: [{ file: "<swap>", path: "", message: describeSwapError(err) }] };
      }

      // Reload through the ordinary boot path. A failure here cannot corrupt the
      // running server (setConfigService is only reached on success), but it does
      // mean the on-disk pack disagrees with the in-memory one, so undo the swap.
      try {
        await this.reload();
      } catch (err) {
        await this.rollback().catch(() => {});
        return {
          ok: false,
          stage: "swap",
          errors: [{ file: "<reload>", path: "", message: `pack was valid but failed to load: ${String(err)}` }],
        };
      }

      const counts: Record<string, number> = {};
      for (const [type, n] of Object.entries(validation.counts)) if (n) counts[type] = n;

      log.info("content pack imported", {
        packId: bundle.packId,
        packVersion: bundle.packVersion,
        sourceHash: bundle.sourceHash,
        files: Object.keys(bundle.files).length,
      });

      return {
        ok: true,
        packId: bundle.packId,
        packVersion: bundle.packVersion,
        sourceHash: bundle.sourceHash,
        counts,
        files: Object.keys(bundle.files).length,
        rollbackAvailable: await this.hasPrevious(),
      };
    });
  }

  /**
   * Swap `content.previous/` back into place. Symmetric with import — the pack
   * being replaced becomes the new `content.previous/` — so rollback is itself
   * undoable, which is what you want at 3am when the rollback was the mistake.
   */
  async rollback(): Promise<ImportResult> {
    return this.serialize(async () => {
      if (!(await isDirectory(this.previousDir))) {
        return {
          ok: false,
          stage: "swap",
          errors: [{ file: "<rollback>", path: "", message: "no previous content pack to roll back to" }],
        };
      }
      // Move `previous` aside first: swapIn() wants to *create* previousDir.
      const restoring = `${this.dir}.restoring-${Date.now()}`;
      try {
        await this.rename(this.previousDir, restoring);
        await this.swapIn(restoring);
      } catch (err) {
        // Best effort: put previous back where it was so a retry can work.
        if (await isDirectory(restoring)) await renameWithRetry(restoring, this.previousDir).catch(() => {});
        return { ok: false, stage: "swap", errors: [{ file: "<rollback>", path: "", message: describeSwapError(err) }] };
      }

      await this.reload();
      const bundle = await this.exportBundle();
      log.info("content pack rolled back", { packId: bundle.packId, packVersion: bundle.packVersion });
      return {
        ok: true,
        packId: bundle.packId,
        packVersion: bundle.packVersion,
        sourceHash: bundle.sourceHash,
        counts: {},
        files: Object.keys(bundle.files).length,
        rollbackAvailable: await this.hasPrevious(),
      };
    });
  }

  /**
   * Rebuild the process-wide ConfigService from the live directory.
   *
   * A **new** ConfigService instance is installed rather than mutating the old
   * one. Rooms pin the instance they were created with (see ArenaRoom), so an
   * in-flight match keeps a coherent pack for its whole life while the next room
   * created picks up the new one. See docs/CONTENT.md.
   */
  async reload(): Promise<ConfigService> {
    const cs = await loadContentFrom(this.dir);
    setConfigService(cs);
    this.info = null; // recomputed lazily from the new bytes
    return cs;
  }

  /** content/ → content.previous/, staged → content/, with rollback if step 2 fails. */
  private async swapIn(stagingDir: string): Promise<void> {
    await rm(this.previousDir, { recursive: true, force: true });
    const live = await isDirectory(this.dir);
    if (live) await this.rename(this.dir, this.previousDir);
    try {
      await this.rename(stagingDir, this.dir);
    } catch (err) {
      // The window where no pack exists. Put the old one back before rethrowing.
      // This undo uses the real rename, never the injected seam: a test that
      // simulates a broken swap must still get its filesystem back.
      if (live) await renameWithRetry(this.previousDir, this.dir).catch(() => {});
      throw err;
    }
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.busy.then(fn, fn);
    this.busy = run.catch(() => {});
    return run;
  }
}

/** Read a content directory into a bundle (used by the store and by tools/export-content.ts). */
export async function exportBundleFrom(dir: string): Promise<ContentBundle> {
  const manifestRaw = await readFile(path.join(dir, MANIFEST_FILENAME), "utf8");
  const manifest: unknown = JSON.parse(manifestRaw);

  const files: Record<string, unknown> = {};
  for (const rel of manifestFiles(manifest)) {
    if (!isSafeContentPath(rel)) throw new Error(`manifest lists an unsafe path: ${rel}`);
    const text = await readFile(path.join(dir, ...rel.split("/")), "utf8");
    try {
      files[rel] = JSON.parse(text);
    } catch (err) {
      throw new Error(`invalid JSON in ${rel}: ${(err as Error).message}`);
    }
  }
  return buildBundle(manifest, files);
}

/**
 * Materialize a bundle into a fresh directory, fsyncing every file and the
 * directories that hold them. Without the fsync a crash between the write and
 * the rename can leave a directory that *looks* complete and holds zero-length
 * files — the classic "atomic rename over unflushed data" trap.
 */
async function writePackTo(dir: string, bundle: ContentBundle): Promise<void> {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });

  const dirs = new Set<string>([dir]);
  await writeJsonSynced(path.join(dir, MANIFEST_FILENAME), bundle.manifest);

  for (const [rel, json] of Object.entries(bundle.files)) {
    // Defence in depth: validateBundle already refused unsafe paths, but this is
    // the function that turns a string into a filesystem write.
    if (!isSafeContentPath(rel)) throw new Error(`refusing to write unsafe path ${JSON.stringify(rel)}`);
    const abs = path.join(dir, ...rel.split("/"));
    const parent = path.dirname(abs);
    if (!dirs.has(parent)) {
      await mkdir(parent, { recursive: true });
      dirs.add(parent);
    }
    await writeJsonSynced(abs, json);
  }

  for (const d of dirs) await syncDir(d);
}

async function writeJsonSynced(absPath: string, json: unknown): Promise<void> {
  const handle = await open(absPath, "w");
  try {
    await handle.writeFile(`${JSON.stringify(json, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * fsync a directory entry. Not supported on Windows (EPERM/EISDIR on opening a
 * directory for read) — swallowed there, because NTFS metadata journaling
 * already orders the rename after the writes.
 */
async function syncDir(dir: string): Promise<void> {
  try {
    const handle = await open(dir, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    /* platform does not allow fsync on a directory — see doc comment */
  }
}

/** rename() with backoff over the Windows "handle still open" errnos. */
export async function renameWithRetry(from: string, to: string, retries = SWAP_RETRIES): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (attempt >= retries || !TRANSIENT_RENAME_CODES.has(code)) throw err;
      log.warn(`rename ${path.basename(from)} → ${path.basename(to)} got ${code}, retrying`, {
        attempt: attempt + 1,
        of: retries,
      });
      await delay(SWAP_RETRY_DELAY_MS * (attempt + 1));
    }
  }
}

/** Turn a swap errno into something an operator can act on. */
export function describeSwapError(err: unknown): string {
  const code = (err as NodeJS.ErrnoException).code ?? "";
  if (TRANSIENT_RENAME_CODES.has(code)) {
    return (
      `could not swap the content directory (${code}) — the previous pack is still live. ` +
      `On Windows this means a handle inside the content directory is held open ` +
      `(an editor, a shell whose working directory is inside it, or a scanner). ` +
      `Close it and retry: ${String(err)}`
    );
  }
  return `could not swap the content directory: ${String(err)}`;
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Stable digest of a directory tree's JSON contents — used by tests and tooling. */
export async function hashDirectory(dir: string): Promise<string> {
  const hash = createHash("sha256");
  const walk = async (current: string, prefix: string): Promise<void> => {
    const entries = (await readdir(current, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(current, entry.name), rel);
      else hash.update(`${rel}\0${await readFile(path.join(current, entry.name), "utf8")}\0`);
    }
  };
  await walk(dir, "");
  return hash.digest("hex");
}

// ---------------------------------------------------------------------------
// Process-wide store
// ---------------------------------------------------------------------------

let store: ContentPackStore | null = null;

/** Replace the process-wide store (tests point it at a temp directory). */
export function setPackStore(next: ContentPackStore): void {
  store = next;
}

/** The process-wide store, defaulting to the configured `CONTENT_DIR`. */
export function getPackStore(): ContentPackStore {
  store ??= new ContentPackStore(contentDir());
  return store;
}

/** Test/teardown hook: forget the store so the next call re-reads the env. */
export function resetPackStore(): void {
  store = null;
}

/** Write a bundle to a directory. Exported for tools and tests. */
export { writePackTo };
