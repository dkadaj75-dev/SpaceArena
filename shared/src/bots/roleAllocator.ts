import type { FlagSnapshot, ShipSnapshot, Snapshot } from "../sim/ArenaSimulation.js";
import type { EntityId } from "../sim/components.js";
import { dist3 } from "../sim/math.js";

/**
 * The job one ship holds for its team this allocation window (L2 of the four-layer
 * pipeline). `free` is not "idle": it is the absence of an objective claim, which
 * is what lets the ordinary combat behaviours own the decision.
 */
export type BotRole = "striker" | "interceptor" | "escort" | "warden" | "free";

export interface RoleAllocation {
  /** Role per ALIVE team ship; absent ⇒ `free`. */
  readonly roles: ReadonlyMap<EntityId, BotRole>;
  /** How many ships hold each role — the claim counts the caps produced. */
  readonly counts: Readonly<Record<BotRole, number>>;
}

/**
 * Allocation window. Re-bidding is event-driven (flag state, roster deaths — both
 * are part of the cache key below), so this is only the drift clock for ships that
 * have merely moved. It matches the shipped `ctfWeights.roleHoldMs` default, which
 * is the same anti-thrash constant one layer down.
 */
export const ROLE_WINDOW_MS = 2_500;

/** Team size the authored counts describe; smaller teams scale down from it. */
const BASELINE_TEAM = 10;
const STRIKERS = 3;
/** Both flags home ⇒ nothing to defend against yet, so press the attack. */
const RALLY_STRIKERS = 4;
const WARDENS = 2;
const INTERCEPTORS = 2;
/** Ships allowed to claim the same dropped flag; more is a queue, not a rescue. */
const RECOVER_CAP = 2;
/** Distance at which a claim's utility has fallen to half. */
const BID_RANGE = 120;

const EMPTY: RoleAllocation = {
  roles: new Map(),
  counts: { striker: 0, interceptor: 0, escort: 0, warden: 0, free: 0 },
};

/**
 * Memoised allocations. The function is PURE, so this is only a cost control —
 * every driver on a team recomputes the same allocation from the same shared
 * snapshot on the same tick, and the key carries everything the result depends on
 * (window, roster, flag state). Bounded because a long match would otherwise
 * accumulate one entry per window.
 */
const cache = new Map<string, RoleAllocation>();
const CACHE_LIMIT = 32;

/**
 * Team job board (D2) — who takes the flag, who kills the carrier, who screens
 * ours, who holds the base. A pure function of the SHARED snapshot: every driver
 * on the team computes the identical allocation from the identical input, which
 * is what lets bots divide work with no channel between them and keeps a replayed
 * seed byte-identical.
 *
 * Deliberately NOT a function of any per-bot state, including the caller's own
 * profile or RNG stream. A driver-local input would make each bot compute a
 * different board — every ship would believe it held the same job, which is the
 * behaviour the allocator exists to remove. Personality therefore does not enter
 * the CLAIM (a teammate's profile is not in the snapshot and cannot be, so no
 * driver could agree on it); it enters the role's URGENCY one layer down, where
 * each bot reads its own `ctfWeights`.
 *
 * Non-CTF snapshots have no flags, so every ship is `free` and the objective
 * layer never runs.
 */
