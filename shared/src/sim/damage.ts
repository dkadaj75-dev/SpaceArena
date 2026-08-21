import type { DamageType } from "../schemas/common.js";
import type { ModuleConfig } from "../schemas/index.js";
import type { EntityId, ShipCore } from "./components.js";
import { damageComponentsOf, type ResolvedDamageTypeProfile } from "./tuningDefaults.js";
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
  /**
   * Hull the shield SAVED its owner, by absorbing hardpoint index — the same
   * soak as {@link DamageTally.absorbed} carried forward through stage 4, i.e.
   * `soaked × hullMult × (1 - resist)`. Banked separately because the two
   * numbers answer different questions and differ by up to 2x: an energy hit
   * soaked for 10 points of shield charge would only ever have cost 5 hull
   * (`hullMult` 0.5). The HUD floats THIS one — a "damage avoided" readout must
   * be comparable to the damage numbers next to it, not to the shield's
   * internal accounting.
   */
  avoided: Map<number, number>;
}

/**
 * Central ship damage pipeline used by beams and projectiles alike. Flow, and
 * the ORDER matters — every stage below multiplies the output of the one above:
 *
 *   1. base *= tuning.globalDamageMult. The global knob is applied FIRST, once,
 *      so it scales the whole hit — shield absorb and hull damage alike keep
 *      their ratio to each other and to the shield's reserve. (Applying it last,
 *      to the hull share only, would silently make shields stronger whenever the
 *      knob went below 1.)
 *   1b. the scaled hit is SPLIT into leaf damage types by
 *      `damageComponentsOf` (2026-08-14). A plain `kinetic` or `energy` hit is
 *      one component of the whole; a COMPOSITE type — `hybrid`, the missile
 *      warhead — is two, `tuning.damageTypes.hybrid.mix` deciding the ratio
 *      (shipped 50/50). Each share then runs stages 2-4 below on its own leaf
 *      profile and the hull's own resist column for that leaf, in the enum's
 *      order, so a reserve too small for both is spent in a deterministic
 *      sequence. The shares are re-joined for the EVENTS (see below): one hit
 *      still floats one number.
 *   2. active shield module mitigation (per §2.3): for each `active` shield whose
 *      `coversFamilies` includes the damage type, remove the type's SHIELD SHARE
 *      of the hit — `tuning.damageTypes[type].shieldAbsorb`, 0.8 for energy and
 *      0.2 for kinetic, so energy is stopped by shields and kinetic sails
 *      through. The share is capped by whatever charge is left in that module's
 *      OWN energy tank — which the absorb then spends — and anything the tank
 *      could not cover simply STAYS in the hit and carries on to hull, so a
 *      shield collapsing mid-hit loses no damage. Absorbing marks the shield
 *      worked-this-tick (EnergySystem also bills its upkeep) and emits
 *      `shieldAbsorb` with what the shield actually soaked, alongside
 *      `hullAvoided` — that same soak carried through stage 4, i.e. the hull the
 *      shield SAVED. A shield that spends its charge to 0 also starts its
 *      collapse cooldown, but that is EnergySystem's call, not this one's: the
 *      flameout is what collapses a shield, whichever way the tank emptied.
 *      A damage type with no authored/shipped profile falls back to the module's
 *      own `mitigation.damageReduction`, i.e. the pre-triangle behaviour.
 *   3. innate ship shield hp (shieldMax is 0 in MVP — ships have no innate shield;
 *      shielding is entirely module-provided — so this step is a no-op today).
 *   4. everything still standing reaches HULL, where it is multiplied by the
 *      type's `hullMult` (energy 0.5, kinetic 1.0) and then by the hull's own
 *      per-type resist. This applies to the penetrating share AND to the whole
 *      hit when the target has no working shield at all (none equipped, none
 *      active, or the reserve is flat) — "reaches hull" is the only condition.
 *
 * Emits `damage` carrying what the hull ACTUALLY lost (post hullMult and
 * resist), so the number that floats over a ship is the number it took; emits
 * `entityDestroyed` once when hull crosses 0. A split hit emits ONE `damage`
 * event (and one `shieldAbsorb` per shield) carrying the SUM across its shares
 * under the authored type: a missile is one impact, so it floats one number, and
 * that number is still exactly the hull it removed.
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
  // A ship the sim is flying (pad hold / launch run) cannot defend itself, so
  // it takes no damage either — no events, no tallies, as if never hit.
  if (world.launchProtected.has(targetId)) return;

  const scaled = baseAmount * world.tuning.globalDamageMult;
  // 1c. the ATTACKER's role profile. Applied per leaf share (below) rather than
  // to the whole hit, which is what lets a kinetic specialist boost exactly the
  // kinetic half of a missile — and it lands at the TOP of the pipeline, like
  // the global knob, so shield absorb and hull damage keep their ratio.
  // Banked either way: a composite hit has to re-join its shares before it can
  // emit, and the tally the beams pass in is that same accumulator.
  const sink: DamageTally = tally ?? { hull: 0, absorbed: new Map(), avoided: new Map() };

  for (const part of damageComponentsOf(world.tuning, type)) {
    // A share that already killed the target ends the hit: the rest of the
    // warhead has nothing left to hit.
    if (core.hull <= 0) break;
    const share = scaled * part.share * outgoingDamageMult(world, sourceId, part.type);
    applyTypedShare(world, targetId, core, share, part.type, part.profile, sink);
  }

  if (!tally) {
    for (const [hardpointIndex, amount] of sink.absorbed) {
      world.emit({
        type: "shieldAbsorb",
        targetId,
        sourceId,
        hardpointIndex,
        amount,
        hullAvoided: sink.avoided.get(hardpointIndex) ?? 0,
        damageType: type,
      });
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

/**
 * The ATTACKING hull's `core.combat.damageOutput` entry for one LEAF damage
 * type — the outgoing half of the role profile (owner request 2026-08-21).
 *
 * Everything that is not a ship with a resolved core multiplies by 1: a hazard,
 * a decoy, or a projectile whose owner died mid-flight has no role profile, and
 * neither does the `hybrid` fallback share a pack produces by deleting
 * `tuning.damageTypes.hybrid.mix` — there is no authorable "hybrid output"
 * knob, because a composite type has no damage of its own to scale.
 */
