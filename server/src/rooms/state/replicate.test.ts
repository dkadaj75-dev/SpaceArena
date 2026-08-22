import { beforeAll, describe, expect, it } from "vitest";
import {
  ArenaSimulation,
  FlagTrailAccumulator,
  applySlow,
  decodeSnapshot,
  setGlobalLogLevel,
  type ArenaConfig,
  type ConfigService,
  type EntityId,
  type Snapshot,
  type TuningConfig,
} from "@space-arena/shared";
import { loadContent } from "../../configService.js";
import { ArenaState, AsteroidState, ModuleState, PlayerState } from "./ArenaState.js";
import { applySnapshot } from "./replicate.js";

setGlobalLogLevel("error");

/**
 * The wire ROUND TRIP: sim snapshot → real replication writer → real
 * `ArenaState` → real client decoder → snapshot again.
 *
 * ## Why this test is the point of `replicate.ts`
 *
 * Before it, the two halves of the wire protocol were only ever exercised
 * apart. `ArenaRoom.test.ts` booted a server and read a handful of schema
 * fields; `replicatedObjectives.test.ts` fed the client's decoders wire
 * literals typed out BY HAND. Nothing anywhere ran the encoder's output through
 * the decoder, so every kind of drift between them — a rename, a dropped
 * writer, a unit mismatch, a field encoded with the wrong codec — was invisible
 * to CI and visible only in a browser.
 *
 * The three imports at the top are the whole design: the real `ArenaState`, the
 * real `applySnapshot`, and the real decoder the client runs. The decoders live
 * in `shared` precisely so this file can import them; see the header of
 * `shared/src/net/decodeState.ts`.
 *
 * ## What "field-for-field" means here
 *
 * Every replicated value is compared against the sim value it came from, within
 * the tolerance of its own codec (positions are int16 deci-units, headings
 * uint16 over a full turn, throttle/lock uint8 over 0..1, floats are float32).
 * A field the wire deliberately DROPS is asserted absent rather than skipped —
 * `colliderRadius` and `sensorRange` are not sent, and a decoder that started
 * inventing them would be just as wrong as one that lost a field. (`velocity`
 * used to be in that list; it has been replicated since 2026-08-18 and is now
 * compared against the sim like any other field.)
 *
 * This is the half of the drift problem the field-name contract in
 * `shared/src/net/wireFields.ts` cannot see: names still line up perfectly when
 * a WRITER is deleted, and the decoder's `?? 0` swallows it. Here the value
 * simply stops matching.
 */

const ARENA_ID = "arena.lunar-rift";
/** The CTF gamemode's default arena has no rocks at all; this one has 82. */
const ROCKY_ARENA_ID = "arena.ring-nebula";
const GAMEMODE_ID = "gamemode.practice-ctf-5v5";
/** Stock interceptor loadout with the JETTISONABLE sink, so decoys are reachable. */
const FITTING = [
  "module.laser-mk1",
  "module.missile-mk1",
  "module.engine-earth-eng1",
  "module.generator-earth-eng1",
  "module.alloy-earth-p1",
  "module.countermeasure-chaff",
  "module.sensors-common-mk1",
];

/** Position codec is int16 deci-units → half a decimetre of slack. */
const POS_TOL = 0.05;
/** uint16 over a full turn. */
const ANGLE_TOL = 1e-4;
/** uint8 over 0..1. */
const UNIT_TOL = 1 / 255;
/** float32 store + a re-orthonormalization against quantized heading/pitch. */
const UP_TOL = 1e-3;

let configs: ConfigService;
let arena: ArenaConfig;
let rockyArena: ArenaConfig;

beforeAll(async () => {
  configs = await loadContent();
  // The shipped pack opens with a frozen 3 s countdown, during which the sim
  // integrates nothing. This suite wants ships that have actually flown, so it
  // runs on a pack that starts instantly — 0 is a legal authored value and goes
  // through the same schema validation as any other.
  const tuning = configs.getAll<TuningConfig>("tuning")[0]!;
  const replaced = configs.replace({ ...tuning, matchCountdownSec: 0 });
  if (!replaced.ok) throw new Error("failed to zero matchCountdownSec for tests");
  arena = configs.get<ArenaConfig>("arena", ARENA_ID)!;
  rockyArena = configs.get<ArenaConfig>("arena", ROCKY_ARENA_ID)!;
});

