import type { ModuleConfig } from "../../schemas/index.js";
import type { EntityId } from "../components.js";
import { seedUp } from "../frame.js";
import type { World } from "../World.js";

/**
 * JettisonSystem (owner 2026-07-31, heat-free since 2026-08-20) — the
 * countermeasure launcher.
 *
 * A `jettisonCountermeasure` order blows the fitted pod clear of the hull,
 * leaving a decoy behind. The glowing pod is the brightest thing in the sky for
 * `decoyLifetimeSec`, so enemy auto-lock prefers it over a hull
 * (TargetingSystem) and homing missiles ALREADY IN FLIGHT re-seek it
 * (ProjectileSystem). That mid-flight steal is the whole of it: the pod buys
 * you one missile volley, nothing else.
 *
 * (Until the heat system was deleted this ALSO purged every rack's heat, which
 * was the reason the module existed. What survives is the half that was about
 * the other ship shooting at you rather than about your own metal.)
 *
 * Only a pod authoring a `jettison` block can do this at all, and then only
 * once per `cooldownSec` — tracked on the pod's own `cycleTimer`, which is
 * otherwise unused by a non-weapon and is already replicated, so the HUD gets
 * the cooldown readout for free.
 *
 * Runs BEFORE targeting and projectiles so a decoy dropped this tick is already
 * lurable the same tick it appears.
 */
export function jettisonSystem(world: World, dt: number): void {
  // Cooldowns tick down for every fitted pod, whether or not it was used.
  for (const id of world.shipIds()) {
    const mods = world.modules.get(id);
    if (!mods) continue;
    for (const m of mods.modules) {
      if (m.cycleTimer <= 0) continue;
      const cfg = world.configs.get<ModuleConfig>("module", m.moduleId);
      if (cfg?.jettison) m.cycleTimer = Math.max(0, m.cycleTimer - dt);
    }
  }

  // Age the drifting pods out BEFORE this tick's drops, so a pod created now
  // gets its whole authored lifetime rather than losing its first tick to the
  // same call that spawned it.
  for (const id of world.decoyIds()) {
    const decoy = world.decoys.get(id)!;
    decoy.lifetime -= dt;
    if (decoy.lifetime <= 0) world.destroyEntity(id);
  }

  for (const { entityId } of world.takeOrders("jettisonCountermeasure")) {
    tryJettison(world, entityId);
  }
}

function tryJettison(world: World, shipId: EntityId): void {
  const mods = world.modules.get(shipId);
  const tf = world.transforms.get(shipId);
  const core = world.shipCores.get(shipId);
  if (!mods || !tf || !core || core.hull <= 0) return;

  // The fitted pod that CAN be jettisoned and is off cooldown.
  let pod: { runtime: (typeof mods.modules)[number]; cfg: ModuleConfig } | null = null;
  for (const m of mods.modules) {
    const cfg = world.configs.get<ModuleConfig>("module", m.moduleId);
    if (!cfg?.jettison) continue;
    if (m.cycleTimer > 0) return; // on cooldown — the order is simply spent
    pod = { runtime: m, cfg };
    break;
  }
  if (!pod) return;

  pod.runtime.cycleTimer = pod.cfg.jettison!.cooldownSec;

  // Leave the lure, at rest where the ship was. It does not inherit the
  // ship's velocity: a pod that flew along with you would shadow the hull it is
  // meant to draw fire away from.
  const decoyId = world.createEntity();
  world.transforms.set(decoyId, {
    pos: { x: tf.pos.x, y: tf.pos.y, z: tf.pos.z },
    heading: tf.heading,
    pitch: 0,
    up: seedUp(tf.heading, 0),
  });
  world.velocities.set(decoyId, { x: 0, y: 0, z: 0 });
  world.colliders.set(decoyId, { radius: pod.cfg.jettison!.decoyRadius });
  world.decoys.set(decoyId, {
    team: world.teams.get(shipId)?.team ?? -1,
    lifetime: pod.cfg.jettison!.decoyLifetimeSec,
    maxLifetime: pod.cfg.jettison!.decoyLifetimeSec,
    radius: pod.cfg.jettison!.decoyRadius,
  });

  world.emit({
    type: "countermeasureJettisoned",
    entityId: shipId,
    decoyId,
    moduleId: pod.runtime.moduleId,
    actions: pod.cfg.onActivate,
  });
}
