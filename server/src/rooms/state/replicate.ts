import {
  encodeCenti,
  encodeFlagState,
  encodeHeading,
  encodeModuleState,
  encodePitch,
  encodeUnit,
  type AsteroidTag,
  type EntityId,
  type ShipSnapshot,
  type Snapshot,
} from "@space-arena/shared";
import {
  ArenaState, PlayerState, ProjectileState, ModuleState,
  DecoyState, FlagState, TeamScoreState,
} from "./ArenaState.js";

/**
 * Sim snapshot → replicated schema state. The whole write side of the wire
 * protocol, and nothing else.
 *
 * ## Why this is not a method on `ArenaRoom`
 *
 * It used to be, and it did not belong there. Every line below is a pure
 * function of `(snapshot, current state)`: no `Client`, no timer, no
 * `this.clock`, no lifecycle. Sitting in the room it was ~170 lines of the
 * repo's single largest file that could only ever be exercised by booting a
 * Colyseus server, standing up a database, connecting a websocket and ticking a
 * real match — which is why the encode side of the protocol had no direct test
 * at all, and why the client's decoders were tested against hand-written wire
 * literals that nothing kept in sync with the writer.
 *
 * As a free function next to the schema it declares against, the writer and the
 * client's real decoder can meet in one process. That is what
 * `replicate.test.ts` does, and it is the only place drift between the two
 * halves of the protocol can actually be caught.
 *
 * ## Write-on-change
 *
 * Almost every assignment here is guarded by an inequality. Since
 * @colyseus/schema 3.x this is a micro-optimization, not a correctness rule:
 * the generated property setter itself skips identical primitive values
 * (`if (value === previousValue) return` in the schema build), so an unguarded
 * `state.x = x` no longer dirties the field — the guards merely save a setter
 * invocation on the hot path. They are kept because the mirror runs per tick
 * for every field of every entity, and because `Math.fround` on the up-axis is
 * still load-bearing: comparing the 64-bit sim value against the stored number
 * without rounding would defeat the equality check for sub-float32 jitter that
 * cannot change the wire value anyway. The unguarded writes below (decoys,
 * flags) are equally safe for the same reason.
 */

/**
 * Mirror one ship snapshot onto its `PlayerState`.
 *
 * Also the join path's full write: a client that connects between ticks has a
 * `PlayerState` full of schema defaults until the next `applySnapshot`, so
 * `ArenaRoom` calls this directly at join to make the very first patch carry a
 * real position and fitting rather than an origin-parked hull.
 */
