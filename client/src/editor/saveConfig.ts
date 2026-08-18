import { contentPathFor, type AnyConfig } from "@space-arena/shared";

export { contentPathFor };

/** POSTs a config to the dev `/__editor/save` endpoint. Returns an error string, or null on success. */
export async function saveConfig(config: AnyConfig): Promise<string | null> {
  try {
    const res = await fetch("/__editor/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: contentPathFor(config), json: config }),
    });
    if (!res.ok) return `Save failed: ${await res.text()}`;
    return null;
  } catch (error) {
    return `Save failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}
