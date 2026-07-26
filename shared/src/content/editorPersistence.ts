import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CONFIG_SCHEMAS,
  manifestSchema,
  type AnyConfig,
  type ConfigType,
  type ManifestConfig,
} from "../schemas/index.js";
import { contentPathFor } from "./configPath.js";

export interface EditorSaveRequest {
  path: string;
  json: unknown;
}

export interface EditorSaveResult {
  path: string;
  addedToManifest: boolean;
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

  const manifestPath = path.join(contentDir, "manifest.json");
  const manifestRaw: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
  const manifestParsed = manifestSchema.safeParse(manifestRaw);
  if (!manifestParsed.success) {
    throw new Error(`invalid manifest.json: ${manifestParsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }

  const manifest: ManifestConfig = manifestParsed.data;
  const addedToManifest = !manifest.files.includes(expectedPath);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  if (addedToManifest) {
    const next = { ...manifest, files: [...manifest.files, expectedPath] };
    const tempPath = `${manifestPath}.editor-save.tmp`;
    await writeFile(tempPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    await rename(tempPath, manifestPath);
  }

  return { path: expectedPath, addedToManifest };
}

function isConfigObject(value: unknown): value is { type: ConfigType } {
  return typeof value === "object"
    && value !== null
    && typeof (value as { type?: unknown }).type === "string"
    && (value as { type: string }).type in CONFIG_SCHEMAS;
}
