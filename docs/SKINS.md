# Skins

*Owner direction, 2026-08-22:*

> Each skin will have 1 or several textures, depending on the model, and I will
> modify myself the textures. Skins are basically a swap between a ship texture,
> or a texture pack (when several textures are present). The only specificity:
> there should be an emissive light texture for each ship. Otherwise each ship
> has their UV texture mapped and I will make variations of these.

A skin is an **authored texture swap**. The images are painted outside the game,
against each hull's own UV layout. The code does the plumbing and nothing else:
it decides which materials each image lands on, loads it once per (hull, skin),
and falls back to the shipped model when a file is not there yet.

---

## The convention

```
content/ships/textures/<hull>/<skin>/<element>.<ext>
```

| Segment     | Is                                                               | Example        |
| ----------- | ---------------------------------------------------------------- | -------------- |
| `<hull>`    | the ship id's last segment                                        | `talon`        |
| `<skin>`    | the livery's own folder — `standard` is the hull as shipped       | `standard`     |
| `<element>` | the skin element the image covers: `body`, `canopy`, `wings`, `emissive` | `body`  |
| `lights`    | the one special name: the **emissive light map**, not an albedo   | `lights.png`   |

`.png`, `.jpg`, `.webp` and `.ktx2` are all accepted. The path in the JSON is
authoritative — the folder layout is a convention for humans, so a file that
lives somewhere else still works as long as the path points at it.

A hull's `standard` folder is filled by unpacking the GLB's own embedded
textures:

```bash
npm run content:ship-textures            # every hull
npm run content:ship-textures -- talon   # one hull
```

That is a read-only tool over configs: it writes images and prints a report,
never edits a JSON. Re-run it any time a hull is re-exported or a new material
gets wired.

---

## Making a variation

1. Copy `content/ships/textures/<hull>/standard/` to
   `content/ships/textures/<hull>/<your-skin>/`.
2. Repaint the images. Same size, same UVs — that is the whole point of starting
   from the standard pack.
3. Copy `content/cosmetics/skin-<hull>-standard.json` to
   `content/cosmetics/skin-<hull>-<your-skin>.json`, change `id` and `name`, and
   point each path at the new folder.
4. Add the new file to `content/manifest.json`.
5. `npm run validate:content`.

Or, entirely in the game: **F10 → Ships → Skins → New skin**, then type a path
per element. The preview beside the panel is the real renderer, so what it shows
is what a pilot flies — including a path that does not resolve.

A skin that only changes one image only needs one entry. Everything else keeps
what the model shipped with.

---

## The shape of a skin

```jsonc
{
  "id": "cosmetic.skin-brawler-standard",
  "type": "cosmetic",
  "kind": "skin",
  "target": "ship.brawler",
  "price": 0,
  "textures": {
    "body":     "ships/textures/brawler/standard/body.jpg",
    "canopy":   "ships/textures/brawler/standard/canopy.jpg",
    "wings":    "ships/textures/brawler/standard/wings.jpg",
    "emissive": "ships/textures/brawler/standard/emissive.jpg"
  },
  // Optional: relight the ship with this livery's own map instead of the hull's.
  "emissive": "ships/textures/brawler/neon/lights.png"
}
```

`textures` is keyed by **element**, never by GLB material name. The hull already
declares which of its materials each element covers (`ship.skin`, edited in
F10 → Ships → Skins logic), so:

* one entry = the whole-hull UV swap, on a hull with a single UV-mapped material
  (the Talon);
* four entries = a pack, on a hull whose plates are separately unwrapped (the
  Brawler);
* an element the hull wires to **nothing** refuses the image — that gate is how
  a designer keeps a livery off the canopy glass or the engine bloom;
* a material that needs its own separately-unwrapped image needs its own
  element. Wire it in the Ship tool; that is what the element vocabulary is for.

---

## The emissive rule

Every ship is meant to have an emissive light texture. Two things have to be
true for it to land:

1. the hull wires the `emissive` element to the materials that are the lit
   plates (strips, windows, exhaust interiors), and
2. a light map exists — `ship.skin.emissiveTexture` on the hull, or a livery's
   own `cosmetic.emissive` overriding it.

The light map belongs to the **hull** first: the lit geometry is the model's, so
every livery inherits the same map unless it deliberately relights the ship.

Neither half is enforced by the schema — the owner paints these images over
time, and failing the pack load would mean no hull could be added before its
light map existed. The gap is instead made **loud** in two places:

