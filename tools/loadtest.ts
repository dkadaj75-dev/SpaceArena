/**
 * Load & soak test harness (ROADMAP §11 6.6).
 *
 *   npm run loadtest              # 20 rooms, 60 s
 *   npm run loadtest:soak         # 20 rooms, 1 h, with leak assertions
 *   npx tsx tools/loadtest.ts --rooms 8 --duration 120 --json out.json
 *
 * ## Shape
 *
 * The server runs in a **child process** and the simulated clients run here.
 * That split is the whole reason the numbers mean anything: twenty colyseus.js
 * clients each hold a decoded copy of the room state and re-decode it 20 times a
 * second, so measuring RSS in a process that contains both would report the load
 * generator's memory as if it were the server's. The harness reaches across the
 * boundary with `GET /metrics` (see server/src/api/metrics.ts), whose counters
 * are cumulative — every window below is a diff of two polls.
 *
 * ## What a "room" is here
 *
 * One simulated client creates a `duel-1v1` room with `botBackfillMs: 0`. The
 * room is short of its two players, so backfill immediately spawns a
 * BotDriver-driven opponent and the match goes live: a real 30 Hz simulation
 * with real combat, real module state machines and real patch encoding. The
 * simulated client then issues orders at human cadence (a move every ~2 s, a
 * module toggle every ~8 s, an occasional target change) — never faster, because
 * the point is to measure the server under plausible load rather than to test
 * its rate limiter.
 *
 * When a match ends the server locks the room, disconnects everyone after its
 * grace period and disposes. The harness immediately creates a replacement, so
 * the room count stays at N for the whole run. That churn is deliberate: an
 * hour of create/dispose cycles is precisely what surfaces a leaked timer, a
 * retained bot driver or a room that never leaves the registry.
 *
 * ## Exit code
 *
 * 0 when every assertion passed (or was honestly reported as
 * "insufficient-data" on a short run), 1 when the teardown audit failed or a
 * soak-length run detected memory growth / tick degradation.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client, type Room } from "colyseus.js";
import { SIM_TICK_RATE } from "../shared/src/constants.js";
import {
  analyzeMemoryTrend,
  analyzeTickTrend,
  auditTeardown,
  mb,
  type MemorySample,
  type TickWindow,
} from "../server/src/telemetry/soak.js";
import {
  diffHistogram,
  emptyHistogram,
  histogramAvg,
  histogramQuantile,
  type HistogramSnapshot,
} from "../server/src/telemetry/metrics.js";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const SERVER_ENTRY = path.join(REPO_ROOT, "server", "src", "index.ts");

/**
 * How often a generated pilot changes its stick/throttle. `flight` orders are
 * level-triggered (FLIGHT.md §1), so this is the ORDER rate, not the input
 * rate: between two of these the server keeps integrating the last state, which
 * is exactly the traffic profile a real client produces.
 */
const FLIGHT_INTERVAL_MS = 2000;
const TOGGLE_INTERVAL_MS = 8000;
/** Cadence of the driver scheduler. One timer for every room, not one per order. */
const SCHEDULER_TICK_MS = 250;
/** Backoff before re-creating a room after the previous match ended or a join failed. */
const RECREATE_DELAY_MS = 500;

/**
 * Id of the generated load gamemode. It is **not** part of the shipped content
 * pack — see {@link prepareContentPack} for why, and for how it is injected.
 */
const LOADTEST_GAMEMODE = "gamemode.loadtest";

interface Options {
  rooms: number;
  durationS: number;
  gamemode: string;
  /** Backstop time limit baked into the generated load gamemode. */
  matchSeconds: number;
  sampleIntervalS: number;
  port: number;
  /** Attach to an already-running server instead of spawning one. */
  endpoint: string | null;
  keepDb: boolean;
  jsonOut: string | null;
  /**
   * Drive → teardown → audit cycles against the same server process. One cycle
   * is the normal gate. More cycles answer the question a single teardown
   * cannot: RSS that jumps once and then plateaus is the allocator keeping
   * freed pages (a high-water mark), RSS that climbs by the same amount every
   * cycle is a genuine native leak.
   */
  cycles: number;
}

