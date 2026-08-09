import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Server } from "@colyseus/core";
import { Client as ColyseusClient, type SeatReservation } from "colyseus.js";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { boot, ColyseusTestServer } from "@colyseus/testing";
import {
  decodeCenti,
  decodePitch,
  setGlobalLogLevel,
  type BotprofileConfig,
  type ConfigService,
  type ShipConfig,
  type TuningConfig,
} from "@space-arena/shared";
import { loadContent, setConfigService } from "../configService.js";
import { getDb, openDatabase, setDb } from "../db/index.js";
import { getMetrics } from "../telemetry/metrics.js";
import { seedNewUser } from "../db/seed.js";
import {
  fittingsRepo,
  ownedCosmeticsRepo,
  ownedModulesRepo,
  profilesRepo,
  selectedCosmeticsRepo,
  shipUpgradesRepo,
  usersRepo,
} from "../db/repos.js";
import { signAccessToken } from "../auth/tokens.js";
import { ArenaRoom } from "./ArenaRoom.js";
import type { ArenaState } from "./state/ArenaState.js";
import { MatchmakingQueue } from "../matchmaking/MatchmakingQueue.js";
import { reserveArenaPair } from "../matchmaking/roomReservations.js";

setGlobalLogLevel("error");

let colyseus: ColyseusTestServer;
let configs: ConfigService;

/** Advance the server room's fixed sim by `n` ticks (real-time, ~33ms each). */
async function advance(room: { waitForNextSimulationTick(): Promise<void> }, n: number): Promise<void> {
  for (let i = 0; i < n; i++) await room.waitForNextSimulationTick();
}

beforeAll(async () => {
  // Existing tests rely on anonymous joins; onAuth now fails closed, so opt in
  // explicitly (non-production + DEV_ALLOW_ANON=1).
  process.env.DEV_ALLOW_ANON = "1";
  configs = await loadContent();
  // The shipped pack opens every match with a 3 s frozen countdown
  // (ArenaSimulation). These tests advance a fixed, small number of simulation
  // ticks to observe flight, locks and order budgets, none of which is the
  // countdown — so this suite runs on a pack that starts instantly. 0 is a legal
  // authored value and goes through the normal schema validation in `replace`.
  {
    const tuning = configs.getAll<TuningConfig>("tuning")[0]!;
    const replaced = configs.replace({ ...tuning, matchCountdownSec: 0 });
    if (!replaced.ok) throw new Error("failed to zero matchCountdownSec for tests");
  }
  setConfigService(configs);
  setDb(openDatabase(":memory:"));
  const server = new Server({ transport: new WebSocketTransport() });
  server.define("arena", ArenaRoom).filterBy(["gamemode"]);
  colyseus = await boot(server);
});

afterAll(async () => {
  await colyseus.shutdown();
});

afterEach(async () => {
  await colyseus.cleanup();
});

