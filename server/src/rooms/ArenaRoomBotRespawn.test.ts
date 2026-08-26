import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { ColyseusTestServer } from "@colyseus/testing";
import { SIM_TICK_RATE, setGlobalLogLevel, type ConfigService, type TuningConfig } from "@space-arena/shared";
import { loadContent, setConfigService } from "../configService.js";
import { openDatabase, setDb } from "../db/index.js";
import { ArenaRoom, internalArenaCreateOptions } from "./ArenaRoom.js";
import type { ArenaState } from "./state/ArenaState.js";

setGlobalLogLevel("error");

let colyseus: ColyseusTestServer;
let configs: ConfigService;

/**
 * Advance the server room's fixed sim by AT LEAST `n` ticks. Tick-counted, not
 * fire-counted: the room's fixed-timestep accumulator may run 0 or 2 sim steps
 * on any single timer fire, so fires are awaited until `n` ticks have run.
 */
async function advance(room: { waitForNextSimulationTick(): Promise<void> }, n: number): Promise<void> {
  // The @colyseus/testing wrapper types rooms as the base Room; the tick probe
  // lives on ArenaRoom, which is what every room in this suite actually is.
  const probe = room as unknown as { totalSimTicks: number };
  const target = probe.totalSimTicks + n;
  while (probe.totalSimTicks < target) await room.waitForNextSimulationTick();
}

beforeAll(async () => {
  process.env.DEV_ALLOW_ANON = "1";
  configs = await loadContent();
  // This test measures respawn driving, not the countdown — start live at once.
  const tuning = configs.getAll<TuningConfig>("tuning")[0]!;
  const replaced = configs.replace({ ...tuning, matchCountdownSec: 0 });
  if (!replaced.ok) throw new Error("failed to zero matchCountdownSec for tests");
  setConfigService(configs);
  setDb(openDatabase(":memory:"));
  const server = new Server({ transport: new WebSocketTransport() });
  server.define("arena", ArenaRoom).filterBy(["gamemode"]);
  // NOT boot(server): that always listens on the default test port, and this
  // file runs in parallel with ArenaRoom.test.ts, which owns it already.
  await server.listen(2599);
  colyseus = new ColyseusTestServer(server);
  const createRoom = colyseus.createRoom.bind(colyseus);
  colyseus.createRoom = ((roomName: string, options: Record<string, unknown> = {}) =>
    createRoom(roomName, {
      ...internalArenaCreateOptions(String(options["gamemode"]), options),
      ...(typeof options["arena"] === "string" ? { arena: options["arena"] } : {}),
    })) as typeof colyseus.createRoom;
});

afterAll(async () => {
  await colyseus.shutdown();
});

afterEach(async () => {
  await colyseus.cleanup();
});

/** The room internals this regression needs to reach past the public surface. */
interface RoomInternals {
  botDrivers: Map<number, unknown>;
  sim: {
    hasShip(entityId: number): boolean;
    releaseLaunchSequences(): void;
    world: {
      shipCores: Map<number, { hull: number }>;
      transforms: Map<number, { pos: { x: number; y: number; z: number } }>;
      flightStates: Map<number, { throttle: number }>;
    };
  };
}

/**
 * Regression for the live "bots become inactive" report (owner 2026-08-16):
 * bots parked motionless at their spawn pads, engines idle, for the rest of the
 * match — three in a row near the base in 5v5 CTF, and a 0.0-unit-displacement
 * bot in plain TDM.
 *
 * Root cause: `driveBots` deleted a bot's driver on the FIRST tick
 * `sim.hasShip()` went false. But a destroyed ship is only absent while it
 * waits out `gamemode.respawn` — the sim then rebuilds it UNDER ITS OLD ENTITY
 * ID — so every bot was orphaned by its first death, and the rebuilt hull
 * integrated its default zero-throttle flight state at the pad forever. The
 * loop now resets and KEEPS the driver, exactly like the client offline host.
 */
describe("ArenaRoom bot drivers across a respawn (owner 2026-08-16)", () => {
  it("keeps a dead bot's driver through the respawn wait and flies the rebuilt hull", async () => {
    const room = await colyseus.createRoom<ArenaState>("arena", {
      gamemode: "gamemode.practice-ctf-5v5",
      botBackfillMs: 0,
    });
    const human = await colyseus.connectTo(room);
    await new Promise((resolve) => setTimeout(resolve, 60));
    await advance(room, 1);
    expect(room.state.matchPhase).toBe("live");

    const internal = colyseus.getRoomById(room.roomId) as unknown as RoomInternals;
    expect(internal.botDrivers.size).toBeGreaterThan(0);
    const botId = [...internal.botDrivers.keys()][0]!;

    // Kill it the way live ships die (boundary damage), so the destruction
    // emits the event the respawn pipeline consumes. The spawnLaunch hold is
    // released first — its damage protection would shrug the boundary off.
    internal.sim.releaseLaunchSequences();
    internal.sim.world.shipCores.get(botId)!.hull = 0.01;
    internal.sim.world.transforms.get(botId)!.pos.x = 30_000;
    for (let tick = 0; tick < 3 * SIM_TICK_RATE && internal.sim.hasShip(botId); tick++) await advance(room, 1);
    expect(internal.sim.hasShip(botId)).toBe(false);

    // THE regression: the driver must survive the respawn wait. The old loop
    // deleted it here, which orphaned the rebuilt hull below.
    await advance(room, 1);
    expect(internal.botDrivers.has(botId)).toBe(true);

    // Wait out `respawn.delay` (4 s in this mode); the sim rebuilds the ship
    // under the same id. Budget in seconds of sim time.
    for (let tick = 0; tick < 8 * SIM_TICK_RATE && !internal.sim.hasShip(botId); tick++) await advance(room, 1);
    expect(internal.sim.hasShip(botId)).toBe(true);

    // A driverless hull keeps its default zero-throttle flight state forever;
    // a driven one receives a flight order within a couple of decision
    // intervals. Waiting on the INTEGRATED state proves an order arrived
    // through the same validation path a human's would.
    let throttled = false;
    for (let tick = 0; tick < 5 * SIM_TICK_RATE && !throttled; tick++) {
      await advance(room, 1);
      if (!internal.sim.hasShip(botId)) continue; // killed again mid-probe: keep waiting
      throttled = (internal.sim.world.flightStates.get(botId)?.throttle ?? 0) > 0;
    }
    expect(throttled, "respawned bot never received a flight order").toBe(true);
    await human.leave();
  }, 60_000);
});