function parseArgs(argv: readonly string[]): Options {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      flags.set(arg.slice(2, eq), arg.slice(eq + 1));
    } else {
      const next = argv[i + 1];
      flags.set(arg.slice(2), next !== undefined && !next.startsWith("--") ? (i++, next) : "1");
    }
  }
  const num = (key: string, fallback: number): number => {
    const raw = flags.get(key);
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`--${key} must be a positive number (got ${JSON.stringify(raw)})`);
    return parsed;
  };
  return {
    rooms: Math.floor(num("rooms", 20)),
    durationS: num("duration", 60),
    gamemode: flags.get("gamemode") ?? LOADTEST_GAMEMODE,
    matchSeconds: num("match-seconds", 180),
    sampleIntervalS: num("sample-interval", 10),
    port: Math.floor(num("port", 2599)),
    endpoint: flags.get("endpoint") ?? null,
    keepDb: flags.get("keep-db") === "1",
    jsonOut: flags.get("json") ?? null,
    cycles: Math.floor(num("cycles", 1)),
  };
}

// ---------------------------------------------------------------------------
// Generated load content pack
// ---------------------------------------------------------------------------

/**
 * Copy the real content pack to a temp directory and add `gamemode.loadtest` to
 * it, returning the new `CONTENT_DIR`.
 *
 * ### Why a generated gamemode rather than the shipped `duel-1v1`
 *
 * `duel-1v1` is `teams: "1v1"` with `eliminationEndsMatch` on, so **the first
 * death ends the match** — a bot duel lasts about four seconds, and the room
 * then spends eight more in the match-end grace period with its simulation
 * stopped. Measured on this repo: twenty `duel-1v1` rooms tick for roughly 30 %
 * of the run, so "20 rooms" answers a question nobody asked ("how does the
 * server cope with six live matches and fourteen idle ones?").
 *
 * The generated mode is the roadmap's *busiest* case instead — `teams: "2v2"`,
 * so one simulated client plus backfill gives four ships per room, exactly the
 * "2v2 with 3 bots" of the Phase 5 exit criteria. Elimination still ends the
 * match, so rooms churn through create/dispose naturally (which is what the leak
 * audit needs), but each match is a real sustained fight rather than a coin flip.
 * `--match-seconds` is only a stalemate backstop.
 *
 * ### Why a temp copy rather than a file in `content/`
 *
 * The lobby builds its Online section from *every* gamemode in the pack
 * (client/src/game/screens/Lobby.ts), so a `gamemode.loadtest` committed to
 * `content/` would appear as a button in the real game. Copying 69 JSON files
 * (~700 KB) per run costs nothing and keeps the shipped pack honest, while
 * staying automatically in sync with it.
 *
 * Pass `--gamemode gamemode.duel-1v1` to skip all of this and measure the
 * shipped mode, churn and all.
 */
