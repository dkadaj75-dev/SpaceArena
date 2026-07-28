import type { DamageType } from "../schemas/common.js";
import type { ModuleConfig } from "../schemas/index.js";
import type { EntityId } from "./components.js";
import type { World } from "./World.js";

/**
 * Event sink for damage that is applied continuously rather than in discrete
 * hits (see {@link applyDamageToShip}). Structurally the banked half of
 * `ChannelRuntime`, kept as its own type so `damage.ts` does not depend on the
 * weapon that happens to use it.
 */
export interface DamageTally {
  hull: number;
  absorbed: Map<number, number>;
}

/**
 * Central ship damage pipeline used by beams and projectiles alike. Flow:
 *
 *   1. base *= tuning.globalDamageMult
 *   2. active shield module mitigation (per §2.3): for each `active` shield whose
 *      `coversFamilies` includes the damage type, remove `damageReduction`× of the
 *      hit, capped by that module's per-tick absorb budget (`absorbPerSecond`×dt).
 *      Absorbing marks the shield worked-this-tick (EnergySystem charges
 *      `drawActive`) and emits `shieldAbsorb`.
 *   3. innate ship shield hp (shieldMax is 0 in MVP — ships have no innate shield;
 *      shielding is entirely module-provided — so this step is a no-op today).
 *   4. remaining damage hits hull after the hull resist for that damage type.
 *
 * Emits `damage`; emits `entityDestroyed` once when hull crosses 0.
 *
 * Pass a `tally` (a channelling continuous weapon does) to BANK the `damage` and
 * `shieldAbsorb` amounts instead of emitting them — the caller then emits one
 * aggregate event per cadence window. `entityDestroyed` is never banked: a kill
 * is announced on the tick it happens. The mechanical result is byte-identical
 * either way; only event volume differs.
 */
export function applyDamageToShip(
  world: World,
  targetId: EntityId,
  sourceId: EntityId | null,
  baseAmount: number,
  type: DamageType,
  tally?: DamageTally,
): void {
  const core = world.shipCores.get(targetId);
  if (!core || core.hull <= 0) return;

  let dmg = baseAmount * world.tuning.globalDamageMult;

  // (2) active shield mitigation
  const mods = world.modules.get(targetId);
  if (mods) {
    for (const m of mods.modules) {
      if (dmg <= 0) break;
      if (m.state !== "active") continue;
      const cfg = world.configs.get<ModuleConfig>("module", m.moduleId);
      const mit = cfg?.mitigation;
      if (!mit) continue;
      if (mit.coversFamilies && !mit.coversFamilies.includes(type)) continue;
      const available = mit.absorbPerSecond === undefined ? Infinity : m.shieldPool;
      if (available <= 0) continue;
      const reduced = Math.min(dmg * mit.damageReduction, available);
      if (reduced <= 0) continue;
      dmg -= reduced;
      if (mit.absorbPerSecond !== undefined) m.shieldPool -= reduced;
      m.workedThisTick = true;
      if (tally) {
        tally.absorbed.set(m.hardpointIndex, (tally.absorbed.get(m.hardpointIndex) ?? 0) + reduced);
      } else {
        world.emit({ type: "shieldAbsorb", targetId, hardpointIndex: m.hardpointIndex, amount: reduced });
      }
    }
  }

  // (3) innate shield hp — none in MVP (shieldMax 0).
  if (core.shieldMax > 0 && core.shield > 0 && dmg > 0) {
    const absorbed = Math.min(core.shield, dmg);
    core.shield -= absorbed;
    dmg -= absorbed;
  }

  // (4) hull after resist
  if (dmg <= 0) return;
  const resist = type === "kinetic" ? core.resists.kinetic : core.resists.energy;
  const hullDmg = dmg * (1 - resist);
  const wasAlive = core.hull > 0;
  core.hull -= hullDmg;
  if (tally) tally.hull += hullDmg;
  else world.emit({ type: "damage", targetId, sourceId, amount: hullDmg, damageType: type, isAsteroid: false });

  if (wasAlive && core.hull <= 0) {
    core.hull = 0;
    world.emit({
      type: "entityDestroyed",
      entityId: targetId,
      killerId: sourceId,
      isAsteroid: false,
      team: world.teams.get(targetId)?.team,
    });
  }
}

/** Damage a destructible asteroid; emits destruction + flips asset state. */
export function applyDamageToAsteroid(
  world: World,
  asteroidId: EntityId,
  sourceId: EntityId | null,
  baseAmount: number,
  type: DamageType,
): void {
  const ast = world.asteroids.get(asteroidId);
  if (!ast || !ast.destructible || ast.state === "destroyed") return;
  const dmg = baseAmount * world.tuning.globalDamageMult;
  ast.hp -= dmg;
  world.emit({ type: "damage", targetId: asteroidId, sourceId, amount: dmg, damageType: type, isAsteroid: true });
  if (ast.hp <= 0) {
    ast.hp = 0;
    ast.state = "destroyed";
    world.emit({ type: "entityDestroyed", entityId: asteroidId, killerId: sourceId, isAsteroid: true });
  }
}
