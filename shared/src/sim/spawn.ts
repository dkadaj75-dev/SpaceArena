import type { ConfigService } from "../core/ConfigService.js";
import { rockSpinFor } from "../collision/rockPose.js";
import { resolveRockShape } from "../collision/rockShape.js";
import type { DamageType } from "../schemas/common.js";
import { hardpointsOf, isInternalFamily, type AsteroidConfig, type ModuleConfig, type ShipConfig } from "../schemas/index.js";
import type { EntityId, ModuleRuntime } from "./components.js";
import { resolveShipStats, type UpgradeLevels } from "./resolveStats.js";
import { railAdmitted } from "./powerRail.js";
import { advancePitch } from "./math.js";
import { seedUp } from "./frame.js";
import { pitchTuningOf } from "./tuningDefaults.js";
import type { World } from "./World.js";

/** Small radius given to travelling ordnance for hit sweeps. */
const PROJECTILE_RADIUS = 0.4;

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
 *
 * `pos.y` and `pitch` are the bubble's vertical seams (BUBBLE.md §A) and both
 * default to 0, so an arena authored without vertical structure spawns exactly
 * where it always did.
 *
 * `reuseEntityId` is the RESPAWN path: the ship is rebuilt under a previously
 * destroyed id so every binding to that id (local player, bot driver, server
 * PlayerState, HUD views) survives the death without rewiring.
 */
export function spawnShipFromConfig(
  world: World,
  configs: ConfigService,
  shipId: string,
  fittingModuleIds: readonly (string | null)[],
  team: number,
  pos: { x: number; y?: number; z: number },
  heading: number,
  upgradeLevels?: UpgradeLevels,
  pitch = 0,
  reuseEntityId?: EntityId,
): EntityId {
  const ship = configs.get<ShipConfig>("ship", shipId);
  if (!ship) throw new Error(`unknown ship config: ${shipId}`);

  let id: EntityId;
  if (reuseEntityId !== undefined) {
    world.restoreEntity(reuseEntityId);
    id = reuseEntityId;
  } else {
    id = world.createEntity();
  }
  // An authored spawn pitch is held to the legacy clamp when a pack has one, and
  // otherwise merely WRAPPED — free pitch has no illegal value, only unspelled
  // ones (BUBBLE.md §A).
  const maxPitch = pitchTuningOf(world.tuning).maxPitchRad;
  const spawnPitch = Number.isFinite(pitch) ? advancePitch(0, pitch, maxPitch) : 0;
  // The orientation FRAME is seeded from the authored attitude: a spawn has no
  // roll history, so the derived up is the one legal frame for its nose.
  world.transforms.set(id, {
    pos: { x: pos.x, y: pos.y ?? 0, z: pos.z },
    heading,
    pitch: spawnPitch,
    up: seedUp(heading, spawnPitch),
  });
  world.velocities.set(id, { x: 0, y: 0, z: 0 });
  world.shipCores.set(id, resolveShipStats(ship, configs, { upgradeLevels, fittedModuleIds: fittingModuleIds }));
  world.colliders.set(id, { radius: ship.collider.radius });
  world.teams.set(id, { team });
  world.targets.set(id, { targetId: null, lockProgress: 0, locked: false });

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
    // Per-module stores are resolved ONCE, here, against the hull that carries
    // them (heat/energy overhaul 2026-08-07): the runtime then owns absolute
    // numbers, so every consumer — sim, snapshot, HUD ring — reads
    // `heat / heatCapacity` without re-deriving a multiplier chain per tick.
    const core = world.shipCores.get(id)!;
    modules.push({
      moduleId,
      hardpointIndex,
      // Weapons come up ONLINE at spawn and respawn alike — their limiter is
      // heat, not the deploy toggle. Internals are normally always on by
      // nature, except a boost-capable engine: boost is a deliberate,
      // energy-priced activation and starts DISABLED on every fresh hull.
      state: modCfg.fire || (isInternalFamily(modCfg.family) && !modCfg.boost) ? "active" : "retracted",
      stateTimer: 0,
      rounds: modCfg.fire?.clip?.size ?? 0,
      heat: 0,
      heatCapacity: modCfg.heat ? modCfg.heat.capacity * core.heatStore.multiplier : 0,
      // Tanks spawn FULL: a pilot leaves the pad with a charged boost bottle and
      // a charged shield, and pays for what they spend from there.
      energy: modCfg.energy ? modCfg.energy.capacity * core.energyStore.multiplier : 0,
      energyCapacity: modCfg.energy ? modCfg.energy.capacity * core.energyStore.multiplier : 0,
      absorbs: modCfg.mitigation !== undefined,
      cycleTimer: 0,
      channeling: false,
      channel: null,
      workedThisTick: false,
    });
  });
  // POWER RAIL (2026-07-31): an over-subscribed fitting is legal, so the hull
  // boots only as many modules as its rail can feed, in slot order. The rest sit
  // retracted until the pilot chooses them — at which point ModuleSystem sheds
  // whatever has to come down.
  const railCapacity = world.shipCores.get(id)?.power.capacity ?? 0;
  const admitted = railAdmitted(configs, modules, railCapacity);
  for (const m of modules) {
    if (m.state === "active" && !admitted.has(m)) m.state = "retracted";
  }
  world.modules.set(id, { modules });

  return id;
}

