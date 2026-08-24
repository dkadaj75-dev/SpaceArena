/**
 * Validates the entire content pack against the Zod schemas and resolves all
 * cross-references. Run via tsx (see root script "validate:content").
 *
 *   npm run validate:content
 *
 * Exits 1 with readable errors (file, JSON path, message) on any failure.
 */
import type { Dirent } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  CONFIG_TYPES,
  ConfigService,
  rockTextureSet,
  shipEmissiveGap,
  type AnyConfig,
  type ConfigError,
  type CosmeticConfig,
  type ShipConfig,
  type ThemeConfig,
} from "@space-arena/shared";

const CONTENT_DIR = fileURLToPath(new URL("../content/", import.meta.url));
const MANIFEST = "manifest.json";

async function fsLoader(relPath: string): Promise<unknown> {
  const abs = path.join(CONTENT_DIR, relPath);
  const text = await readFile(abs, "utf8");
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`invalid JSON: ${(err as Error).message}`);
  }
}

function printErrors(errors: ConfigError[]): void {
  console.error(`\n✖ ${errors.length} content problem(s):\n`);
  for (const e of errors) {
    const loc = e.path ? `${e.file} → ${e.path}` : e.file;
    console.error(`  • ${loc}\n      ${e.message}`);
  }
  console.error("");
}

// ---------------------------------------------------------------------------
// Content-pack reachability sweep (refactor plan 5d step 4).
//
// tools/bundle-budget.ts gates client/dist/assets — the built JS bundle — but
// never looks at content/, the ~53 MB pack of models, textures and skyboxes
// shipped alongside it (deploy-pages.yml: `cp -r content client/dist/content`).
// Nothing has ever measured whether a binary in that pack is reachable from a
// config, so orphaned art accumulates silently.
//
// This is a WARNING, never a gate. The editor's own workflow is "park new art
// under content/ via the F10 Map/Ship tool, wire it up later" — a freshly
// dropped, not-yet-referenced GLB is normal content-authoring traffic, not a
// bug, and must never turn a content commit red. EXCEPTION_LIST below covers
// the one case that is unreferenced BY DESIGN rather than by omission.
// ---------------------------------------------------------------------------

/**
 * Binary extensions this sweep treats as model/texture assets — exactly the
 * types `render.model` / `lods[].model` / `skybox.texture` can point at.
 *
 * Audio (content/sounds/*.mp3) is deliberately NOT swept: it is reached
 * through `theme.music.tracks[].src`, which (unlike every model/texture path
 * in the schema) is authored WITH a leading "content/" — a different path
 * convention this sweep's resolver does not speak — and it sits outside the
 * render.model / lods / skybox.texture surface this step was scoped to.
 */
const SWEEP_EXTENSIONS = new Set([".glb", ".gltf", ".jpg", ".jpeg", ".png", ".webp", ".ktx2"]);

/**
 * Directory names the walk never descends into. All three are gitignored
 * scratch space (.artpass/, .tmp/, dist/) that can hold stale backup copies of
 * renamed or deleted GLBs — real files on disk that would otherwise pollute
 * the orphan list with binaries nobody ships.
 */
const EXCLUDED_DIR_NAMES = new Set([".artpass", ".tmp", "dist"]);

/** The four rock-texture map suffixes `rockMesh.ts` requests per set. */
const ROCK_TEXTURE_SUFFIXES = ["diff", "nor", "ao", "rough"] as const;

/**
 * A content-relative path that is unreferenced BY DESIGN, and why. Every
 * entry needs a reason: an exception with no reason is indistinguishable from
 * someone quietly silencing a real leak.
 */
interface Exception {
  readonly path: string;
  readonly reason: string;
}

