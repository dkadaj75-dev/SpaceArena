/**
 * Extract each hull's own UV-mapped textures out of its GLB, into the skin
 * texture convention. Run via tsx (root script "content:ship-textures"):
 *
 *   npm run content:ship-textures            # every hull
 *   npm run content:ship-textures -- talon   # one hull, by id or slug
 *
 * WHY THIS EXISTS (owner 2026-08-22). A skin is now a swap of AUTHORED images:
 * "each ship has their UV texture mapped and I will make variations of these."
 * Making a variation means starting from the exact image the model was exported
 * with — but those images are embedded inside the .glb, where no paint program
 * can reach them. This unpacks them, byte-for-byte, into the standard skin's
 * folder, so the first variation is "duplicate that folder and repaint".
 *
 * It is a READ-ONLY tool over configs: it writes image files and prints a
 * report, and never edits a ship or cosmetic JSON. Re-runnable at any time —
 * re-exported a hull, wired a new material — and it overwrites what it wrote
 * before, so the standard folder always mirrors the GLB.
 *
 * CONVENTION (the one this repo has; see docs/SKINS.md):
 *
 *   content/ships/textures/<hull>/<skin>/<element>.<ext>   albedo, per element
 *   content/ships/textures/<hull>/<skin>/lights.<ext>      emissive light map
 *
 * Elements, not material names, because that is what a skin's `textures` block
 * is keyed by — the hull's own wiring (`ship.skin`) says which materials each
 * element covers, and the extractor follows the same wiring the renderer will.
 * A material the hull wires to NOTHING is skipped and listed in the report: it
 * is not reachable by any skin until someone wires it in F10 → Ships.
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NodeIO, type Material, type Texture } from "@gltf-transform/core";
import { SURFACE_ELEMENTS, type ShipConfig, type SurfaceElement } from "@space-arena/shared";

const CONTENT_DIR = fileURLToPath(new URL("../content/", import.meta.url));
const SHIPS_DIR = path.join(CONTENT_DIR, "ships");

/** The skin folder a freshly extracted pack lands in — the hull as shipped. */
const STANDARD_SKIN = "standard";

/** glTF embeds images by mime type; the file on disk needs the matching extension. */
const EXTENSION: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

interface Extracted {
  readonly element: SurfaceElement | "lights";
  readonly file: string;
  readonly bytes: number;
  readonly size: string;
}

interface HullReport {
  readonly ship: string;
  readonly model: string;
  readonly materials: string[];
  readonly written: Extracted[];
  /** Materials the hull wires to no element — unreachable by any skin. */
  readonly unwired: string[];
  /** Wired elements whose material carries no base-colour map in the GLB. */
  readonly noAlbedo: SurfaceElement[];
  /** True when NO material on this hull has an emissive map: the owner must paint one. */
  readonly noEmissive: boolean;
  readonly notes: string[];
}

