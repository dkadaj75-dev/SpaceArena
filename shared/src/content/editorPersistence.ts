import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CONFIG_SCHEMAS,
  manifestSchema,
  type AnyConfig,
  type ConfigType,
  type ManifestConfig,
} from "../schemas/index.js";
import { contentPathFor, isContentConfigPath } from "./configPath.js";

export interface EditorSaveRequest {
  path: string;
  json: unknown;
}

export interface EditorSaveResult {
  path: string;
  addedToManifest: boolean;
}

export interface EditorDeleteRequest {
  path: string;
}

export interface EditorDeleteResult {
  path: string;
  /** False when the file was already gone — the delete is still a success. */
  existed: boolean;
  removedFromManifest: boolean;
}

/**
 * Validate and persist one editor config. New configs are added to the manifest
 * in the same operation so a successful save is guaranteed to survive reload.
 */
export async function persistEditorConfig(contentDir: string, payload: EditorSaveRequest): Promise<EditorSaveResult> {
  if (!isConfigObject(payload.json)) throw new Error("config must contain a known type");
  const parsed = CONFIG_SCHEMAS[payload.json.type].safeParse(payload.json);
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
  }

  const config = parsed.data as AnyConfig;
  const expectedPath = contentPathFor(config);
  const requestedPath = payload.path.split("\\").join("/");
  if (requestedPath !== expectedPath) {
    throw new Error(`path must be ${expectedPath} for ${config.id}`);
  }

  const absolute = path.resolve(contentDir, expectedPath);
  const relative = path.relative(path.resolve(contentDir), absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("invalid content path");

  const manifest = await readManifest(contentDir);
  const addedToManifest = !manifest.files.includes(expectedPath);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  if (addedToManifest) await writeManifest(contentDir, { ...manifest, files: [...manifest.files, expectedPath] });

  return { path: expectedPath, addedToManifest };
}

/**
 * Delete one editor config from the content tree and drop it from the manifest,
 * so the deletion survives a reload exactly as {@link persistEditorConfig}'s
 * write does.
 *
 * There is no config to regenerate the path from here, so the path is validated
 * structurally — a known content folder, a json leaf, and no escape from
 * `contentDir` — before anything is unlinked.
 */
export async function removeEditorConfig(contentDir: string, payload: EditorDeleteRequest): Promise<EditorDeleteResult> {
  const requestedPath = payload.path.split("\\").join("/");
  if (!isContentConfigPath(requestedPath)) throw new Error(`refusing to delete "${payload.path}": not a content config path`);

  const absolute = path.resolve(contentDir, requestedPath);
  const relative = path.relative(path.resolve(contentDir), absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("invalid content path");

  let existed = true;
  try {
    await unlink(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // Already gone: still reconcile the manifest so a half-applied delete heals.
    existed = false;
  }

  const manifest = await readManifest(contentDir);
  const removedFromManifest = manifest.files.includes(requestedPath);
  if (removedFromManifest) {
    await writeManifest(contentDir, { ...manifest, files: manifest.files.filter((file) => file !== requestedPath) });
  }

  return { path: requestedPath, existed, removedFromManifest };
}

async function readManifest(contentDir: string): Promise<ManifestConfig> {
  const manifestRaw: unknown = JSON.parse(await readFile(path.join(contentDir, "manifest.json"), "utf8"));
  const parsed = manifestSchema.safeParse(manifestRaw);
  if (!parsed.success) {
    throw new Error(`invalid manifest.json: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return parsed.data;
}

/** Manifest writes go through a temp file + rename so a crash cannot truncate it. */
async function writeManifest(contentDir: string, manifest: ManifestConfig): Promise<void> {
  const manifestPath = path.join(contentDir, "manifest.json");
  const tempPath = `${manifestPath}.editor-save.tmp`;
  await writeFile(tempPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await rename(tempPath, manifestPath);
}

function isConfigObject(value: unknown): value is { type: ConfigType } {
  return typeof value === "object"
    && value !== null
    && typeof (value as { type?: unknown }).type === "string"
    && (value as { type: string }).type in CONFIG_SCHEMAS;
}