/**
 * Seeded with the author-selectable GLB library the F10 Map/Ship editor
 * offers through `/__editor/list-models` (see the middleware in
 * `client/vite.config.ts`, which recursively walks CONTENT_DIR for every
 * `.glb`/`.gltf` and hands the whole list to the picker — it does not consult
 * any config's `render.model`). These three predate the switch to the human_
 * hull pipeline and are no longer wired into any shipped config, but deleting
 * them would silently shrink that picker out from under an author reaching for
 * a legacy hull.
 *
 * The four legacy rock GLBs that used to sit here are gone: the six sculpted
 * `asteroids/asteroid_*.glb` replaced every shipped rock and are referenced by
 * their configs, so the picker offers real content rather than an orphan.
 *
 * `content/skyboxes/Skybox01.jpg` is deliberately NOT here: list-models
 * filters on `/\.gl(b|tf)$/` only, so nothing enumerates a lone skybox
 * texture — it has no equivalent excuse and should keep warning until an
 * author either wires it into an arena or deletes it.
 */
const EXCEPTION_LIST: readonly Exception[] = [
  { path: "ships/HShip01.glb", reason: "F10 editor model library (list-models) — legacy hull, still author-selectable" },
  { path: "ships/LShip01.glb", reason: "F10 editor model library (list-models) — legacy hull, still author-selectable" },
  { path: "ships/MShip01.glb", reason: "F10 editor model library (list-models) — legacy hull, still author-selectable" },
];

/**
 * Parse a GLB's JSON chunk and return every `images[].uri` it declares.
 *
 * GLB layout (glTF 2.0 binary container): a 12-byte header (magic "glTF" =
 * 0x46546C67, version, total length), then chunks. The first chunk is always
 * JSON: its byte length lives at offset 12 and its data starts at offset 20
 * (12-byte header + 4-byte chunk length + 4-byte chunk type). An image with no
 * `uri` is embedded via a `bufferView` instead — nothing to follow, so it's
 * skipped — and a `data:` URI is inline, not a file on disk.
 */
async function glbImageUris(absPath: string): Promise<string[]> {
  let buf: Buffer;
  try {
    buf = await readFile(absPath);
  } catch {
    return [];
  }
  if (buf.length < 20 || buf.readUInt32LE(0) !== 0x46546c67) return [];
  const jsonLength = buf.readUInt32LE(12);
  const jsonBytes = buf.subarray(20, 20 + jsonLength);
  let json: unknown;
  try {
    json = JSON.parse(jsonBytes.toString("utf8"));
  } catch {
    return [];
  }
  const images = (json as { images?: unknown }).images;
  if (!Array.isArray(images)) return [];
  const uris: string[] = [];
  for (const image of images) {
    const uri = (image as { uri?: unknown } | null)?.uri;
    if (typeof uri === "string" && uri.length > 0 && !uri.startsWith("data:")) uris.push(decodeURIComponent(uri));
  }
  return uris;
}

/**
 * Field names that hold a content-relative asset path anywhere in the schema
 * pack: `render.model`, `render.lods[].model`, `arena.render.skybox.texture`,
 * `texture.source` and its companion maps, and `theme.menu.diorama`'s ground
 * and Earth maps.
 *
 * Over-inclusive on purpose. A key called `normal` that happens to hold a
 * non-path string only ever ADDS a reachable entry, and the worst case is one
 * binary going unflagged in a warning-only sweep — whereas a missing key name
 * reports real, referenced art as orphaned and invites someone to delete it.
 */
const ASSET_PATH_KEYS = new Set([
  "model",
  "texture",
  "source",
  "albedo",
  "normal",
  "ao",
  "metallicRoughness",
  "clouds",
  "night",
  "ocean",
  // The texture-skin pipeline (2026-08-22): a hull's own emissive light map
  // (`ship.skin.emissiveTexture`) and a livery's override (`cosmetic.emissive`).
  "emissiveTexture",
  "emissive",
]);

/**
 * Keys whose VALUE is a record of asset paths rather than one path. A skin's
 * `textures` block is keyed by skin element (`body`, `canopy`, …), so no fixed
 * key name could ever reach the paths inside it — and every image the owner
 * paints would be reported as an orphan, inviting someone to delete a livery.
 */
const ASSET_PATH_RECORD_KEYS = new Set(["textures"]);

/**
 * Recursively collect every string value at one of {@link ASSET_PATH_KEYS}, and
 * every string leaf of a {@link ASSET_PATH_RECORD_KEYS} record.
 * Walking the already-validated config tree, rather than grepping raw JSON,
 * means a field zod would have rejected can never smuggle in a bogus path.
 */
