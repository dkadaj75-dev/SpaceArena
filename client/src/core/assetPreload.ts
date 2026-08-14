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
 * Load (once) every model the arena needs. Match startup awaits this promise
 * before constructing the synchronous asteroid views, so a valid authored GLB
 * cannot lose a race with the first snapshot. `ensureModel` resolves `null` on
 * an actual load/decode failure, preserving the procedural fallback for that
 * failure case without making it the normal first-match path.
 */
export async function preloadArenaModels(
  assets: AssetRegistry,
  configs: ConfigService,
  arenaId: string,
): Promise<void> {
  await Promise.all(
    arenaModelRenders(configs, arenaId).map((render) =>
      assets.ensureModel(render, { mergeParts: render.mergeParts !== false }),
    ),
  );
}

/** Every authored ship base and LOD GLB, independent of the active quality tier. */
export function shipModelRenders(configs: ConfigService): RenderRecipe[] {
  const renders: RenderRecipe[] = [];
  for (const ship of configs.getAll<ShipConfig>("ship")) {
    const render = ship.render;
    if (typeof render.model !== "string") continue;
    renders.push(render);
    for (const lod of render.lods ?? []) renders.push({ ...render, model: lod.model, lods: undefined });
  }
  return renders;
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
 */
export async function preloadShipModels(assets: AssetRegistry, configs: ConfigService): Promise<void> {
  const ships = configs.getAll<ShipConfig>("ship").filter((ship) => typeof ship.render.model === "string");
  await Promise.all(shipModelRenders(configs).map((render) => assets.ensureModel(render)));
  await Promise.all(ships.map(async (ship) => {
    const master = await assets.ensureModel(ship.render);
    if (master) await assets.applyModelLods(master, ship.render.lods ?? []);
  }));
}

/** Reports completed model loads out of the total this match needs. */
export type PreloadProgress = (loaded: number, total: number) => void;

/**
 * Everything a match can render. Awaited behind the match launch screen — and,
 * since the online flow searches for players FIRST, usually started long before
 * that screen is done with it, which is what `onProgress` is for: the card shows
 * whatever is left only if the pilots are found before the models are in.
 *
 * Progress is counted in individual model loads rather than in the three coarse
 * groups, so the bar tracks the work instead of jumping to 90% on the first
 * resolve. `ensureModel` is memoized per (path, scale, yaw), so naming the ship
 * renders here AND running the hull pass (which additionally wires each hull's
 * LOD chain, and must see every master resolved) costs one load apiece.
 */
export async function preloadMatchModels(
  assets: AssetRegistry,
  configs: ConfigService,
  arenaId: string,
  onProgress?: PreloadProgress,
): Promise<void> {
  const jobs: (() => Promise<unknown>)[] = [
    ...arenaModelRenders(configs, arenaId).map(
      (render) => () => assets.ensureModel(render, { mergeParts: render.mergeParts !== false }),
    ),
    ...shipModelRenders(configs).map((render) => () => assets.ensureModel(render)),
    ...moduleModelRenders(configs).map((render) => () => assets.ensureModel(render)),
    () => preloadShipModels(assets, configs),
  ];
  let loaded = 0;
  onProgress?.(0, jobs.length);
  await Promise.all(
    jobs.map(async (job) => {
      await job();
      loaded++;
      onProgress?.(loaded, jobs.length);
    }),
  );
}