export function applyShipSnapshot(ps: PlayerState, ship: ShipSnapshot): void {
  if (!ps.alive) ps.alive = true;
  const qx = encodeCenti(ship.pos.x);
  const qy = encodeCenti(ship.pos.y);
  const qz = encodeCenti(ship.pos.z);
  const qh = encodeHeading(ship.heading);
  const qp = encodePitch(ship.pitch);
  // The up axis rides as float32 — round through Math.fround for the dirty
  // check, or the stored 32-bit value never equals the 64-bit sim value and
  // every field would be re-sent on every patch.
  const qux = Math.fround(ship.up.x);
  const quy = Math.fround(ship.up.y);
  const quz = Math.fround(ship.up.z);
  if (ps.x !== qx) ps.x = qx;
  if (ps.y !== qy) ps.y = qy;
  if (ps.z !== qz) ps.z = qz;
  if (ps.heading !== qh) ps.heading = qh;
  if (ps.pitch !== qp) ps.pitch = qp;
  if (ps.upX !== qux) ps.upX = qux;
  if (ps.upY !== quy) ps.upY = quy;
  if (ps.upZ !== quz) ps.upZ = quz;
  // Velocity, on the same int16 deci-unit codec as the position triple (see
  // PlayerState.vx). A snapshot with no `velocity` at all replicates zeroes
  // rather than stale values — the client's decoder treats a zero-vector as
  // "no usable velocity" and falls back to finite differences, which is the
  // pre-velocity behaviour and always safe.
  const vel = ship.velocity;
  const qvx = vel ? encodeCenti(vel.x) : 0;
  const qvy = vel ? encodeCenti(vel.y) : 0;
  const qvz = vel ? encodeCenti(vel.z) : 0;
  if (ps.vx !== qvx) ps.vx = qvx;
  if (ps.vy !== qvy) ps.vy = qvy;
  if (ps.vz !== qvz) ps.vz = qvz;
  if (ps.hull !== ship.hull) ps.hull = ship.hull;
  // Resolved maxima (ship class + upgrades + module passives): the sim already
  // resolved these into the snapshot at spawn, so mirror them straight through.
  if (ps.hullMax !== ship.hullMax) ps.hullMax = ship.hullMax;

  // Flight + sensor state (FLIGHT.md §5). `throttle` and `lockProgress` are
  // already normalized 0..1 in the snapshot, so they quantize through the same
  // `encodeUnit` the client decodes with — no per-field scaling anywhere else.
  const qThrottle = encodeUnit(ship.throttle);
  const qLock = encodeUnit(ship.lockProgress);
  if (ps.throttle !== qThrottle) ps.throttle = qThrottle;
  // Tenths of a second, saturating: the pad hold is 3 s, far under the cap.
  const qHold = Math.min(255, Math.round((ship.launchHold ?? 0) * 10));
  if (ps.launchHold !== qHold) ps.launchHold = qHold;
  const launchLocked = ship.launchLocked ?? false;
  if (ps.launchLocked !== launchLocked) ps.launchLocked = launchLocked;
  if (ps.lockProgress !== qLock) ps.lockProgress = qLock;
  if (ps.locked !== ship.locked) ps.locked = ship.locked;
  // Slowing-ray strength, on the same unit codec (2026-08-22). Absent means
  // "flying free", which is the same thing as 0.
  const qSlow = encodeUnit(ship.slowFactor ?? 0);
  if (ps.slowFactor !== qSlow) ps.slowFactor = qSlow;
  const targetId = ship.targetId ?? -1;
  if (ps.targetId !== targetId) ps.targetId = targetId;

  let shieldPool = 0;
  for (let i = 0; i < ship.modules.length; i++) {
    const m = ship.modules[i]!;
    shieldPool += m.shieldPool;
    const target = ps.modules[i];
    if (!target) {
      const ms = new ModuleState();
      ms.moduleId = m.moduleId;
      ms.hardpointIndex = m.hardpointIndex;
      ms.state = encodeModuleState(m.state);
      ms.stateTimer = m.stateTimer;
      ms.rounds = m.rounds ?? 0;
      ms.energy = m.energy;
      ms.energyCapacity = m.energyCapacity;
      ms.cycleTimer = m.cycleTimer;
      ms.channeling = m.channeling;
      ms.shieldPool = m.shieldPool;
      ps.modules.push(ms);
      continue;
    }
    if (target.moduleId !== m.moduleId) target.moduleId = m.moduleId;
    if (target.hardpointIndex !== m.hardpointIndex) target.hardpointIndex = m.hardpointIndex;
    const code = encodeModuleState(m.state);
    if (target.state !== code) target.state = code;
    if (target.stateTimer !== m.stateTimer) target.stateTimer = m.stateTimer;
    if (target.rounds !== (m.rounds ?? 0)) target.rounds = m.rounds ?? 0;
    if (target.energy !== m.energy) target.energy = m.energy;
    if (target.energyCapacity !== m.energyCapacity) target.energyCapacity = m.energyCapacity;
    if (target.cycleTimer !== m.cycleTimer) target.cycleTimer = m.cycleTimer;
    if (target.channeling !== m.channeling) target.channeling = m.channeling;
    if (target.shieldPool !== m.shieldPool) target.shieldPool = m.shieldPool;
  }
  if (ps.shieldPool !== shieldPool) ps.shieldPool = shieldPool;
}

/**
 * Full ship write for one entity, used at join before the first tick.
 *
 * Takes the `PlayerState` rather than the `ArenaState` + key because both
 * callers have just built and inserted it; the snapshot is passed in for the
 * same reason `applySnapshot` takes one — nothing in this module may reach for
 * a simulation.
 */
export function syncShipState(snap: Snapshot, entityId: EntityId, ps: PlayerState): void {
  const ship = snap.ships.find((s) => s.id === entityId);
  if (ship) applyShipSnapshot(ps, ship);
}

/**
 * Mirror a whole sim snapshot onto the room's schema state.
 *
 * The extra arguments are the identity mappings the snapshot does not carry:
 *
 *  - `entityToKey` — sim entity id → the schema map key (a session id for a
 *    human, a synthetic `bot-*` key otherwise). Snapshots talk in entity ids;
 *    `state.players` is keyed by client, and only the room knows the join.
 *  - `asteroidEntityIds` — the arena's rocks in PLACEMENT ORDER. The schema map
 *    is keyed by placement index (that is the identity a client can share, since
 *    entity ids are allocated per-World and a client never sees them), so the
 *    array position IS the key.
 *  - `asteroidTags` — the live `world.asteroids` map, keyed by entity id, which
 *    is what turns a placement index back into a rock's intact/destroyed state.
 */