function collectModelTextureRefs(value: unknown, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectModelTextureRefs(item, out);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (ASSET_PATH_KEYS.has(key) && typeof child === "string" && child.length > 0) {
      out.add(child);
    } else if (ASSET_PATH_RECORD_KEYS.has(key) && child !== null && typeof child === "object") {
      for (const path of Object.values(child as Record<string, unknown>)) {
        if (typeof path === "string" && path.length > 0) out.add(path);
      }
    } else {
      collectModelTextureRefs(child, out);
    }
  }
}

/**
 * The rock-texture NAMING CONVENTION `client/src/core/rockMesh.ts` builds
 * paths from — `<set>_{diff,nor,ao,rough}_1k.jpg` under
 * `content/props/textures/game/` — for every set the schema currently allows.
 * No config ever writes these paths out (`asteroid.render.surface.textureSet`
 * carries just the bare set name, e.g. "gray_rocks"), so nothing but this
 * convention would ever mark them reachable. Derived from
 * `shared/src/schemas/asteroid.ts`'s `rockTextureSet` enum rather than
 * hardcoded, so a new set added there is picked up here without a second edit.
 */
/**
 * Cubemap faces reached through a PREFIX rather than a path.
 *
 * `theme.menu.scene.starfield.sky` carries `textures/sky/milkyway` — the six
 * real files append `_px` … `_nz` and the authored extension, so no config ever
 * spells one out and nothing else would mark them reachable. Same shape of
 * problem as the rock-texture convention below, and the same fix.
 */
const CUBE_FACES = ["_px", "_nx", "_py", "_ny", "_pz", "_nz"] as const;

function cubemapConventionRefs(service: ConfigService): string[] {
  const refs: string[] = [];
  for (const theme of service.getAll<ThemeConfig>("theme")) {
    const sky = theme.menu?.scene?.starfield;
    if (!sky?.sky) continue;
    const ext = sky.skyExtension ?? ".webp";
    for (const face of CUBE_FACES) refs.push(`${sky.sky}${face}${ext}`);
  }
  return refs;
}

function rockTextureConventionRefs(): string[] {
  const refs: string[] = [];
  for (const set of rockTextureSet.options) {
    for (const suffix of ROCK_TEXTURE_SUFFIXES) refs.push(`props/textures/game/${set}_${suffix}_1k.jpg`);
  }
  return refs;
}

/** Every file under `dir` whose extension is in {@link SWEEP_EXTENSIONS}, skipping {@link EXCLUDED_DIR_NAMES}. */
async function walkBinaries(dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
      await walkBinaries(path.join(dir, entry.name), out);
      continue;
    }
    if (SWEEP_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) out.push(path.join(dir, entry.name));
  }
}

interface SweepFile {
  readonly relPath: string;
  readonly bytes: number;
}

interface SweepResult {
  readonly orphanBytes: number;
  readonly orphanFiles: readonly SweepFile[];
  readonly exemptBytes: number;
  readonly exemptFiles: readonly (SweepFile & { reason: string })[];
}

/**
 * Compute every binary under content/ that no config, GLB, or the rock-
 * texture convention reaches, split into genuine orphans and declared
 * exceptions.
 */
