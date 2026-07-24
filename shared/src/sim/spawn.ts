import type { ConfigService } from "../core/ConfigService.js";
import type { AsteroidConfig, ModuleConfig, ShipConfig, UpgradeConfig } from "../schemas/index.js";
import type { EntityId, ModuleRuntime, ShipCore } from "./components.js";
import type { World } from "./World.js";

/** Small radius given to travelling ordnance for hit sweeps. */
const PROJECTILE_RADIUS = 0.4;

/**
 * Resolve final ship core stats from the ship class plus its upgrade tracks.
 * MVP resolves every track at level 0 (index 0 = base line, add/mul are no-ops
 * by content convention), but the full add→mul→clamp stack is implemented so the
 * Phase 4 stat resolver can slot straight in.
 */
export function resolveShipCore(
  config: ShipConfig,
  configs: ConfigService,
  trackLevels: { hull: number; engine: number; energy: number; heat: number } = {
    hull: 0,
    engine: 0,
    energy: 0,
    heat: 0,
  },
): ShipCore {
  const c = config.core;
  // Flatten base stats into a path→value bag, apply upgrade deltas, read back.
  const stats: Record<string, number> = {
    "hull.base": c.hull.base,
    "engine.nominalSpeed": c.engine.nominalSpeed,
    "engine.accel": c.engine.accel,
    "engine.turnRate": c.engine.turnRate,
    "energy.capacitor": c.energy.capacitor,
    "energy.regen": c.energy.regen,
    "heat.capacity": c.heat.capacity,
    "heat.dissipation": c.heat.dissipation,
    "heat.criticalDamagePerSec": c.heat.criticalDamagePerSec,
  };

  const tracks: Array<[keyof typeof trackLevels, string]> = [
    ["hull", config.upgradeTracks.hull],
    ["engine", config.upgradeTracks.engine],
    ["energy", config.upgradeTracks.energy],
    ["heat", config.upgradeTracks.heat],
  ];
  const adds: Record<string, number> = {};
  const muls: Record<string, number> = {};
  for (const [track, upgradeId] of tracks) {
    const upgrade = configs.get<UpgradeConfig>("upgrade", upgradeId);
    if (!upgrade) continue;
    const level = upgrade.levels[trackLevels[track]];
    if (!level) continue;
    for (const [k, v] of Object.entries(level.add ?? {})) adds[k] = (adds[k] ?? 0) + v;
    for (const [k, v] of Object.entries(level.mul ?? {})) muls[k] = (muls[k] ?? 1) * v;
  }
  for (const k of Object.keys(stats)) {
    stats[k] = (stats[k]! + (adds[k] ?? 0)) * (muls[k] ?? 1);
  }

  const hullMax = stats["hull.base"]!;
  return {
    hull: hullMax,
    hullMax,
    shield: 0,
    shieldMax: 0,
    resists: { kinetic: c.hull.resists.kinetic, energy: c.hull.resists.energy },
    engine: {
      nominalSpeed: stats["engine.nominalSpeed"]!,
      accel: stats["engine.accel"]!,
      turnRate: stats["engine.turnRate"]!,
    },
    capacitor: {
      cur: stats["energy.capacitor"]!,
      max: stats["energy.capacitor"]!,
      regen: stats["energy.regen"]!,
    },
    heat: {
      cur: 0,
      capacity: stats["heat.capacity"]!,
      dissipation: stats["heat.dissipation"]!,
      criticalDamagePerSec: stats["heat.criticalDamagePerSec"]!,
    },
  };
}

/**
 * Instantiate a ship from config with a resolved core and per-module runtimes.
 *
 * `fittingModuleIds` is **positional**: the array index is the hardpoint index,
 * and a `null` (or missing) entry is an empty hardpoint that is skipped. Each
 * built {@link ModuleRuntime} carries its true `hardpointIndex`, so the modules
 * array is sparse-safe — module toggles address modules by hardpoint index, not
 * by array position (see ModuleSystem).
 */
export function spawnShipFromConfig(
  world: World,
  configs: ConfigService,
  shipId: string,
  fittingModuleIds: readonly (string | null)[],
  team: number,
  pos: { x: number; z: number },
  heading: number,
): EntityId {
  const ship = configs.get<ShipConfig>("ship", shipId);
  if (!ship) throw new Error(`unknown ship config: ${shipId}`);

  const id = world.createEntity();
  world.transforms.set(id, { pos: { x: pos.x, z: pos.z }, heading });
  world.velocities.set(id, { x: 0, z: 0 });
  world.shipCores.set(id, resolveShipCore(ship, configs));
  world.colliders.set(id, { radius: ship.collider.radius });
  world.teams.set(id, { team });
  world.targets.set(id, { targetId: null, manual: false });

  const modules: ModuleRuntime[] = [];
  fittingModuleIds.forEach((moduleId, hardpointIndex) => {
    if (moduleId === null || moduleId === undefined) return; // empty hardpoint
    if (!configs.get<ModuleConfig>("module", moduleId)) {
      throw new Error(`unknown module config: ${moduleId}`);
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