function prepareContentPack(options: Options): { dir: string; cleanup: () => void } | null {
  if (options.gamemode !== LOADTEST_GAMEMODE) return null;

  const root = mkdtempSync(path.join(tmpdir(), "space-arena-loadtest-content-"));
  const source = path.join(REPO_ROOT, "content");
  cpSync(source, root, { recursive: true });

  const gamemode = {
    id: LOADTEST_GAMEMODE,
    type: "gamemode",
    version: 1,
    name: "Load Test",
    teams: "2v2",
    // The rock field on purpose: 46 mesh-collided asteroids and a radius-126
    // spatial hash is the shape production actually runs, and it is the case the
    // per-tick collision/broadphase cost has to survive.
    defaultArena: "arena.ring-nebula",
    // Backstop only: elimination normally ends the match first.
    winCondition: { type: "timeLimit", seconds: options.matchSeconds },
    eliminationEndsMatch: true,
    respawn: { enabled: true, delay: 4 },
    boundaryRule: { type: "damage", damagePerSec: 8 },
    rewards: { win: 0, loss: 0, perKill: 0 },
    bots: { defaultProfile: "bot.aggressive", defaultShip: "ship.interceptor", backfillWaitMs: 0 },
  };

  const relPath = "gamemodes/loadtest.json";
  mkdirSync(path.join(root, "gamemodes"), { recursive: true });
  writeFileSync(path.join(root, relPath), JSON.stringify(gamemode, null, 2));

  const manifestPath = path.join(root, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { files: string[] };
  manifest.files.push(relPath);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  return { dir: root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------
// Server child process
// ---------------------------------------------------------------------------

interface ServerHandle {
  child: ChildProcess | null;
  httpBase: string;
  wsBase: string;
  dbPath: string | null;
  stop(): Promise<void>;
}

async function startServer(options: Options): Promise<ServerHandle> {
  if (options.endpoint) {
    const url = new URL(options.endpoint);
    const httpBase = `${url.protocol === "wss:" ? "https:" : url.protocol === "ws:" ? "http:" : url.protocol}//${url.host}`;
    console.log(`attaching to running server at ${options.endpoint}`);
    return { child: null, httpBase, wsBase: options.endpoint, dbPath: null, stop: async () => {} };
  }

  // A real on-disk database, not `:memory:` — the run should exercise the same
  // migrations, prepared statements and telemetry writes production does, and a
  // memory database would quietly hide any allocation they cause.
  const dbDir = mkdtempSync(path.join(tmpdir(), "space-arena-loadtest-"));
  const dbPath = path.join(dbDir, "loadtest.db");
  const pack = prepareContentPack(options);
  if (pack) console.log(`generated load content pack at ${pack.dir} (${LOADTEST_GAMEMODE}, 2v2, ${options.matchSeconds}s backstop)`);

  // cwd is the server workspace, matching `npm run dev -w server`: tsx resolves
  // the nearest tsconfig.json from there, and only server/tsconfig.json turns on
  // `experimentalDecorators` — without it `@colyseus/schema`'s `@type()`
  // decorators fail at import time.
  const child = spawn(process.execPath, ["--import", "tsx", SERVER_ENTRY], {
    cwd: path.join(REPO_ROOT, "server"),
    env: {
      ...process.env,
      NODE_ENV: "development",
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --expose-gc`.trim(),
      PORT: String(options.port),
      SPACE_ARENA_DB: dbPath,
      // Simulated clients have no accounts; anonymous joins are dev-only and
      // this child is explicitly a dev process.
      DEV_ALLOW_ANON: "1",
      // Exercise the 6.8 sampler for real during the run.
      SPACE_ARENA_TELEMETRY: "1",
      SERVE_CLIENT: "0",
      // Errors only: the child logs a warning on every anonymous join, which at
      // twenty rooms churning for an hour would bury the report. `LOG=info npm
      // run loadtest` turns the server's own logging back on.
      LOG: process.env.LOG ?? "error",
      ...(pack ? { CONTENT_DIR: pack.dir } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout?.on("data", (chunk: Buffer) => process.stdout.write(`  [server] ${chunk.toString()}`));
  child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(`  [server] ${chunk.toString()}`));

  const httpBase = `http://127.0.0.1:${options.port}`;
  await waitForHealth(httpBase, child);

  return {
    child,
    httpBase,
    wsBase: `ws://127.0.0.1:${options.port}`,
    dbPath,
    async stop() {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await Promise.race([once(child, "exit"), delay(5000)]);
        if (child.exitCode === null) child.kill("SIGKILL");
      }
      pack?.cleanup();
      if (!options.keepDb) rmSync(dbDir, { recursive: true, force: true });
      else console.log(`\nkept load-test database at ${dbPath}`);
    },
  };
}

async function waitForHealth(httpBase: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited with code ${child.exitCode} before becoming healthy`);
    try {
      const res = await fetch(`${httpBase}/health`);
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await delay(250);
  }
  throw new Error("server did not become healthy within 60 s");
}

// ---------------------------------------------------------------------------
// /metrics polling
// ---------------------------------------------------------------------------

interface RoomMetricsJson {
  roomId: string;
  gamemode: string;
  clients: number;
  tick: HistogramSnapshot;
  patchBytes: number;
  patches: number;
  bytesOut: number;
}

interface MetricsJson {
  now: number;
  uptimeMs: number;
  roomCount: number;
  clientCount: number;
  rooms: RoomMetricsJson[];
  tick: HistogramSnapshot;
  patchBytes: number;
  patches: number;
  bytesOut: number;
  memory: { rss: number; heapUsed: number; heapTotal: number; external: number; arrayBuffers: number };
  lifetime: { roomsCreated: number; roomsDisposed: number };
}

async function pollMetrics(httpBase: string, options: { gc?: boolean } = {}): Promise<MetricsJson> {
  const res = await fetch(`${httpBase}/metrics${options.gc ? "?gc=1" : ""}`);
  if (!res.ok) throw new Error(`GET /metrics -> ${res.status}`);
  return (await res.json()) as MetricsJson;
}

// ---------------------------------------------------------------------------
// Simulated client
// ---------------------------------------------------------------------------

interface DriverStats {
  roomsCreated: number;
  ordersSent: number;
  joinFailures: number;
}

/**
 * Holds exactly one live room, re-creating it whenever the current match ends,
 * until {@link stop} is called. One of these per room in the target count.
 */
class RoomDriver {
  private room: Room | null = null;
  private stopped = false;
  private seq = 1;
  private nextFlightAt = 0;
  private nextToggleAt = 0;
  private reconnectAt = 0;
  readonly stats: DriverStats = { roomsCreated: 0, ordersSent: 0, joinFailures: 0 };

  constructor(
    private readonly client: Client,
    private readonly gamemode: string,
    private readonly index: number,
  ) {}

  async start(): Promise<void> {
    await this.createRoom();
  }

  private async createRoom(): Promise<void> {
    if (this.stopped) return;
    try {
      const room = await this.client.create(ARENA_ROOM_NAME, {
        gamemode: this.gamemode,
        // Backfill the empty slot immediately: without a bot the room sits in
        // `waiting` and never ticks, which would measure nothing at all.
        botBackfillMs: 0,
        // Deterministic-but-distinct fights, so twenty rooms are not twenty
        // copies of the same engagement.
        seed: 1000 + this.index,
      });
      if (this.stopped) {
        await room.leave(true);
        return;
      }
      this.room = room;
      this.stats.roomsCreated++;
      // A real client subscribes to orderAck/simEvent/fireEvent. Registering a
      // catch-all both silences colyseus.js's "not registered" warnings and
      // makes the generator decode the same message stream a player would.
      room.onMessage("*", () => {});
      // Stagger the first order so twenty rooms do not all fire on the same tick.
      const now = Date.now();
      this.nextFlightAt = now + jitter(FLIGHT_INTERVAL_MS);
      this.nextToggleAt = now + jitter(TOGGLE_INTERVAL_MS);

      room.onLeave(() => {
        this.room = null;
        this.reconnectAt = Date.now() + RECREATE_DELAY_MS;
      });
      room.onError(() => {
        this.room = null;
        this.reconnectAt = Date.now() + RECREATE_DELAY_MS;
      });
    } catch {
      this.stats.joinFailures++;
      this.room = null;
      this.reconnectAt = Date.now() + RECREATE_DELAY_MS * 4;
    }
  }

  /** Called by the shared scheduler. Issues at most one order per kind per pass. */
  pump(now: number): void {
    if (this.stopped) return;
    if (!this.room) {
      if (this.reconnectAt !== 0 && now >= this.reconnectAt) {
        this.reconnectAt = 0;
        void this.createRoom();
      }
      return;
    }
    if (now >= this.nextFlightAt) {
      this.nextFlightAt = now + jitter(FLIGHT_INTERVAL_MS);
      // Throttle up and hold a turn: the ship keeps flying (and keeps colliding,
      // and keeps entering other pilots' sensor cones) between orders, so the
      // server does the same per-tick work a real match does. No target orders —
      // targeting is the sim's, automatically (FLIGHT.md §2).
      this.send({
        kind: "flight",
        throttle: 0.4 + Math.random() * 0.6,
        turn: Math.random() * 2 - 1,
        boost: Math.random() < 0.2,
        fire: true,
      });
    }
    if (now >= this.nextToggleAt) {
      this.nextToggleAt = now + jitter(TOGGLE_INTERVAL_MS);
      this.send({ kind: "moduleToggle", hardpointIndex: Math.floor(Math.random() * 3) });
    }
  }

  private send(order: unknown): void {
    try {
      this.room?.send("order", { seq: this.seq++, order });
      this.stats.ordersSent++;
    } catch {
      // A send racing a disconnect is expected during match teardown.
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const room = this.room;
    this.room = null;
    if (!room) return;
    try {
      await room.leave(true);
    } catch {
      // already gone
    }
  }
}

const ARENA_ROOM_NAME = "arena";

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

interface Window {
  atMs: number;
  roomCount: number;
  /**
   * Rooms whose simulation actually advanced during this window. Lower than
   * `roomCount` whenever rooms sit in `waiting` or in the post-match grace, so
   * the two together show the duty cycle instead of hiding it behind a room
   * count that only proves objects exist.
   */
  liveRooms: number;
  clientCount: number;
  tick: HistogramSnapshot;
  patchBytes: number;
  patches: number;
  bytesOut: number;
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
  elapsedMs: number;
  /** 1-based drive cycle this window belongs to (always 1 unless `--cycles`). */
  cycle: number;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  // Long enough that a "no verdict" answer is itself a failure. The trend
  // analysis drops the first third of a run as warm-up and needs seven minutes
  // of fitted window, so ~11 minutes is the true floor; 15 leaves margin.
  const soakLength = options.durationS >= 900;

  console.log(
    [
      "",
      "Orion's Arm load test (ROADMAP §11 6.6)",
      `  rooms:           ${options.rooms}`,
      `  duration:        ${options.durationS}s${soakLength ? " (soak: leak assertions enabled)" : ""}`,
      `  gamemode:        ${options.gamemode}`,
      `  sample interval: ${options.sampleIntervalS}s`,
      "",
    ].join("\n"),
  );

  const server = await startServer(options);
  let exitCode = 0;

  try {
    const baseline = await pollMetrics(server.httpBase, { gc: true });
    console.log(`baseline: rss ${mb(baseline.memory.rss)}, heapUsed ${mb(baseline.memory.heapUsed)}, rooms ${baseline.roomCount}\n`);

    const client = new Client(server.wsBase);
    const runStartedAt = Date.now();
    const windows: Window[] = [];
    const drivers: RoomDriver[] = [];
    const cycleFinals: MetricsJson[] = [];
    let roomsGone = true;

    for (let cycle = 1; cycle <= options.cycles; cycle++) {
      if (options.cycles > 1) console.log(`— cycle ${cycle}/${options.cycles} —`);
      const cycleDrivers = Array.from(
        { length: options.rooms },
        (_, i) => new RoomDriver(client, options.gamemode, i),
      );
      drivers.push(...cycleDrivers);

      // Ramp in rather than stampede: twenty simultaneous room creations would
      // measure the matchmaker's cold start, not the steady state we care about.
      for (const driver of cycleDrivers) {
        await driver.start();
        await delay(50);
      }

      const deadline = Date.now() + options.durationS * 1000;
      const scheduler = setInterval(() => {
        const now = Date.now();
        for (const driver of cycleDrivers) driver.pump(now);
      }, SCHEDULER_TICK_MS);

      let previous = await pollMetrics(server.httpBase);
      let previousAt = Date.now();

      while (Date.now() < deadline) {
        await delay(Math.min(options.sampleIntervalS * 1000, Math.max(0, deadline - Date.now())));
        const current = await pollMetrics(server.httpBase);
        const now = Date.now();
        const previousTicks = new Map(previous.rooms.map((r) => [r.roomId, r.tick.count]));
        const window: Window = {
          atMs: now,
          elapsedMs: now - runStartedAt,
          cycle,
          roomCount: current.roomCount,
          liveRooms: current.rooms.filter((r) => r.tick.count > (previousTicks.get(r.roomId) ?? 0)).length,
          clientCount: current.clientCount,
          tick: diffHistogram(current.tick, previous.tick),
          // Byte counters are per-room and rooms churn, so a naive diff of the
          // process total goes negative whenever a room disposes. Clamp at zero
          // and note that bytes from a room that died mid-window are lost with it
          // — an under-count of at most one match's tail.
          patchBytes: Math.max(0, current.patchBytes - previous.patchBytes),
          patches: Math.max(0, current.patches - previous.patches),
          bytesOut: Math.max(0, current.bytesOut - previous.bytesOut),
          rss: current.memory.rss,
          heapUsed: current.memory.heapUsed,
          heapTotal: current.memory.heapTotal,
          external: current.memory.external,
          arrayBuffers: current.memory.arrayBuffers,
        };
        windows.push(window);
        printWindow(window, now - previousAt);
        previous = current;
        previousAt = now;
      }

      clearInterval(scheduler);
      console.log(`\ntearing down clients${options.cycles > 1 ? ` (cycle ${cycle})` : ""}…`);
      await Promise.all(cycleDrivers.map((d) => d.stop()));

      roomsGone = (await waitForRoomCount(server.httpBase, 0, 45_000)) && roomsGone;
      // Two collections with a pause between: the first frees the rooms, the
      // second frees whatever the first made unreachable.
      await pollMetrics(server.httpBase, { gc: true });
      await delay(1500);
      cycleFinals.push(await pollMetrics(server.httpBase, { gc: true }));
    }

    const final = cycleFinals[cycleFinals.length - 1]!;
    exitCode = report({
      options,
      soakLength,
      windows,
      baseline,
      cycleFinals,
      final,
      roomsGone,
      drivers,
      startedAt: runStartedAt,
    });

    if (options.jsonOut) {
      writeFileSync(
        options.jsonOut,
        JSON.stringify({ options, baseline, final, windows: windows.map(serializeWindow) }, null, 2),
      );
      console.log(`\nraw samples written to ${options.jsonOut}`);
    }
  } finally {
    await server.stop();
  }

  process.exit(exitCode);
}

function printWindow(window: Window, spanMs: number): void {
  const seconds = spanMs / 1000;
  const perRoom = Math.max(1, window.roomCount);
  console.log(
    [
      `t+${String(Math.round(window.elapsedMs / 1000)).padStart(4)}s`,
      `rooms ${String(window.roomCount).padStart(3)} (${String(window.liveRooms).padStart(3)} live)`,
      `tick avg ${histogramAvg(window.tick).toFixed(3)}ms`,
      `p95 ${histogramQuantile(window.tick, 0.95).toFixed(3)}ms`,
      `max ${histogramQuantile(window.tick, 1).toFixed(2)}ms`,
      `patch ${(window.patchBytes / seconds / perRoom / 1024).toFixed(1)} KB/s/room`,
      `rss ${mb(window.rss)}`,
      `heap ${mb(window.heapUsed)}`,
    ].join("  "),
  );
}

function serializeWindow(window: Window): Record<string, number> {
  return {
    elapsedMs: window.elapsedMs,
    roomCount: window.roomCount,
    liveRooms: window.liveRooms,
    clientCount: window.clientCount,
    tickCount: window.tick.count,
    tickAvgMs: histogramAvg(window.tick),
    tickP95Ms: histogramQuantile(window.tick, 0.95),
    tickMaxMs: histogramQuantile(window.tick, 1),
    patchBytes: window.patchBytes,
    patches: window.patches,
    bytesOut: window.bytesOut,
    rss: window.rss,
    heapUsed: window.heapUsed,
  };
}

interface ReportInput {
  options: Options;
  soakLength: boolean;
  windows: Window[];
  baseline: MetricsJson;
  /** Post-GC teardown snapshot for each churn cycle (retained for JSON/report extensions). */
  cycleFinals: MetricsJson[];
  final: MetricsJson;
  roomsGone: boolean;
  drivers: RoomDriver[];
  startedAt: number;
}

/** Print the run report. Returns the process exit code. */
function report(input: ReportInput): number {
  const { options, soakLength, windows, baseline, final, roomsGone, drivers } = input;

  const total = windows.reduce((acc, w) => mergeInto(acc, w.tick), emptyHistogram());
  const totalSpanS = windows.length === 0 ? 0 : (windows[windows.length - 1]!.elapsedMs - (windows[0]!.elapsedMs - options.sampleIntervalS * 1000)) / 1000;
  const patchBytes = windows.reduce((sum, w) => sum + w.patchBytes, 0);
  const bytesOut = windows.reduce((sum, w) => sum + w.bytesOut, 0);
  const meanRooms = windows.length === 0 ? 0 : windows.reduce((sum, w) => sum + w.roomCount, 0) / windows.length;
  const peakRooms = windows.reduce((peak, w) => Math.max(peak, w.roomCount), 0);
  const meanLive = windows.length === 0 ? 0 : windows.reduce((sum, w) => sum + w.liveRooms, 0) / windows.length;
  const ordersSent = drivers.reduce((sum, d) => sum + d.stats.ordersSent, 0);
  const joinFailures = drivers.reduce((sum, d) => sum + d.stats.joinFailures, 0);

  const line = "─".repeat(78);
  console.log(`\n${line}\nRESULTS\n${line}`);
  console.log(`  rooms held:         ${meanRooms.toFixed(1)} mean, ${peakRooms} peak (target ${options.rooms})`);
  console.log(`  rooms simulating:   ${meanLive.toFixed(1)} mean (${meanRooms === 0 ? 0 : Math.round((meanLive / meanRooms) * 100)}% duty cycle)`);
  console.log(`  matches played:     ${final.lifetime.roomsCreated} created, ${final.lifetime.roomsDisposed} disposed`);
  console.log(`  orders sent:        ${ordersSent}${joinFailures > 0 ? `  (join failures: ${joinFailures})` : ""}`);
  console.log(`  sim ticks measured: ${total.count}`);
  // The generator's own footprint, printed so it is never mistaken for the
  // server's. It runs 20 Hz schema decoding per room and is not GC-tuned; a
  // large number here says nothing about the server under test.
  console.log(`  generator rss:      ${mb(process.memoryUsage().rss)} (this process, not the server)`);
  console.log("");
  console.log(`  tick avg:           ${histogramAvg(total).toFixed(3)} ms`);
  console.log(`  tick p50:           ${histogramQuantile(total, 0.5).toFixed(3)} ms`);
  console.log(`  tick p95:           ${histogramQuantile(total, 0.95).toFixed(3)} ms`);
  console.log(`  tick p99:           ${histogramQuantile(total, 0.99).toFixed(3)} ms`);
  console.log(`  tick max:           ${total.maxMs.toFixed(3)} ms  (budget ${(1000 / SIM_TICK_RATE).toFixed(1)} ms per step)`);
  if (totalSpanS > 0 && meanRooms > 0) {
    const patches = windows.reduce((sum, w) => sum + w.patches, 0);
    console.log("");
    console.log(`  patch bytes/s:      ${(patchBytes / totalSpanS / 1024).toFixed(1)} KB/s total, ${(patchBytes / totalSpanS / meanRooms / 1024).toFixed(2)} KB/s/room`);
    console.log(`  egress bytes/s:     ${(bytesOut / totalSpanS / 1024).toFixed(1)} KB/s total, ${(bytesOut / totalSpanS / meanRooms / 1024).toFixed(2)} KB/s/room`);
    console.log(`  patch writes:       ${patches} (${(patches / totalSpanS / meanRooms).toFixed(1)}/s/room, ${patches === 0 ? 0 : Math.round(patchBytes / patches)} bytes each)`);
  }

  // --- assertions ---------------------------------------------------------
  const memorySamples: MemorySample[] = windows.map((w) => ({ atMs: w.elapsedMs, rss: w.rss, heapUsed: w.heapUsed }));
  const tickWindows: TickWindow[] = windows.map((w) => ({
    atMs: w.elapsedMs,
    avgMs: histogramAvg(w.tick),
    p95Ms: histogramQuantile(w.tick, 0.95),
    count: w.tick.count,
  }));

  const memory = analyzeMemoryTrend(memorySamples);
  const tick = analyzeTickTrend(tickWindows);
  const teardown = auditTeardown(
    { roomCount: baseline.roomCount, rss: baseline.memory.rss, heapUsed: baseline.memory.heapUsed },
    { roomCount: final.roomCount, rss: final.memory.rss, heapUsed: final.memory.heapUsed },
  );

  console.log(`\n${line}\nSOAK ASSERTIONS\n${line}`);
  console.log(`  [${memory.verdict.toUpperCase()}] memory trend — ${memory.reason}`);
  if (memory.samples > 0) {
    console.log(`          fitted ${(memory.durationMs / 60000).toFixed(1)} min of ${memory.samples} sample(s), warm-up prefix dropped`);
    console.log(`          heapUsed ${mb(memory.heap.first)} → ${mb(memory.heap.last)} (peak ${mb(memory.heap.peak)}), slope ${mb(memory.heap.slopeBytesPerHour)}/h, r²=${memory.heap.r2.toFixed(2)}   ← leak signal`);
    console.log(`          rss      ${mb(memory.rss.first)} → ${mb(memory.rss.last)} (peak ${mb(memory.rss.peak)}), slope ${mb(memory.rss.slopeBytesPerHour)}/h, r²=${memory.rss.r2.toFixed(2)}`);
  }
  console.log(`  [${tick.verdict.toUpperCase()}] tick stability — ${tick.reason}`);

  console.log(`\n${line}\nTEARDOWN AUDIT\n${line}`);
  if (!roomsGone) console.log("  WARNING: rooms did not reach 0 within the wait window");
  for (const finding of teardown.findings) console.log(`  ${finding}`);

  const failures: string[] = [];
  if (teardown.verdict === "fail") failures.push("teardown audit");
  if (memory.verdict === "fail") failures.push("memory trend");
  if (tick.verdict === "fail") failures.push("tick stability");
  if (soakLength && memory.verdict === "insufficient-data") failures.push("memory trend (soak run produced no verdict)");

  console.log("");
  if (failures.length === 0) {
    console.log("PASS — no leaks or degradation detected.\n");
    return 0;
  }
  console.log(`FAIL — ${failures.join(", ")}\n`);
  return 1;
}

function mergeInto(acc: HistogramSnapshot, add: HistogramSnapshot): HistogramSnapshot {
  return {
    count: acc.count + add.count,
    sumMs: acc.sumMs + add.sumMs,
    maxMs: Math.max(acc.maxMs, add.maxMs),
    buckets: acc.buckets.map((v, i) => v + (add.buckets[i] ?? 0)),
  };
}

async function waitForRoomCount(httpBase: string, target: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const metrics = await pollMetrics(httpBase);
    if (metrics.roomCount <= target) return true;
    await delay(500);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function once(child: ChildProcess, event: string): Promise<void> {
  return new Promise((resolve) => child.once(event, () => resolve()));
}

/** ±25 % around `base`, so N drivers never synchronise into a thundering herd. */
function jitter(base: number): number {
  return base * (0.75 + Math.random() * 0.5);
}

main().catch((err) => {
  console.error("\nload test failed:", err);
  process.exit(1);
});