* `npm run validate:content` prints an "Emissive light textures" roll-call of
  every hull that is missing one;
* F10 → Ships → Skins logic shows a warning row on the hull itself, and
  F10 → Skins shows one on the emissive element.

Only the ABSENCE is a warning, though. A light map that is *declared* and does
not resolve fails `npm run validate:content` outright, like any other committed
texture path — see [Missing files](#missing-files).

**As of 2026-08-22 no shipped GLB carries an emissive map.** All four hulls need
one painted:

| Hull          | Emissive element wired to | Light map |
| ------------- | ------------------------- | --------- |
| `interceptor` | `HUM_LGT_Emissive_Blue`   | missing   |
| `brawler`     | `ENGINE_GLOW`             | missing   |
| `support`     | — (nothing wired yet)     | missing   |
| `talon`       | — (single material hull)  | missing   |

---

## Missing files

**At runtime, a path that fails to load is survivable, and always will be.** The
material keeps exactly what the GLB shipped with, one line is logged per missing
path (per session, not per ship), and nothing else changes. A hull is never
black and never invisible — the image is applied only once it has loaded,
precisely so a failed request cannot blank a ship for its duration. F10 live
editing depends on that: a designer types a path before the file exists, and the
preview has to keep showing a ship while he does.

**A path that is committed is a different thing, and it is now checked.**
`npm run validate:content` fails on any *declared* skin-texture path that does
not resolve to a file — a cosmetic's `textures.*`, a cosmetic's `emissive`, a
hull's `ship.skin.emissiveTexture` — and it compares with **exact case**:
development is Windows, whose filesystem does not care, while the deployed pack
is served from Linux, which does. `Body.png` over a `body.png` on disk works on
every dev machine and 404s only in production.

The rule is about the writing down, not the painting. Scaffold a pack by
declaring **only the elements whose images exist**, and add the path and the
image in the same commit. [Making a variation](#making-a-variation) already
works that way — step 1 copies the whole standard folder before anything is
repainted, so every path step 3 writes already has a file behind it.

The Interceptor is why the check exists. Its GLB carries no albedo maps at all
(its look is per-material base-colour factors), so
`content/cosmetics/skin-interceptor-standard.json` declares **no textures yet** —
an empty pack renders the hull exactly as it shipped and requests nothing. It
used to declare `body`, `canopy` and `emissive` into a folder nobody had ever
painted, which is how three 404s per match shipped unnoticed. Elements get
declared as the owner paints them: `body`, `canopy`, and the emissive light map
per the table above.

---

## What the renderer does

`client/src/game/shipPaint.ts` (`ShipPaintBank`) clones a **painted master** per
(hull, skin) and instances every ship off it, so ten ships in one livery cost one
extra draw batch, not ten — and one image load, not ten. Materials the hull
wires to no element keep the *original* material object, not a copy of it.

Two details worth knowing, both in `client/src/game/skinTexture.ts`:

* **invertY is false.** glTF's UV origin is top-left and Babylon's glTF loader
  builds its textures the same way; a default `Texture` would land a repaint
  upside down against the very UVs it was painted on.
* **The base-colour factor is neutralised** when an albedo is applied. The
  shipped hulls tint plates by factor; left in place it would multiply into the
  authored image.

---

## Legacy: `kind: "paint"`

The 32 shipped `paint-*.json` cosmetics are the **previous** pipeline: procedural
recipes of colour, pattern (`zebra` / `tiger` / `rust`) and surface finish, drawn
into a canvas at runtime because a recipe has no file to load. They are wired
into the shop, the ownership tables and every bot's dressing, and they keep
working exactly as authored — including their editor, which F10 → Skins still
shows for any `kind: "paint"` cosmetic.

They are being replaced one at a time, as the owner paints packs to stand in for
them. Nothing new should be authored as a paint: **New skin** in the editor makes
a texture skin, and the legacy path is reachable only by duplicating an existing
paint.

The two kinds do not mix — the schema rejects a paint that carries textures and a
skin that carries colours. The one thing they share is `elements.propulsion`,
which swaps a particle effect rather than a surface and belongs to both.

`cosmetic.paint-<hull>-standard` also stays where it is: it is the id written
into every stored selection and ownership row, so it means "the ship exactly as
authored" regardless of which pipeline a hull's other liveries use.
