import { createServer } from "node:http";
import express from "express";
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { monitor } from "@colyseus/monitor";
import { createLogger, PROTOCOL_VERSION, SIM_TICK_RATE } from "@space-arena/shared";
import { loadContent, setConfigService } from "./configService.js";
import { ArenaRoom } from "./rooms/ArenaRoom.js";

const log = createLogger("Server");

const PORT = Number(process.env.PORT ?? 2567);
/** Enable /monitor + verbose room logging only when explicitly in dev. */
const DEV = process.env.NODE_ENV !== "production" || process.env.COLYSEUS_MONITOR === "1";

async function main(): Promise<void> {
  // Fail fast on invalid content before opening the socket.
  const configs = await loadContent();
  setConfigService(configs);
  log.info("content loaded", { protocolVersion: PROTOCOL_VERSION, tickRate: SIM_TICK_RATE });

  const app = express();
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", protocolVersion: PROTOCOL_VERSION, tickRate: SIM_TICK_RATE });
  });

  const httpServer = createServer(app);
  const gameServer = new Server({
    transport: new WebSocketTransport({ server: httpServer }),
  });

  gameServer.define("arena", ArenaRoom).filterBy(["gamemode"]);

  if (DEV) {
    app.use("/monitor", monitor());
    log.info("colyseus monitor enabled at /monitor");
  }

  await gameServer.listen(PORT);
  log.info(`listening on :${PORT}`, { dev: DEV });

  const shutdown = (signal: string): void => {
    log.info(`received ${signal}, shutting down`);
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
