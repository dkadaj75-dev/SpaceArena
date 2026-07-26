import type {
  ArenaConfig,
  AsteroidConfig,
  ConfigService,
  RenderRecipe,
  ShipConfig,
} from "@space-arena/shared";
import type { AssetRegistry } from "./AssetRegistry.js";

/**
 * Which GLB models an arena needs (§11 6.3 preloading).
 *
 * Ships preload at bootstrap because there are only a handful of hulls and any
 * of them can turn up in any match. Asteroids are the other way round: the
 * models are ~1 MB each and WHICH ones a match needs is a property of the
 * arena, so they are preloaded per-arena instead — see
 * {@link preloadArenaModels}.
 *
 * Nothing here knows an asteroid id or a file name: it walks the arena's
 * placements, resolves each asteroid config, and takes whatever `render.model`
 * that config (or one of its visual states) declares. Deduplicated on the same
 * (path, scale, yaw) identity the registry caches masters by, so an arena that
 * places the same rock 30 times still asks for one load.
 */
export function arenaModelRenders(configs: ConfigService, arenaId: string): RenderRecipe[] {
  const arena = configs.get<ArenaConfig>("arena", arenaId);
  if (!arena) return [];
  const seen = new Set<string>();
  const out: RenderRecipe[] = [];
  const add = (render: RenderRecipe | undefined): void => {
    if (!render?.model) return;
    const key = `${render.model}::s${render.modelScale ?? 1}::r${render.modelRotationY ?? 0}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(render);
  };
  for (const placement of arena.asteroidPlacements) {
    const asteroid = configs.get<AsteroidConfig>("asteroid", placement.asteroidId);
    if (!asteroid) continue;
    add(asteroid.render);
    for (const state of asteroid.states ?? []) add(state.render);
  }
  return out;
}

/**
 * Kick off (once) every model load the arena needs. Fire-and-forget: a model
 * that has not landed by the time the first snapshot arrives just means those
 * rocks render as their procedural fallback for that match — `getAsteroidMaster`
 * resolves once per asteroid at spawn, so nothing pops mid-match.
 */
export function preloadArenaModels(assets: AssetRegistry, configs: ConfigService, arenaId: string): void {
  for (const render of arenaModelRenders(configs, arenaId)) void assets.ensureModel(render);
}

/** Every authored ship GLB, independent of the active quality tier. */
export function shipModelRenders(configs: ConfigService): RenderRecipe[] {
  return configs
    .getAll<ShipConfig>("ship")
    .map((ship) => ship.render)
    .filter((render) => typeof render.model === "string");
}

/**
 * Ship views choose their master synchronously and keep it for their lifetime,
 * so bootstrap must await these loads. Asteroids intentionally remain
 * fire-and-forget and may be quality-gated; ships never are.
 */
export async function preloadShipModels(assets: AssetRegistry, configs: ConfigService): Promise<void> {
  await Promise.all(shipModelRenders(configs).map((render) => assets.ensureModel(render)));
}
