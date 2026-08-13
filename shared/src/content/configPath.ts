import type { AnyConfig, ConfigType } from "../schemas/index.js";

/** Content-pack folder for each manifest-loadable config type. */
const CONTENT_FOLDERS: Record<ConfigType, string> = {
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
  tutorial: "tutorials",
};

/** Canonical manifest-relative path for a config. */
export function contentPathFor(config: Pick<AnyConfig, "id" | "type">): string {
  const prefix = `${config.type}.`;
  const slug = config.id.startsWith(prefix) ? config.id.slice(prefix.length) : config.id;
  return `${CONTENT_FOLDERS[config.type]}/${slug}.json`;
}
