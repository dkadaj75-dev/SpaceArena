import type { EntityId } from "../components.js";
import { distSq } from "../math.js";
import type { World } from "../World.js";

/**
 * TargetingSystem (1.5) — resolves each ship's TargetRef. Explicit `target`
 * orders set a sticky manual target (cleared only on target death). Otherwise an
 * auto policy from tuning picks a target: `nearest` or `lowestHp` (`attacker`
 * falls back to nearest for now). LoS itself is computed on demand by
 * CombatSystem via {@link hasLineOfSightBetween}, cached per tick.
 */
export function targetingSystem(world: World): void {
  for (const { entityId, order } of world.takeOrders("target")) {
    const ref = world.targets.get(entityId);
    if (!ref) continue;
    ref.targetId = order.targetId;
    ref.manual = order.targetId !== null;
    world.emit({ type: "targetSet", entityId, targetId: order.targetId });
  }

  const policy = world.tuning.targetingPolicy;
  const ships = world.shipIds();

  for (const id of ships) {
    const ref = world.targets.get(id);
    if (!ref) continue;
    const myTeam = world.teams.get(id)!.team;

    // Drop a dead/invalid target.
    if (ref.targetId !== null && !world.shipCores.has(ref.targetId)) {
      ref.targetId = null;
      ref.manual = false;
      world.emit({ type: "targetSet", entityId: id, targetId: null });
    }

    // Manual target that is still alive stays put.
    if (ref.manual && ref.targetId !== null) continue;

    const picked = pickTarget(world, id, myTeam, ships, policy);
    if (picked !== ref.targetId) {
      ref.targetId = picked;
      world.emit({ type: "targetSet", entityId: id, targetId: picked });
    }
  }
}

function pickTarget(
  world: World,
  self: EntityId,
  myTeam: number,
  ships: EntityId[],
  policy: string,
): EntityId | null {
  const selfPos = world.transforms.get(self)!.pos;
  let best: EntityId | null = null;
  let bestScore = Infinity;
  for (const other of ships) {
    if (other === self) continue;
    if (world.teams.get(other)!.team === myTeam) continue;
    const score =
      policy === "lowestHp"
        ? world.shipCores.get(other)!.hull
        : distSq(selfPos, world.transforms.get(other)!.pos);
    if (score < bestScore) {
      bestScore = score;
      best = other;
    }
  }
  return best;
}
