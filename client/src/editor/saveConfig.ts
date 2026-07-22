import type { AnyConfig, ConfigType } from "@space-arena/shared";

/** Content-relative subfolder for each config type (mirrors content/ layout). */
const CONTENT_FOLDERS: Record<ConfigType, string> = {
  ship: "ships",
  module: "modules",
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
  botprofile: "bots",
};

/** Strips the `type.` prefix from a config id to get its file slug. */
function slugFor(type: ConfigType, id: string): string {
  const prefix = `${type}.`;
  return id.startsWith(prefix) ? id.slice(prefix.length) : id;
}

/** Content-relative save path for a config, matching MapEditor's arena convention. */
export function contentPathFor(config: Pick<AnyConfig, "id" | "type">): string {
  return `${CONTENT_FOLDERS[config.type]}/${slugFor(config.type, config.id)}.json`;
}

/** POSTs a config to the dev `/__editor/save` endpoint. Returns an error string, or null on success. */
export async function saveConfig(config: AnyConfig): Promise<string | null> {
  const res = await fetch("/__editor/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: contentPathFor(config), json: config }),
  });
  if (!res.ok) return `Save failed: ${await res.text()}`;
  return null;
}