export function allocateTeamRoles(snapshot: Snapshot, team: number): RoleAllocation {
  if (snapshot.flags.length === 0) return EMPTY;
  const own = snapshot.flags.find((flag) => flag.team === team);
  const enemy = snapshot.flags.find((flag) => flag.team !== team);
  if (!own || !enemy) return EMPTY;

  const members: ShipSnapshot[] = [];
  for (const ship of snapshot.ships) {
    // A respawning hull is still in the snapshot; it cannot hold a claim.
    if (ship.team === team && ship.hull > 0) members.push(ship);
  }
  if (members.length === 0) return EMPTY;
  members.sort((a, b) => a.id - b.id);

  const key = `${team}|${Math.floor((snapshot.elapsed * 1000) / ROLE_WINDOW_MS)}`
    + `|${snapshot.flags.map((flag) => `${flag.team}:${flag.state}:${flag.carrierId ?? -1}`).join(",")}`
    + `|${members.map((ship) => ship.id).join(",")}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const allocation = allocate(snapshot, own, enemy, members);
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  cache.set(key, allocation);
  return allocation;
}

/** Drop every memoised allocation (tests that replay a match from tick zero). */
export function clearRoleAllocationCache(): void {
  cache.clear();
}

function allocate(
  snapshot: Snapshot,
  own: FlagSnapshot,
  enemy: FlagSnapshot,
  members: readonly ShipSnapshot[],
): RoleAllocation {
  const roles = new Map<EntityId, BotRole>();
  const pool = new Set<EntityId>(members.map((ship) => ship.id));
  const byId = new Map<EntityId, ShipSnapshot>(members.map((ship) => [ship.id, ship]));

  // A ship already holding the enemy flag IS the strike, and no other job can
  // outbid the thing it is carrying.
  const ourCarrier = enemy.carrierId !== null ? byId.get(enemy.carrierId) ?? null : null;
  if (ourCarrier) {
    roles.set(ourCarrier.id, "striker");
    pool.delete(ourCarrier.id);
  }

  const scale = members.length / BASELINE_TEAM;
  const quota = (count: number): number =>
    count <= 0 ? 0 : Math.min(members.length, Math.max(1, Math.round(count * scale)));

  const thief = own.state === "carried" && own.carrierId !== null
    ? snapshot.ships.find((ship) => ship.id === own.carrierId) ?? null
    : null;
  const recovering = own.state === "dropped";
  const flagTakeable = enemy.state !== "carried";

  // Claim order is the shipped objective ladder's precedence, now expressed once
  // for the team instead of ten times per bot: a loose flag of ours outranks
  // everything (nobody can score until it is home), then the carrier who has it,
  // then the screen for our own runner, then the run itself, and last the stand.
  // Guarding is deliberately the lowest claim — it is the rung a bot took only
  // when nothing else applied, and putting it any higher starves the attack on a
  // small team, where every quota rounds to one.
  const claims: { role: Exclude<BotRole, "free">; slots: number; target: { x: number; y: number; z: number }; fighter: boolean }[] = [];
  if (recovering) claims.push({ role: "warden", slots: Math.min(RECOVER_CAP, quota(WARDENS)), target: own.pos, fighter: false });
  if (ourCarrier) {
    const nearbyThreats = snapshot.ships.filter((ship) =>
      ship.team !== ourCarrier.team && ship.hull > 0 && dist3(ship.pos, ourCarrier.pos) <= 140
    ).length;
    const overwhelmed = nearbyThreats >= 4
      || (nearbyThreats >= 3 && ourCarrier.hullMax > 0 && ourCarrier.hull / ourCarrier.hullMax <= 0.6);
    claims.push({
      role: "escort",
      slots: Math.min(members.length - 1, overwhelmed ? 3 : 2),
      target: ourCarrier.pos,
      fighter: true,
    });
  }
  if (thief) claims.push({ role: "interceptor", slots: quota(INTERCEPTORS), target: thief.pos, fighter: true });
  if (flagTakeable) {
    const press = own.state === "home" && enemy.state === "home";
    // A 5v5 needs four ships arriving together across the enlarged lunar-rift
    // lanes. Scaling the ten-ship rally quota down to two left each pickup in
    // the enemy crater with no nearby screen to inherit the escort claims.
    const strikeSlots = press ? Math.min(members.length, Math.max(4, quota(RALLY_STRIKERS))) : quota(STRIKERS);
    claims.push({ role: "striker", slots: strikeSlots, target: enemy.pos, fighter: true });
  }
  if (!recovering) claims.push({ role: "warden", slots: quota(WARDENS), target: own.home, fighter: false });

  for (const claim of claims) {
    if (claim.slots <= 0) continue;
    const bids = [...pool]
      .map((id) => ({ id, bid: bidFor(byId.get(id)!, claim.target, claim.fighter) }))
      // Highest bid wins; equal bids resolve by entity id, which every driver
      // orders the same way. No RNG anywhere: a coin flip here would allocate
      // differently per stream and split the team's board.
      .sort((a, b) => b.bid - a.bid || a.id - b.id);
    for (const { id } of bids.slice(0, claim.slots)) {
      roles.set(id, claim.role);
      pool.delete(id);
    }
  }

  const counts: Record<BotRole, number> = { striker: 0, interceptor: 0, escort: 0, warden: 0, free: pool.size };
  for (const role of roles.values()) counts[role] += 1;
  return { roles, counts };
}

/**
 * Utility of one ship for one claim: proximity to the job, and — for the claims
 * that end in a fight — how much hull it still has to spend there. Both are read
 * straight off the shared snapshot, so every driver computes the same number.
 */
function bidFor(ship: ShipSnapshot, target: { x: number; y: number; z: number }, fighter: boolean): number {
  const reach = 1 / (1 + dist3(ship.pos, target) / BID_RANGE);
  if (!fighter) return reach;
  const hull = ship.hullMax > 0 ? ship.hull / ship.hullMax : 0;
  return reach * (0.5 + 0.5 * hull);
}
