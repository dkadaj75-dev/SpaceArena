import { createLogger, PROTOCOL_VERSION, SIM_TICK_RATE } from "@space-arena/shared";

const log = createLogger("Server");

log.info("server placeholder", { tickRate: SIM_TICK_RATE, protocolVersion: PROTOCOL_VERSION });

// Colyseus rooms, matchmaking, and the authoritative sim land in Phase 2.
// This placeholder only proves the workspace wiring (shared -> server) works.
