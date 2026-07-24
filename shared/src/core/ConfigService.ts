import type { EventBus } from "./EventBus.js";
import {
  CONFIG_TYPES,
  collectReferences,
  collectRelationalErrors,
  manifestSchema,
  validateConfig,
  type AnyConfig,
  type ConfigType,
} from "../schemas/index.js";

/** A structured, human-readable config problem. */
export interface ConfigError {
  /** Source file (relative path from the manifest), or "<manifest>". */
  file: string;
  /** JSON path within the file, e.g. `core.energy.capacitor`. */
  path: string;
  /** What went wrong. */
  message: string;
}

export interface LoadResult {
  ok: boolean;
  errors: ConfigError[];
  /** Number of loaded configs per type (only meaningful when ok). */
  counts: Partial<Record<ConfigType, number>>;
}

export interface ReplaceResult {
  ok: boolean;
  errors: ConfigError[];
}

/** Events emitted by ConfigService onto an injected bus. */
export interface ConfigEvents extends Record<string, unknown> {
  "config:changed": { id: string; type: ConfigType };
}

/** Loads a content file (relative path) and returns its parsed JSON. */
export type ConfigLoader = (path: string) => Promise<unknown>;

function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== "object") return obj;
  for (const value of Object.values(obj as Record<string, unknown>)) {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
      deepFreeze(value);
    }
  }
  return Object.freeze(obj);
}

/**
 * Environment-agnostic config registry. The constructor takes a loader fn so the
 * same class works with `fetch` (client), `fs` (server/tools), or a stub (tests).
 */
export class ConfigService {
  private readonly registry = new Map<ConfigType, Map<string, AnyConfig>>();
  private readonly idIndex = new Map<string, ConfigType>();

  constructor(
    private readonly loader: ConfigLoader,
    private readonly bus?: EventBus<ConfigEvents>,
  ) {
    for (const type of CONFIG_TYPES) {
      this.registry.set(type, new Map());
    }
  }

  /**
   * Load the manifest (by path) and every file it lists. Validates all configs,
   * aggregates structured errors, then resolves cross-references (dangling id =
   * error). On success the registry is populated with deep-frozen objects; on
   * failure the registry is left untouched.
   */
  async load(manifestPath: string): Promise<LoadResult> {
    const errors: ConfigError[] = [];

    let manifestRaw: unknown;
    try {
      manifestRaw = await this.loader(manifestPath);
    } catch (err) {
      return {
        ok: false,
        errors: [{ file: manifestPath, path: "", message: `failed to load manifest: ${String(err)}` }],
        counts: {},
      };
    }

    const manifestParsed = manifestSchema.safeParse(manifestRaw);
    if (!manifestParsed.success) {
      return {
        ok: false,
        errors: zodToErrors(manifestPath, manifestParsed.error),
        counts: {},
      };
    }

    // Stage into fresh maps; commit only if fully valid.
    const staged = new Map<ConfigType, Map<string, AnyConfig>>();
    const stagedIndex = new Map<string, ConfigType>();
    for (const type of CONFIG_TYPES) staged.set(type, new Map());

    // Track where each config came from for later reference errors.
    const fileById = new Map<string, string>();
    const configs: AnyConfig[] = [];

    for (const file of manifestParsed.data.files) {
      let raw: unknown;
      try {
        raw = await this.loader(file);
      } catch (err) {
        errors.push({ file, path: "", message: `failed to load file: ${String(err)}` });
        continue;
      }
      const result = validateConfig(raw);
      if (!result.success) {
        if (result.error) {
          errors.push(...zodToErrors(file, result.error));
        } else {
          errors.push({ file, path: "", message: result.message ?? "invalid config" });
        }
        continue;
      }
      const config = result.data;
      if (stagedIndex.has(config.id)) {
        errors.push({
          file,
          path: "id",
          message: `duplicate config id: ${config.id} (also in ${fileById.get(config.id)})`,
        });
        continue;
      }
      stagedIndex.set(config.id, result.type);
      fileById.set(config.id, file);
      staged.get(result.type)!.set(config.id, config);
      configs.push(config);
    }

    // Resolve cross-references against the full staged id set.
    const stagedResolve = (type: ConfigType, id: string): AnyConfig | undefined => staged.get(type)?.get(id);
    for (const config of configs) {
      for (const ref of collectReferences(config)) {
        if (!stagedIndex.has(ref.id)) {
          errors.push({
            file: fileById.get(config.id) ?? config.id,
            path: ref.path,
            message: `dangling reference: no config with id "${ref.id}"`,
          });
        }
      }
      // Relational (cross-config) constraints, e.g. ship defaultFitting vs sockets.
      for (const rel of collectRelationalErrors(config, stagedResolve)) {
        errors.push({ file: fileById.get(config.id) ?? config.id, path: rel.path, message: rel.message });
      }
    }

    if (errors.length > 0) {
      return { ok: false, errors, counts: {} };
    }

    // Commit: freeze and swap.
    this.registry.clear();
    this.idIndex.clear();
    const counts: Partial<Record<ConfigType, number>> = {};
    for (const type of CONFIG_TYPES) {
      const map = staged.get(type)!;
      for (const config of map.values()) deepFreeze(config);
      this.registry.set(type, map);
      if (map.size > 0) counts[type] = map.size;
    }
    for (const [id, type] of stagedIndex) this.idIndex.set(id, type);

    return { ok: true, errors: [], counts };
  }

