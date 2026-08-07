/** Fixed simulation tick rate (Hz) shared by client render-interpolation and server sim. */
export const SIM_TICK_RATE = 30;

/** Wire protocol version; bump on any breaking message/schema change. */
// 3: PlayerState replicates the authoritative ship up-vector (upX/upY/upZ) —
// older clients cannot reconstruct the full orientation frame from heading/pitch
// (docs/HANDOFF-2026-07-30-FLIGHT-FRAME.md).
// 4: the heat/energy overhaul (2026-08-07, docs/COMBAT-REWORK.md). Heat and
// energy became PER MODULE: `ModuleState` gained heat/heatCapacity/energy/
// energyCapacity and `PlayerState` lost energyCur/energyMax/heatCur/
// heatCapacity outright. An older client would read a ship-wide gauge that no
// longer travels, and a newer one would find no ring data at all.
export const PROTOCOL_VERSION = 4;
