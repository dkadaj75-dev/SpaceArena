import type { EntityId, Flag } from "../components.js";
import { dist3 } from "../math.js";
import type { World } from "../World.js";

/**
 * CtfSystem (owner 2026-07-31) — the whole capture-the-flag rule set.
 *
 * The rules, stated once so the code below can be read against them:
 *
 *  - A flag belongs to a team and lives on that team's base.
 *  - Flying through an enemy flag TAKES it; you are then the carrier and cannot
 *    boost. There is no other way to get it — while it is borne you have to kill
 *    the carrier first.
 *  - Flying through your OWN flag does nothing while it is home, and RETURNS it
 *    instantly while it is loose.
 *  - Killing a carrier drops the flag where it died. It waits `dropReturnSec`
 *    for someone: an enemy of its owner picks the run back up, a defender sends
 *    it straight home, and if nobody comes it returns itself.
 *  - You score by carrying the enemy flag into your own base WHILE YOUR OWN FLAG
 *    IS HOME. That last clause is the mode: it is what makes defending matter.
 *
 * Ordering matters and is deliberate. This runs AFTER collision (so a ship that
 * just died has hull ≤ 0) and BEFORE cleanup (so it still has a transform to
 * drop the flag at). Carrier death is therefore detected at the position where
 * it actually happened, not at the origin.
 *
 * Determinism: ships are consulted in ascending entity-id order, so two ships
 * touching a loose flag on the same tick always resolve the same way.
 */
export function ctfSystem(world: World, dt: number): void {
  const rules = world.gamemode.ctf;
  if (!rules || world.flags.size === 0) return;

  for (const flagId of world.flagIds()) {
    const flag = world.flags.get(flagId)!;
    const tf = world.transforms.get(flagId);
    if (!tf) continue;

    // 1. Follow the carrier, or notice that we have lost one.
    if (flag.state === "carried") {
      const carrierId = flag.carrierId;
      if (carrierId === null || !carrierAlive(world, carrierId)) {
        // The transform already holds the carrier's last position — that is
        // exactly where the flag should land.
        drop(world, flagId, flag, carrierId, rules.dropReturnSec);
      } else {
        const carrierTf = world.transforms.get(carrierId)!;
        tf.pos.x = carrierTf.pos.x;
        tf.pos.y = carrierTf.pos.y;
        tf.pos.z = carrierTf.pos.z;
      }
    }

    // 2. A loose flag counts down to its own rescue.
    if (flag.state === "dropped") {
      flag.dropTimer -= dt;
      if (flag.dropTimer <= 0) {
        sendHome(world, flagId, flag, null, true);
      }
    }

    // 3. Contact. A flag at home can only be TAKEN (by an enemy); a loose one
    //    can be taken by an enemy or sent home by a defender.
    if (flag.state !== "carried") {
      for (const shipId of world.shipIds()) {
        if (!carrierAlive(world, shipId)) continue;
        const team = world.teams.get(shipId)!.team;
        const reach = flag.pickupRadius + (world.colliders.get(shipId)?.radius ?? 0);
        if (dist3(tf.pos, world.transforms.get(shipId)!.pos) > reach) continue;

        if (team === flag.team) {
          // Your own flag: nothing at home, an instant return when loose.
          if (flag.state === "home") continue;
          sendHome(world, flagId, flag, shipId, false);
          break;
        }
        take(world, flagId, flag, shipId, team);
        break;
      }
    }

    // 4. Trail. A flag that is going somewhere leaves a wake; one on its stand
    //    does not.
    if (flag.state === "home") {
      flag.trail.length = 0;
    } else {
      pushTrail(flag, tf.pos, rules.trailLength);
    }
  }
}

/**
 * Is `shipId` a live ship? Runs before cleanup, so "destroyed this tick" shows
 * up as hull ≤ 0 rather than as a missing entity.
 */
function carrierAlive(world: World, shipId: EntityId): boolean {
  if (!world.isAlive(shipId)) return false;
  const core = world.shipCores.get(shipId);
  return core !== undefined && core.hull > 0;
}

function take(world: World, flagId: EntityId, flag: Flag, carrierId: EntityId, carrierTeam: number): void {
  flag.state = "carried";
  flag.carrierId = carrierId;
  flag.dropTimer = 0;
  world.emit({ type: "flagTaken", flagId, flagTeam: flag.team, carrierId, carrierTeam });
}

