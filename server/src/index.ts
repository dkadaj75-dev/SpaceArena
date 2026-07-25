import { createServer } from "node:http";
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { monitor } from "@colyseus/monitor";
import { createLogger, PROTOCOL_VERSION, SIM_TICK_RATE } from "@space-arena/shared";
import { loadContent, setConfigService } from "./configService.js";
import { openDatabase, setDb } from "./db/index.js";
import { describeEnv, envWarnings, getEnv } from "./env.js";
import { createHttpApp } from "./httpApp.js";
import { createMetricsRouter } from "./api/metrics.js";
import { TelemetrySampler } from "./telemetry/sampler.js";
import { ArenaRoom } from "./rooms/ArenaRoom.js";

const log = createLogger("Server");

async function main(): Promise<void> {
  // Env first: a bad PORT/JWT_SECRET/CORS_ORIGIN must fail before we load
  // content, touch the database, or bind a socket (ROADMAP §11 6.3).
  const env = getEnv();
  for (const warning of envWarnings()) log.warn(warning);
  log.info("environment", describeEnv(env));

  // Fail fast on invalid content before opening the socket.
  const configs = await loadContent();
  setConfigService(configs);
  log.info("content loaded", { protocolVersion: PROTOCOL_VERSION, tickRate: SIM_TICK_RATE });

  // Open + migrate the database (dir auto-created, gitignored).
  setDb(openDatabase(env.dbPath));
  log.info("database ready", { dbPath: env.dbPath });

  const app = createHttpApp({
    corsOrigins: env.corsOrigins,
    contentDir: env.contentDir,
    clientDir: env.clientDir,
  });
  const httpServer = createServer(app);
  const gameServer = new Server({
    transport: new WebSocketTransport({ server: httpServer }),
  });

  gameServer.define("arena", ArenaRoom).filterBy(["gamemode"]);

  if (env.devTools) {
    app.use("/monitor", monitor());
    // Load-test / ops metrics (§11 6.6). Same gate as the monitor: both are
    // operator surfaces and both go behind admin auth in 6.4.
    app.use("/metrics", createMetricsRouter());
    log.info("colyseus monitor enabled at /monitor, metrics at /metrics");
  }

  // Periodic server_metrics rollup (§11 6.8). Off in dev unless opted in, so a
  // normal dev session does not write a row every ten seconds.
  const sampler = new TelemetrySampler();
  if (env.telemetryEnabled) sampler.start();

  await gameServer.listen(env.port);
  log.info(`listening on :${env.port}`, {
    dev: env.devTools,
    serving: env.clientDir ? "client + api + content" : "api + content",
  });

  const shutdown = (signal: string): void => {
    log.info(`received ${signal}, shutting down`);
    sampler.stop();
    gameServer
      .gracefullyShutdown()
      .then(() => {
        log.info("shutdown complete");
        process.exit(0);
      })
      .catch((err) => {
        log.error("shutdown error", err);
        process.exit(1);
      });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  log.error("fatal boot error", err);
  process.exit(1);
});