export function applySnapshot(
  state: ArenaState,
  snap: Snapshot,
  entityToKey: ReadonlyMap<EntityId, string>,
  asteroidEntityIds: readonly EntityId[],
  asteroidTags: ReadonlyMap<EntityId, AsteroidTag>,
): void {
  // Match clock and scoreboard. These are MIRRORS of the sim, not second
  // timers — they used to sit inline in `ArenaRoom.update()` right after the
  // ship write, which meant a third of the replicated `ArenaState` was written
  // somewhere the replication test could not reach. `matchPhase`, `winnerTeam`
  // and `lobbyRemainingSec` stay with the room on purpose: those are room
  // LIFECYCLE, decided by joins and the grace timer, not read off a snapshot.
  state.matchTimer = snap.elapsed;
  if (state.countdownRemaining !== snap.countdownRemaining) {
    state.countdownRemaining = snap.countdownRemaining;
  }
  for (const { team, kills, captures } of snap.teamScores) {
    const key = String(team);
    let score = state.teamScores.get(key);
    if (!score) {
      score = new TeamScoreState();
      state.teamScores.set(key, score);
    }
    if (score.kills !== kills) score.kills = kills;
    if (score.captures !== captures) score.captures = captures;
  }

  // Ships (players + bots).
  for (const ship of snap.ships) {
    const key = entityToKey.get(ship.id);
    if (!key) continue;
    const ps = state.players.get(key);
    if (!ps) continue;
    applyShipSnapshot(ps, ship);
  }

  // Missiles only (beams/kinetics are events).
  const liveMissiles = new Set<string>();
  for (const p of snap.projectiles) {
    if (p.kind !== "missile") continue;
    const pk = String(p.id);
    liveMissiles.add(pk);
    let proj = state.projectiles.get(pk);
    if (!proj) {
      proj = new ProjectileState();
      proj.entityId = p.id;
      state.projectiles.set(pk, proj);
    }
    const qx = encodeCenti(p.pos.x);
    const qy = encodeCenti(p.pos.y);
    const qz = encodeCenti(p.pos.z);
    const qh = encodeHeading(p.heading);
    if (proj.x !== qx) proj.x = qx;
    if (proj.y !== qy) proj.y = qy;
    if (proj.z !== qz) proj.z = qz;
    if (proj.heading !== qh) proj.heading = qh;
  }
  for (const pk of [...state.projectiles.keys()]) {
    if (!liveMissiles.has(pk)) state.projectiles.delete(pk);
  }

  const liveDecoys = new Set<string>();
  for (const d of snap.decoys) {
    const key = String(d.id);
    liveDecoys.add(key);
    let decoy = state.decoys.get(key);
    if (!decoy) {
      decoy = new DecoyState();
      decoy.entityId = d.id;
      state.decoys.set(key, decoy);
    }
    decoy.team = d.team;
    decoy.x = encodeCenti(d.pos.x);
    decoy.y = encodeCenti(d.pos.y);
    decoy.z = encodeCenti(d.pos.z);
    decoy.radius = d.radius;
    decoy.lifeFraction = d.lifeFraction;
  }
  for (const key of [...state.decoys.keys()]) if (!liveDecoys.has(key)) state.decoys.delete(key);

  const liveFlags = new Set<string>();
  for (const f of snap.flags) {
    const key = String(f.id);
    liveFlags.add(key);
    let flag = state.flags.get(key);
    if (!flag) {
      flag = new FlagState();
      flag.entityId = f.id;
      state.flags.set(key, flag);
    }
    flag.team = f.team;
    flag.state = encodeFlagState(f.state);
    flag.x = encodeCenti(f.pos.x);
    flag.y = encodeCenti(f.pos.y);
    flag.z = encodeCenti(f.pos.z);
    flag.carrierEntityId = f.carrierId ?? -1;
    flag.dropRemaining = f.dropRemaining;
  }
  for (const key of [...state.flags.keys()]) if (!liveFlags.has(key)) state.flags.delete(key);

  // Asteroids: the destroyed flag and nothing else. Remaining `hp` used to ride
  // along; no client ever decoded it, so protocol 7 dropped the field.
  asteroidEntityIds.forEach((id, i) => {
    const tag = asteroidTags.get(id);
    if (!tag) return;
    const a = state.asteroids.get(String(i));
    if (!a) return;
    const destroyed = tag.state === "destroyed";
    if (a.destroyed !== destroyed) a.destroyed = destroyed;
  });
}
