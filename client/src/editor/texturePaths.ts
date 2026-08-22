/**
 * The shared datalist of image files under content/, for every editor field
 * that takes a texture PATH (the hull's emissive light map, a skin's per-element
 * albedo).
 *
 * A `<datalist>` rather than a dropdown because the field is authoritative: the
 * owner scaffolds a pack and paints the files afterwards, so a path that does
 * not exist yet has to be typeable. The list is a convenience for the ones that
 * do exist, and the runtime's missing-file fallback covers the rest.
 *
 * One element for the whole document, id-stable, filled once: the Ship tool and
 * the Skins tool both point at it and neither owns it. Dev-server only —
 * `/__editor/list-textures` exists in `client/vite.config.ts` and nowhere in a
 * production build, so the fetch failing leaves a plain free-text box, which is
 * exactly what a built game should have.
 */

export const TEXTURE_DATALIST_ID = "sa-texture-paths";

let requested = false;

/** Ensure the datalist exists and is (being) populated. Safe to call per render. */
export function attachTextureDatalist(): HTMLDataListElement {
  let list = document.getElementById(TEXTURE_DATALIST_ID) as HTMLDataListElement | null;
  if (!list) {
    list = document.createElement("datalist");
    list.id = TEXTURE_DATALIST_ID;
    document.body.append(list);
  }
  if (requested) return list;
  requested = true;
  const target = list;
  void fetch("/__editor/list-textures")
    .then((r) => r.json() as Promise<{ textures: string[] }>)
    .then(({ textures }) => target.replaceChildren(...textures.map((path) => new Option(path))))
    .catch(() => undefined);
  return list;
}
