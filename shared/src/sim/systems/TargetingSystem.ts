import type { EntityId, ShipCore, TargetRef, Transform2D } from "../components.js";
import { angleDelta, distSq, headingOf } from "../math.js";
import type { World } from "../World.js";

/** Fallback drain multiplier when `tuning.lockDecayMult` is absent. */
const DEFAULT_LOCK_DECAY_MULT = 1.5;

/**
 * TargetingSystem (1.5 + FLIGHT.md §2) — resolves each ship's TargetRef and runs
 * the time-based lock.
 *
 * The lock zone is a heading-relative world-space cone from the ship's resolved
 * sensors: `dist <= sensors.lockRange` and
 * `|angleDelta(heading, bearingToTarget)| <= sensors.coneDeg/2`. Per tick:
 *   - candidate = nearest enemy ship inside the zone (auto policy from tuning);
 *   - candidate changed → progress reset to 0, lock dropped;
 *   - candidate in zone → `lockProgress += dt`, capped at `lockTimeSec`;
 *     `locked` flips true when it fills and STAYS true while progress > 0;
 *   - nothing in the zone → `lockProgress -= dt * tuning.lockDecayMult`; hitting
 *     0 drops the target and the lock. That drain window IS the lock-break grace.
 * CombatSystem fires only while `locked`, so this gate applies to every ship
 * equally — bots included, whichever driver moves them.
 *
 * INTERIM manual targeting (retires with move orders, bots still use it): a
 * `target` order pins WHICH enemy is the candidate, but it does not bypass the
 * lock — the pinned enemy must sit in the cone + range for progress to accrue,
 * and when it leaves, progress drains exactly as an auto candidate's would. On
 * reaching 0 the pin clears and auto targeting takes back over. A pin issued
 * while the enemy is already outside the zone (progress 0, nothing to drain)
 * therefore clears on the same tick — deterministic, and it keeps "lock gating
 * applies to all ships equally" true regardless of who issued the order.
 *
 * LoS is NOT part of the lock; CombatSystem still checks it per weapon.
 */
export function targetingSystem(world: World, dt: number): void {
  for (const { entityId, order } of world.takeOrders("target")) {
    const ref = world.targets.get(entityId);
    if (!ref) continue;
    if (order.targetId !== ref.targetId) resetLock(world, entityId, ref);
    ref.targetId = order.targetId;
    ref.manual = order.targetId !== null;
    world.emit({ type: "targetSet", entityId, targetId: order.targetId });
  }

  const policy = world.tuning.targetingPolicy;
  const decayMult = world.tuning.lockDecayMult ?? DEFAULT_LOCK_DECAY_MULT;
  const ships = world.shipIds();

  for (const id of ships) {
    const ref = world.targets.get(id);
    if (!ref) continue;
    const core = world.shipCores.get(id)!;
    const tf = world.transforms.get(id)!;
    const myTeam = world.teams.get(id)!.team;

    // A dead/invalid target drops immediately — no drain grace for a wreck.
    if (ref.targetId !== null && !world.shipCores.has(ref.targetId)) {
      dropTarget(world, id, ref);
    }

    // Half-cone in radians: coneDeg is the FULL width, so deg/2 → rad is /360*PI.
    const halfCone = (core.sensors.coneDeg * Math.PI) / 360;
    const candidate =
      ref.manual && ref.targetId !== null
        ? inLockZone(world, tf, core, halfCone, ref.targetId)
          ? ref.targetId
          : null
        : pickCandidate(world, id, myTeam, ships, policy, tf, core, halfCone);

    if (candidate !== null) {
      if (candidate !== ref.targetId) {
        resetLock(world, id, ref);
        ref.targetId = candidate;
        world.emit({ type: "targetSet", entityId: id, targetId: candidate });
      }
      const full = core.sensors.lockTimeSec;
      ref.lockProgress = Math.min(full, ref.lockProgress + dt);
      if (!ref.locked && ref.lockProgress >= full) {
        ref.locked = true;
        world.emit({ type: "lockAcquired", entityId: id, targetId: candidate });
      }
      continue;
    }

    // Nothing lockable in the zone: drain, then drop at 0.
    if (ref.lockProgress > 0) {
      ref.lockProgress -= dt * decayMult;
      if (ref.lockProgress <= 0) {
        ref.lockProgress = 0;
        dropTarget(world, id, ref);
      }
    } else if (ref.targetId !== null) {
      dropTarget(world, id, ref);
    }
  }
}

/** Clear lock progress (and announce a lost lock) without touching `targetId`. */
function resetLock(world: World, entityId: EntityId, ref: TargetRef): void {
  ref.lockProgress = 0;
  if (ref.locked) {
    ref.locked = false;
    world.emit({ type: "lockLost", entityId });
  }
}

/** Drop the target and its lock, announcing both. */
function dropTarget(world: World, entityId: EntityId, ref: TargetRef): void {
  resetLock(world, entityId, ref);
  if (ref.targetId === null && !ref.manual) return;
  ref.targetId = null;
  ref.manual = false;
  world.emit({ type: "targetSet", entityId, targetId: null });
}

/** True if `targetId` is inside the ship's sensor range AND heading-relative cone. */
function inLockZone(
  world: World,
  tf: Transform2D,
  core: ShipCore,
  halfCone: number,
  targetId: EntityId,
): boolean {
  const tgt = world.transforms.get(targetId);
  if (!tgt) return false;
  const dx = tgt.pos.x - tf.pos.x;
  const dz = tgt.pos.z - tf.pos.z;
  const range = core.sensors.lockRange;
  if (dx * dx + dz * dz > range * range) return false;
  // Co-located ships have no meaningful bearing; treat that as in-cone.
  if (dx === 0 && dz === 0) return true;
  return Math.abs(angleDelta(tf.heading, headingOf(dx, dz))) <= halfCone;
}

/**
 * Nearest (or lowest-hp, per tuning policy) enemy ship inside the lock zone.
 * `attacker` falls back to nearest, as before. Iterates `ships` in sorted-id
 * order, so ties resolve deterministically.
 */
function pickCandidate(
  world: World,
  self: EntityId,
  myTeam: number,
  ships: EntityId[],
  policy: string,
  tf: Transform2D,
  core: ShipCore,
  halfCone: number,
): EntityId | null {
  let best: EntityId | null = null;
  let bestScore = Infinity;
  for (const other of ships) {
    if (other === self) continue;
    if (world.teams.get(other)!.team === myTeam) continue;
    if (!inLockZone(world, tf, core, halfCone, other)) continue;
    const score =
      policy === "lowestHp"
        ? world.shipCores.get(other)!.hull
        : distSq(tf.pos, world.transforms.get(other)!.pos);
    if (score < bestScore) {
      bestScore = score;
      best = other;
    }
  }
  return best;
}