async function loadShips(): Promise<ShipConfig[]> {
  const ships: ShipConfig[] = [];
  for (const entry of await readdir(SHIPS_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const parsed = JSON.parse(await readFile(path.join(SHIPS_DIR, entry.name), "utf8")) as ShipConfig;
    if (parsed.type === "ship") ships.push(parsed);
  }
  return ships.sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** `ship.interceptor` → `interceptor`: the hull segment of every convention path. */
function hullSlug(shipId: string): string {
  return shipId.split(".").pop() ?? shipId;
}

/** The GLB material objects this hull wires to `element`, case-insensitively. */
function materialsFor(materials: Material[], names: readonly string[]): Material[] {
  const wanted = new Set(names.map((n) => n.trim().toLowerCase()));
  return materials.filter((m) => wanted.has(m.getName().trim().toLowerCase()));
}

function describe(texture: Texture): string {
  const [w, h] = texture.getSize() ?? [0, 0];
  return `${w}×${h}`;
}

async function extractHull(ship: ShipConfig): Promise<HullReport | null> {
  const model = ship.render.model;
  if (!model) return null;
  const slug = hullSlug(ship.id);
  const document = await new NodeIO().read(path.join(CONTENT_DIR, model));
  const materials = document.getRoot().listMaterials();
  const outDir = path.join(CONTENT_DIR, "ships", "textures", slug, STANDARD_SKIN);

  const report: HullReport = {
    ship: ship.id,
    model,
    materials: materials.map((m) => m.getName()),
    written: [],
    unwired: [],
    noAlbedo: [],
    noEmissive: !materials.some((m) => m.getEmissiveTexture()),
    notes: [],
  };

  const wiredNames = new Set<string>();
  for (const element of SURFACE_ELEMENTS) {
    for (const name of ship.skin?.[element] ?? []) wiredNames.add(name.trim().toLowerCase());
  }
  for (const material of materials) {
    if (!wiredNames.has(material.getName().trim().toLowerCase())) report.unwired.push(material.getName());
  }

  // One file per (element, channel). `seen` keys by the glTF Texture object, so
  // two materials sharing one image (the Support hull ships a single 2K set for
  // both its slots) write the same bytes once and the second entry points at
  // the file the first produced.
  const seen = new Map<Texture, string>();
  const write = async (texture: Texture, element: Extracted["element"]): Promise<void> => {
    const image = texture.getImage();
    const extension = EXTENSION[texture.getMimeType()];
    if (!image || !extension) {
      report.notes.push(`${element}: texture "${texture.getName()}" has no readable image (mime ${texture.getMimeType()})`);
      return;
    }
    const already = seen.get(texture);
    if (already) {
      report.notes.push(`${element}: shares "${already}" with another element — one image, two slots, written once`);
      return;
    }
    const file = `${element}.${extension}`;
    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, file), image);
    seen.set(texture, file);
    report.written.push({ element, file, bytes: image.byteLength, size: describe(texture) });
  };

  for (const element of SURFACE_ELEMENTS) {
    const wired = materialsFor(materials, ship.skin?.[element] ?? []);
    if (wired.length === 0) continue;
    const withAlbedo = wired.filter((m) => m.getBaseColorTexture());
    if (withAlbedo.length === 0) {
      report.noAlbedo.push(element);
    } else {
      if (withAlbedo.length > 1) {
        // The pack is one image per ELEMENT, so several separately-unwrapped
        // materials under one element cannot all be swapped. Extract the first
        // and say so — the fix is a wiring change, not a schema change.
        report.notes.push(
          `${element}: wires ${withAlbedo.length} textured materials (${withAlbedo.map((m) => m.getName()).join(", ")}); ` +
            `a skin carries ONE image per element, so only "${withAlbedo[0]!.getName()}" was extracted`,
        );
      }
      await write(withAlbedo[0]!.getBaseColorTexture()!, element);
    }
    // The emissive LIGHT map comes off whichever wired material carries one.
    if (element === "emissive") {
      const lit = wired.find((m) => m.getEmissiveTexture());
      if (lit) await write(lit.getEmissiveTexture()!, "lights");
    }
  }
  return report;
}

function humanBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MiB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${n} B`;
}

function print(report: HullReport): void {
  const slug = hullSlug(report.ship);
  console.log(`\n${report.ship}  (${report.model})`);
  console.log(`  materials: ${report.materials.join(", ") || "none"}`);
  if (report.written.length === 0) {
    console.log("  ⚠ nothing extracted — this GLB carries no image for any wired element (its look is material factors only).");
  }
  for (const file of report.written) {
    console.log(
      `  ✔ ships/textures/${slug}/${STANDARD_SKIN}/${file.file}`.padEnd(58) +
        `${file.size.padStart(10)}  ${humanBytes(file.bytes)}`,
    );
  }
  for (const element of report.noAlbedo) {
    console.log(`  · ${element}: wired, but the material has no base-colour map — paint ${element}.png from scratch.`);
  }
  if (report.unwired.length > 0) {
    console.log(`  · not wired to any element (no skin can reach these): ${report.unwired.join(", ")}`);
  }
  if (report.noEmissive) {
    console.log(`  ⚠ NO EMISSIVE MAP anywhere in this GLB. Every ship is meant to have one — paint`);
    console.log(`     content/ships/textures/${slug}/${STANDARD_SKIN}/lights.png and point ship.skin.emissiveTexture at it.`);
  }
  for (const note of report.notes) console.log(`  · ${note}`);
}

async function main(): Promise<void> {
  const filter = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const ships = (await loadShips()).filter(
    (ship) => filter.length === 0 || filter.some((f) => ship.id === f || hullSlug(ship.id) === f),
  );
  if (ships.length === 0) {
    console.error(`no ship matched ${filter.join(", ")}`);
    process.exit(1);
  }
  console.log(`Extracting embedded hull textures into content/ships/textures/<hull>/${STANDARD_SKIN}/ …`);
  const reports: HullReport[] = [];
  for (const ship of ships) {
    const report = await extractHull(ship);
    if (!report) {
      console.log(`\n${ship.id}  — no render.model (procedural recipe); nothing to extract.`);
      continue;
    }
    reports.push(report);
    print(report);
  }
  const missing = reports.filter((r) => r.noEmissive).map((r) => r.ship);
  console.log(
    missing.length === 0
      ? "\nEvery hull ships an emissive map.\n"
      : `\n⚠ hulls with NO emissive light texture (the owner has to paint one for each): ${missing.join(", ")}\n`,
  );
}

main().catch((error) => {
  console.error("content:ship-textures crashed:", error);
  process.exit(1);
});
