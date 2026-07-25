/**
 * Content-pack bundles (ROADMAP §11 6.7 / S6).
 *
 * A **bundle** is the entire content pack as one JSON document: the manifest
 * plus every file the manifest lists, keyed by its content-relative path. It is
 * the unit that moves between environments — exported from a dev machine or a
 * running server, imported into production over the admin API, with **no
 * redeploy**.
 *
 * Everything here is environment-agnostic on purpose (no `node:fs`, no
 * `node:crypto`), so the same code validates a bundle in a tool, on the server,
 * and — if an editor ever wants a pre-flight check — in the browser.
 *
 * The validation guarantee is deliberately *not* re-implemented: a bundle is
 * checked by handing {@link ConfigService} a loader that reads out of the bundle
 * instead of off the disk. That means an imported pack passes **exactly** the
 * gate `npm run validate:content` and server boot apply — every schema, every
 * cross-reference, every relational rule — and the errors come back in the same
 * `{ file, path, message }` shape the editors and the CLI already print.
 */
import { ConfigService, type ConfigError, type ConfigLoader } from "../core/ConfigService.js";
import { z } from "zod";
import { PROTOCOL_VERSION } from "../constants.js";
import type { ConfigType } from "../schemas/index.js";

/** Discriminator stored in every bundle, so a stray JSON file cannot be mistaken for one. */
export const CONTENT_BUNDLE_KIND = "space-arena.content-pack";

/** The manifest's fixed path inside a pack (and inside a bundle). */
export const MANIFEST_FILENAME = "manifest.json";

/**
 * Hard ceiling on files in one bundle. The real pack is ~55 files; 2000 leaves
 * enormous headroom while keeping a hostile bundle from creating a directory
 * tree the size of the disk before validation has even finished.
 */
export const MAX_BUNDLE_FILES = 2000;

/**
 * Default ceiling on the raw JSON body of an import, in bytes. The real pack
 * serializes to ~120 kb, so 8 MB is ~60× headroom and still small enough that a
 * malicious body cannot exhaust the server's heap. Overridable per deployment
 * (`CONTENT_IMPORT_MAX_BYTES`).
 */
export const DEFAULT_IMPORT_MAX_BYTES = 8 * 1024 * 1024;

/**
 * A content-relative file path inside a bundle.
 *
 * Import writes these to disk, so this is a security boundary, not a style
 * check. Rejected: absolute paths, Windows drive letters, UNC prefixes,
 * backslashes, `.`/`..` segments, empty segments, and anything that is not
 * `.json`. Only forward slashes and a conservative charset survive.
 */
const SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;

/** Returns a human-readable problem with `path`, or null when it is safe. */
export function contentPathProblem(path: string): string | null {
  if (path.length === 0) return "empty path";
  if (path.length > 200) return "path is longer than 200 characters";
  if (path.includes("\\")) return "path must use forward slashes";
  if (path.startsWith("/")) return "path must be relative to the content root";
  if (/^[A-Za-z]:/.test(path)) return "path must not be absolute (drive letter)";
  if (path.includes("\0")) return "path contains a NUL byte";
  if (!path.toLowerCase().endsWith(".json")) return "content pack files must be .json";
  for (const segment of path.split("/")) {
    if (segment === "") return "path has an empty segment";
    if (segment === "." || segment === "..") return "path must not contain `.` or `..` segments";
    if (!SEGMENT_PATTERN.test(segment)) return `path segment ${JSON.stringify(segment)} has unsupported characters`;
  }
  return null;
}

/** True when `path` is safe to write under the content root. */
export function isSafeContentPath(path: string): boolean {
  return contentPathProblem(path) === null;
}

/**
 * Envelope schema. Note that `manifest` and the values of `files` are
 * intentionally `unknown` here — validating *those* is ConfigService's job, and
 * duplicating it would let the two drift apart.
 */
export const contentBundleSchema = z.object({
  kind: z.literal(CONTENT_BUNDLE_KIND),
  /** Wire/protocol generation this pack was authored against. Must match the server. */
  protocolVersion: z.number().int().nonnegative(),
  /** The manifest's `id`, echoed for readability in logs and the export listing. */
  packId: z.string().min(1),
  /** The manifest's `version` field — the pack's own revision number. */
  packVersion: z.number().int().nonnegative(),
  /** ISO-8601 timestamp of when the bundle was produced. */
  generatedAt: z.string().min(1),
  /** `sha256:<hex>` over the canonical serialization (see {@link computeSourceHash}). */
  sourceHash: z.string().min(1),
  manifest: z.unknown(),
  files: z.record(z.string(), z.unknown()),
});

export type ContentBundle = z.infer<typeof contentBundleSchema> & {
  manifest: unknown;
  files: Record<string, unknown>;
};

/** Outcome of {@link validateBundle}: the same error shape the editors render. */
export interface BundleValidation {
  ok: boolean;
  errors: ConfigError[];
  /** Loaded config counts per type — only meaningful when `ok`. */
  counts: Partial<Record<ConfigType, number>>;
  /** The parsed envelope. Present whenever the envelope itself parsed. */
  bundle?: ContentBundle;
}

/**
 * A {@link ConfigLoader} that resolves out of a bundle rather than the disk.
 * Unknown paths throw, which ConfigService already reports as a per-file error,
 * so "manifest lists a file the bundle does not carry" needs no special case.
 */
