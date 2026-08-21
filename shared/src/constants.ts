/** Fixed simulation tick rate (Hz) shared by client render-interpolation and server sim. */
export const SIM_TICK_RATE = 30;

/** Wire protocol version; bump on any breaking message/schema change. */
// 3: PlayerState replicates the authoritative ship up-vector (upX/upY/upZ) —
// older clients cannot reconstruct the full orientation frame from heading/pitch
// (docs/HANDOFF-2026-07-30-FLIGHT-FRAME.md).
// 4: the energy overhaul (2026-08-07, docs/COMBAT-REWORK.md). Energy became
// PER MODULE: `ModuleState` gained energy/energyCapacity and `PlayerState` lost
// energyCur/energyMax outright. An older client would read a ship-wide gauge that no
// longer travels, and a newer one would find no ring data at all.
// 5: cosmetics (shop, 2026-08-08). `PlayerState` replicates the equipped paint
// as `cosmeticId`, and `ShipSnapshot` carries the same field offline. An older
// client would render every hull in its authored colours while the rest of the
// room sees paint, which is exactly the disagreement replication exists to
// prevent.
// 6: clip-fed weapons add the `reloading` module state and replicate each
// module's dynamic rounds-remaining count.
// 7: five fields DELETED from the replicated state — `PlayerState.vx`/`vz`
// (never written by anyone; the client differences positions instead, see the
// note on `PlayerState`), `PlayerState.lastProcessedSeq` (reconciliation is the
// per-client `orderAck`), `PlayerState.connected` (clients filter on `alive`)
// and `AsteroidState.hp` (no rock health bar exists). Colyseus encodes by
// declaration index, so an older client would mis-decode every field after the
// first hole.
export const PROTOCOL_VERSION = 7;
