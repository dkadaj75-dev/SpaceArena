import type { DamageType } from "../schemas/common.js";
import type { ModuleConfig } from "../schemas/index.js";
import type { EntityId, ShipCore } from "./components.js";
import { damageTypeProfileOf, type ResolvedDamageTypeProfile } from "./tuningDefaults.js";
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
 * Central ship damage pipeline used by beams and projectiles alike.
 *
 * SHIELDED AND BARE ARE TWO SEPARATE CASES (owner 2026-08-15), not one chain.
 * The older model soaked a share off the top and passed the remainder down to
 * hull, which meant one number implied the other; the rules are now stated
 * independently per damage type, and the two cases are:
 *
 *   WHILE A COVERING SHIELD IS UP (active, and its reserve is not flat)
 *     - the shield takes `shieldedShield` of the hit into its reserve;
 *     - hull takes `shieldedHull` of the hit, and nothing else.
 *     These are read independently and DELIBERATELY DO NOT HAVE TO SUM TO 1:
 *     an autocannon puts 0.2 into the reserve and 0.2 through to plating and
 *     spends the rest of the round on the shield's surface. A laser puts 1.0
 *     into the reserve and nothing through; so does half a missile.
 *
 *   BARE — no shield equipped, none active, or the reserve is flat
 *     - hull takes `bareHull` of the hit. Kinetic and missiles land full;
 *       energy scorches unprotected plating for half.
 *
 * A shield that COLLAPSES mid-hit is the seam between the two: the part of
 * `shieldedShield` its reserve could not cover is charged to hull at `bareHull`
 * rather than evaporating, so the round that breaks a shield still hurts and no
 * damage is silently lost at the boundary.
 *
 * Order within a hit: `base *= tuning.globalDamageMult` FIRST and once, so the
 * knob scales shield and hull alike and leaves their ratio alone. Hull damage
 * is then multiplied by the hull's own per-type resist.
 *
 * Emits `damage` carrying what the hull ACTUALLY lost, so the number floating
 * over a ship is the number it took, and one `shieldAbsorb` per shield that
 * soaked. Pass a `tally` (a channelling continuous weapon does) to BANK those
 * amounts instead of emitting them; `entityDestroyed` is never banked.
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

  const scaled = baseAmount * world.tuning.globalDamageMult;
  // Banked either way: the tally the beams pass in is the same accumulator the
  // discrete path uses to build its one event per hit.
  const sink: DamageTally = tally ?? { hull: 0, absorbed: new Map() };

  applyTyped(world, targetId, core, scaled, type, damageTypeProfileOf(world.tuning, type), sink);

  if (!tally) {
    for (const [hardpointIndex, amount] of sink.absorbed) {
      world.emit({ type: "shieldAbsorb", targetId, sourceId, hardpointIndex, amount, damageType: type });
    }
    if (sink.hull > 0) {
      world.emit({ type: "damage", targetId, sourceId, amount: sink.hull, damageType: type, isAsteroid: false });
    }
  }

  if (core.hull <= 0) {
    core.hull = 0;
    const pos = world.transforms.get(targetId)?.pos;
    world.emit({
      type: "entityDestroyed",
      entityId: targetId,
      killerId: sourceId,
      isAsteroid: false,
      team: world.teams.get(targetId)?.team,
      pos: pos ? { x: pos.x, y: pos.y, z: pos.z } : undefined,
    });
  }
}

/** A shield that is up, covers `type`, and still has reserve to spend. */
interface CoveringShield {
  module: NonNullable<ReturnType<World["modules"]["get"]>>["modules"][number];
  /** Reserve left in its own tank; Infinity for a module with no tank. */
  available: number;
  /** Its authored `damageReduction`, used only for a type with no rule at all. */
  fallbackShare: number;
}

/**
 * The shields standing between `targetId` and a hit of `type`, in module order
 * so the sequence of draws against a reserve too small to pay is deterministic.
 * A shield with a flat reserve is NOT covering — that is exactly the "bare"
 * case, and it is what makes a collapsed shield stop protecting.
 */
function coveringShields(world: World, targetId: EntityId, type: DamageType): CoveringShield[] {
  const mods = world.modules.get(targetId);
  if (!mods) return [];
  const out: CoveringShield[] = [];
  for (const m of mods.modules) {
    if (m.state !== "active") continue;
    const cfg = world.configs.get<ModuleConfig>("module", m.moduleId);
    const mit = cfg?.mitigation;
    if (!mit) continue;
    // Asked about the type the shield itself lists in `coversFamilies`.
    if (mit.coversFamilies && !mit.coversFamilies.includes(type)) continue;
    const available = m.energyCapacity > 0 ? m.energy : Infinity;
    if (available <= 0) continue;
    out.push({ module: m, available, fallbackShare: mit.damageReduction });
  }
  return out;
}

/**
 * Apply one hit of `type` to a ship: shield reserve, then hull.
 *
 * The shield draw is computed ONCE for the hit and then filled from whatever
 * covering shields are up, in module order, rather than per shield — otherwise
 * two shields would each take the type's full share and a second shield would
 * silently double the protection.
 */
function applyTyped(
  world: World,
  targetId: EntityId,
  core: ShipCore,
  amount: number,
  type: DamageType,
  profile: ResolvedDamageTypeProfile,
  sink: DamageTally,
): void {
  if (amount <= 0) return;

  // --- what the shields can take ------------------------------------------
  let hull: number;
  const shields = coveringShields(world, targetId, type);
  if (shields.length === 0) {
    // Bare: no shield equipped, none active, or every reserve is flat.
    hull = amount * profile.bareHull;
  } else {
    const share = profile.shieldedShield ?? shields[0]!.fallbackShare;
    let want = amount * share;
    for (const shield of shields) {
      if (want <= 0) break;
      const taken = Math.min(want, shield.available);
      if (taken <= 0) continue;
      want -= taken;
      const m = shield.module;
      if (m.energyCapacity > 0) m.energy -= taken;
      m.workedThisTick = true;
      sink.absorbed.set(m.hardpointIndex, (sink.absorbed.get(m.hardpointIndex) ?? 0) + taken);
    }
    // `want` is now the shortfall: the share the reserves could not cover. It
    // is charged to hull at the BARE rate — the shield collapsed under it.
    hull = amount * profile.shieldedHull + want * profile.bareHull;
  }

  // --- innate shield hp (shieldMax is 0 in MVP) ----------------------------
  if (core.shieldMax > 0 && core.shield > 0 && hull > 0) {
    const absorbed = Math.min(core.shield, hull);
    core.shield -= absorbed;
    hull -= absorbed;
  }

  if (hull <= 0) return;
  const resist = type === "kinetic" ? core.resists.kinetic : core.resists.energy;
  const hullDmg = hull * (1 - resist);
  if (hullDmg <= 0) return;
  core.hull -= hullDmg;
  sink.hull += hullDmg;
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
    const pos = world.transforms.get(asteroidId)?.pos;
    world.emit({
      type: "entityDestroyed",
      entityId: asteroidId,
      killerId: sourceId,
      isAsteroid: true,
      pos: pos ? { x: pos.x, y: pos.y, z: pos.z } : undefined,
    });
  }
}