function outgoingDamageMult(world: World, sourceId: EntityId | null, leaf: DamageType): number {
  if (sourceId === null) return 1;
  const out = world.shipCores.get(sourceId)?.combat.damageOutput;
  if (!out) return 1;
  if (leaf === "kinetic") return out.kinetic;
  if (leaf === "energy") return out.energy;
  return 1;
}

/**
 * Stages 2-4 for ONE leaf share of a hit: shields, innate shield hp, hull.
 * Amounts land in `sink` rather than in events — {@link applyDamageToShip} joins
 * the shares back up and decides what to emit — and the hull is debited here so
 * a later share of the same hit sees the damage the earlier one did.
 */
function applyTypedShare(
  world: World,
  targetId: EntityId,
  core: ShipCore,
  amount: number,
  type: DamageType,
  profile: ResolvedDamageTypeProfile,
  sink: DamageTally,
): void {
  let dmg = amount;
  if (dmg <= 0) return;

  // Stage 4's conversion, hoisted: what one point of damage costs the HULL once
  // it gets there. Needed up here because a point a shield stops is a point of
  // hull SAVED at exactly this rate, and that is the number the HUD floats.
  const resist = type === "kinetic" ? core.resists.kinetic : core.resists.energy;
  const hullFactor = profile.hullMult * (1 - resist);

  // (2) active shield mitigation
  const mods = world.modules.get(targetId);
  if (mods) {
    for (const m of mods.modules) {
      if (dmg <= 0) break;
      if (m.state !== "active") continue;
      const cfg = world.configs.get<ModuleConfig>("module", m.moduleId);
      const mit = cfg?.mitigation;
      if (!mit) continue;
      // Asked about the LEAF type, which is what a shield's `coversFamilies`
      // lists: half a missile is energy to a shield, and the shield knows what
      // energy is even though it has never heard of `hybrid`.
      if (mit.coversFamilies && !mit.coversFamilies.includes(type)) continue;
      // The shield's RESERVE is its own energy tank (energy overhaul
      // 2026-08-07): a point soaked is a point of charge spent, so a shield
      // holds exactly as long as its tank and returns as fast as it refills.
      const available = m.energyCapacity > 0 ? m.energy : Infinity;
      if (available <= 0) continue;
      // The share this shield TRIES to take is a property of the damage type,
      // not of the module: what one shield has over another is a bigger, faster
      // reserve, not a better ratio. Only a type with no profile at all falls
      // back to the module's authored `damageReduction`.
      const share = profile.shieldAbsorb ?? mit.damageReduction;
      // Capped by the reserve — the shortfall stays in `dmg` and goes on to
      // hull, which is the whole of the collapse-mid-hit rule.
      const reduced = Math.min(dmg * share, available);
      if (reduced <= 0) continue;
      dmg -= reduced;
      if (m.energyCapacity > 0) m.energy -= reduced;
      m.workedThisTick = true;
      sink.absorbed.set(m.hardpointIndex, (sink.absorbed.get(m.hardpointIndex) ?? 0) + reduced);
      sink.avoided.set(m.hardpointIndex, (sink.avoided.get(m.hardpointIndex) ?? 0) + reduced * hullFactor);
    }
  }

  // (3) innate shield hp — none in MVP (shieldMax 0).
  if (core.shieldMax > 0 && core.shield > 0 && dmg > 0) {
    const absorbed = Math.min(core.shield, dmg);
    core.shield -= absorbed;
    dmg -= absorbed;
  }

  // (4) hull: type effectiveness, then the hull's own resist
  if (dmg <= 0) return;
  const hullDmg = dmg * hullFactor;
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
  // A rock has no shields and no resist column, so there is nothing to split it
  // into — but the attacker's role profile still has to count, and for a
  // composite type that means the share-weighted average of its leaves. A pure
  // kinetic hit reduces to exactly `damageOutput.kinetic`.
  let outMult = 0;
  for (const part of damageComponentsOf(world.tuning, type)) {
    outMult += part.share * outgoingDamageMult(world, sourceId, part.type);
  }
  const dmg = baseAmount * world.tuning.globalDamageMult * (outMult > 0 ? outMult : 1);
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