export function bundleLoader(bundle: ContentBundle): ConfigLoader {
  return async (path: string): Promise<unknown> => {
    if (path === MANIFEST_FILENAME) return bundle.manifest;
    if (!Object.prototype.hasOwnProperty.call(bundle.files, path)) {
      throw new Error(`not present in bundle`);
    }
    return bundle.files[path];
  };
}

/**
 * Validate a bundle end to end: envelope shape → protocol match → path safety →
 * the full ConfigService load (schemas + typed references + relational rules).
 *
 * Nothing is written and no global state is touched; this is a pure predicate
 * over the candidate pack, which is what lets the import endpoint decide
 * *before* it goes anywhere near the filesystem.
 *
 * @param expectedProtocolVersion defaults to this build's {@link PROTOCOL_VERSION}.
 */
export async function validateBundle(
  raw: unknown,
  expectedProtocolVersion: number = PROTOCOL_VERSION,
): Promise<BundleValidation> {
  const parsed = contentBundleSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      counts: {},
      errors: parsed.error.issues.map((issue) => ({
        file: "<bundle>",
        path: issue.path.map(String).join(".") || "(root)",
        message: issue.message,
      })),
    };
  }
  const bundle = parsed.data as ContentBundle;

  // Protocol gate first: a pack authored for a different wire generation may
  // parse cleanly and still mean something else. Refuse before doing more work.
  if (bundle.protocolVersion !== expectedProtocolVersion) {
    return {
      ok: false,
      counts: {},
      bundle,
      errors: [
        {
          file: "<bundle>",
          path: "protocolVersion",
          message:
            `bundle targets protocol version ${bundle.protocolVersion} but this server speaks ` +
            `${expectedProtocolVersion} — re-export the pack from a matching build`,
        },
      ],
    };
  }

  const errors: ConfigError[] = [];

  const paths = Object.keys(bundle.files);
  if (paths.length === 0) {
    errors.push({ file: "<bundle>", path: "files", message: "bundle contains no content files" });
  }
  if (paths.length > MAX_BUNDLE_FILES) {
    errors.push({
      file: "<bundle>",
      path: "files",
      message: `bundle has ${paths.length} files, more than the ${MAX_BUNDLE_FILES} allowed`,
    });
  }
  for (const path of paths) {
    const problem = contentPathProblem(path);
    if (problem) errors.push({ file: path, path: "(path)", message: `unsafe file path: ${problem}` });
    if (path === MANIFEST_FILENAME) {
      errors.push({
        file: path,
        path: "(path)",
        message: "the manifest travels in `manifest`, not in `files`",
      });
    }
  }
  // A path-unsafe bundle must never reach the writer, so stop here.
  if (errors.length > 0) return { ok: false, errors, counts: {}, bundle };

  // The real gate: load the whole pack through ConfigService.
  const service = new ConfigService(bundleLoader(bundle));
  const result = await service.load(MANIFEST_FILENAME);
  errors.push(...result.errors);

  // Files carried but never listed would be written and then ignored — a silent
  // way for a pack to drift from what the server actually loads.
  if (result.ok) {
    const listed = new Set(manifestFiles(bundle.manifest));
    for (const path of paths) {
      if (!listed.has(path)) {
        errors.push({
          file: path,
          path: "(path)",
          message: "file is not listed in manifest.files — add it to the manifest or drop it from the bundle",
        });
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors, counts: {}, bundle };
  return { ok: true, errors: [], counts: result.counts, bundle };
}

/** Best-effort read of `manifest.files` from an unvalidated manifest object. */
export function manifestFiles(manifest: unknown): string[] {
  const files = (manifest as { files?: unknown } | null)?.files;
  return Array.isArray(files) ? files.filter((f): f is string => typeof f === "string") : [];
}

/**
 * Deterministic serialization of a pack's contents: every file path sorted, each
 * followed by its JSON with **sorted object keys**. Key order and whitespace in
 * the source files therefore cannot change the hash, but any value change does.
 */
export function canonicalPackString(manifest: unknown, files: Record<string, unknown>): string {
  const parts: string[] = [`${MANIFEST_FILENAME} ${stableStringify(manifest)}`];
  for (const path of Object.keys(files).sort()) {
    parts.push(`${path} ${stableStringify(files[path])}`);
  }
  return parts.join("");
}

/**
 * `sha256:<hex>` over {@link canonicalPackString}, for provenance: it answers
 * "is the pack on this server byte-for-byte the one I exported?" without
 * diffing 55 files.
 *
 * Uses WebCrypto (`globalThis.crypto.subtle`), present in Node ≥ 18 and every
 * browser, so this module stays free of `node:crypto` and remains bundleable.
 * It is a provenance digest, not an authenticity check — a bundle is trusted
 * because the caller held an admin token, not because a hash matched.
 */
export async function computeSourceHash(manifest: unknown, files: Record<string, unknown>): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalPackString(manifest, files));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `sha256:${hex}`;
}

/** Build a bundle envelope around an already-collected manifest + files map. */
export async function buildBundle(manifest: unknown, files: Record<string, unknown>): Promise<ContentBundle> {
  const meta = manifest as { id?: unknown; version?: unknown } | null;
  return {
    kind: CONTENT_BUNDLE_KIND,
    protocolVersion: PROTOCOL_VERSION,
    packId: typeof meta?.id === "string" ? meta.id : "manifest.unknown",
    packVersion: typeof meta?.version === "number" ? meta.version : 0,
    generatedAt: new Date().toISOString(),
    sourceHash: await computeSourceHash(manifest, files),
    manifest,
    files,
  };
}

/** JSON.stringify with object keys sorted at every depth (arrays keep their order). */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}
