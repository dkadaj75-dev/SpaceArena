import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ConfigService } from "../core/ConfigService.js";
import type { ArenaConfig, GamemodeConfig, TuningConfig } from "../schemas/index.js";
import { World } from "./World.js";

const CONTENT_DIR = fileURLToPath(new URL("../../../content/", import.meta.url));

async function fsLoader(relPath: string): Promise<unknown> {
  const abs = path.join(CONTENT_DIR, relPath);
  return JSON.parse(await readFile(abs, "utf8"));
}

/** Load the real content pack into a ConfigService for sim tests. */
export async function loadTestConfigs(): Promise<ConfigService> {
  const configs = new ConfigService(fsLoader);
  const result = await configs.load("manifest.json");
  if (!result.ok) {
    throw new Error("test content failed to load: " + JSON.stringify(result.errors));
  }
  return configs;
}

/**
 * Build a bare World for unit-testing individual systems. Spawns no asteroids;
 * pass `gamemodeOverride` to swap the boundary rule etc.
 */
export function makeWorld(
  configs: ConfigService,
  opts: { arenaId?: string; gamemodeId?: string; gamemodeOverride?: Partial<GamemodeConfig> } = {},
): World {
  const tuning = configs.getAll<TuningConfig>("tuning")[0]!;
  const arena = configs.get<ArenaConfig>("arena", opts.arenaId ?? "arena.ring-nebula")!;
  const base = configs.get<GamemodeConfig>("gamemode", opts.gamemodeId ?? "gamemode.practice")!;
  const gamemode = { ...base, ...opts.gamemodeOverride } as GamemodeConfig;
  return new World(configs, tuning, arena, gamemode);
}

/** Rebuild the spatial hash from current asteroid + ship positions (what tick() does). */
export function rebuildSpatial(world: World): void {
  world.spatial.clear();
  for (const id of world.asteroidIds()) {
    if (world.asteroids.get(id)!.state === "destroyed") continue;
    const t = world.transforms.get(id)!;
    const c = world.colliders.get(id)!;
    world.spatial.insert(id, t.pos.x, t.pos.z, c.radius);
  }
  for (const id of world.shipIds()) {
    const t = world.transforms.get(id)!;
    const c = world.colliders.get(id)!;
    world.spatial.insert(id, t.pos.x, t.pos.z, c.radius);
  }
}

export const INTERCEPTOR_FITTING = [
  "module.laser-mk1",
  "module.missile-mk1",
  "module.shield-mk1",
  "module.boost-mk1",
];