describe("ArenaRoom", () => {
  it("lands two queued identities in the same reserved duel room", async () => {
    for (const [id, token, name] of [
      ["queue-user-a", "queue-token-a", "Crimson Vector"],
      ["queue-user-b", "queue-token-b", "Silent Quasar"],
    ] as const) {
      usersRepo.create({ id, email: null, pass_hash: null, guest_token: token });
      seedNewUser(configs, id, name);
    }

    const queue = new MatchmakingQueue(reserveArenaPair);
    await queue.enqueue({ playerKey: "queue-user-a", displayName: "Crimson Vector", elo: 1000, mode: "duel-1v1" });
    const second = await queue.enqueue({
      playerKey: "queue-user-b",
      displayName: "Silent Quasar",
      elo: 1000,
      mode: "duel-1v1",
    });
    const first = await queue.heartbeat("queue-user-a");
    expect(first.state).toBe("found");
    expect(second.state).toBe("found");
    if (first.state !== "found" || second.state !== "found") throw new Error("queue did not pair");
    expect(first.reservation.room.roomId).toBe(second.reservation.room.roomId);

    const port = (colyseus.server as unknown as { port: number }).port;
    const sdk = new ColyseusClient(`ws://127.0.0.1:${port}`);
    const [c1, c2] = await Promise.all([
      sdk.consumeSeatReservation(first.reservation as SeatReservation),
      sdk.consumeSeatReservation(second.reservation as SeatReservation),
    ]);
    expect(c1.roomId).toBe(c2.roomId);
    const room = colyseus.getRoomById<ArenaState>(c1.roomId);
    // Names are static PlayerState fields populated before the first simulation
    // tick, so the initial schema snapshot already carries both identities.
    expect([...room.state.players.values()].map((player) => player.displayName).sort()).toEqual([
      "Crimson Vector",
      "Silent Quasar",
    ]);
    await advance(room, 1);
    expect(room.clients).toHaveLength(2);
    expect(room.state.matchPhase).toBe("live");
    await c1.leave();
    await c2.leave();
  });

  it("flies ships, acks valid orders, rejects invalid ones, and reflects module toggles", async () => {
    const room = await colyseus.createRoom<ArenaState>("arena", { gamemode: "gamemode.duel-1v1", minPlayers: 2 });
    const c1 = await colyseus.connectTo(room, { shipId: "ship.interceptor" });
    const c2 = await colyseus.connectTo(room);

    await advance(room, 1);
    expect(room.state.matchPhase).toBe("live");

    const p1 = room.state.players.get(c1.sessionId)!;
    const startX = p1.x;
    const startZ = p1.z;

    // Valid flight order → accepted ack.
    c1.send("order", { seq: 1, order: { kind: "flight", throttle: 1, turn: 0, boost: false, fire: true } });
    const ack1 = await c1.waitForMessage("orderAck");
    expect(ack1).toMatchObject({ seq: 1, accepted: true });

    await advance(room, 20);
    // Server-authoritative position changed.
    expect(p1.x !== startX || p1.z !== startZ).toBe(true);
    expect(p1.lastProcessedSeq).toBe(1);

    // Out-of-range flight axis → rejected by the wire schema.
    c1.send("order", { seq: 2, order: { kind: "flight", throttle: 5, turn: 0, boost: false, fire: true } });
    const ack2 = await c1.waitForMessage("orderAck");
    expect(ack2).toMatchObject({ seq: 2, accepted: false, reason: "malformed" });

    // Malformed order → rejected.
    c1.send("order", { seq: 3, order: { kind: "bogus" } });
    const ack3 = await c1.waitForMessage("orderAck");
    expect(ack3).toMatchObject({ accepted: false, reason: "malformed" });

    // Heat/energy overhaul (2026-08-07): a mk1 rack burns for ~5 s before it
    // locks out, so twenty ticks in it is still ONLINE (2) and merely warm —
    // and the per-module heat/capacity pair the HUD rings read is replicated.
    expect(p1.modules[0]!.state).toBe(2);
    expect(p1.modules[0]!.heatCapacity).toBeGreaterThan(0);
    expect(p1.modules[0]!.heat).toBeGreaterThan(0);
    expect(p1.modules[0]!.energyCapacity).toBe(0); // a weapon costs no energy
    expect(p1.modules[2]!.state).toBe(2); // engine bay
    // The continuous-channel flag rides the same per-module state; a `held`
    // laser must never set it.
    expect(p1.modules[0]!.channeling).toBe(false);

    // Module toggle → the missile rack leaves the active (2) state and retracts.
    c1.send("order", { seq: 4, order: { kind: "moduleToggle", hardpointIndex: 1 } });
    const ack4 = await c1.waitForMessage("orderAck");
    expect(ack4).toMatchObject({ seq: 4, accepted: true });
    await advance(room, 2);
    expect(p1.modules[1]!.state).not.toBe(2);

    await c1.leave();
    await c2.leave();
  });

  it("broadcasts a beam fireEvent and ends the match on elimination", async () => {
    const room = await colyseus.createRoom<ArenaState>("arena", { gamemode: "gamemode.duel-1v1", minPlayers: 1 });
    const c1 = await colyseus.connectTo(room);
    await advance(room, 1);
    expect(room.state.matchPhase).toBe("live");

    // Direct sim access to set up a point-blank, low-hull enemy (task-sanctioned).
    const serverRoom = colyseus.getRoomById(room.roomId) as unknown as {
      sim: {
        world: {
          transforms: Map<number, { pos: { x: number; y: number; z: number }; heading: number }>;
          shipCores: Map<number, { hull: number }>;
        };
        spawnPlayerAt: (shipId: string, fitting: string[], team: number, pos: { x: number; y: number; z: number }, heading: number) => number;
      };
    };
    const ship = configs.get<ShipConfig>("ship", "ship.interceptor")!;
    const playerEntity = room.state.players.get(c1.sessionId)!.entityId;
    const pTf = serverRoom.sim.world.transforms.get(playerEntity)!;
    // Straight down the player's nose: weapons need a sensor LOCK (FLIGHT.md §2),
    // which only accrues while the enemy sits inside the heading-relative cone —
    // dropping it beside the ship would leave the laser cold no matter how long
    // the loop runs.
    const enemyId = serverRoom.sim.spawnPlayerAt(
      "ship.interceptor",
      ship.defaultFitting,
      1,
      { x: pTf.pos.x + Math.cos(pTf.heading) * 10, y: pTf.pos.y, z: pTf.pos.z + Math.sin(pTf.heading) * 10 },
      Math.PI,
    );
    serverRoom.sim.world.shipCores.get(enemyId)!.hull = 8;

    const fireEvents: unknown[] = [];
    const simEvents: Array<{ type: string }> = [];
    c1.onMessage("fireEvent", (m) => fireEvents.push(m));
    c1.onMessage("simEvent", (m) => simEvents.push(m as { type: string }));

    // Focus the enemy and pull the trigger — the laser spawns ONLINE (2026-07-31),
    // so no moduleToggle is needed (one would retract it).
    c1.send("order", { seq: 1, order: { kind: "target", targetId: enemyId } });
    c1.send("order", {
      seq: 2,
      order: { kind: "flight", throttle: 0, turn: 0, boost: false, fire: true },
    });

    // Enough ticks for the lock + a few laser cycles to kill 8 hull.
    for (let i = 0; i < 200 && room.state.matchPhase !== "ended"; i++) {
      await advance(room, 1);
    }

    // Let the final broadcast (matchEnded) flush to the client after state sync.
    await new Promise((r) => setTimeout(r, 200));

    expect(fireEvents.length).toBeGreaterThan(0);
    expect(fireEvents.some((e) => (e as { type: string }).type === "beam")).toBe(true);
    expect(room.state.matchPhase).toBe("ended");
    expect(room.state.winnerTeam).toBe(0);
    expect(simEvents.some((e) => e.type === "matchEnded")).toBe(true);

    await c1.leave();
  });

  // -------------------------------------------------------------------------
  // Flight netcode (FLIGHT.md §5)
  // -------------------------------------------------------------------------

  it("flies a ship from wire flight orders and replicates the throttle it is holding", async () => {
    const room = await colyseus.createRoom<ArenaState>("arena", { gamemode: "gamemode.duel-1v1", minPlayers: 1 });
    const c1 = await colyseus.connectTo(room, { shipId: "ship.interceptor" });
    await advance(room, 1);
    expect(room.state.matchPhase).toBe("live");

    const p1 = room.state.players.get(c1.sessionId)!;
    const startX = p1.x;
    const startZ = p1.z;
    const startHeading = p1.heading;
    expect(p1.throttle).toBe(0); // no FlightState yet

    c1.send("order", { seq: 1, order: { kind: "flight", throttle: 1, turn: 0.5, boost: false, fire: true } });
    expect(await c1.waitForMessage("orderAck")).toMatchObject({ seq: 1, accepted: true });

    await advance(room, 30);
    // Level-triggered: ONE order, integrated every tick — position and heading
    // both moved, and the held throttle is replicated (encodeUnit(1) === 255).
    expect(p1.x !== startX || p1.z !== startZ).toBe(true);
    expect(p1.heading).not.toBe(startHeading);
    expect(p1.throttle).toBe(255);
    expect(p1.lastProcessedSeq).toBe(1);

    // Cutting the throttle is another single order; the ship decelerates.
    c1.send("order", { seq: 2, order: { kind: "flight", throttle: 0, turn: 0, boost: false, fire: true } });
    expect(await c1.waitForMessage("orderAck")).toMatchObject({ seq: 2, accepted: true });
    await advance(room, 5);
    expect(p1.throttle).toBe(0);

    await c1.leave();
  });

  it("replicates sensor lock progress, locked and targetId to the client", async () => {
    const room = await colyseus.createRoom<ArenaState>("arena", { gamemode: "gamemode.duel-1v1", minPlayers: 1 });
    const c1 = await colyseus.connectTo(room, { shipId: "ship.interceptor" });
    await advance(room, 1);

    const serverRoom = colyseus.getRoomById(room.roomId) as unknown as {
      sim: {
        world: { transforms: Map<number, { pos: { x: number; y: number; z: number }; heading: number }> };
        spawnPlayerAt: (shipId: string, fitting: (string | null)[], team: number, pos: { x: number; y: number; z: number }, heading: number) => number;
      };
    };
    const ship = configs.get<ShipConfig>("ship", "ship.interceptor")!;
    const p1 = room.state.players.get(c1.sessionId)!;
    expect(p1.locked).toBe(false);
    expect(p1.lockProgress).toBe(0);
    expect(p1.targetId).toBe(-1);

    // Park an enemy straight down the player's nose — inside the heading-relative
    // sensor cone, which is the only thing that fills lockProgress (FLIGHT.md §2).
    const pTf = serverRoom.sim.world.transforms.get(p1.entityId)!;
    const enemyId = serverRoom.sim.spawnPlayerAt(
      "ship.interceptor",
      [...ship.defaultFitting],
      1,
      { x: pTf.pos.x + Math.cos(pTf.heading) * 10, y: pTf.pos.y, z: pTf.pos.z + Math.sin(pTf.heading) * 10 },
      Math.PI,
    );

    for (let i = 0; i < 120 && !p1.locked; i++) await advance(room, 1);
    expect(p1.locked).toBe(true);
    expect(p1.lockProgress).toBe(255); // encodeUnit(1) — a completed lock
    expect(p1.targetId).toBe(enemyId);

    await c1.leave();
  });

  it("rejects malformed flight orders as malformed without disturbing a legitimate client", async () => {
    const room = await colyseus.createRoom<ArenaState>("arena", { gamemode: "gamemode.duel-1v1", minPlayers: 2 });
    const cheat = await colyseus.connectTo(room, { shipId: "ship.interceptor" });
    const honest = await colyseus.connectTo(room, { shipId: "ship.interceptor" });
    await advance(room, 1);
    expect(room.state.matchPhase).toBe("live");

    const cheatState = room.state.players.get(cheat.sessionId)!;
    const before = { x: cheatState.x, z: cheatState.z, heading: cheatState.heading };

    // Non-finite and out-of-range axes are refused at the trust boundary
    // (orderSchema) — the sim never sees them, so no heading/position poisoning.
    const bad = [
      { throttle: Number.NaN, turn: 0, boost: false, fire: true },
      { throttle: 0.5, turn: Number.POSITIVE_INFINITY, boost: false, fire: true },
      { throttle: Number.NEGATIVE_INFINITY, turn: 0, boost: false, fire: true },
      { throttle: 5, turn: 0, boost: false, fire: true },
      { throttle: -0.5, turn: 0, boost: false, fire: true },
      { throttle: 0.5, turn: -3, boost: false, fire: true },
      { throttle: 0.5, turn: 1.5, boost: false, fire: true },
    ];
    for (let i = 0; i < bad.length; i++) {
      cheat.send("order", { seq: i + 1, order: { kind: "flight", ...bad[i] } });
      expect(await cheat.waitForMessage("orderAck"), JSON.stringify(bad[i])).toMatchObject({
        seq: i + 1,
        accepted: false,
        reason: "malformed",
      });
    }

    await advance(room, 10);
    // Nothing was applied: the ship never acquired a FlightState.
    expect(cheatState.throttle).toBe(0);
    expect(Number.isFinite(cheatState.x)).toBe(true);
    expect(cheatState.x).toBe(before.x);
    expect(cheatState.z).toBe(before.z);
    expect(cheatState.heading).toBe(before.heading);

    // The other client is untouched and still flies.
    const honestState = room.state.players.get(honest.sessionId)!;
    honest.send("order", { seq: 1, order: { kind: "flight", throttle: 1, turn: 0, boost: false, fire: true } });
    expect(await honest.waitForMessage("orderAck")).toMatchObject({ seq: 1, accepted: true });
    await advance(room, 20);
    expect(honestState.throttle).toBe(255);
    expect(honestState.x !== before.x || honestState.z !== before.z).toBe(true);

    await cheat.leave();
    await honest.leave();
  });

  it("requires a boolean fire flag on human wire orders", async () => {
    const room = await colyseus.createRoom<ArenaState>("arena", { gamemode: "gamemode.duel-1v1", minPlayers: 1 });
    const client = await colyseus.connectTo(room, { shipId: "ship.interceptor" });
    await advance(room, 1);

    client.send("order", { seq: 1, order: { kind: "flight", throttle: 0, turn: 0, boost: false } });
    expect(await client.waitForMessage("orderAck")).toMatchObject({
      seq: 1,
      accepted: false,
      reason: "malformed",
    });

    client.send("order", {
      seq: 2,
      order: { kind: "flight", throttle: 0, turn: 0, boost: false, fire: "yes" },
    });
    expect(await client.waitForMessage("orderAck")).toMatchObject({
      seq: 2,
      accepted: false,
      reason: "malformed",
    });

    await client.leave();
  });

  it("charges one trigger-bearing flight order as one budget slot", async () => {
    const room = await colyseus.createRoom<ArenaState>("arena", { gamemode: "gamemode.duel-1v1", minPlayers: 1 });
    const client = await colyseus.connectTo(room, { shipId: "ship.interceptor" });
    await advance(room, 1);
    const internal = colyseus.getRoomById(room.roomId) as unknown as {
      orderRates: Map<string, { count: number }>;
    };
    const before = internal.orderRates.get(client.sessionId)?.count ?? 0;

    client.send("order", {
      seq: 1,
      order: { kind: "flight", throttle: 0, turn: 0, boost: false, fire: true },
    });
    expect(await client.waitForMessage("orderAck")).toMatchObject({ seq: 1, accepted: true });
    expect(internal.orderRates.get(client.sessionId)?.count).toBe(before + 1);

    await client.leave();
  });

  // -------------------------------------------------------------------------
  // Bubble netcode (BUBBLE.md §B) — the third axis on the wire
  // -------------------------------------------------------------------------

  it("flies a wire pitch order off the ground plane and replicates y and pitch", async () => {
    const room = await colyseus.createRoom<ArenaState>("arena", { gamemode: "gamemode.duel-1v1", minPlayers: 1 });
    const c1 = await colyseus.connectTo(room, { shipId: "ship.interceptor" });
    await advance(room, 1);
    expect(room.state.matchPhase).toBe("live");

    const p1 = room.state.players.get(c1.sessionId)!;
    // The authored spawn altitude is replicated before any order; the level nose
    // keeps the following climb attributable to the pitch input.
    const startY = decodeCenti(p1.y);
    expect(startY).toBe(7);
    expect(p1.pitch).toBe(0);

    c1.send("order", { seq: 1, order: { kind: "flight", throttle: 1, turn: 0, pitchStick: 1, boost: false, fire: true } });
    expect(await c1.waitForMessage("orderAck")).toMatchObject({ seq: 1, accepted: true });

    await advance(room, 25);

    // The SIM moved off-plane (the point of the stage), and the two new fields
    // carry it: y through the same centi codec as x/z, pitch through the signed
    // int16 pair. Cross-check against the server's own transform so a codec that
    // silently clamped or wrapped could not pass.
    const serverRoom = colyseus.getRoomById(room.roomId) as unknown as {
      sim: { world: { transforms: Map<number, { pos: { x: number; y: number; z: number }; pitch: number }> } };
    };
    const tf = serverRoom.sim.world.transforms.get(p1.entityId)!;
    expect(tf.pos.y).toBeGreaterThan(startY + 1);
    expect(tf.pitch).toBeGreaterThan(0);
    // Deci-unit wire precision since the CTF arena doubled (2026-08-05).
    expect(decodeCenti(p1.y)).toBeCloseTo(tf.pos.y, 1);
    expect(decodePitch(p1.pitch)).toBeCloseTo(tf.pitch, 3);

    // Nose back down: pitch is HELD state, so the ship keeps climbing until an
    // order says otherwise — and the replicated pitch must go NEGATIVE, which is
    // precisely what routing it through the heading codec would have destroyed.
    c1.send("order", { seq: 2, order: { kind: "flight", throttle: 1, turn: 0, pitchStick: -1, boost: false, fire: true } });
    expect(await c1.waitForMessage("orderAck")).toMatchObject({ seq: 2, accepted: true });
    await advance(room, 30);
    expect(tf.pitch).toBeLessThan(0);
    expect(p1.pitch).toBeLessThan(0);
    expect(decodePitch(p1.pitch)).toBeCloseTo(tf.pitch, 3);

    await c1.leave();
  });

  it("rejects a malformed pitchStick as malformed, without kicking the client or touching its attitude", async () => {
    const room = await colyseus.createRoom<ArenaState>("arena", { gamemode: "gamemode.duel-1v1", minPlayers: 1 });
    const c1 = await colyseus.connectTo(room, { shipId: "ship.interceptor" });
    await advance(room, 1);

    const p1 = room.state.players.get(c1.sessionId)!;
    const spawnY = p1.y;
    let left = false;
    c1.onLeave(() => (left = true));

    // A bad pitch axis is a bad order, exactly like a bad turn axis: refused at
    // the trust boundary so the sim never stores it. Sending a handful of them
    // is a validation failure, not abuse — the client stays connected.
    const bad: unknown[] = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 2, -1.5, "up", null];
    for (let i = 0; i < bad.length; i++) {
      c1.send("order", { seq: i + 1, order: { kind: "flight", throttle: 0.5, turn: 0, pitchStick: bad[i], boost: false, fire: true } });
      expect(await c1.waitForMessage("orderAck"), String(bad[i])).toMatchObject({
        seq: i + 1,
        accepted: false,
        reason: "malformed",
      });
    }

    await advance(room, 10);
    expect(left).toBe(false);
    expect(p1.throttle).toBe(0); // no FlightState was ever stored
    expect(p1.y).toBe(spawnY);
    expect(p1.pitch).toBe(0);

    // Omitting the axis entirely is legal (pitch is held state — absent means
    // "unchanged", the same as a centred stick), and the client still flies.
    c1.send("order", { seq: 99, order: { kind: "flight", throttle: 1, turn: 0, boost: false, fire: true } });
    expect(await c1.waitForMessage("orderAck")).toMatchObject({ seq: 99, accepted: true });
    await advance(room, 10);
    expect(p1.throttle).toBe(255);
    expect(p1.pitch).toBe(0); // still level: no pitch order was ever accepted

    await c1.leave();
  });

  it("kicks a client that floods flight orders past the rate limit", async () => {
    const room = await colyseus.createRoom<ArenaState>("arena", { gamemode: "gamemode.duel-1v1", minPlayers: 1 });
    const c1 = await colyseus.connectTo(room, { shipId: "ship.interceptor" });
    await advance(room, 1);

    const acks: Array<{ accepted: boolean; reason?: string }> = [];
    c1.onMessage("orderAck", (m) => acks.push(m as { accepted: boolean; reason?: string }));
    const closed = new Promise<number>((resolve) => c1.onLeave((code) => resolve(code)));

    // maxOrdersPerSec (20) + ABUSE_KICK_THRESHOLD (40) rate-limited orders, all
    // inside one window: every order here is individually VALID, so this is the
    // rate limiter doing the work, not validation.
    for (let i = 0; i < 150; i++) {
      c1.send("order", { seq: i + 1, order: { kind: "flight", throttle: 0.5, turn: 0, boost: false, fire: true } });
    }

    const code = await Promise.race([closed, new Promise<number>((r) => setTimeout(() => r(-1), 4000))]);
    expect(code).toBe(4290); // custom close code: rate-limit kick
    expect(acks.some((a) => !a.accepted && a.reason === "rate-limited")).toBe(true);
  });

  it("forgives burst abuse after clean windows while sustained flooding still kicks", async () => {
    const room = await colyseus.createRoom<ArenaState>("arena", {
      gamemode: "gamemode.duel-1v1",
      minPlayers: 1,
    });
    const serverRoom = colyseus.getRoomById(room.roomId) as unknown as {
      maxOrdersPerSec: number;
      orderRates: Map<string, { windowStart: number; count: number; abuse: number }>;
      rateLimited(client: { sessionId: string; leave(code: number): void }): boolean;
    };
    const leave = vi.fn();
    const client = { sessionId: "burst-test", leave };
    serverRoom.orderRates.set(client.sessionId, {
      windowStart: Date.now(),
      count: 0,
      abuse: 0,
    });

    // One brief burst creates abuse debt.
    for (let i = 0; i < serverRoom.maxOrdersPerSec + 5; i++) {
      serverRoom.rateLimited(client);
    }
    const rate = serverRoom.orderRates.get(client.sessionId)!;
    expect(rate.abuse).toBe(5);

    // First rollover ends the abusive window; the next sparse window is clean.
    rate.windowStart -= 1000;
    expect(serverRoom.rateLimited(client)).toBe(false);
    expect(rate.abuse).toBe(5);
    // Rolling that clean window clears the old burst instead of accumulating it
    // toward a kick for the rest of the match.
    rate.windowStart -= 1000;
    expect(serverRoom.rateLimited(client)).toBe(false);
    expect(rate.abuse).toBe(0);
    expect(leave).not.toHaveBeenCalled();

    // Consecutive flooding never supplies a clean window and still reaches the
    // same sustained-abuse kick path covered by the socket-level flood test.
    for (let i = 0; i < serverRoom.maxOrdersPerSec + 40; i++) {
      serverRoom.rateLimited(client);
    }
    expect(leave).toHaveBeenCalledWith(4290);
  });

  it("counts MALFORMED order messages against the rate limit and kicks the flooder (review Finding 1)", async () => {
    // The limiter used to run AFTER Zod parsing, so an unparseable message was
    // answered with a `malformed` ack and never charged to the budget: an
    // authenticated client could hold the server in an unbounded parse-and-reply
    // loop forever, never incrementing the abuse counter, never being kicked.
    const room = await colyseus.createRoom<ArenaState>("arena", { gamemode: "gamemode.duel-1v1", minPlayers: 1 });
    const c1 = await colyseus.connectTo(room, { shipId: "ship.interceptor" });
    await advance(room, 1);

    const acks: Array<{ accepted: boolean; reason?: string }> = [];
    c1.onMessage("orderAck", (m) => acks.push(m as { accepted: boolean; reason?: string }));
    const closed = new Promise<number>((resolve) => c1.onLeave((code) => resolve(code)));

    // Every message here is structurally invalid (unknown discriminant, bogus
    // axis types) — the exact traffic the old ordering served for free.
    for (let i = 0; i < 150; i++) {
      c1.send("order", { seq: i + 1, order: { kind: "warp", axis: "sideways" } });
    }

    const code = await Promise.race([closed, new Promise<number>((r) => setTimeout(() => r(-1), 4000))]);
    expect(code).toBe(4290); // same rate-limit kick a valid-order flood earns
    expect(acks.some((a) => !a.accepted && a.reason === "rate-limited")).toBe(true);
  });

  /**
   * The start countdown (ArenaSimulation) is server-authoritative so both clients
   * count the SAME numbers off the SAME clock. This suite otherwise runs with the
   * countdown zeroed, so these tests install the shipped 3 s locally.
   */
  describe("match-start countdown", () => {
    const COUNTDOWN = 3;

    /** Swap the pinned pack's countdown for the duration of one test. */
    async function withCountdown(seconds: number, body: () => Promise<void>): Promise<void> {
      const tuning = configs.getAll<TuningConfig>("tuning")[0]!;
      expect(configs.replace({ ...tuning, matchCountdownSec: seconds }).ok).toBe(true);
      try {
        await body();
      } finally {
        expect(configs.replace({ ...tuning, matchCountdownSec: 0 }).ok).toBe(true);
      }
    }

    it("replicates the sim's countdown and holds the ship still until GO", async () => {
      await withCountdown(COUNTDOWN, async () => {
        const room = await colyseus.createRoom<ArenaState>("arena", {
          gamemode: "gamemode.duel-1v1",
          minPlayers: 1,
        });
        const c1 = await colyseus.connectTo(room, { shipId: "ship.interceptor" });
        await advance(room, 1);

        // The room is live (its lifecycle), while the SIM is counting down.
        expect(room.state.matchPhase).toBe("live");
        expect(room.state.countdownRemaining).toBeGreaterThan(0);
        expect(room.state.countdownRemaining).toBeLessThanOrEqual(COUNTDOWN);

        const p1 = room.state.players.get(c1.sessionId)!;
        const startX = p1.x;
        const startZ = p1.z;

        // Full throttle held through the countdown. The order is ACCEPTED (the
        // sim stores it without integrating), so no "not-live" rejection.
        const acks: Array<{ accepted: boolean; reason?: string }> = [];
        c1.onMessage("orderAck", (m) => acks.push(m as { accepted: boolean; reason?: string }));
        c1.send("order", { seq: 1, order: { kind: "flight", throttle: 1, turn: 0, boost: false, fire: true } });
        await advance(room, 20);

        expect(acks.some((a) => a.accepted)).toBe(true);
        expect(acks.some((a) => a.reason === "not-live")).toBe(false);
        expect(p1.x).toBe(startX);
        expect(p1.z).toBe(startZ);
        expect(p1.throttle).toBe(255); // encodeUnit(1) — the held state IS replicated
        expect(room.state.matchTimer).toBe(0);

        // Run the clock out: the held throttle bites immediately at GO.
        for (let i = 0; i < 120 && room.state.countdownRemaining > 0; i++) await advance(room, 1);
        expect(room.state.countdownRemaining).toBe(0);
        await advance(room, 10);
        expect(p1.x === startX && p1.z === startZ).toBe(false);
        expect(room.state.matchTimer).toBeGreaterThan(0);

        await c1.leave();
      });
    });

    it("broadcasts the 3-2-1-GO beats so both clients cue on the same tick", async () => {
      await withCountdown(COUNTDOWN, async () => {
        const room = await colyseus.createRoom<ArenaState>("arena", {
          gamemode: "gamemode.duel-1v1",
          minPlayers: 2,
        });
        const c1 = await colyseus.connectTo(room, { shipId: "ship.interceptor" });
        const c2 = await colyseus.connectTo(room);
        const beats1: number[] = [];
        const beats2: number[] = [];
        let started = 0;
        for (const [client, beats] of [
          [c1, beats1],
          [c2, beats2],
        ] as const) {
          client.onMessage("simEvent", (m) => {
            const ev = m as { type: string; remaining?: number };
            if (ev.type === "countdownTick") beats.push(ev.remaining!);
            if (ev.type === "matchStarted" && client === c1) started++;
          });
        }

        for (let i = 0; i < 140 && room.state.countdownRemaining > 0; i++) await advance(room, 1);
        await new Promise((r) => setTimeout(r, 250)); // let the broadcasts flush

        expect(beats1).toEqual([3, 2, 1]);
        // Both clients got the identical sequence — the whole point of putting the
        // countdown in the sim rather than in each client.
        expect(beats2).toEqual(beats1);
        expect(started).toBe(1);

        await c1.leave();
        await c2.leave();
      });
    });

    it("starts instantly when the pack authors 0", async () => {
      await withCountdown(0, async () => {
        const room = await colyseus.createRoom<ArenaState>("arena", {
          gamemode: "gamemode.duel-1v1",
          minPlayers: 1,
        });
        const c1 = await colyseus.connectTo(room, { shipId: "ship.interceptor" });
        await advance(room, 2);
        expect(room.state.countdownRemaining).toBe(0);
        expect(room.state.matchTimer).toBeGreaterThan(0);
        await c1.leave();
      });
    });
  });

  it("relays lockAcquired over the wire so online clients get the lock cue (review Finding 7)", async () => {
    // `toSimEventMessage` dropped both lock events, so the reticle's audio and
    // haptic cue (soundIds.ts / Haptics.ts) only ever fired in practice mode.
    const room = await colyseus.createRoom<ArenaState>("arena", { gamemode: "gamemode.duel-1v1", minPlayers: 1 });
    const c1 = await colyseus.connectTo(room, { shipId: "ship.interceptor" });
    await advance(room, 1);

    const simEvents: Array<{ type: string; entityId?: number; targetId?: number }> = [];
    c1.onMessage("simEvent", (m) => simEvents.push(m as { type: string; entityId?: number; targetId?: number }));

    const serverRoom = colyseus.getRoomById(room.roomId) as unknown as {
      sim: {
        world: { transforms: Map<number, { pos: { x: number; y: number; z: number }; heading: number }> };
        spawnPlayerAt: (shipId: string, fitting: (string | null)[], team: number, pos: { x: number; y: number; z: number }, heading: number) => number;
      };
    };
    const ship = configs.get<ShipConfig>("ship", "ship.interceptor")!;
    const p1 = room.state.players.get(c1.sessionId)!;
    // Straight down the nose, inside the sensor cone — the only thing that fills
    // lock progress (FLIGHT.md §2).
    const pTf = serverRoom.sim.world.transforms.get(p1.entityId)!;
    const enemyId = serverRoom.sim.spawnPlayerAt(
      "ship.interceptor",
      [...ship.defaultFitting],
      1,
      { x: pTf.pos.x + Math.cos(pTf.heading) * 10, y: pTf.pos.y, z: pTf.pos.z + Math.sin(pTf.heading) * 10 },
      Math.PI,
    );

    for (let i = 0; i < 120 && !p1.locked; i++) await advance(room, 1);
    expect(p1.locked).toBe(true);
    await new Promise((r) => setTimeout(r, 200)); // let the broadcast flush

    const acquired = simEvents.find((e) => e.type === "lockAcquired");
    expect(acquired).toBeDefined();
    expect(acquired).toMatchObject({ entityId: p1.entityId, targetId: enemyId });

    await c1.leave();
  });

  it("rejects orders sent before the match goes live", async () => {
    const room = await colyseus.createRoom<ArenaState>("arena", { gamemode: "gamemode.duel-1v1", minPlayers: 2 });
    const c1 = await colyseus.connectTo(room);
    // Only one human joined → still waiting.
    expect(room.state.matchPhase).toBe("waiting");
    c1.send("order", { seq: 1, order: { kind: "flight", throttle: 1, turn: 0, boost: false, fire: true } });
    const ack = await c1.waitForMessage("orderAck");
    expect(ack).toMatchObject({ seq: 1, accepted: false, reason: "not-live" });
    await c1.leave();
  });

  it("rejects anon join when DEV_ALLOW_ANON=0 and accepts a valid token", async () => {
    const prev = process.env.DEV_ALLOW_ANON;
    process.env.DEV_ALLOW_ANON = "0";
    try {
      // Seed a user + default fitting; join with its token + fittingId.
      usersRepo.create({ id: "u-join", email: null, pass_hash: null, guest_token: "gt-join" });
      seedNewUser(configs, "u-join", "Ace");
      const fitting = fittingsRepo.byUser("u-join")[0]!;
      const token = signAccessToken("u-join");

      const roomA = await colyseus.createRoom<ArenaState>("arena", { gamemode: "gamemode.duel-1v1", minPlayers: 1 });
      const c = await colyseus.connectTo(roomA, { token, fittingId: fitting.id });
      await advance(roomA, 1);
      const ps = roomA.state.players.get(c.sessionId)!;
      expect(ps.displayName).toBe("Ace");
      expect(ps.shipId).toBe(fitting.ship_id);

      // A separate room: an anonymous (tokenless) join is rejected.
      const roomB = await colyseus.createRoom<ArenaState>("arena", { gamemode: "gamemode.duel-1v1", minPlayers: 1 });
      await expect(colyseus.connectTo(roomB)).rejects.toBeDefined();

      await c.leave();
    } finally {
      process.env.DEV_ALLOW_ANON = prev;
    }
  });

  it("grants match rewards to an authenticated participant on match end", async () => {
    usersRepo.create({ id: "u-win", email: null, pass_hash: null, guest_token: "gt-win" });
    seedNewUser(configs, "u-win", "Winner");
    const before = profilesRepo.byUser("u-win")!;
    const token = signAccessToken("u-win");

    // No minPlayers override → rewardsEligible room. Two real
    // clients: c1 (authed, team 0) vs c2 (anon, team 1).
    const room = await colyseus.createRoom<ArenaState>("arena", { gamemode: "gamemode.duel-1v1" });
    const c1 = await colyseus.connectTo(room, { token });
    const c2 = await colyseus.connectTo(room);
    await advance(room, 1);
    expect(room.state.matchPhase).toBe("live");

    const serverRoom = colyseus.getRoomById(room.roomId) as unknown as {
      sim: {
        world: {
          shipCores: Map<number, { hull: number }>;
          transforms: Map<number, { pos: { x: number; z: number }; heading: number }>;
        };
      };
    };
    // Force the enemy (c2) to near-death and park it point-blank ahead of c1 —
    // inside the sensor cone, or the lock never completes and nothing fires
    // (FLIGHT.md §2).
    const playerId = room.state.players.get(c1.sessionId)!.entityId;
    const enemyId = room.state.players.get(c2.sessionId)!.entityId;
    const pTf = serverRoom.sim.world.transforms.get(playerId)!;
    const ePos = serverRoom.sim.world.transforms.get(enemyId)!.pos;
    ePos.x = pTf.pos.x + Math.cos(pTf.heading) * 8;
    ePos.z = pTf.pos.z + Math.sin(pTf.heading) * 8;
    serverRoom.sim.world.shipCores.get(enemyId)!.hull = 8;

    const rewards: Array<{ type: string; credits: number; xp: number }> = [];
    c1.onMessage("simEvent", (m) => rewards.push(m as { type: string; credits: number; xp: number }));

    // The enemy is parked dead ahead inside the sensor cone, so automatic
    // targeting (FLIGHT.md §2) locks it; the laser spawns ONLINE (2026-07-31),
    // so pulling the trigger is all it takes.
    c1.send("order", {
      seq: 1,
      order: { kind: "flight", throttle: 0, turn: 0, boost: false, fire: true },
    });

    for (let i = 0; i < 400 && room.state.matchPhase !== "ended"; i++) await advance(room, 1);
    await new Promise((r) => setTimeout(r, 200));

    expect(room.state.matchPhase).toBe("ended");
    const after = profilesRepo.byUser("u-win")!;
    // Won (win reward) + at least one frag (perKill) → credits + xp increased.
    expect(after.credits).toBeGreaterThan(before.credits);
    expect(after.xp).toBeGreaterThan(before.xp);
    expect(rewards.some((r) => r.type === "matchRewards" && r.credits > 0)).toBe(true);

    await c1.leave();
    await c2.leave();
  });

  it("rejects a second join from a userId already in the room (3b)", async () => {
    usersRepo.create({ id: "u-dupe", email: null, pass_hash: null, guest_token: "gt-dupe" });
    seedNewUser(configs, "u-dupe", "Dupe");
    const token = signAccessToken("u-dupe");

    const room = await colyseus.createRoom<ArenaState>("arena", { gamemode: "gamemode.duel-1v1" });
    const c1 = await colyseus.connectTo(room, { token });
    await advance(room, 1);
    // Same token/userId a second time → join rejected.
    await expect(colyseus.connectTo(room, { token })).rejects.toBeDefined();
    await c1.leave();
  });

  it("preserves hardpoint positions: sparse fit toggles the right module (9)", async () => {
    // Seed a user whose fitting leaves slots 1 and 2 empty: {0:laser, 3:generator}.
    // Slot 3 is the light hull's generator bay since the internal bay landed.
    usersRepo.create({ id: "u-sparse", email: null, pass_hash: null, guest_token: "gt-sparse" });
    seedNewUser(configs, "u-sparse", "Sparse");
    // Own the shield so the fit is legal, then save the sparse fitting.
    ownedModulesRepo.grant("u-sparse", "module.generator-compact", 1);
    const fit = fittingsRepo.create({
      id: "fit-sparse",
      user_id: "u-sparse",
      ship_id: "ship.interceptor",
      name: "Sparse",
      hardpointMap: { "0": "module.laser-mk1", "3": "module.generator-compact" },
    });
    const token = signAccessToken("u-sparse");

    const room = await colyseus.createRoom<ArenaState>("arena", { gamemode: "gamemode.duel-1v1", minPlayers: 1 });
    const c = await colyseus.connectTo(room, { token, fittingId: fit.id });
    await advance(room, 1);

    const ps = room.state.players.get(c.sessionId)!;
    // Two fitted modules; the generator answers slot index 3 (not compacted 1).
    expect(ps.modules.length).toBe(2);
    const generatorModule = [...ps.modules].find((m) => m.hardpointIndex === 3)!;
    expect(generatorModule).toBeDefined();

    // Toggling slot index 1 (empty) is rejected.
    c.send("order", { seq: 1, order: { kind: "moduleToggle", hardpointIndex: 1 } });
    const badAck = await c.waitForMessage("orderAck");
    expect(badAck).toMatchObject({ seq: 1, accepted: false, reason: "bad-hardpoint" });

    // Toggling slot index 3 addresses the generator, proving the index survived
    // the sparse fit rather than being compacted.
    c.send("order", { seq: 2, order: { kind: "moduleToggle", hardpointIndex: 3 } });
    const okAck = await c.waitForMessage("orderAck");
    expect(okAck).toMatchObject({ seq: 2, accepted: true });
    await advance(room, 2);
    // The generator is an always-on internal, so the toggle RETRACTS it (0).
    const generatorAfter = [...ps.modules].find((m) => m.hardpointIndex === 3)!;
    expect(generatorAfter.state).toBe(0);

    await c.leave();
  });

  it("rejects a join whose fitting references an unowned module (Finding 1)", async () => {
    usersRepo.create({ id: "u-cheat", email: null, pass_hash: null, guest_token: "gt-cheat" });
    seedNewUser(configs, "u-cheat", "Cheater");
    // Craft an illegal fitting directly in the repo: shield-mk2 is a priced module
    // the fresh user does not own (family-legal for hardpoint 1).
    const fit = fittingsRepo.create({
      id: "fit-cheat",
      user_id: "u-cheat",
      ship_id: "ship.interceptor",
      name: "Cheat",
      hardpointMap: { "0": "module.laser-mk1", "1": "module.shield-mk2" },
    });
    const token = signAccessToken("u-cheat");

    const room = await colyseus.createRoom<ArenaState>("arena", { gamemode: "gamemode.duel-1v1", minPlayers: 1 });
    // resolveFitting validates the loadout in onJoin → join rejected.
    await expect(colyseus.connectTo(room, { token, fittingId: fit.id })).rejects.toBeDefined();
  });

  describe("cosmetics (protocol 5)", () => {
    it("replicates an owned, applicable paint and falls back to the DB selection", async () => {
      usersRepo.create({ id: "u-paint", email: null, pass_hash: null, guest_token: "gt-paint" });
      seedNewUser(configs, "u-paint", "Painter");
      ownedCosmeticsRepo.grant("u-paint", "cosmetic.paint-interceptor-crimson");
      const token = signAccessToken("u-paint");

      const room = await colyseus.createRoom<ArenaState>("arena", { gamemode: "gamemode.duel-1v1", minPlayers: 1 });
      const c = await colyseus.connectTo(room, { token, shipId: "ship.interceptor", cosmeticId: "cosmetic.paint-interceptor-crimson" });
      await advance(room, 1);
      expect(room.state.players.get(c.sessionId)!.cosmeticId).toBe("cosmetic.paint-interceptor-crimson");
      await c.leave();

      // No join-option paint: the account's saved selection is what flies.
      selectedCosmeticsRepo.set("u-paint", "ship.interceptor", "cosmetic.paint-interceptor-crimson");
      const room2 = await colyseus.createRoom<ArenaState>("arena", { gamemode: "gamemode.duel-1v1", minPlayers: 1 });
      const c2 = await colyseus.connectTo(room2, { token, shipId: "ship.interceptor" });
      await advance(room2, 1);
      expect(room2.state.players.get(c2.sessionId)!.cosmeticId).toBe("cosmetic.paint-interceptor-crimson");
      await c2.leave();
    });

    it("sanitizes an unowned, unknown or wrong-hull paint to standard instead of refusing the join", async () => {
      usersRepo.create({ id: "u-nopaint", email: null, pass_hash: null, guest_token: "gt-nopaint" });
      seedNewUser(configs, "u-nopaint", "Bare");
      // Owned but authored for ship.brawler only.
      ownedCosmeticsRepo.grant("u-nopaint", "cosmetic.paint-brawler-ironclad");
      const token = signAccessToken("u-nopaint");

      for (const cosmeticId of ["cosmetic.paint-violet", "cosmetic.paint-nonexistent", "cosmetic.paint-brawler-ironclad"]) {
        const room = await colyseus.createRoom<ArenaState>("arena", { gamemode: "gamemode.duel-1v1", minPlayers: 1 });
        const c = await colyseus.connectTo(room, { token, shipId: "ship.interceptor", cosmeticId });
        await advance(room, 1);
        expect(room.state.players.get(c.sessionId)!.cosmeticId, cosmeticId).toBe("cosmetic.paint-interceptor-standard");
        await c.leave();
      }
    });

    it("gives an anonymous join no paint at all — it owns nothing to wear", async () => {
      const room = await colyseus.createRoom<ArenaState>("arena", { gamemode: "gamemode.duel-1v1", minPlayers: 1 });
      const c = await colyseus.connectTo(room, { shipId: "ship.interceptor", cosmeticId: "cosmetic.paint-interceptor-crimson" });
      await advance(room, 1);
      expect(room.state.players.get(c.sessionId)!.cosmeticId).toBe("");
      await c.leave();
    });

    it("dresses backfilled bots in a target-ship paint, identically for the same seed", async () => {
      const paints: string[] = [];
      for (let run = 0; run < 2; run++) {
        const room = await colyseus.createRoom<ArenaState>("arena", {
          gamemode: "gamemode.duel-1v1",
          minPlayers: 2,
          botBackfillMs: 0,
          seed: 42,
        });
        const c = await colyseus.connectTo(room, { shipId: "ship.interceptor" });
        await new Promise((resolve) => setTimeout(resolve, 60));
        await advance(room, 2);
        const botKey = [...room.state.players.keys()].find((k) => k.startsWith("bot-"))!;
        paints.push(room.state.players.get(botKey)!.cosmeticId);
        await c.leave();
      }
      expect(paints[0]).toMatch(/^cosmetic\.paint-/);
      expect(paints[1]).toBe(paints[0]);
    });
  });

  it("backfills empty slots with bots and starts the match (5.1)", async () => {
    // botBackfillMs: 0 → backfill as soon as the (single) human is in and the
    // room is still short of `minPlayers`.
    const room = await colyseus.createRoom<ArenaState>("arena", {
      gamemode: "gamemode.duel-1v1",
      minPlayers: 2,
      botBackfillMs: 0,
      botProfile: "bot.aggressive",
    });
    const c1 = await colyseus.connectTo(room, { shipId: "ship.interceptor" });

    // Wait for the backfill timer, then let the sim run.
    await new Promise((resolve) => setTimeout(resolve, 60));
    await advance(room, 40);

    expect(room.state.matchPhase).toBe("live");
    const botKeys = [...room.state.players.keys()].filter((k) => k.startsWith("bot-"));
    expect(botKeys.length).toBe(1); // 1v1: one empty slot filled
    const bot = room.state.players.get(botKeys[0]!)!;
    expect(bot.team).not.toBe(room.state.players.get(c1.sessionId)!.team);
    // Bots wear player-like handles rather than their profile id (2026-07-31):
    // "Aggressive" reads as furniture on a scoreboard. The exact name is a
    // seeded roll, so assert the SHAPE — a non-empty, whitespace-free handle
    // that is not simply the profile's name.
    expect(bot.displayName).not.toBe("Aggressive");
    expect(bot.displayName).toMatch(/^\S{3,24}$/);

    // The bot drives itself through the normal order pipeline: it moves and
    // brings modules online.
    await advance(room, 60);
    const movedOrArmed = bot.x !== 0 || bot.z !== 0 || bot.modules.some((m) => m.state > 0);
    expect(movedOrArmed).toBe(true);

    await c1.leave();
  });

  it("rejects missing and non-boolean bot fire flags with the human validation rule", async () => {
    const room = await colyseus.createRoom<ArenaState>("arena", {
      gamemode: "gamemode.duel-1v1",
      minPlayers: 2,
      botBackfillMs: 0,
      botProfile: "bot.aggressive",
    });
    const client = await colyseus.connectTo(room, { shipId: "ship.interceptor" });
    await advance(room, 2);
    const bot = [...room.state.players.entries()].find(([key]) => key.startsWith("bot-"))?.[1];
    expect(bot).toBeDefined();
    const internal = colyseus.getRoomById(room.roomId) as unknown as {
      validateOrder(entityId: number, order: unknown): string | null;
    };

    expect(
      internal.validateOrder(bot!.entityId, { kind: "flight", throttle: 0, turn: 0, boost: false }),
    ).toBe("malformed");
    expect(
      internal.validateOrder(bot!.entityId, {
        kind: "flight",
        throttle: 0,
        turn: 0,
        boost: false,
        fire: 1,
      }),
    ).toBe("malformed");
    expect(
      internal.validateOrder(bot!.entityId, {
        kind: "flight",
        throttle: 0,
        turn: 0,
        boost: false,
        fire: true,
      }),
    ).toBeNull();

    await client.leave();
  });

  it("never bot-backfills a matchmade room — the second seat belongs to a reserved player", async () => {
    // Identical setup to the backfill test above, but created the way the
    // matchmaking queue creates rooms (matchmaking: true). A slow-connecting
    // opponent must find their chair empty, not occupied by a bot.
    const room = await colyseus.createRoom<ArenaState>("arena", {
      gamemode: "gamemode.duel-1v1",
      minPlayers: 2,
      botBackfillMs: 0,
      botProfile: "bot.aggressive",
      matchmaking: true,
    });
    const c1 = await colyseus.connectTo(room, { shipId: "ship.interceptor" });

    await new Promise((resolve) => setTimeout(resolve, 60));
    await advance(room, 40);

    const botKeys = [...room.state.players.keys()].filter((k) => k.startsWith("bot-"));
    expect(botKeys.length).toBe(0);
    expect(room.state.matchPhase).not.toBe("live"); // still waiting for the real opponent

    await c1.leave();
  });

  it("holds a content-edited hot-rod bot to the same order budget as a human (review Finding 3)", async () => {
    // `driveBots` validated bot orders but never charged them to the rate
    // budget, on the grounds that the shipped profiles are slow. The schema
    // permits a 16 ms decision interval, though, and one decision can emit a
    // flight order plus a toggle per hardpoint — so a Behavior Editor tweak
    // alone could put a bot far above the cap a player is held to.
    const base = configs.get<BotprofileConfig>("botprofile", "bot.aggressive")!;
    const hotRod = {
      ...base,
      id: "bot.hotrod-test",
      name: "Hot Rod",
      decisionIntervalMs: 16, // one sim tick: the fastest the schema allows
      orderJitterMs: 0,
      // Re-send on the tiniest stick change, defeating the driver's own gate.
      flight: { ...base.flight, turnEpsilon: 0, throttleEpsilon: 0 },
    };
    expect(configs.replace(hotRod).ok).toBe(true);

    const room = await colyseus.createRoom<ArenaState>("arena", {
      gamemode: "gamemode.duel-1v1",
      minPlayers: 2,
      botBackfillMs: 0,
      botProfile: "bot.hotrod-test",
    });
    const c1 = await colyseus.connectTo(room, { shipId: "ship.interceptor" });
    await new Promise((resolve) => setTimeout(resolve, 60));
    await advance(room, 1);
    expect(room.state.matchPhase).toBe("live");

    // Count what actually reaches the sim. The human client sends nothing, so
    // every applied order is the bot's.
    const serverRoom = colyseus.getRoomById(room.roomId) as unknown as {
      sim: { applyOrder: (id: number, order: unknown) => void };
    };
    const appliedAt: number[] = [];
    const original = serverRoom.sim.applyOrder.bind(serverRoom.sim);
    serverRoom.sim.applyOrder = (id: number, order: unknown): void => {
      appliedAt.push(Date.now());
      original(id, order);
    };

    const startedAt = Date.now();
    await advance(room, 90); // ~3 s of sim at 30 Hz
    serverRoom.sim.applyOrder = original;
    const elapsedS = (Date.now() - startedAt) / 1000;

    // The bot was genuinely trying to flood: a 16 ms cadence with zero epsilons
    // wants a flight order on nearly every decision, ~62/s.
    expect(appliedAt.length).toBeGreaterThan(10);
    expect(elapsedS).toBeGreaterThan(1);

    // The budget is the human one — a fixed one-second window, so the honest
    // bound is the same one a human client gets: at most `cap` per window, with
    // a window's worth of slack for the partial windows at each end.
    const cap = configs.getAll<TuningConfig>("tuning")[0]?.maxOrdersPerSec ?? 20;
    expect(appliedAt.length).toBeLessThanOrEqual(Math.ceil(elapsedS) * cap + cap);
    // ...and far below what the profile asked for, which is the actual point.
    expect(appliedAt.length / elapsedS).toBeLessThan(1000 / 16);

    await c1.leave();
  });

  it("reflects a player's ship upgrades in the replicated maxima (Finding 3)", async () => {
    usersRepo.create({ id: "u-upg", email: null, pass_hash: null, guest_token: "gt-upg" });
    seedNewUser(configs, "u-upg", "Upgraded");
    // Buy the full hull track (5 purchases) → resolved hullMax = 120 + 90 = 210.
    shipUpgradesRepo.setTrackLevel("u-upg", "ship.interceptor", "hull", 5);
    const token = signAccessToken("u-upg");

    const room = await colyseus.createRoom<ArenaState>("arena", { gamemode: "gamemode.duel-1v1", minPlayers: 1 });
    const c = await colyseus.connectTo(room, { token, shipId: "ship.interceptor" });
    await advance(room, 1);

    const ps = room.state.players.get(c.sessionId)!;
    expect(ps.hullMax).toBeCloseTo(210, 3);
    expect(ps.hull).toBeCloseTo(210, 3); // spawns at full resolved hull
    // Heat and energy are PER MODULE since 2026-08-07: the replicated maxima a
    // client needs are the module stores, not a ship-wide pair.
    const laser = ps.modules[0]!;
    expect(laser.heatCapacity).toBeCloseTo(100, 3);
    expect(laser.heat).toBe(0);

    await c.leave();
  });

  it("records a match_results row with room id, player and bot counts (6.8)", async () => {
    const db = getDb();
    const before = (db.prepare("SELECT COUNT(*) AS n FROM match_results").get() as { n: number }).n;

    // One human + one backfilled bot: player_count 1, bot_count 1.
    const room = await colyseus.createRoom<ArenaState>("arena", {
      gamemode: "gamemode.duel-1v1",
      botBackfillMs: 0,
    });
    const c1 = await colyseus.connectTo(room);
    for (let i = 0; i < 40 && room.state.matchPhase !== "live"; i++) await advance(room, 1);
    expect(room.state.matchPhase).toBe("live");

    // Kill the bot outright so the match ends by elimination.
    const serverRoom = colyseus.getRoomById(room.roomId) as unknown as {
      sim: { world: { shipCores: Map<number, { hull: number }> } };
    };
    const playerEntity = room.state.players.get(c1.sessionId)!.entityId;
    for (const [key, ps] of room.state.players) {
      if (key === c1.sessionId) continue;
      serverRoom.sim.world.shipCores.get(ps.entityId)!.hull = 0;
    }

    for (let i = 0; i < 400 && room.state.matchPhase !== "ended"; i++) await advance(room, 1);
    await new Promise((r) => setTimeout(r, 200));
    expect(room.state.matchPhase).toBe("ended");

    const rows = db
      .prepare("SELECT * FROM match_results ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .all() as Array<{ mode: string; room_id: string | null; player_count: number; bot_count: number; duration_s: number }>;
    expect((db.prepare("SELECT COUNT(*) AS n FROM match_results").get() as { n: number }).n).toBe(before + 1);
    const row = rows[0]!;
    expect(row.mode).toBe("gamemode.duel-1v1");
    expect(row.room_id).toBe(room.roomId);
    expect(row.player_count).toBe(1);
    expect(row.bot_count).toBe(1);
    expect(row.duration_s).toBeGreaterThan(0);
    expect(playerEntity).toBeGreaterThanOrEqual(0);

    await c1.leave();
  });

  it("registers itself in the metrics registry and unregisters on dispose (6.6)", async () => {
    const metrics = getMetrics();
    const roomsBefore = metrics.snapshot().roomCount;

    const room = await colyseus.createRoom<ArenaState>("arena", { gamemode: "gamemode.duel-1v1", minPlayers: 1 });
    const c = await colyseus.connectTo(room);
    await advance(room, 5);

    const during = metrics.snapshot();
    expect(during.roomCount).toBe(roomsBefore + 1);
    const entry = during.rooms.find((r) => r.roomId === room.roomId)!;
    expect(entry.gamemode).toBe("gamemode.duel-1v1");
    expect(entry.clients).toBe(1);
    // The fixed step was timed, and the patch broadcast was measured in bytes.
    expect(entry.tick.count).toBeGreaterThan(0);
    expect(entry.tick.maxMs).toBeGreaterThan(0);
    expect(during.patchBytes).toBeGreaterThan(0);
    expect(during.patches).toBeGreaterThan(0);

    await c.leave();
    await room.disconnect();
    await new Promise((r) => setTimeout(r, 200));

    const after = metrics.snapshot();
    expect(after.rooms.some((r) => r.roomId === room.roomId)).toBe(false);
    // Lifetime tick counters survive the room they came from (6.6 windowing).
    expect(after.tick.count).toBeGreaterThanOrEqual(during.tick.count);
  });
});