/** Everything `ArenaRoom` owns that `applySnapshot` needs handed to it. */
interface Room {
  sim: ArenaSimulation;
  state: ArenaState;
  entityToKey: Map<EntityId, string>;
  asteroidEntityIds: EntityId[];
  arena: ArenaConfig;
}

/** Stand up a room's state exactly the way `ArenaRoom.onCreate` does. */
function createRoom(arenaId = ARENA_ID, seed = 4242): Room {
  const sim = new ArenaSimulation(configs, arenaId, GAMEMODE_ID, seed);
  const state = new ArenaState();
  state.matchPhase = "live";
  const asteroidEntityIds = sim.world.asteroidIds();
  asteroidEntityIds.forEach((id, i) => {
    const tag = sim.world.asteroids.get(id)!;
    const a = new AsteroidState();
    a.destroyed = tag.state === "destroyed";
    state.asteroids.set(String(i), a);
  });
  return {
    sim,
    state,
    entityToKey: new Map(),
    asteroidEntityIds,
    arena: arenaId === ROCKY_ARENA_ID ? rockyArena : arena,
  };
}

/** Spawn a ship and give it a roster row, exactly the way `ArenaRoom.onJoin` does. */
function join(room: Room, key: string, team: number, pos: { x: number; y: number; z: number }): EntityId {
  const entityId = room.sim.spawnPlayerAt("ship.interceptor", FITTING, team, pos, 0.7, undefined, -0.3);
  const ps = new PlayerState();
  ps.entityId = entityId;
  ps.team = team;
  ps.shipId = "ship.interceptor";
  ps.displayName = key;
  // Paint is a JOIN-time static, resolved by the room and never touched again by
  // `applySnapshot` — mirrored here from the sim's own spawn record so the ship
  // comparison covers it the same way the room's join path would.
  ps.cosmeticId = room.sim.snapshot().ships.find((s) => s.id === entityId)?.cosmeticId ?? "";
  for (let i = 0; i < FITTING.length; i++) ps.modules.push(new ModuleState());
  room.state.players.set(key, ps);
  room.entityToKey.set(entityId, key);
  return entityId;
}

/** Write `snap` through the real replication path and read it back with the real decoder. */
function roundTrip(room: Room, snap: Snapshot): Snapshot {
  applySnapshot(room.state, snap, room.entityToKey, room.asteroidEntityIds, room.sim.world.asteroids);
  return decodeSnapshot(room.state, {
    arena: room.arena,
    // Rocks are rebuilt from the arena config client-side and are not part of
    // the wire payload; the asteroid assertions below read `state.asteroids`
    // (`destroyed`) directly, which IS everything the wire carries for them.
    asteroids: [],
    trails: new FlagTrailAccumulator(),
    trailLength: 0,
  });
}