/**
 * Instantiate an asteroid from config + placement.
 *
 * `placementIndex` is the rock's index in `arena.asteroidPlacements` and is the
 * identity its tumble is derived from — deliberately NOT the entity id, which an
 * online client never sees (see `collision/rockPose.ts`). It defaults to the
 * count of rocks already spawned, which is the same number for the normal
 * "spawn the arena in placement order" path and keeps hand-built test worlds
 * sensible.
 */
export function spawnAsteroid(
  world: World,
  configs: ConfigService,
  asteroidId: string,
  pos: { x: number; y?: number; z: number },
  scale = 1,
  placementIndex = world.asteroids.size,
  rotationY = 0,
): EntityId {
  const cfg = configs.get<AsteroidConfig>("asteroid", asteroidId);
  if (!cfg) throw new Error(`unknown asteroid config: ${asteroidId}`);

  const id = world.createEntity();
  world.transforms.set(id, { pos: { x: pos.x, y: pos.y ?? 0, z: pos.z }, heading: 0, pitch: 0, up: { x: 0, y: 1, z: 0 } });
  const visualRadius = cfg.radius * scale;
  const shape = cfg.shape ? resolveRockShape(cfg.shape) : null;
  // `collider.radius` is the rock's BOUNDING sphere. It is what the spatial hash
  // is seeded with and what every narrowphase rejects against first, so it must
  // be a genuine upper bound on the surface — never the old inscribed sphere,
  // which would reject real contacts before the shape was ever consulted.
  const boundRadius = shape ? shape.maxRadius * visualRadius : visualRadius * (cfg.colliderScale ?? 1);
  world.colliders.set(id, { radius: boundRadius });
  const hp = cfg.hp ?? Infinity;
  world.asteroids.set(id, {
    configId: asteroidId,
    hp,
    maxHp: hp,
    destructible: cfg.destructible,
    impactDamage: cfg.impactDamage,
    visualRadius,
    placementIndex,
    shape,
    spin: rockSpinFor(placementIndex, cfg.render.spin),
    baseRotationY: rotationY,
    orientation: { x: 0, y: 0, z: 0, w: 1 },
    // NaN forces the first query of this rock to build its pose; no real match
    // time can equal it, so the cache can never be wrongly hit at t = 0.
    orientationTime: Number.NaN,
    innerRadius: shape ? shape.minRadius * visualRadius : boundRadius,
    meanRadius: shape ? shape.meanRadius * visualRadius : boundRadius,
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
    /**
     * The AUTHORED type, composite ones (`hybrid`) included — the split into
     * leaf types happens on impact, in `applyDamageToShip`, not here. Widened
     * from the two leaves on 2026-08-14 when missiles became hybrid warheads.
     */
    damageType: DamageType;
    speed: number;
    turnRate?: number;
    lifetime: number;
    ownerId: EntityId;
    ownerTeam: number;
    targetId?: EntityId;
    pos: { x: number; y?: number; z: number };
    heading: number;
    /** Launch elevation (BUBBLE.md §A); defaults to level. */
    pitch?: number;
  },
): EntityId {
  const id = world.createEntity();
  const pitch = params.pitch ?? 0;
  world.transforms.set(id, {
    pos: { x: params.pos.x, y: params.pos.y ?? 0, z: params.pos.z },
    heading: params.heading,
    pitch,
    up: seedUp(params.heading, pitch),
  });
  const cosPitch = Math.cos(pitch);
  world.velocities.set(id, {
    x: cosPitch * Math.cos(params.heading) * params.speed,
    y: Math.sin(pitch) * params.speed,
    z: cosPitch * Math.sin(params.heading) * params.speed,
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
