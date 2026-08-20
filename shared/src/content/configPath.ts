import type { AnyConfig, ConfigType } from "../schemas/index.js";

/** Content-pack folder for each manifest-loadable config type. */
export const CONTENT_FOLDERS: Record<ConfigType, string> = {
  ship: "ships",
  module: "modules",
  effect: "effects",
  upgrade: "upgrades",
  arena: "arenas",
  asteroid: "asteroids",
  gamemode: "gamemodes",
  camera: "camera",
  tuning: "tuning",
  action: "actions",
  event: "events",
  notification: "notifications",
  theme: "themes",
  progression: "progression",
  prop: "props",
  botprofile: "bots",
  quality: "quality",
  cosmetic: "cosmetics",
  texture: "textures",
  tutorial: "tutorials",
};

/** Canonical manifest-relative path for a config. */
export function contentPathFor(config: Pick<AnyConfig, "id" | "type">): string {
  const prefix = `${config.type}.`;
  const slug = config.id.startsWith(prefix) ? config.id.slice(prefix.length) : config.id;
  return `${CONTENT_FOLDERS[config.type]}/${slug}.json`;
}

const CONTENT_PATH = /^[a-z0-9-]+\/[a-z0-9][a-z0-9.-]*\.json$/;

/**
 * Whether a manifest-relative path could name a config file: one known content
 * folder, one json leaf, no traversal. The write path proves a path by
 * regenerating it from the config ({@link contentPathFor}); a delete has no
 * config to regenerate from, so it is checked structurally instead.
 */
export function isContentConfigPath(relative: string): boolean {
  const normalized = relative.split("\\").join("/");
  if (!CONTENT_PATH.test(normalized)) return false;
  const folder = normalized.slice(0, normalized.indexOf("/"));
  return Object.values(CONTENT_FOLDERS).includes(folder);
}
