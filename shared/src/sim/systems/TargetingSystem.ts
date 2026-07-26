import type { EntityId, ShipCore, TargetRef, Transform3D } from "../components.js";
import { angleBetween3, distSq3, facingVec } from "../math.js";
import type { World } from "../World.js";

/** Fallback drain multiplier when `tuning.lockDecayMult` is absent. */
const DEFAULT_LOCK_DECAY_MULT = 1.5;

/**
 * Scratch vectors for the cone test. The zone check runs for every
 * ship × candidate pair every tick; these keep it allocation-free.
 */
const facingScratch = { x: 0, y: 0, z: 0 };
const bearingScratch = { x: 0, y: 0, z: 0 };

/**
 * TargetingSystem (1.5 + FLIGHT.md §2) — resolves each ship's TargetRef and runs
 * the time-based lock. Targeting is **fully automatic**: there is no target
 * order and no manual pin, so the same rule produces every ship's candidate,
 * player and bot alike.
 *
 * The lock zone is an orientation-relative world-space cone from the ship's
 * resolved sensors, and it is a true 3D cone in the bubble (BUBBLE.md §A):
 * `dist3 <= sensors.lockRange` and the angle between the ship's 3D facing vector
 * and the 3D bearing to the target `<= sensors.coneDeg/2`. Per tick:
 *   - candidate = **the current target if it is still in the zone** (the sticky
 *     rule, see below), otherwise the best fresh enemy in the zone under
 *     `tuning.targetingPolicy`;
 *   - candidate changed → progress reset to 0, lock dropped;
 *   - candidate in zone → `lockProgress += dt`, capped at `lockTimeSec`;
 *     `locked` flips true when it fills and STAYS true while progress > 0;
 *   - nothing in the zone → `lockProgress -= dt * tuning.lockDecayMult`; hitting
 *     0 drops the target and the lock. That drain window IS the lock-break grace.
 * CombatSystem fires only while `locked`, so this gate applies to every ship
 * equally — bots included, whichever driver moves them.
 *
 * ## Sticky candidate (why re-ranking every tick is not an option)
 *
 * A lock takes `lockTimeSec` of continuous progress on ONE candidate, and any
 * change zeroes it. Re-running "nearest enemy in the cone" from scratch every
 * tick means a second enemy drifting a hair closer — or two enemies trading
 * places as everyone manoeuvres — throws away a warm-up that was about to
 * complete, and in a two-on-one nobody ever fires. So the choice is sticky: as
 * long as the current target is a live enemy still inside the cone AND range, it
 * REMAINS the candidate regardless of how the ranking now reads. Selection only
 * runs when there is no incumbent — because it died, left the zone (its progress
 * then drains, and the drop at 0 re-opens selection), or was never set.
 *
 * That is deliberately the sim-side version of what the bots' `holdLockTarget`
 * did while target orders still existed, moved here so it applies to human
 * pilots too and so bots gain nothing the player does not have.
 *
 * LoS is NOT part of the lock; CombatSystem still checks it per weapon.
 */
export function targetingSystem(world: World, dt: number): void {
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
    // Sticky: hold the incumbent while it is still lockable; only then re-select.
    const candidate =
      ref.targetId !== null && inLockZone(world, tf, core, halfCone, ref.targetId)
        ? ref.targetId
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
  if (ref.targetId === null) return;
  ref.targetId = null;
  world.emit({ type: "targetSet", entityId, targetId: null });
}

/**
 * True if `targetId` is inside the ship's sensor range AND its 3D cone. Team is
 * NOT re-checked: only {@link pickCandidate} ever sets a target, it only ever
 * picks an enemy, and teams are fixed for the life of a ship.
 *
 * Both tests are fully 3D (BUBBLE.md §A): range on the true distance, and the
 * cone as the angle between the ship's facing vector and the bearing vector. The
 * planar `angleDelta(heading, bearing)` this replaces would have locked an enemy
 * hanging straight overhead as if it were dead ahead.
 */
function inLockZone(
  world: World,
  tf: Transform3D,
  core: ShipCore,
  halfCone: number,
  targetId: EntityId,
): boolean {
  const tgt = world.transforms.get(targetId);
  if (!tgt) return false;
  const dx = tgt.pos.x - tf.pos.x;
  const dy = tgt.pos.y - tf.pos.y;
  const dz = tgt.pos.z - tf.pos.z;
  const range = core.sensors.lockRange;
  if (dx * dx + dy * dy + dz * dz > range * range) return false;
  // Co-located ships have no meaningful bearing; treat that as in-cone.
  if (dx === 0 && dy === 0 && dz === 0) return true;
  bearingScratch.x = dx;
  bearingScratch.y = dy;
  bearingScratch.z = dz;
  return angleBetween3(facingVec(tf.heading, tf.pitch, facingScratch), bearingScratch) <= halfCone;
}

/**
 * Nearest (or lowest-hp, per tuning policy) enemy ship inside the lock zone.
 * `attacker` falls back to nearest, as before. Iterates `ships` in sorted-id
 * order, so ties resolve deterministically. Only consulted when the ship has no
 * lockable incumbent — see the sticky rule on {@link targetingSystem}.
 */
function pickCandidate(
  world: World,
  self: EntityId,
  myTeam: number,
  ships: EntityId[],
  policy: string,
  tf: Transform3D,
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
        : distSq3(tf.pos, world.transforms.get(other)!.pos);
    if (score < bestScore) {
      bestScore = score;
      best = other;
    }
  }
  return best;
}
