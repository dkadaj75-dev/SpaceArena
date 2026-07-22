import { Schema, MapSchema, ArraySchema, type } from "@colyseus/schema";

/**
 * Colyseus schema state for an arena match. Mirrors the shared sim snapshot
 * *minimally* — only what a client cannot derive locally from configs + events:
 *
 *  - Static asteroid *layout* is NOT synced (both sides load it from the arena
 *    config); only per-placement `hp` / `destroyed` travel (task 2.10).
 *  - Beams and kinetics are one-shot fire events (protocol `fireEvent`), NOT
 *    schema entities. Only **missiles** get a {@link ProjectileState} entry
 *    (task 2.7).
 *  - Positions/velocities are quantized to int16 centi-units and headings to
 *    uint16 (see shared `net/quantize`), documented there.
 *
 * Uses @colyseus/schema's `@type` decorators (server tsconfig enables
 * `experimentalDecorators` + `useDefineForClassFields:false`, the combination
 * schema 3.x's legacy decorators require).
 */

/** Per-fitted-module remote-visible state (drives deploy/shield/overheat visuals). */
export class ModuleState extends Schema {
  /** §2.3 state machine code (see shared `MODULE_STATE_CODE`). */
  @type("uint8") state = 0;
  /** Remaining seconds in a timed state (deploying/retracting/overheated). */
  @type("float32") stateTimer = 0;
  /** Module heat vs its overheat threshold (for the button heat fill). */
  @type("float32") heat = 0;
}

export class PlayerState extends Schema {
  /** Sim entity id (stable within a match; used to correlate fire/sim events). */
  @type("number") entityId = 0;
  @type("uint8") team = 0;
  @type("string") shipId = "";
  /** Position, int16 centi-units (decode with shared `decodeCenti`). */
  @type("int16") x = 0;
  @type("int16") z = 0;
  /** Heading, uint16 (decode with shared `decodeHeading`). */
  @type("uint16") heading = 0;
  /** Velocity, int16 centi-units. */
  @type("int16") vx = 0;
  @type("int16") vz = 0;
  @type("float32") hull = 0;
  /** Sum of active shield-module absorb reservoirs. */
  @type("float32") shieldPool = 0;
  @type("float32") energyCur = 0;
  @type("float32") heatCur = 0;
  @type([ModuleState]) modules = new ArraySchema<ModuleState>();
  /** Highest client order seq applied for this player (reconciliation). */
  @type("number") lastProcessedSeq = 0;
  @type("boolean") connected = true;
}

/** Missiles only (beams/kinetics are events). Keyed by sim entity id string. */
export class ProjectileState extends Schema {
  @type("number") entityId = 0;
  @type("int16") x = 0;
  @type("int16") z = 0;
  @type("uint16") heading = 0;
}

/** Asteroid dynamic state only; position/radius come from the arena config. */
export class AsteroidState extends Schema {
  /** Current hit points, or -1 for indestructible asteroids. */
  @type("float32") hp = 0;
  @type("boolean") destroyed = false;
}

export class ArenaState extends Schema {
  /** "waiting" | "live" | "ended". */
  @type("string") matchPhase = "waiting";
  /** Elapsed live seconds. */
  @type("float32") matchTimer = 0;
  /** Winning team, or -1 for none/draw. */
  @type("int8") winnerTeam = -1;
  /** Keyed by client sessionId. */
  @type({ map: PlayerState }) players = new MapSchema<PlayerState>();
  /** Missiles only. Keyed by sim entity id (string). */
  @type({ map: ProjectileState }) projectiles = new MapSchema<ProjectileState>();
  /** Keyed by arena-config placement index (string). */
  @type({ map: AsteroidState }) asteroids = new MapSchema<AsteroidState>();
}