describe("replication round trip", () => {
  it("carries every replicated ship field through the schema unchanged", () => {
    const room = createRoom();
    const a = join(room, "session-a", 0, { x: 40, y: 6, z: -25 });
    join(room, "session-b", 1, { x: -30, y: -4, z: 55 });
    // Fly, so nothing under test is comparing zero to zero: throttle, heading,
    // pitch, the up axis and the module timers all have to be moving for a
    // dropped writer to be distinguishable from a correct one.
    room.sim.applyOrder(a, { kind: "flight", throttle: 1, turn: 0.6, pitchStick: -0.4, boost: false, fire: true });
    for (let i = 0; i < 20; i++) room.sim.tick(1 / 30);

    const snap = room.sim.snapshot();
    const decoded = roundTrip(room, snap);

    expect(decoded.ships).toHaveLength(snap.ships.length);
    // The velocity assertions below are conditional on a ship actually moving,
    // so pin that at least one does — otherwise a dropped velocity writer could
    // pass this suite by taking every branch that asserts absence.
    expect(decoded.ships.some((s) => s.velocity !== undefined)).toBe(true);
    for (const ship of snap.ships) {
      const got = decoded.ships.find((s) => s.id === ship.id);
      expect(got, `ship ${ship.id} missing from the decoded snapshot`).toBeDefined();
      if (!got) continue;
      expect(got.team).toBe(ship.team);
      expect(got.pos.x).toBeCloseTo(ship.pos.x, 1);
      expect(Math.abs(got.pos.y - ship.pos.y)).toBeLessThanOrEqual(POS_TOL);
      expect(Math.abs(got.pos.z - ship.pos.z)).toBeLessThanOrEqual(POS_TOL);
      // Heading is folded into 0..2π by its codec; the sim's value is not.
      const heading = ((ship.heading % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      expect(Math.abs(got.heading - heading)).toBeLessThanOrEqual(ANGLE_TOL);
      expect(Math.abs(got.pitch - ship.pitch)).toBeLessThanOrEqual(ANGLE_TOL);
      expect(Math.abs(got.up.x - ship.up.x)).toBeLessThanOrEqual(UP_TOL);
      expect(Math.abs(got.up.y - ship.up.y)).toBeLessThanOrEqual(UP_TOL);
      expect(Math.abs(got.up.z - ship.up.z)).toBeLessThanOrEqual(UP_TOL);
      expect(got.hull).toBeCloseTo(ship.hull, 3);
      expect(got.hullMax).toBeCloseTo(ship.hullMax, 3);
      expect(Math.abs(got.throttle - ship.throttle)).toBeLessThanOrEqual(UNIT_TOL);
      expect(Math.abs(got.lockProgress - ship.lockProgress)).toBeLessThanOrEqual(UNIT_TOL);
      expect(got.locked).toBe(ship.locked);
      expect(Math.abs((got.slowFactor ?? 0) - (ship.slowFactor ?? 0))).toBeLessThanOrEqual(UNIT_TOL);
      expect(got.targetId).toBe(ship.targetId ?? null);
      expect(got.cosmeticId).toBe(ship.cosmeticId === "" ? undefined : ship.cosmeticId);
      // Velocity IS replicated as of 2026-08-18 (three int16 deci-unit fields,
      // same codec as `pos`) — the client's interpolation tangents, its bounded
      // dead reckoning and the HUD speed readout all read it.
      //
      // A ship that has not been ordered anywhere is genuinely at rest, and the
      // decoder reports an all-zero triple as ABSENT on purpose (a pre-velocity
      // server sends nothing, and "no velocity" must not decode as a confident
      // standstill). So the two cases are asserted separately rather than
      // asserting `toBeDefined()` on a parked hull.
      const simSpeed = Math.hypot(ship.velocity!.x, ship.velocity!.y, ship.velocity!.z);
      if (simSpeed > POS_TOL) {
        expect(got.velocity, `moving ship ${ship.id} lost its replicated velocity`).toBeDefined();
        expect(Math.abs(got.velocity!.x - ship.velocity!.x)).toBeLessThanOrEqual(POS_TOL);
        expect(Math.abs(got.velocity!.y - ship.velocity!.y)).toBeLessThanOrEqual(POS_TOL);
        expect(Math.abs(got.velocity!.z - ship.velocity!.z)).toBeLessThanOrEqual(POS_TOL);
      } else {
        expect(got.velocity).toBeUndefined();
      }
      // Fields the wire still deliberately drops. Asserted absent, not skipped:
      // a decoder that started synthesizing them would be silently wrong.
      expect(got.colliderRadius).toBeUndefined();
      expect(got.sensorRange).toBeUndefined();
    }
  });

  it("carries a live slowing-ray effect to the clients (owner 2026-08-22)", () => {
    // Its own test rather than a line in the sweep above, because the sweep
    // flies a clean match where nothing is slowed — and a field that only ever
    // replicates 0 would pass that sweep with no writer at all.
    const room = createRoom();
    const a = join(room, "session-a", 0, { x: 40, y: 6, z: -25 });
    applySlow(room.sim.world, a, 0.35, 4, null);

    const snap = room.sim.snapshot();
    const decoded = roundTrip(room, snap);
    const got = decoded.ships.find((s) => s.id === a)!;
    expect(got.slowFactor).toBeGreaterThan(0);
    expect(Math.abs(got.slowFactor! - 0.35)).toBeLessThanOrEqual(UNIT_TOL);
  });

  it("carries every replicated module field, by hardpoint and not by array slot", () => {
    const room = createRoom();
    const a = join(room, "session-a", 0, { x: 12, y: 0, z: 0 });
    join(room, "session-b", 1, { x: -12, y: 0, z: 0 });
    room.sim.applyOrder(a, { kind: "flight", throttle: 1, turn: 0, pitchStick: 0, boost: false, fire: true });
    for (let i = 0; i < 30; i++) room.sim.tick(1 / 30);

    // Every per-module store gets a DISTINCT non-zero value before the
    // snapshot. Without this most of them are 0 in a fresh match, and 0 === 0
    // passes just as happily when a writer has been deleted as when it works —
    // the whole point of a round trip is that a dropped field has to show.
    // (`shieldPool` is not settable here: the snapshot derives it from `energy`
    // for modules that absorb, so `absorbs` is what makes it non-zero.)
    const runtime = room.sim.world.modules.get(a)!.modules;
    runtime.forEach((m, i) => {
      m.energy = 11 + i;
      m.stateTimer = 0.25 + i * 0.1;
      m.cycleTimer = 0.5 + i * 0.1;
      m.rounds = 2 + i;
      m.absorbs = i === 1;
      m.channeling = i === 0;
    });
    expect(room.sim.snapshot().ships.find((s) => s.id === a)!.modules[1]!.shieldPool).toBeGreaterThan(0);

    const snap = room.sim.snapshot();
    const decoded = roundTrip(room, snap);
    const ship = snap.ships.find((s) => s.id === a)!;
    const got = decoded.ships.find((s) => s.id === a)!;

    expect(got.modules).toHaveLength(ship.modules.length);
    expect(ship.modules.length).toBeGreaterThan(1);
    for (const m of ship.modules) {
      const mod = got.modules.find((x) => x.hardpointIndex === m.hardpointIndex);
      expect(mod, `hardpoint ${m.hardpointIndex} missing from the decoded modules`).toBeDefined();
      if (!mod) continue;
      expect(mod.moduleId).toBe(m.moduleId);
      expect(mod.state).toBe(m.state);
      expect(mod.rounds).toBe(m.rounds ?? 0);
      expect(mod.energy).toBeCloseTo(m.energy, 3);
      expect(mod.energyCapacity).toBeCloseTo(m.energyCapacity, 3);
      expect(mod.stateTimer).toBeCloseTo(m.stateTimer, 3);
      expect(mod.cycleTimer).toBeCloseTo(m.cycleTimer, 3);
      expect(mod.channeling).toBe(m.channeling);
      expect(mod.shieldPool).toBeCloseTo(m.shieldPool, 3);
    }
  });

  it("carries the match clock and the per-team scoreboard", () => {
    const room = createRoom();
    join(room, "session-a", 0, { x: 12, y: 0, z: 0 });
    join(room, "session-b", 1, { x: -12, y: 0, z: 0 });
    for (let i = 0; i < 12; i++) room.sim.tick(1 / 30);

    const snap = room.sim.snapshot();
    const decoded = roundTrip(room, snap);

    expect(decoded.elapsed).toBeCloseTo(snap.elapsed, 3);
    expect(decoded.tick).toBe(Math.round(snap.elapsed * 30));
    expect(decoded.countdownRemaining).toBeCloseTo(snap.countdownRemaining, 3);
    expect(decoded.phase).toBe("live");
    expect(decoded.teamScores).toEqual(snap.teamScores);
    expect(decoded.teamScores.length).toBeGreaterThan(0);
  });

  it("carries a jettisoned decoy, a flag mid-run and a missile", () => {
    const room = createRoom();
    const a = join(room, "session-a", 0, { x: 12, y: 0, z: 0 });
    join(room, "session-b", 1, { x: -12, y: 0, z: 0 });
    for (let i = 0; i < 4; i++) room.sim.tick(1 / 30);

    // A real decoy from the real system: the sink is fitted, so the order that
    // the HUD's jettison button sends produces one.
    room.sim.applyOrder(a, { kind: "jettisonCountermeasure" });
    // Put the same ship on the ENEMY flag so it takes it — that exercises
    // `state`, `carrierEntityId` and a non-home position in one move.
    const enemyFlagId = room.sim.world.flagIds().find((id) => room.sim.world.flags.get(id)!.team === 1)!;
    const flagPos = room.sim.world.transforms.get(enemyFlagId)!.pos;
    const shipTf = room.sim.world.transforms.get(a)!;
    shipTf.pos.x = flagPos.x;
    shipTf.pos.y = flagPos.y;
    shipTf.pos.z = flagPos.z;
    room.sim.tick(1 / 30);

    const snap = room.sim.snapshot();
    expect(snap.decoys).toHaveLength(1);
    expect(snap.flags.find((f) => f.id === enemyFlagId)?.state).toBe("carried");

    // Missiles are the only schema-replicated projectile, and getting the sim to
    // launch one takes a lock, a range and a live target. The ENCODER is what is
    // under test here, so the entity is placed on the snapshot directly — the
    // writer, the schema and the decoder are all still the real ones.
    snap.projectiles.push({
      id: 90001,
      kind: "missile",
      pos: { x: -8.3, y: 2.5, z: 14.1 },
      heading: 2.25,
      velocity: { x: 1, y: 0, z: 0 },
    });

    const decoded = roundTrip(room, snap);

    expect(decoded.decoys).toHaveLength(1);
    const decoy = decoded.decoys[0]!;
    const simDecoy = snap.decoys[0]!;
    expect(decoy.id).toBe(simDecoy.id);
    expect(decoy.team).toBe(simDecoy.team);
    expect(Math.abs(decoy.pos.x - simDecoy.pos.x)).toBeLessThanOrEqual(POS_TOL);
    expect(Math.abs(decoy.pos.y - simDecoy.pos.y)).toBeLessThanOrEqual(POS_TOL);
    expect(Math.abs(decoy.pos.z - simDecoy.pos.z)).toBeLessThanOrEqual(POS_TOL);
    expect(decoy.radius).toBeCloseTo(simDecoy.radius, 3);
    expect(decoy.lifeFraction).toBeCloseTo(simDecoy.lifeFraction, 3);

    expect(decoded.flags).toHaveLength(snap.flags.length);
    for (const flag of snap.flags) {
      const got = decoded.flags.find((f) => f.id === flag.id)!;
      expect(got.team).toBe(flag.team);
      expect(got.state).toBe(flag.state);
      expect(got.carrierId).toBe(flag.carrierId);
      expect(Math.abs(got.pos.x - flag.pos.x)).toBeLessThanOrEqual(POS_TOL);
      expect(Math.abs(got.pos.y - flag.pos.y)).toBeLessThanOrEqual(POS_TOL);
      expect(Math.abs(got.pos.z - flag.pos.z)).toBeLessThanOrEqual(POS_TOL);
      expect(got.dropRemaining).toBeCloseTo(flag.dropRemaining, 3);
      // `home` and `baseRadius` never travel: the client joins them from the
      // same arena config the server built the flag from.
      expect(got.home.x).toBeCloseTo(flag.home.x, 3);
      expect(got.baseRadius).toBeCloseTo(flag.baseRadius, 3);
    }

    const missile = decoded.projectiles.find((p) => p.id === 90001)!;
    expect(missile.kind).toBe("missile");
    expect(Math.abs(missile.pos.x - -8.3)).toBeLessThanOrEqual(POS_TOL);
    expect(Math.abs(missile.pos.y - 2.5)).toBeLessThanOrEqual(POS_TOL);
    expect(Math.abs(missile.pos.z - 14.1)).toBeLessThanOrEqual(POS_TOL);
    expect(Math.abs(missile.heading - 2.25)).toBeLessThanOrEqual(ANGLE_TOL);
    expect(missile.velocity).toBeUndefined();
  });

  it("replicates a flag's return timer while it is loose, not just its state code", () => {
    // The regression the field-name contract cannot catch on its own: renaming
    // or dropping the `dropRemaining` writer leaves the decoder reading its
    // `?? 0` fallback, and every dropped flag shows a 0-second timer.
    const room = createRoom();
    join(room, "session-a", 0, { x: 12, y: 0, z: 0 });
    join(room, "session-b", 1, { x: -12, y: 0, z: 0 });
    room.sim.tick(1 / 30);

    const enemyFlagId = room.sim.world.flagIds().find((id) => room.sim.world.flags.get(id)!.team === 1)!;
    const flag = room.sim.world.flags.get(enemyFlagId)!;
    flag.state = "dropped";
    flag.carrierId = null;
    flag.dropTimer = 7.5;
    room.sim.tick(1 / 30);

    const snap = room.sim.snapshot();
    const simFlag = snap.flags.find((f) => f.id === enemyFlagId)!;
    expect(simFlag.state).toBe("dropped");
    expect(simFlag.dropRemaining).toBeGreaterThan(0);

    const got = roundTrip(room, snap).flags.find((f) => f.id === enemyFlagId)!;
    expect(got.state).toBe("dropped");
    expect(got.dropRemaining).toBeCloseTo(simFlag.dropRemaining, 3);
    expect(got.carrierId).toBeNull();
  });

  it("replicates asteroid destruction, and prunes entities the sim dropped", () => {
    const room = createRoom(ROCKY_ARENA_ID);
    join(room, "session-a", 0, { x: 12, y: 0, z: 0 });
    room.sim.tick(1 / 30);
    expect(room.asteroidEntityIds.length).toBeGreaterThan(0);

    // The state is read from the live world map rather than the snapshot, and
    // keyed by PLACEMENT INDEX — the only rock identity a client can share.
    const index = 0;
    const rockId = room.asteroidEntityIds[index]!;
    const rock = room.sim.world.asteroids.get(rockId)!;
    rock.hp = 3.5;

    let snap = room.sim.snapshot();
    applySnapshot(room.state, snap, room.entityToKey, room.asteroidEntityIds, room.sim.world.asteroids);
    // A damaged-but-intact rock replicates as intact: remaining hp is a
    // server-side number that no client decodes (protocol 7 deleted the field).
    expect(room.state.asteroids.get(String(index))!.destroyed).toBe(false);

    rock.hp = 0;
    rock.state = "destroyed";
    snap = room.sim.snapshot();
    applySnapshot(room.state, snap, room.entityToKey, room.asteroidEntityIds, room.sim.world.asteroids);
    expect(room.state.asteroids.get(String(index))!.destroyed).toBe(true);

    // Entity pruning: a missile that stops being in the snapshot must leave the
    // schema map, or a client renders a frozen ghost for the rest of the match.
    snap.projectiles.push({ id: 77, kind: "missile", pos: { x: 1, y: 2, z: 3 }, heading: 0 });
    applySnapshot(room.state, snap, room.entityToKey, room.asteroidEntityIds, room.sim.world.asteroids);
    expect(room.state.projectiles.has("77")).toBe(true);
    snap.projectiles.length = 0;
    applySnapshot(room.state, snap, room.entityToKey, room.asteroidEntityIds, room.sim.world.asteroids);
    expect(room.state.projectiles.has("77")).toBe(false);
  });

  it("drops a dead player from the decoded snapshot but keeps its roster row", () => {
    const room = createRoom();
    const a = join(room, "session-a", 0, { x: 12, y: 0, z: 0 });
    join(room, "session-b", 1, { x: -12, y: 0, z: 0 });
    room.sim.tick(1 / 30);
    applySnapshot(room.state, room.sim.snapshot(), room.entityToKey, room.asteroidEntityIds, room.sim.world.asteroids);

    room.sim.world.shipCores.get(a)!.hull = 0;
    for (let i = 0; i < 2; i++) room.sim.tick(1 / 30);
    const snap = room.sim.snapshot();
    expect(snap.ships.find((s) => s.id === a)).toBeUndefined();

    // The room marks the row dead on `entityDestroyed`; the roster entry itself
    // survives so the scoreboard keeps the name through the respawn gap. The
    // decoder is what has to drop it from the render/sim snapshot — and
    // `applyShipSnapshot`'s `alive = true` must NOT resurrect it, which it would
    // if a corpse were still being written.
    room.state.players.get("session-a")!.alive = false;
    const decoded = roundTrip(room, snap);
    expect(decoded.ships.find((s) => s.id === a)).toBeUndefined();
    expect(room.state.players.get("session-a")).toBeDefined();
    expect(room.state.players.get("session-a")!.alive).toBe(false);
  });
});
