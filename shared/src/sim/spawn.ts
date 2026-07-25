import type { ConfigService } from "../core/ConfigService.js";
import { hardpointsOf, type AsteroidConfig, type ModuleConfig, type ShipConfig } from "../schemas/index.js";
import type { EntityId, ModuleRuntime, ShipCore } from "./components.js";
import { resolveShipStats, type UpgradeLevels } from "./resolveStats.js";
import type { World } from "./World.js";

/** Small radius given to travelling ordnance for hit sweeps. */
const PROJECTILE_RADIUS = 0.4;

/**
 * Resolve final ship core stats from the ship class + upgrade tracks + module
 * passives. Thin back-compat wrapper over {@link resolveShipStats} (the single
 * Phase 4 resolver); `upgradeLevels` are DB purchase counts (0 = base).
 */
export function resolveShipCore(
  config: ShipConfig,
  configs: ConfigService,
  upgradeLevels?: UpgradeLevels,
  fittedModuleIds?: readonly (string | null)[],
): ShipCore {
  return resolveShipStats(config, configs, { upgradeLevels, fittedModuleIds });
}

/**
 * Instantiate a ship from config with a resolved core and per-module runtimes.
 *
 * `fittingModuleIds` is **positional**: the array index is the hardpoint index,
 * and a `null` (or missing) entry is an empty hardpoint that is skipped. Each
 * built {@link ModuleRuntime} carries its true `hardpointIndex`, so the modules
 * array is sparse-safe — module toggles address modules by hardpoint index, not
 * by array position (see ModuleSystem).
 *
 * `upgradeLevels` (optional, additive) are the player's DB upgrade purchase
 * counts; omitted ⇒ base stats. Fitted module passives are always folded in.
 */
export function spawnShipFromConfig(
  world: World,
  configs: ConfigService,
  shipId: string,
  fittingModuleIds: readonly (string | null)[],
  team: number,
  pos: { x: number; z: number },
  heading: number,
  upgradeLevels?: UpgradeLevels,
): EntityId {
  const ship = configs.get<ShipConfig>("ship", shipId);
  if (!ship) throw new Error(`unknown ship config: ${shipId}`);

  const id = world.createEntity();
  world.transforms.set(id, { pos: { x: pos.x, z: pos.z }, heading });
  world.velocities.set(id, { x: 0, z: 0 });
  world.shipCores.set(id, resolveShipStats(ship, configs, { upgradeLevels, fittedModuleIds: fittingModuleIds }));
  world.colliders.set(id, { radius: ship.collider.radius });
  world.teams.set(id, { team });
  world.targets.set(id, { targetId: null, manual: false, lockProgress: 0, locked: false });

  // Ordered hardpoint sockets: array index === hardpoint index (see hardpointsOf).
  const hardpoints = hardpointsOf(ship);
  const modules: ModuleRuntime[] = [];
  fittingModuleIds.forEach((moduleId, hardpointIndex) => {
    if (moduleId === null || moduleId === undefined) return; // empty hardpoint
    const modCfg = configs.get<ModuleConfig>("module", moduleId);
    if (!modCfg) {
      throw new Error(`unknown module config: ${moduleId}`);
    }
    // Enforce socket compatibility at spawn (defence in depth behind fitting
    // validation): a fit addressing a missing hardpoint, or one whose family the
    // hardpoint does not accept, is a programming/content error — throw loudly.
    const hp = hardpoints[hardpointIndex];
    if (!hp) {
      throw new Error(`fitting references hardpoint index ${hardpointIndex} but ship ${shipId} has ${hardpoints.length} hardpoint(s)`);
    }
    if (!hp.accepts.includes(modCfg.family)) {
      throw new Error(`module ${moduleId} (family '${modCfg.family}') not accepted by hardpoint ${hardpointIndex} of ${shipId} (accepts ${hp.accepts.join(", ")})`);
    }
    modules.push({
      moduleId,
      hardpointIndex,
      state: "retracted",
      stateTimer: 0,
      heat: 0,
      cycleTimer: 0,
      workedThisTick: false,
      shieldPool: 0,
      overheatDamaged: false,
    });
  });
  world.modules.set(id, { modules });

  return id;
}

/** Instantiate an asteroid from config + placement. */
export function spawnAsteroid(
  world: World,
  configs: ConfigService,
  asteroidId: string,
  pos: { x: number; z: number },
  scale = 1,
): EntityId {
  const cfg = configs.get<AsteroidConfig>("asteroid", asteroidId);
  if (!cfg) throw new Error(`unknown asteroid config: ${asteroidId}`);

  const id = world.createEntity();
  world.transforms.set(id, { pos: { x: pos.x, z: pos.z }, heading: 0 });
  world.colliders.set(id, { radius: cfg.radius * scale });
  const hp = cfg.hp ?? Infinity;
  world.asteroids.set(id, {
    configId: asteroidId,
    hp,
    maxHp: hp,
    destructible: cfg.destructible,
    impactDamage: cfg.impactDamage,
    state: "intact",
  });
  return id;
}

/** Spawn a travelling projectile (kinetic dumb / missile homing). */
export function spawnProjectile(
  world: World,
  params: {
    kind: "kinetic" | "missile";
    damage: number;
    damageType: "kinetic" | "energy";
    speed: number;
    turnRate?: number;
    lifetime: number;
    ownerId: EntityId;
    ownerTeam: number;
    targetId?: EntityId;
    pos: { x: number; z: number };
    heading: number;
  },
): EntityId {
  const id = world.createEntity();
  world.transforms.set(id, { pos: { x: params.pos.x, z: params.pos.z }, heading: params.heading });
  world.velocities.set(id, {
    x: Math.cos(params.heading) * params.speed,
    z: Math.sin(params.heading) * params.speed,
  });
  world.colliders.set(id, { radius: PROJECTILE_RADIUS });
  world.projectiles.set(id, {
    kind: params.kind,
    damage: params.damage,
    damageType: params.damageType,
    speed: params.speed,
    turnRate: params.turnRate,
    lifetime: params.lifetime,
    ownerId: params.ownerId,
    ownerTeam: params.ownerTeam,
    targetId: params.targetId,
    radius: PROJECTILE_RADIUS,
  });
  return id;
}
