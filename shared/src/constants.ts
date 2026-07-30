/** Fixed simulation tick rate (Hz) shared by client render-interpolation and server sim. */
export const SIM_TICK_RATE = 30;

/** Wire protocol version; bump on any breaking message/schema change. */
// 3: PlayerState replicates the authoritative ship up-vector (upX/upY/upZ) —
// older clients cannot reconstruct the full orientation frame from heading/pitch
// (docs/HANDOFF-2026-07-30-FLIGHT-FRAME.md).
export const PROTOCOL_VERSION = 3;
