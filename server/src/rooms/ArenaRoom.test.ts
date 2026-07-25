import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { boot, ColyseusTestServer } from "@colyseus/testing";
import { setGlobalLogLevel, type ConfigService, type ShipConfig } from "@space-arena/shared";
import { loadContent, setConfigService } from "../configService.js";
import { getDb, openDatabase, setDb } from "../db/index.js";
import { getMetrics } from "../telemetry/metrics.js";
import { seedNewUser } from "../db/seed.js";
import { fittingsRepo, ownedModulesRepo, profilesRepo, shipUpgradesRepo, usersRepo } from "../db/repos.js";
import { signAccessToken } from "../auth/tokens.js";
import { ArenaRoom } from "./ArenaRoom.js";
import type { ArenaState } from "./state/ArenaState.js";

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
  it("moves ships, acks valid orders, rejects invalid ones, and reflects module toggles", async () => {
    const room = await colyseus.createRoom<ArenaState>("arena", { gamemode: "gamemode.duel-1v1", minPlayers: 2 });
    const c1 = await colyseus.connectTo(room, { shipId: "ship.interceptor" });
    const c2 = await colyseus.connectTo(room);

    await advance(room, 1);
    expect(room.state.matchPhase).toBe("live");

    const p1 = room.state.players.get(c1.sessionId)!;
    const startX = p1.x;
    const startZ = p1.z;

    // Valid move order → accepted ack.
    c1.send("order", { seq: 1, order: { kind: "move", target: { x: -40, z: -40 }, boost: false } });
    const ack1 = await c1.waitForMessage("orderAck");
    expect(ack1).toMatchObject({ seq: 1, accepted: true });

    await advance(room, 20);
    // Server-authoritative position changed.
    expect(p1.x !== startX || p1.z !== startZ).toBe(true);
    expect(p1.lastProcessedSeq).toBe(1);

    // Out-of-bounds move → rejected.
    c1.send("order", { seq: 2, order: { kind: "move", target: { x: 100000, z: 0 }, boost: false } });
    const ack2 = await c1.waitForMessage("orderAck");
    expect(ack2).toMatchObject({ seq: 2, accepted: false, reason: "out-of-bounds" });

    // Malformed order → rejected.
    c1.send("order", { seq: 3, order: { kind: "bogus" } });
    const ack3 = await c1.waitForMessage("orderAck");
    expect(ack3).toMatchObject({ accepted: false, reason: "malformed" });

    // Module toggle → module leaves the retracted (0) state.
    expect(p1.modules[0]!.state).toBe(0);
    c1.send("order", { seq: 4, order: { kind: "moduleToggle", hardpointIndex: 0 } });
    const ack4 = await c1.waitForMessage("orderAck");
    expect(ack4).toMatchObject({ seq: 4, accepted: true });
    await advance(room, 2);
    expect(p1.modules[0]!.state).toBeGreaterThan(0);

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
          transforms: Map<number, { pos: { x: number; z: number }; heading: number }>;
          shipCores: Map<number, { hull: number }>;
        };
        spawnPlayerAt: (shipId: string, fitting: string[], team: number, pos: { x: number; z: number }, heading: number) => number;
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
      { x: pTf.pos.x + Math.cos(pTf.heading) * 10, z: pTf.pos.z + Math.sin(pTf.heading) * 10 },
      Math.PI,
    );
    serverRoom.sim.world.shipCores.get(enemyId)!.hull = 8;

    const fireEvents: unknown[] = [];
    const simEvents: Array<{ type: string }> = [];
    c1.onMessage("fireEvent", (m) => fireEvents.push(m));
    c1.onMessage("simEvent", (m) => simEvents.push(m as { type: string }));

    // Focus the enemy and activate the laser (hardpoint 0).
    c1.send("order", { seq: 1, order: { kind: "target", targetId: enemyId } });
    c1.send("order", { seq: 2, order: { kind: "moduleToggle", hardpointIndex: 0 } });

    // Enough ticks for deploy (1.5s) + a few laser cycles to kill 8 hull.
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

  it("rejects an order targeting a friendly and orders when not yet live", async () => {
    const room = await colyseus.createRoom<ArenaState>("arena", { gamemode: "gamemode.duel-1v1", minPlayers: 2 });
    const c1 = await colyseus.connectTo(room);
    // Only one human joined → still waiting.
    expect(room.state.matchPhase).toBe("waiting");
    c1.send("order", { seq: 1, order: { kind: "move", target: { x: 0, z: 0 }, boost: false } });
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

    // No minPlayers/practiceTarget override → rewardsEligible room. Two real
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

    // Park c1 next to the enemy so LoS + range hold, then fire the laser.
    c1.send("order", { seq: 1, order: { kind: "target", targetId: enemyId } });
    c1.send("order", { seq: 2, order: { kind: "moduleToggle", hardpointIndex: 0 } });

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
    // Seed a user whose fitting leaves hardpoint 1 empty: {0:laser, 2:shield}.
    usersRepo.create({ id: "u-sparse", email: null, pass_hash: null, guest_token: "gt-sparse" });
    seedNewUser(configs, "u-sparse", "Sparse");
    // Own the shield so the fit is legal, then save the sparse fitting.
    ownedModulesRepo.grant("u-sparse", "module.shield-mk1", 1);
    const fit = fittingsRepo.create({
      id: "fit-sparse",
      user_id: "u-sparse",
      ship_id: "ship.interceptor",
      name: "Sparse",
      hardpointMap: { "0": "module.laser-mk1", "2": "module.shield-mk1" },
    });
    const token = signAccessToken("u-sparse");

    const room = await colyseus.createRoom<ArenaState>("arena", { gamemode: "gamemode.duel-1v1", minPlayers: 1 });
    const c = await colyseus.connectTo(room, { token, fittingId: fit.id });
    await advance(room, 1);

    const ps = room.state.players.get(c.sessionId)!;
    // Two fitted modules; the shield answers hardpoint index 2 (not compacted 1).
    expect(ps.modules.length).toBe(2);
    const shieldModule = [...ps.modules].find((m) => m.hardpointIndex === 2)!;
    expect(shieldModule).toBeDefined();

    // Toggling hardpoint index 1 (empty) is rejected.
    c.send("order", { seq: 1, order: { kind: "moduleToggle", hardpointIndex: 1 } });
    const badAck = await c.waitForMessage("orderAck");
    expect(badAck).toMatchObject({ seq: 1, accepted: false, reason: "bad-hardpoint" });

    // Toggling hardpoint index 2 activates the shield module.
    c.send("order", { seq: 2, order: { kind: "moduleToggle", hardpointIndex: 2 } });
    const okAck = await c.waitForMessage("orderAck");
    expect(okAck).toMatchObject({ seq: 2, accepted: true });
    await advance(room, 2);
    const shieldAfter = [...ps.modules].find((m) => m.hardpointIndex === 2)!;
    expect(shieldAfter.state).toBeGreaterThan(0);

    await c.leave();
  });

  it("rejects a join whose fitting references an unowned module (Finding 1)", async () => {
    usersRepo.create({ id: "u-cheat", email: null, pass_hash: null, guest_token: "gt-cheat" });
    seedNewUser(configs, "u-cheat", "Cheater");
    // Craft an illegal fitting directly in the repo: shield-mk2 is a priced module
    // the fresh user does not own (family-legal for hardpoint 2).
    const fit = fittingsRepo.create({
      id: "fit-cheat",
      user_id: "u-cheat",
      ship_id: "ship.interceptor",
      name: "Cheat",
      hardpointMap: { "0": "module.laser-mk1", "2": "module.shield-mk2" },
    });
    const token = signAccessToken("u-cheat");

    const room = await colyseus.createRoom<ArenaState>("arena", { gamemode: "gamemode.duel-1v1", minPlayers: 1 });
    // resolveFitting validates the loadout in onJoin → join rejected.
    await expect(colyseus.connectTo(room, { token, fittingId: fit.id })).rejects.toBeDefined();
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
    expect(bot.displayName).toBe("Aggressive");

    // The bot drives itself through the normal order pipeline: it moves and
    // brings modules online.
    await advance(room, 60);
    const movedOrArmed = bot.x !== 0 || bot.z !== 0 || bot.modules.some((m) => m.state > 0);
    expect(movedOrArmed).toBe(true);

    await c1.leave();
  });

  it("reflects a player's ship upgrades in the replicated maxima (Finding 3)", async () => {
    usersRepo.create({ id: "u-upg", email: null, pass_hash: null, guest_token: "gt-upg" });
    seedNewUser(configs, "u-upg", "Upgraded");
    // Buy the full hull track (5 purchases) → resolved hullMax = 80 + 90 = 170.
    shipUpgradesRepo.setTrackLevel("u-upg", "ship.interceptor", "hull", 5);
    const token = signAccessToken("u-upg");

    const room = await colyseus.createRoom<ArenaState>("arena", { gamemode: "gamemode.duel-1v1", minPlayers: 1 });
    const c = await colyseus.connectTo(room, { token, shipId: "ship.interceptor" });
    await advance(room, 1);

    const ps = room.state.players.get(c.sessionId)!;
    expect(ps.hullMax).toBeCloseTo(170, 3);
    expect(ps.hull).toBeCloseTo(170, 3); // spawns at full resolved hull
    // Base energy/heat maxima also present.
    expect(ps.energyMax).toBeCloseTo(120, 3);
    expect(ps.heatCapacity).toBeCloseTo(100, 3);

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
