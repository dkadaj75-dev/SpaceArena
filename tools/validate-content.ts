/**
 * Validates the entire content pack against the Zod schemas and resolves all
 * cross-references. Run via tsx (see root script "validate:content").
 *
 *   npm run validate:content
 *
 * Exits 1 with readable errors (file, JSON path, message) on any failure.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { CONFIG_TYPES, ConfigService, rockTextureSet, type AnyConfig, type ConfigError } from "@space-arena/shared";

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
 * Recursively collect every string value at a key literally named `model` or
 * `texture` — the two field names every model/texture reference in the
 * schema pack uses (`render.model`, `render.lods[].model`,
 * `arena.render.skybox.texture`, and any future recipe that reuses either
 * name). Walking the already-validated config tree, rather than grepping raw
 * JSON, means a field zod would have rejected can never smuggle in a bogus
 * path.
 */
function collectModelTextureRefs(value: unknown, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectModelTextureRefs(item, out);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if ((key === "model" || key === "texture") && typeof child === "string" && child.length > 0) {
      out.add(child);
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
  const roots = new Set<string>(rockTextureConventionRefs());
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
