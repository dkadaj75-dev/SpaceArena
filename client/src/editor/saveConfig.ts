import { contentPathFor, type AnyConfig } from "@space-arena/shared";

export { contentPathFor };

/**
 * Successful-save announcements. The shell's dirty tracker listens here so any
 * panel's own "Save to disk" button clears the config it saved — the tracker
 * pairs these against `config:changed` events by the same `type:id` key.
 */
type ConfigSavedListener = (config: AnyConfig) => void;
const savedListeners = new Set<ConfigSavedListener>();
export function onConfigSaved(listener: ConfigSavedListener): () => void {
  savedListeners.add(listener);
  return () => savedListeners.delete(listener);
}

/** POSTs a config to the dev `/__editor/save` endpoint. Returns an error string, or null on success. */
export async function saveConfig(config: AnyConfig): Promise<string | null> {
  try {
    const res = await fetch("/__editor/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: contentPathFor(config), json: config }),
    });
    if (!res.ok) return `Save failed: ${await res.text()}`;
    for (const listener of savedListeners) listener(config);
    return null;
  } catch (error) {
    return `Save failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}