async function sweepContentPack(service: ConfigService): Promise<SweepResult> {
  // 1. Roots: every model/texture string any loaded config carries, plus the
  // rock-texture naming convention (which no config spells out literally).
  const roots = new Set<string>([...rockTextureConventionRefs(), ...cubemapConventionRefs(service)]);
  for (const type of CONFIG_TYPES) {
    for (const config of service.getAll<AnyConfig>(type)) collectModelTextureRefs(config, roots);
  }

  // 2. Transitive closure: every GLB root pulls in its own `images[].uri`,
  // resolved relative to the GLB's OWN directory — a prop GLB and the
  // textures it points at are not necessarily siblings of the JSON that names
  // the GLB (props live under content/props/, their scans under
  // content/props/textures/game/).
  const reachable = new Set<string>();
  const queue: string[] = [...roots];
  while (queue.length > 0) {
    const rel = queue.pop()!;
    if (reachable.has(rel)) continue;
    reachable.add(rel);
    if (!/\.gl(b|tf)$/i.test(rel)) continue;
    const uris = await glbImageUris(path.join(CONTENT_DIR, rel));
    const glbDir = path.posix.dirname(rel.split(path.sep).join("/"));
    for (const uri of uris) {
      const resolved = glbDir === "." ? uri : path.posix.normalize(`${glbDir}/${uri}`);
      if (!reachable.has(resolved)) queue.push(resolved);
    }
  }

  // 3. Everything on disk (excluding scratch dirs), minus everything reachable.
  const absFiles: string[] = [];
  await walkBinaries(CONTENT_DIR, absFiles);

  const exceptionReasons = new Map(EXCEPTION_LIST.map((e) => [e.path, e.reason]));
  const orphanFiles: SweepFile[] = [];
  const exemptFiles: (SweepFile & { reason: string })[] = [];
  for (const abs of absFiles) {
    const relPath = path.relative(CONTENT_DIR, abs).split(path.sep).join("/");
    if (reachable.has(relPath)) continue;
    const bytes = (await stat(abs)).size;
    const reason = exceptionReasons.get(relPath);
    if (reason) exemptFiles.push({ relPath, bytes, reason });
    else orphanFiles.push({ relPath, bytes });
  }
  orphanFiles.sort((a, b) => b.bytes - a.bytes);
  exemptFiles.sort((a, b) => b.bytes - a.bytes);

  return {
    orphanBytes: orphanFiles.reduce((sum, f) => sum + f.bytes, 0),
    orphanFiles,
    exemptBytes: exemptFiles.reduce((sum, f) => sum + f.bytes, 0),
    exemptFiles,
  };
}

function humanBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MiB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${n} B`;
}

/** Prints the sweep as a WARNING section. Never calls process.exit — an orphan is content-authoring noise, not a build failure. */
function printSweep(result: SweepResult): void {
  console.log("\nContent-pack reachability sweep — WARNING only, never fails the build\n");
  if (result.orphanFiles.length === 0) {
    console.log("  ✔ no unreferenced binaries found.");
  } else {
    const plural = result.orphanFiles.length === 1 ? "" : "ies";
    const singular = result.orphanFiles.length === 1 ? "y" : "";
    console.log(`  ⚠ ${result.orphanFiles.length} unreferenced binar${singular || plural}, ${humanBytes(result.orphanBytes)} total:`);
    for (const f of result.orphanFiles) console.log(`      ${humanBytes(f.bytes).padStart(10)}  content/${f.relPath}`);
  }
  if (result.exemptFiles.length > 0) {
    console.log(
      `\n  exempted by EXCEPTION_LIST (${result.exemptFiles.length} file${result.exemptFiles.length === 1 ? "" : "s"}, ${humanBytes(result.exemptBytes)}):`,
    );
    for (const f of result.exemptFiles) console.log(`      ${humanBytes(f.bytes).padStart(10)}  content/${f.relPath}  — ${f.reason}`);
  }
  console.log("");
}

/**
 * THE EMISSIVE LIGHT MAP ROLL-CALL (owner 2026-08-22: "there should be an
 * emissive light texture for each ship").
 *
 * A warning, not a gate, for the same reason the orphan sweep is: the owner
 * paints these images himself, over time, and a hull that ships before its
 * light map is normal authoring traffic rather than a broken build. But it must
 * never be SILENT — a missing light map is invisible in-game (the hull simply
 * emits whatever the GLB authored, which is usually nothing), so this list is
 * the only place the gap shows up outside the F10 Ship tool.
 */
function printEmissiveGaps(service: ConfigService): void {
  const gaps = service
    .getAll<ShipConfig>("ship")
    .map((ship) => ({ ship, gap: shipEmissiveGap(ship.skin) }))
    .filter((entry): entry is { ship: ShipConfig; gap: "unwired" | "unpainted" } => entry.gap !== null);

  console.log("\nEmissive light textures — WARNING only, never fails the build\n");
  if (gaps.length === 0) {
    console.log("  ✔ every hull wires an emissive element and declares its light map.");
    console.log("");
    return;
  }
  console.log(`  ⚠ ${gaps.length} hull(s) without an emissive light texture:`);
  for (const { ship, gap } of gaps) {
    console.log(`      ${ship.id.padEnd(18)} ${gap === "unwired" ? "no emissive element wired" : "wired, but no ship.skin.emissiveTexture"}`);
  }
  console.log(
    "\n  Fix: paint content/ships/textures/<hull>/standard/lights.png and set\n" +
      "  ship.skin.emissiveTexture (F10 → Ships → Skins logic). See docs/SKINS.md.",
  );
  console.log("");
}

// ---------------------------------------------------------------------------
// DECLARED SKIN-TEXTURE PATHS — a HARD gate, unlike everything above it.
//
// The rule is about the WRITING DOWN, not the painting. An element no config
// mentions is fine — that is the roll-call's job, and it stays a warning
// because the owner paints these images at his own pace. But a path someone
// COMMITTED must name a real file. That split keeps "scaffold the pack, paint
// it over days" working (declare only the elements whose images exist) while
// making a dangling reference impossible to ship.
//
// It exists because exactly that shipped unnoticed: skin-interceptor-standard
// declared body, canopy and emissive under ships/textures/interceptor/standard/
// — a folder nobody ever painted — so every match wearing the Interceptor's
// standard pack logged three 404s and silently fell back to the GLB's own look.
// Nothing checked, so nothing said anything.
// ---------------------------------------------------------------------------

/** What {@link resolveExactCase} found for one declared path. */
type PathCheck =
  | { readonly kind: "ok" }
  | { readonly kind: "missing" }
  | { readonly kind: "case"; readonly onDisk: string };

/** readdir memo — the pack's texture paths share their leading directories. */
const dirEntryCache = new Map<string, Dirent[]>();

async function dirEntries(absDir: string): Promise<Dirent[]> {
  const cached = dirEntryCache.get(absDir);
  if (cached) return cached;
  let entries: Dirent[];
  try {
    entries = await readdir(absDir, { withFileTypes: true });
  } catch {
    entries = [];
  }
  dirEntryCache.set(absDir, entries);
  return entries;
}

/**
 * Resolve a content-relative path one segment at a time, comparing each
 * segment's name against the parent directory's listing EXACTLY.
 *
 * A `stat`/`access` would be simpler and wrong: development is Windows, whose
 * filesystem is case-insensitive, but the pack is served from Linux (GitHub
 * Pages), which matches a request byte for byte. `.../Body.png` against a
 * `body.png` on disk therefore passes every local check and 404s only in
 * production — the one place nobody is watching the console. Reading the
 * directory and doing the comparison ourselves is the only way to see that
 * difference from a dev machine.
 */
async function resolveExactCase(relPath: string): Promise<PathCheck> {
  const segments = relPath.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) return { kind: "missing" };

  let absDir = CONTENT_DIR;
  const onDisk: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const wanted = segments[i]!;
    const isLast = i === segments.length - 1;
    const entries = await dirEntries(absDir);
    // Exact match first, so a directory that really does hold both `Body.png`
    // and `body.png` resolves to the one that was written down.
    const match =
      entries.find((entry) => entry.name === wanted) ??
      entries.find((entry) => entry.name.toLowerCase() === wanted.toLowerCase());
    if (!match || (isLast ? !match.isFile() : !match.isDirectory())) return { kind: "missing" };
    onDisk.push(match.name);
    absDir = path.join(absDir, match.name);
  }

  const actual = onDisk.join("/");
  return actual === segments.join("/") ? { kind: "ok" } : { kind: "case", onDisk: actual };
}

/** One content-relative image path a config writes down, and where it wrote it. */
interface DeclaredTexturePath {
  /** The config that declares it. */
  readonly configId: string;
  /** JSON path within that config, e.g. `textures.body`. */
  readonly jsonPath: string;
  readonly relPath: string;
}

/**
 * Every skin-texture path the pack declares: a cosmetic's `textures` record
 * (element → albedo) and its `emissive` light-map override, plus a hull's own
 * `ship.skin.emissiveTexture`. All three are `contentImagePath` — relative to
 * content/, never prefixed — so one resolver serves all of them.
 */
function declaredSkinTexturePaths(service: ConfigService): DeclaredTexturePath[] {
  const declared: DeclaredTexturePath[] = [];
  for (const cosmetic of service.getAll<CosmeticConfig>("cosmetic")) {
    for (const [element, relPath] of Object.entries(cosmetic.textures ?? {})) {
      if (typeof relPath === "string" && relPath.length > 0) {
        declared.push({ configId: cosmetic.id, jsonPath: `textures.${element}`, relPath });
      }
    }
    if (cosmetic.emissive) declared.push({ configId: cosmetic.id, jsonPath: "emissive", relPath: cosmetic.emissive });
  }
  for (const ship of service.getAll<ShipConfig>("ship")) {
    const emissive = ship.skin?.emissiveTexture;
    if (emissive) declared.push({ configId: ship.id, jsonPath: "skin.emissiveTexture", relPath: emissive });
  }
  return declared;
}

/**
 * The declared paths that do not resolve, shaped for {@link printErrors}.
 *
 * `file` carries the config ID rather than the manifest-relative filename:
 * ConfigService indexes configs by id and never exposes which file each one
 * came from. The id is the honest answer, and it is one grep from the file.
 */
async function skinTextureErrors(service: ConfigService): Promise<ConfigError[]> {
  const errors: ConfigError[] = [];
  for (const { configId, jsonPath, relPath } of declaredSkinTexturePaths(service)) {
    const check = await resolveExactCase(relPath);
    if (check.kind === "ok") continue;
    errors.push({
      file: configId,
      path: jsonPath,
      message:
        check.kind === "case"
          ? `case mismatch: declares "${relPath}", but the file on disk is "${check.onDisk}". ` +
            `Windows resolves both; the deployed pack is served from Linux and resolves only the second.`
          : `missing file: content/${relPath} does not exist. Paint the image, or drop this entry ` +
            `until it does — an element no config declares simply keeps the look the GLB shipped with.`,
    });
  }
  return errors;
}

async function main(): Promise<void> {
  const service = new ConfigService(fsLoader);
  const result = await service.load(MANIFEST);

  if (!result.ok) {
    printErrors(result.errors);
    console.error("validate:content FAILED");
    process.exit(1);
  }

  // Exactly one tuning config. `ConfigService.tuning()` returns "the" tuning
  // config, and 32 call sites across the sim, the netcode and the HUD rely on
  // that being unambiguous — but nothing enforced it, so a pack shipping two
  // would have silently handed every one of them whichever happened to load
  // first. This is a hard failure rather than a warning: unlike an orphaned
  // binary, it changes how the game plays.
  const tuningCount = service.getAll("tuning").length;
  if (tuningCount !== 1) {
    console.error(
      `\n✖ content problem:\n      the pack declares ${tuningCount} tuning configs; exactly 1 is required ` +
        `(ConfigService.tuning() resolves the single one, and the sim, netcode and HUD all read it).\n`,
    );
    console.error("validate:content FAILED");
    process.exit(1);
  }

  // Every skin-texture path a config WRITES DOWN has to name a real file, with
  // exact case. Hard, for the same reason the tuning count is: a dangling path
  // is not authoring traffic, it is a 404 in every match that equips the skin.
  const textureErrors = await skinTextureErrors(service);
  if (textureErrors.length > 0) {
    printErrors(textureErrors);
    console.error("validate:content FAILED");
    process.exit(1);
  }

  printEmissiveGaps(service);

  const total = Object.values(result.counts).reduce((a, b) => a + (b ?? 0), 0);
  const breakdown = Object.entries(result.counts)
    .map(([type, n]) => `${type}=${n}`)
    .join(", ");
  console.log(`✔ validate:content OK — ${total} configs loaded (${breakdown})`);

  printSweep(await sweepContentPack(service));
}

main().catch((err) => {
  console.error("validate:content crashed:", err);
  process.exit(1);
});