  /** Typed getter for a single config by type + id. */
  get<T extends AnyConfig = AnyConfig>(type: ConfigType, id: string): T | undefined {
    return this.registry.get(type)?.get(id) as T | undefined;
  }

  /** All configs of a given type. */
  getAll<T extends AnyConfig = AnyConfig>(type: ConfigType): T[] {
    return Array.from(this.registry.get(type)?.values() ?? []) as T[];
  }

  /** Whether any config with this id exists. */
  has(id: string): boolean {
    return this.idIndex.has(id);
  }

  /** The type of the config with this id, if any. */
  typeOf(id: string): ConfigType | undefined {
    return this.idIndex.get(id);
  }

  /**
   * Re-validate a single config, re-check its outgoing references against the
   * current registry, swap it in, and emit `config:changed`. Used by dev
   * hot-reload. Returns structured errors on failure (registry untouched).
   */
  replace(raw: unknown): ReplaceResult {
    const result = validateConfig(raw);
    if (!result.success) {
      const errors = result.error
        ? zodToErrors("<replace>", result.error)
        : [{ file: "<replace>", path: "", message: result.message ?? "invalid config" }];
      return { ok: false, errors };
    }
    const config = result.data;

    // Existing id must keep its type (can't morph a ship into a module).
    const existingType = this.idIndex.get(config.id);
    if (existingType && existingType !== result.type) {
      return {
        ok: false,
        errors: [
          {
            file: "<replace>",
            path: "type",
            message: `cannot change type of ${config.id} from ${existingType} to ${result.type}`,
          },
        ],
      };
    }

    // Outgoing refs must resolve (self counts, so add id first).
    const errors: ConfigError[] = [];
    for (const ref of collectReferences(config)) {
      if (ref.id !== config.id && !this.idIndex.has(ref.id)) {
        errors.push({
          file: "<replace>",
          path: ref.path,
          message: `dangling reference: no config with id "${ref.id}"`,
        });
      }
    }
    // Relational constraints against the live registry (self-lookups see the new value).
    for (const rel of collectRelationalErrors(config, (type, id) =>
      id === config.id ? config : this.registry.get(type)?.get(id),
    )) {
      errors.push({ file: "<replace>", path: rel.path, message: rel.message });
    }
    if (errors.length > 0) return { ok: false, errors };

    deepFreeze(config);
    this.registry.get(result.type)!.set(config.id, config);
    this.idIndex.set(config.id, result.type);
    this.bus?.emit("config:changed", { id: config.id, type: result.type });
    return { ok: true, errors: [] };
  }
}

function zodToErrors(file: string, error: { issues: readonly { path: PropertyKey[]; message: string }[] }): ConfigError[] {
  return error.issues.map((issue) => ({
    file,
    path: issue.path.map(String).join(".") || "(root)",
    message: issue.message,
  }));
}
