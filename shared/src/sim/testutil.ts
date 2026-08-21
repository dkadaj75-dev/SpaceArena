import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ConfigService } from "../core/ConfigService.js";
import type { ArenaConfig, AsteroidConfig, GamemodeConfig, ShipConfig, TuningConfig } from "../schemas/index.js";
import type { EntityId } from "./components.js";
import { targetingSystem } from "./systems/TargetingSystem.js";
import { World } from "./World.js";

const CONTENT_DIR = fileURLToPath(new URL("../../../content/", import.meta.url));

async function fsLoader(relPath: string): Promise<unknown> {
  const abs = path.join(CONTENT_DIR, relPath);
  return JSON.parse(await readFile(abs, "utf8"));
}

/**
 * Load the real content pack into a ConfigService for sim tests.
 *
 * `matchCountdownSec` defaults to **0** — the shipped pack opens every match with
 * a 3-second frozen countdown (`ArenaSimulation`), and a suite that ticks a fixed
 * number of steps to measure flight, damage or a win condition is not testing
 * that. Zero is a legal authored value, so this is a real content override rather
 * than a back door into the sim. The countdown has its own suite
 * (`countdown.test.ts`), which passes the shipped value explicitly.
 */
export async function loadTestConfigs(
  opts: { matchCountdownSec?: number } = {},
): Promise<ConfigService> {
  const configs = new ConfigService(fsLoader);
  const result = await configs.load("manifest.json");
  if (!result.ok) {
    throw new Error("test content failed to load: " + JSON.stringify(result.errors));
  }
  setTestCountdown(configs, opts.matchCountdownSec ?? 0);
  return configs;
}

/**
 * Rewrite the loaded pack's `tuning.matchCountdownSec`. Goes through
 * `ConfigService.replace`, so the value is schema-validated exactly like an
 * editor save — a test cannot install a countdown the shipped schema would
 * reject.
 */
export function setTestCountdown(configs: ConfigService, seconds: number): void {
  const tuning = configs.getAll<TuningConfig>("tuning")[0];
  if (!tuning) throw new Error("no tuning config loaded");
  const result = configs.replace({ ...tuning, matchCountdownSec: seconds });
  if (!result.ok) {
    throw new Error("failed to set test countdown: " + JSON.stringify(result.errors));
  }
}

/**
 * Build a bare World for unit-testing individual systems. Spawns no asteroids;
 * pass `gamemodeOverride` to swap the boundary rule etc.
 */
export function makeWorld(
  configs: ConfigService,
  opts: {
    arenaId?: string;
    gamemodeId?: string;
    gamemodeOverride?: Partial<GamemodeConfig>;
    tuningOverride?: Partial<TuningConfig>;
  } = {},
): World {
  const shippedTuning = configs.getAll<TuningConfig>("tuning")[0]!;
  // A tuning override needs a FRESH id: `World.tuning` re-resolves by id every
  // read (so offline hot-tuning works), and an override that kept the shipped id
  // would be silently replaced by the registry copy on the first read. The main
  // caller is a test authoring the LEGACY `maxPitchRad` clamp, which the shipped
  // pack deliberately omits so that ships can loop (BUBBLE.md §A).
  const tuning = opts.tuningOverride
    ? ({ ...shippedTuning, ...opts.tuningOverride, id: `${shippedTuning.id}.override` } as TuningConfig)
    : shippedTuning;
  const arena = configs.get<ArenaConfig>("arena", opts.arenaId ?? "arena.ring-nebula")!;
  const base = configs.get<GamemodeConfig>("gamemode", opts.gamemodeId ?? "gamemode.practice-bots-1v1")!;
  const gamemode = { ...base, ...opts.gamemodeOverride } as GamemodeConfig;
  return new World(configs, tuning, arena, gamemode);
}

/**
 * Stand-in rocks for sim fixtures, and the scale that sizes one.
 *
 * The pack used to ship a config per size band (`small-rock` at 3.5,
 * `large-hazard` at 8, `colossal-a` at 18). Since 2026-08-18 it ships six
 * SHAPES at one nominal radius and every placement states its own size through
 * `scale`, so a fixture that cares about a rock's size says so explicitly
 * instead of encoding it in the config id.
 *
 * Both stand-ins are the roundest bodies in the catalogue — a fixture that wants
 * "a rock of radius R in the way" wants as little silhouette surprise as
 * possible. Reach for a specific lumpy one (see `asteroidCollision.test.ts`) when
 * the shape is the point.
 */
export const ROCK_LARGE = "asteroid.rock-b";
export const ROCK_SMALL = "asteroid.rock-f";

/** Placement scale that makes `asteroidId` span `worldRadius` world units. */
export function rockScaleFor(configs: ConfigService, asteroidId: string, worldRadius: number): number {
  const cfg = configs.get<AsteroidConfig>("asteroid", asteroidId);
  if (!cfg) throw new Error(`unknown asteroid config: ${asteroidId}`);
  return worldRadius / cfg.radius;
}

/** Rebuild the spatial hash from current asteroid + ship positions (what tick() does). */
export function rebuildSpatial(world: World): void {
  // Rocks go into the STATIC layer, ships into the dynamic one, exactly as
  // `tick()` does — otherwise a test's broadphase would order its candidates
  // differently from the real sim's.
  world.spatial.clear();
  for (const id of world.asteroidIds()) {
    if (world.asteroids.get(id)!.state === "destroyed") continue;
    const t = world.transforms.get(id)!;
    const c = world.colliders.get(id)!;
    world.spatial.insertStatic(id, t.pos.x, t.pos.z, c.radius);
  }
  for (const id of world.shipIds()) {
    const t = world.transforms.get(id)!;
    const c = world.colliders.get(id)!;
    world.spatial.insert(id, t.pos.x, t.pos.z, c.radius);
  }
}