function drop(world: World, flagId: EntityId, flag: Flag, carrierId: EntityId | null, returnSec: number): void {
  flag.state = "dropped";
  flag.carrierId = null;
  flag.dropTimer = returnSec;
  world.emit({ type: "flagDropped", flagId, flagTeam: flag.team, carrierId, returnSec });
}

function sendHome(world: World, flagId: EntityId, flag: Flag, byId: EntityId | null, timedOut: boolean): void {
  const tf = world.transforms.get(flagId);
  if (tf) {
    tf.pos.x = flag.home.x;
    tf.pos.y = flag.home.y;
    tf.pos.z = flag.home.z;
  }
  flag.state = "home";
  flag.carrierId = null;
  flag.dropTimer = 0;
  flag.trail.length = 0;
  world.emit({ type: "flagReturned", flagId, flagTeam: flag.team, byId, timedOut });
}

/**
 * Resolve a capture for `carrierId` if it is standing in its own base with the
 * enemy flag AND its own flag is home. Returns the flag that was scored, or
 * null. Called by {@link ArenaSimulation} rather than here because scoring is
 * the match's business, not the flag's.
 */
export function tryCapture(world: World, flagId: EntityId, flag: Flag): { carrierId: EntityId; team: number } | null {
  if (flag.state !== "carried" || flag.carrierId === null) return null;
  const carrierId = flag.carrierId;
  const carrierTeam = world.teams.get(carrierId)?.team;
  if (carrierTeam === undefined) return null;

  const ownBase = findFlagOfTeam(world, carrierTeam);
  if (!ownBase) return null;
  // The clause that makes defence a job: you cannot cash a run while your own
  // flag is out there.
  if (ownBase.flag.state !== "home") return null;

  const carrierTf = world.transforms.get(carrierId);
  if (!carrierTf) return null;
  const reach = ownBase.flag.baseRadius + (world.colliders.get(carrierId)?.radius ?? 0);
  if (dist3(carrierTf.pos, ownBase.flag.home) > reach) return null;

  return { carrierId, team: carrierTeam };
}

/** The flag belonging to `team`, if this arena has one. */
export function findFlagOfTeam(world: World, team: number): { id: EntityId; flag: Flag } | null {
  for (const id of world.flagIds()) {
    const flag = world.flags.get(id)!;
    if (flag.team === team) return { id, flag };
  }
  return null;
}

/** The flag `shipId` is carrying, if any — what gates the carrier's afterburner. */
export function carriedFlagOf(world: World, shipId: EntityId): Flag | null {
  for (const id of world.flagIds()) {
    const flag = world.flags.get(id)!;
    if (flag.state === "carried" && flag.carrierId === shipId) return flag;
  }
  return null;
}

/** Put a flag back on its stand from outside the system (a capture, a reset). */
export function returnFlagHome(world: World, flagId: EntityId, flag: Flag): void {
  const tf = world.transforms.get(flagId);
  if (tf) {
    tf.pos.x = flag.home.x;
    tf.pos.y = flag.home.y;
    tf.pos.z = flag.home.z;
  }
  flag.state = "home";
  flag.carrierId = null;
  flag.dropTimer = 0;
  flag.trail.length = 0;
}

/**
 * Extend the wake and trim it to `maxLength` world units of PATH, not to a
 * point count — a flag on a fast hull would otherwise stream a much longer
 * ribbon than one being walked home.
 */
function pushTrail(flag: Flag, pos: { x: number; y: number; z: number }, maxLength: number): void {
  if (maxLength <= 0) {
    flag.trail.length = 0;
    return;
  }
  const last = flag.trail[flag.trail.length - 1];
  if (last) {
    const step = dist3(last, pos);
    // Sub-resolution movement is not worth a point; it would fill the ribbon
    // with duplicates and cost the tail its length.
    if (step < MIN_TRAIL_STEP) return;
    // A jump longer than the whole ribbon is a DISCONTINUITY, not a wake — a
    // teleport, a reset, a respawn. Drawing a line across it would claim the
    // flag flew a path it never flew, so start the ribbon over.
    if (step > maxLength) {
      flag.trail.length = 0;
    }
  }
  flag.trail.push({ x: pos.x, y: pos.y, z: pos.z });

  let length = 0;
  for (let i = flag.trail.length - 1; i > 0; i--) {
    length += dist3(flag.trail[i]!, flag.trail[i - 1]!);
    if (length > maxLength) {
      flag.trail.splice(0, i - 1);
      return;
    }
  }
}

/** Smallest movement worth a trail point, in world units. */
const MIN_TRAIL_STEP = 0.5;
