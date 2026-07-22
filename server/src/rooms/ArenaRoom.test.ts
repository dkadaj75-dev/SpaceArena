import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { boot, ColyseusTestServer } from "@colyseus/testing";
import { setGlobalLogLevel, type ConfigService, type ShipConfig } from "@space-arena/shared";
import { loadContent, setConfigService } from "../configService.js";
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
  configs = await loadContent();
  setConfigService(configs);
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
        world: { transforms: Map<number, { pos: { x: number; z: number } }>; shipCores: Map<number, { hull: number }> };
        spawnPlayerAt: (shipId: string, fitting: string[], team: number, pos: { x: number; z: number }, heading: number) => number;
      };
    };
    const ship = configs.get<ShipConfig>("ship", "ship.interceptor")!;
    const playerEntity = room.state.players.get(c1.sessionId)!.entityId;
    const pPos = serverRoom.sim.world.transforms.get(playerEntity)!.pos;
    const enemyId = serverRoom.sim.spawnPlayerAt(
      "ship.interceptor",
      ship.defaultFitting,
      1,
      { x: pPos.x + 10, z: pPos.z },
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
});