/**
 * Run the real TargetingSystem until `entityId` holds a full lock (FLIGHT.md §2)
 * — the fixture a CombatSystem-level test uses to reach the state a player
 * reaches by holding an enemy in the cone. Uses the actual cone/range geometry
 * and the ship's own `sensors.lockTimeSec`, so it fails loudly if the scenario
 * is not lockable at all instead of silently testing nothing.
 */
export function warmLock(world: World, entityId: EntityId, dt = 1 / 30): void {
  const core = world.shipCores.get(entityId);
  if (!core) throw new Error(`warmLock: ${entityId} is not a ship`);
  const maxTicks = Math.ceil(core.sensors.lockTimeSec / dt) + 2;
  for (let i = 0; i < maxTicks; i++) {
    targetingSystem(world, dt);
    if (world.targets.get(entityId)?.locked) return;
  }
  throw new Error(`warmLock: ${entityId} never locked (target out of sensor cone/range?)`);
}

/**
 * Force a ship's lock to full on its CURRENT target without any geometry, for
 * benches that deliberately measure something other than lock behaviour (a
 * scripted flight path would otherwise swing the target out of the cone and stop
 * the guns for reasons unrelated to what is being measured). Call it every tick:
 * the drain still runs, it just never reaches 0.
 */
export function pinLock(world: World, entityId: EntityId): void {
  const ref = world.targets.get(entityId);
  const core = world.shipCores.get(entityId);
  if (!ref || !core || ref.targetId === null) return;
  ref.lockProgress = core.sensors.lockTimeSec;
  ref.locked = true;
}

/**
 * The light hull's slots in order (owner 2026-07-31): two hardpoints, then the
 * five-bay internal block (engine, generator, transformer, countermeasure, sensors).
 * Mirrors `ship.interceptor`'s `defaultFitting` — tests that want a weapon on a
 * specific index address 0 (laser) and 1 (missile); anything ≥ 2 is an internal.
 */
export const INTERCEPTOR_FITTING = [
  "module.laser-mk1",
  "module.missile-mk1",
  "module.engine-civ",
  "module.generator-compact",
  "module.transformer-stock",
  "module.countermeasure-flare",
  "module.sensors-basic",
];

/** Fitted-slot index of each internal bay on the light hull. */
export const INTERCEPTOR_SLOTS = {
  laser: 0,
  missile: 1,
  engine: 2,
  generator: 3,
  transformer: 4,
  countermeasure: 5,
  sensors: 6,
} as const;

/**
 * The light hull with a SHIELD on its second hardpoint (which accepts one) in
 * place of the missile — for the mitigation/shield tests, since the stock light
 * fitting carries no shield.
 */
export const INTERCEPTOR_FITTING_SHIELD = [
  "module.laser-mk1",
  "module.shield-mk1",
  "module.engine-civ",
  "module.generator-compact",
  "module.transformer-stock",
  "module.countermeasure-flare",
  "module.sensors-basic",
];

/**
 * The light hull with a BOOSTING engine. Boost lives on the engine internal
 * since 2026-07-31, so "does this hull have an afterburner" is a question about
 * slot {@link INTERCEPTOR_SLOTS.engine}, not about a hardpoint.
 */
export const INTERCEPTOR_FITTING_BOOST = [
  "module.laser-mk1",
  "module.missile-mk1",
  "module.engine-sport",
  "module.generator-compact",
  "module.transformer-stock",
  "module.countermeasure-flare",
  "module.sensors-basic",
];

/**
 * The light hull carrying a HEAVY laser and a heavy shield — deliberately more
 * than its power rail can feed at once (owner 2026-07-31). This is the fitting
 * the dual-energy rules are written about: legal to build, impossible to run
 * whole, so raising the shield puts the gun out.
 */
export const INTERCEPTOR_FITTING_OVERSUBSCRIBED = [
  "module.laser-mk2",
  "module.shield-mk2",
  "module.engine-civ",
  "module.generator-compact",
  "module.transformer-stock",
  "module.countermeasure-flare",
  "module.sensors-basic",
];

/** As {@link INTERCEPTOR_FITTING}, but carrying the longer-lived chaff pod. */
export const INTERCEPTOR_FITTING_CHAFF = [
  "module.laser-mk1",
  "module.missile-mk1",
  "module.engine-civ",
  "module.generator-compact",
  "module.transformer-stock",
  "module.countermeasure-chaff",
  "module.sensors-basic",
];

/**
 * Strip every hull's `core.combat` role profile from a test registry, in memory.
 *
 * The profile (outgoing damage, rate of fire, shield efficiency) is
 * DESIGNER-OWNED content the F10 ship tool writes, so the shipped hulls carry
 * whatever the last tuning pass typed. A suite that asserts a MECHANISM —
 * "a weapon charges its authored cycle time", "a channel deals exactly its
 * authored DPS", "the stat panel rolls up the fitted tanks" — is not asserting
 * today's balance, and must not turn red because a designer moved a slider.
 * Call this in `beforeAll` and those suites read the module's authored numbers
 * again.
 *
 * Balance suites (TTK bands, the golden fingerprint) deliberately do NOT call
 * this: pinning the shipped pack is the whole of their job.
 *
 * `replace` is in-memory only — nothing here touches content on disk.
 */
export function clearCombatProfiles(configs: ConfigService): void {
  for (const ship of configs.getAll<ShipConfig>("ship")) {
    if (!ship.core.combat) continue;
    const core = { ...ship.core };
    delete (core as Record<string, unknown>)["combat"];
    const result = configs.replace({ ...ship, core });
    if (!result.ok) throw new Error(`clearCombatProfiles(${ship.id}): ${JSON.stringify(result.errors)}`);
  }
}
