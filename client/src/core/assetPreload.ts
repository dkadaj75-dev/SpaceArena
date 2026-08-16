import type {
  ArenaConfig,
  AsteroidConfig,
  ConfigService,
  ModuleConfig,
  PropConfig,
  RenderRecipe,
  ShipConfig,
} from "@space-arena/shared";
import type { AssetRegistry } from "./AssetRegistry.js";

/**
 * Which GLB models an arena needs (§11 6.3 preloading).
 *
 * Boot performs no model work. Hulls are loaded at match launch and hangar
 * previews are split into blocking owned assets plus a throttled background
 * queue. Arena models are resolved per match by {@link preloadArenaModels}.
 *
 * Nothing here knows an asteroid id or a file name: it walks the arena's
 * placements, resolves each asteroid config, and takes whatever `render.model`
 * that config (or one of its visual states) declares. Deduplicated on the same
 * (path, scale, yaw) identity the registry caches masters by, so an arena that
 * places the same rock 30 times still asks for one load.
 */
export type ArenaModelRender = RenderRecipe & { mergeParts?: boolean };

export function arenaModelRenders(configs: ConfigService, arenaId: string): ArenaModelRender[] {
  const arena = configs.get<ArenaConfig>("arena", arenaId);
  if (!arena) return [];
  const seen = new Set<string>();
  const out: ArenaModelRender[] = [];
  const add = (render: RenderRecipe | undefined, mergeParts = true): void => {
    if (!render?.model) return;
    const key = `${render.model}::s${render.modelScale ?? 1}::r${render.modelRotationY ?? 0}::${mergeParts ? "merged" : "parts"}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(mergeParts ? render : { ...render, mergeParts: false });
  };
  for (const placement of arena.asteroidPlacements) {
    const asteroid = configs.get<AsteroidConfig>("asteroid", placement.asteroidId);
    if (!asteroid) continue;
    add(asteroid.render);
    for (const state of asteroid.states ?? []) add(state.render);
  }
  for (const placement of arena.propPlacements ?? []) {
    const prop = configs.get<PropConfig>("prop", placement.propId);
    if (!prop) continue;
    add(prop.render, false);
    for (const lod of prop.render.lods ?? []) add({ ...prop.render, model: lod.model }, false);
  }
  return out;
}

/**
 * How many preload jobs may be in flight at once.
 *
 * The busiest shipped arena asks for fifty separate binaries totalling ~20 MB,
 * and starting all fifty together buys nothing: a browser caps same-origin
 * HTTP/1.1 at ~6 sockets, and every decode/merge past that point still has to
 * queue for the one main thread — while EVERY decoded buffer stays live at once,
 * which is the part a phone actually feels. A small pool keeps the pipe full and
 * the peak flat. Deliberately below `PACK_LOAD_CONCURRENCY` (12): a config file
 * is a few kilobytes of JSON, a hull is megabytes of geometry.
 */
const PRELOAD_CONCURRENCY = 6;

/**
 * Run every job with at most {@link PRELOAD_CONCURRENCY} in flight, taken in
 * list order — so the order a caller builds its job list in is the order the
 * work actually starts in.
 *
 * `onSettled` fires once per job whether it resolved or threw, because callers
 * count progress off it and a stalled counter is worse than a failed load. The
 * first error is re-thrown once the pool has drained rather than immediately, so
 * one bad model cannot abandon the rest of the arena half-loaded.
 */
async function runPreloadPool(
  jobs: readonly (() => Promise<unknown>)[],
  onSettled?: (index: number) => void,
): Promise<void> {
  let next = 0;
  let failure: unknown;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      const job = jobs[index];
      if (!job) return;
      try {
        await job();
      } catch (error) {
        failure ??= error;
      }
      onSettled?.(index);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(PRELOAD_CONCURRENCY, jobs.length)) }, worker));
  if (failure !== undefined) throw failure;
}

/**
 * Load (once) every model the arena needs. Match startup awaits this promise
 * before constructing the synchronous asteroid views, so a valid authored GLB
 * cannot lose a race with the first snapshot. `ensureModel` resolves `null` on
 * an actual load/decode failure, preserving the procedural fallback for that
 * failure case without making it the normal first-match path.
 */
export function preloadArenaModels(
  assets: AssetRegistry,
  configs: ConfigService,
  arenaId: string,
): Promise<void> {
  // Through the same pool as the match preload: `setArena` fires this alongside
  // {@link preloadMatchModels} for the very same arena, and two unbounded fans
  // at the same models would put the cap back where it started.
  return runPreloadPool(
    arenaModelRenders(configs, arenaId).map(
      (render) => () => assets.ensureModel(render, { mergeParts: render.mergeParts !== false }),
    ),
  );
}

/**
 * The rock scan sets an arena's asteroids shade with.
 *
 * No shipped asteroid declares `render.model`, so {@link arenaModelRenders}
 * returns nothing at all for an asteroid arena and the match preload used to
 * have no arena half: the launch bar reached 100% on the ship hulls while the
 * several megabytes of rock scans had not been asked for yet. These are the
 * arena's real download.
 */
export function arenaRockSurfaces(configs: ConfigService, arenaId: string): string[] {
  const arena = configs.get<ArenaConfig>("arena", arenaId);
  if (!arena) return [];
  const sets = new Set<string>();
  for (const placement of arena.asteroidPlacements) {
    const asteroid = configs.get<AsteroidConfig>("asteroid", placement.asteroidId);
    // Only the config's own surface matters: a visual state carries a plain
    // render recipe and is shaded by the material the base config built.
    const set = asteroid?.render.surface?.textureSet;
    if (set) sets.add(set);
  }
  return [...sets];
}

/** Ship configs that actually author a hull GLB. */
function shipConfigsWithModels(configs: ConfigService): ShipConfig[] {
  return configs.getAll<ShipConfig>("ship").filter((ship) => typeof ship.render.model === "string");
}

/**
 * One hull's GLBs: the base first, then each authored LOD, keyed exactly the way
 * the registry caches its masters.
 */
function hullRenders(ship: ShipConfig): RenderRecipe[] {
  const render = ship.render;
  return [render, ...(render.lods ?? []).map((lod) => ({ ...render, model: lod.model, lods: undefined }))];
}

/** Every authored ship base and LOD GLB, independent of the active quality tier. */
export function shipModelRenders(configs: ConfigService): RenderRecipe[] {
  return shipConfigsWithModels(configs).flatMap(hullRenders);
}

/**
 * Load ONE hull completely: base GLB, every authored LOD GLB, and the ladder
 * wiring that joins them.
 *
 * A hull is the unit of work rather than a GLB because a half-loaded hull is
 * useless: {@link AssetRegistry.getShipMaster} resolves a master synchronously
 * and the view keeps whatever it got for its lifetime, so a ladder wired after
 * the view exists has nothing left to attach to.
 *
 * `lodBias` scales the authored LOD distances (quality.scene.ships.lodBias).
 * Optional and last so existing positional callers — including
 * `assetPreload.test.ts` — are unaffected; omitted behaves exactly as before.
 * Safe to call again for an already-loaded hull: `ensureModel` resolves cached
 * masters/in-flight loads without a re-fetch, and `applyModelLods` clears and
 * re-attaches the LOD levels, so a later call with a different bias is a
 * cheap clone-and-reattach, not a re-download.
 */
async function preloadShipHull(assets: AssetRegistry, ship: ShipConfig, lodBias = 1): Promise<void> {
  const lods = ship.render.lods ?? [];
  // The base is first in `hullRenders`, so one parallel pass both fetches the
  // whole ladder and hands back the master `applyModelLods` attaches it to.
  const [master] = await Promise.all(hullRenders(ship).map((render) => assets.ensureModel(render)));
  if (master) await assets.applyModelLods(master, lods, lodBias);
}

/** Every authored hardpoint/module model that can be mounted on a match ship. */
export function moduleModelRenders(configs: ConfigService): RenderRecipe[] {
  return configs
    .getAll<ModuleConfig>("module")
    .map((module) => module.render)
    .filter((render): render is RenderRecipe => typeof render?.model === "string");
}

/**
 * Ship views choose their master synchronously and keep it for their lifetime,
 * so match launch awaits these loads before creating views.
 *
 * `lodBias` is optional and last (see {@link preloadShipHull}) so this stays
 * callable exactly as before; pass `quality.scene.ships?.lodBias` to apply
 * the active tier's ship-LOD distance bias, including on a later call for
 * hulls that are already loaded (re-applying is cheap — see above).
 */
export async function preloadShipModels(assets: AssetRegistry, configs: ConfigService, lodBias?: number): Promise<void> {
  await Promise.all(shipConfigsWithModels(configs).map((ship) => preloadShipHull(assets, ship, lodBias)));
}

/** Reports completed model loads out of the total this match needs. */
export type PreloadProgress = (loaded: number, total: number) => void;

/** One unit of preload work, tagged so {@link MatchPreload.ready} can select it. */
interface PreloadJob {
  /** Ship-config id when this job loads a hull, otherwise null. */
  readonly shipId: string | null;
  readonly run: () => Promise<unknown>;
}

/** A match preload already running, and the two ways to wait on it. */
export interface MatchPreload {
  /** Everything this match COULD render, hulls nobody seated included. */
  readonly all: Promise<void>;
  /**
   * Everything a match on this roster renders: the arena, its rock scans, the
   * modules, and only the hulls named by `shipConfigIds`. The hulls left out
   * keep loading behind the running match.
   *
   * Pass nothing when the roster is not final — the tutorial scripts its
   * opponents in minutes after launch, and a hull that arrives after the view
   * that wanted it is a permanent procedural stand-in — and this degenerates to
   * {@link MatchPreload.all}. An empty set does the same, so a session that
   * cannot resolve its own ship ids fails safe rather than silently launching
   * with no hulls at all.
   */
  ready(shipConfigIds?: Iterable<string>): Promise<void>;
}

/**
 * Everything a match can render. Started at launch and awaited behind the match
 * launch screen — and, since the online flow searches for players FIRST, usually
 * started long before that screen is done with it, which is what `onProgress` is
 * for: the card shows whatever is left only if the pilots are found before the
 * models are in.
 *
 * Progress is counted in individual jobs rather than in the coarse groups, so
 * the bar tracks the work instead of jumping to 90% on the first resolve.
 *
 * Hulls are scheduled FIRST because they are the only group whose members can be
 * skipped: on every arena but one they are also the entire download, so ordering
 * them ahead of the arena is what makes {@link MatchPreload.ready} able to return
 * early at all rather than finding the seated hulls stuck behind forty props.
 */
export function preloadMatchModels(
  assets: AssetRegistry,
  configs: ConfigService,
  arenaId: string,
  onProgress?: PreloadProgress,
  /**
   * Quality tier's ship LOD distance bias (`quality.scene.ships?.lodBias`).
   * Optional and last, after `onProgress`, so existing positional callers —
   * including `assetPreload.test.ts` — are unaffected.
   */
  lodBias?: number,
): MatchPreload {
  const jobs: PreloadJob[] = [
    ...shipConfigsWithModels(configs).map((ship) => ({
      shipId: ship.id,
      run: () => preloadShipHull(assets, ship, lodBias),
    })),
    ...arenaModelRenders(configs, arenaId).map((render) => ({
      shipId: null,
      run: () => assets.ensureModel(render, { mergeParts: render.mergeParts !== false }),
    })),
    ...arenaRockSurfaces(configs, arenaId).map((textureSet) => ({
      shipId: null,
      run: () => assets.ensureRockSurfaces([textureSet]),
    })),
    ...moduleModelRenders(configs).map((render) => ({
      shipId: null,
      run: () => assets.ensureModel(render),
    })),
  ];

  let loaded = 0;
  onProgress?.(0, jobs.length);

  // One settle handle per job, so `ready` can wait on a SUBSET without needing
  // to know how the pool happened to schedule it.
  const settle: (() => void)[] = [];
  const settled = jobs.map(
    () =>
      new Promise<void>((resolve) => {
        settle.push(resolve);
      }),
  );

  const all = runPreloadPool(
    jobs.map((job) => job.run),
    (index) => {
      settle[index]!();
      loaded++;
      onProgress?.(loaded, jobs.length);
    },
  );

  return {
    all,
    ready(shipConfigIds?: Iterable<string>): Promise<void> {
      const seated = shipConfigIds === undefined ? null : new Set(shipConfigIds);
      if (!seated || seated.size === 0) return all;
      const waits = settled.filter((_, index) => {
        const shipId = jobs[index]!.shipId;
        return shipId === null || seated.has(shipId);
      });
      // Raced against `all` so a preload that blows up outright still fails the
      // launch rather than dropping the player into a half-built match. (A model
      // that merely fails to LOAD never gets here: `ensureModel` resolves null
      // and the view falls back to its procedural recipe.)
      return Promise.race([Promise.all(waits).then(() => undefined), all]);
    },
  };
}
