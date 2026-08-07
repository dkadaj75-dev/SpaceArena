import type { ModuleConfig } from "../../schemas/index.js";
import type { EntityId } from "../components.js";
import { seedUp } from "../frame.js";
import type { World } from "../World.js";

/**
 * JettisonSystem (owner 2026-07-31) — the heatsink escape hatch.
 *
 * A `jettisonHeatsink` order blows the fitted sink clear of the hull. Two things
 * happen, and both are the point:
 *
 *  1. **Every rack's heat is purged.** All module heat goes to zero and every
 *     lockout clears — the sink holding that heat has just left the hull. This
 *     is the out for a loadout that has cooked itself, and the only instant one.
 *  2. **A decoy is left behind.** The glowing sink is the brightest thing in the
 *     sky for `decoyLifetimeSec`, so enemy auto-lock prefers it over a hull
 *     (TargetingSystem) and homing missiles ALREADY IN FLIGHT re-seek it
 *     (ProjectileSystem). That mid-flight steal is what makes it a counter to
 *     missiles rather than only a heat reset.
 *
 * Only a sink authoring a `jettison` block can do this at all, and then only
 * once per `cooldownSec` — tracked on the sink's own `cycleTimer`, which is
 * otherwise unused by a non-weapon and is already replicated, so the HUD gets
 * the cooldown readout for free.
 *
 * Runs BEFORE targeting and projectiles so a decoy dropped this tick is already
 * lurable the same tick it appears.
 */
export function jettisonSystem(world: World, dt: number): void {
  // Cooldowns tick down for every fitted sink, whether or not it was used.
  for (const id of world.shipIds()) {
    const mods = world.modules.get(id);
    if (!mods) continue;
    for (const m of mods.modules) {
      if (m.cycleTimer <= 0) continue;
      const cfg = world.configs.get<ModuleConfig>("module", m.moduleId);
      if (cfg?.jettison) m.cycleTimer = Math.max(0, m.cycleTimer - dt);
    }
  }

  // Age the drifting sinks out BEFORE this tick's drops, so a sink created now
  // gets its whole authored lifetime rather than losing its first tick to the
  // same call that spawned it.
  for (const id of world.decoyIds()) {
    const decoy = world.decoys.get(id)!;
    decoy.lifetime -= dt;
    if (decoy.lifetime <= 0) world.destroyEntity(id);
  }

  for (const { entityId } of world.takeOrders("jettisonHeatsink")) {
    tryJettison(world, entityId);
  }
}

function tryJettison(world: World, shipId: EntityId): void {
  const mods = world.modules.get(shipId);
  const tf = world.transforms.get(shipId);
  const core = world.shipCores.get(shipId);
  if (!mods || !tf || !core || core.hull <= 0) return;

  // The fitted sink that CAN be jettisoned and is off cooldown.
  let sink: { runtime: (typeof mods.modules)[number]; cfg: ModuleConfig } | null = null;
  for (const m of mods.modules) {
    const cfg = world.configs.get<ModuleConfig>("module", m.moduleId);
    if (!cfg?.jettison) continue;
    if (m.cycleTimer > 0) return; // on cooldown — the order is simply spent
    sink = { runtime: m, cfg };
    break;
  }
  if (!sink) return;

  sink.runtime.cycleTimer = sink.cfg.jettison!.cooldownSec;

  // 1. Purge EVERY rack to zero and clear every lockout (heat/energy overhaul
  // 2026-08-07). This is the one instant heat clear in the game — the sink
  // carrying the heat is physically gone — and it is what makes a cooked
  // loadout recoverable in the middle of a fight rather than at the end of it.
  for (const m of mods.modules) {
    m.heat = 0;
    if (m.state === "overheated") {
      const cfg = world.configs.get<ModuleConfig>("module", m.moduleId);
      m.stateTimer = 0;
      m.state = cfg?.fire ? "active" : "retracted";
      world.emit({
        type: "moduleStateChanged",
        entityId: shipId,
        hardpointIndex: m.hardpointIndex,
        moduleId: m.moduleId,
        from: "overheated",
        to: m.state,
      });
    }
  }

  // 2. Leave the lure, at rest where the ship was. It does not inherit the
  // ship's velocity: a sink that flew along with you would shadow the hull it is
  // meant to draw fire away from.
  const decoyId = world.createEntity();
  world.transforms.set(decoyId, {
    pos: { x: tf.pos.x, y: tf.pos.y, z: tf.pos.z },
    heading: tf.heading,
    pitch: 0,
    up: seedUp(tf.heading, 0),
  });
  world.velocities.set(decoyId, { x: 0, y: 0, z: 0 });
  world.colliders.set(decoyId, { radius: sink.cfg.jettison!.decoyRadius });
  world.decoys.set(decoyId, {
    team: world.teams.get(shipId)?.team ?? -1,
    lifetime: sink.cfg.jettison!.decoyLifetimeSec,
    maxLifetime: sink.cfg.jettison!.decoyLifetimeSec,
    radius: sink.cfg.jettison!.decoyRadius,
  });

  world.emit({
    type: "heatsinkJettisoned",
    entityId: shipId,
    decoyId,
    moduleId: sink.runtime.moduleId,
    actions: sink.cfg.onActivate,
  });
}
