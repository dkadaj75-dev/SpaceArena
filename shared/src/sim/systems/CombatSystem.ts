import type { ModuleConfig } from "../../schemas/index.js";
import { applyDamageToShip } from "../damage.js";
import { headingOf } from "../math.js";
import { hasLineOfSightBetween } from "../los.js";
import { spawnProjectile } from "../spawn.js";
import type { World } from "../World.js";

/**
 * CombatSystem (1.6) — active weapon modules auto-fire when the ship holds a
 * LOCK on its target (FLIGHT.md §2 — every weapon kind requires it, no
 * exceptions and no per-driver carve-outs), the target is in weapon range, has
 * LoS (if required), the cycle has elapsed and energy is available.
 *   - beam (`projectile: null`): instant damage (projectileFired + damage events)
 *   - kinetic: dumb projectile aimed at the target's *current* position (leads
 *     nothing, so it can miss a mover — intentional)
 *   - missile: homing projectile carrying the target id (LoS checked at launch)
 * Firing marks the module worked-this-tick for EnergySystem.
 */
export function combatSystem(world: World, dt: number): void {
  for (const id of world.shipIds()) {
    const mods = world.modules.get(id);
    if (!mods) continue;
    const core = world.shipCores.get(id)!;
    const ref = world.targets.get(id);
    const myTeam = world.teams.get(id)!.team;
    const myTf = world.transforms.get(id)!;

    for (const m of mods.modules) {
      const cfg = world.configs.get<ModuleConfig>("module", m.moduleId);
      if (!cfg?.fire) continue;
      if (m.state !== "active") continue;

      if (m.cycleTimer > 0) {
        m.cycleTimer -= dt;
        if (m.cycleTimer > 0) continue;
        m.cycleTimer = 0;
      }

      // Lock gate (checked after the cycle timer: a weapon keeps cooling down
      // whether or not the pilot is holding a lock).
      if (!ref?.locked) continue;
      const targetId = ref.targetId;
      if (targetId === null || !world.shipCores.has(targetId)) continue;
      const tgtTf = world.transforms.get(targetId)!;

      const dx = tgtTf.pos.x - myTf.pos.x;
      const dz = tgtTf.pos.z - myTf.pos.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist > cfg.fire.range) continue;
      if (cfg.fire.requiresLineOfSight && !hasLineOfSightBetween(world, id, targetId)) continue;
      if (core.capacitor.cur <= cfg.energy.drawActive * dt) continue;

      // Fire.
      m.cycleTimer = cfg.fire.cycleTime;
      m.workedThisTick = true;
      const heading = headingOf(dx, dz);

      if (cfg.fire.projectile === null) {
        applyDamageToShip(world, targetId, id, cfg.fire.damage, cfg.fire.damageType);
        world.emit({
          type: "projectileFired",
          ownerId: id,
          moduleId: m.moduleId,
          kind: "beam",
          targetId,
          actions: cfg.onFire,
        });
      } else {
        const proj = cfg.fire.projectile;
        const kind = proj.turnRate !== undefined ? "missile" : "kinetic";
        const pid = spawnProjectile(world, {
          kind,
          damage: cfg.fire.damage,
          damageType: cfg.fire.damageType,
          speed: proj.speed,
          turnRate: proj.turnRate,
          lifetime: proj.lifetime,
          ownerId: id,
          ownerTeam: myTeam,
          targetId: kind === "missile" ? targetId : undefined,
          pos: { x: myTf.pos.x, z: myTf.pos.z },
          heading,
        });
        world.emit({
          type: "projectileFired",
          ownerId: id,
          moduleId: m.moduleId,
          kind,
          projectileId: pid,
          targetId,
          actions: cfg.onFire,
        });
      }
    }
  }
}
