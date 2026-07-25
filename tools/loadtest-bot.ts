/**
 * `@colyseus/loadtest` bot script (ROADMAP §11 6.6).
 *
 *   npx colyseus-loadtest tools/loadtest-bot.ts --endpoint ws://localhost:2567 \
 *       --room arena --numClients 20 --delay 100
 *
 * This is the roadmap's named tool, driven by its own TUI: it shows live
 * connected/disconnected/failed counts, bytes in and out, and the *generator's*
 * CPU and memory. Use it when you want to watch a run, point it at a deployed
 * server, or push connection counts past what one room can hold.
 *
 * `npm run loadtest` deliberately runs `tools/loadtest.ts` instead, because this
 * entry point cannot do the two things 6.6 actually gates on:
 *
 *   - **Server-side metrics.** `cli()` measures the process it runs in, which is
 *     the load generator. Tick duration, patch bytes and RSS have to come from
 *     the server, and only the harness polls `GET /metrics` for them.
 *   - **A non-interactive report.** `cli()` paints a `blessed` full-screen TUI
 *     and never resolves, so it cannot produce a pass/fail exit code for a soak
 *     run or write a report.
 *
 * Both scripts drive rooms identically — one client per room, bot backfilled,
 * orders at human cadence — so their load is comparable.
 */
import { cli, type Options } from "@colyseus/loadtest";
import { Client, type Room } from "colyseus.js";

/** Matches tools/loadtest.ts, so the two generators produce the same load. */
const ARENA_RADIUS = 90;
const ORDER_RADIUS = ARENA_RADIUS * 0.8;
const MOVE_INTERVAL_MS = 2000;
const TOGGLE_INTERVAL_MS = 8000;

/**
 * One simulated player. Creates its own room so `--numClients N` yields N
 * concurrent matches, each with a backfilled bot opponent, then issues orders
 * until the connection closes.
 */
export async function main(options: Options): Promise<void> {
  const client = new Client(options.endpoint);
  const room: Room = await client.create(options.roomName || "arena", {
    gamemode: "gamemode.duel-1v1",
    botBackfillMs: 0,
    seed: 1000 + options.clientId,
  });

  let seq = 1;
  const send = (order: unknown): void => {
    try {
      room.send("order", { seq: seq++, order });
    } catch {
      // Racing a disconnect at match end is expected.
    }
  };

  const move = setInterval(() => {
    const angle = Math.random() * Math.PI * 2;
    const radius = Math.sqrt(Math.random()) * ORDER_RADIUS;
    send({ kind: "move", target: { x: Math.cos(angle) * radius, z: Math.sin(angle) * radius }, boost: Math.random() < 0.2 });
  }, MOVE_INTERVAL_MS);

  const toggle = setInterval(() => {
    send({ kind: "moduleToggle", hardpointIndex: Math.floor(Math.random() * 3) });
  }, TOGGLE_INTERVAL_MS);

  // The room disconnects everyone a few seconds after the match ends; stop the
  // timers with it rather than sending into a closed socket forever.
  room.onLeave(() => {
    clearInterval(move);
    clearInterval(toggle);
  });
}

cli(main);
