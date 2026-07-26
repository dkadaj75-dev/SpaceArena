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
  /** Fitted module config id (so the client can resolve the module without the fitting). */
  @type("string") moduleId = "";
  /** Hardpoint index this module occupies (client toggles address by this). */
  @type("uint8") hardpointIndex = 0;
  /** §2.3 state machine code (see shared `MODULE_STATE_CODE`). */
  @type("uint8") state = 0;
  /** Remaining seconds in a timed state (deploying/retracting/overheated). */
  @type("float32") stateTimer = 0;
  /** Module heat vs its overheat threshold (for the button heat fill). */
  @type("float32") heat = 0;
  /** Weapon cooldown countdown (seconds) — drives fire-cadence visuals. */
  @type("float32") cycleTimer = 0;
  /** This module's shield-absorb reservoir (0 for non-shield modules). */
  @type("float32") shieldPool = 0;
}

export class PlayerState extends Schema {
  /** Sim entity id (stable within a match; used to correlate fire/sim events). */
  @type("number") entityId = 0;
  @type("uint8") team = 0;
  @type("string") shipId = "";
  /** Player display name (from profile), or a generated guest/anon label. */
  @type("string") displayName = "";
  /**
   * Position, int16 centi-units (decode with shared `decodeCenti`). `y` is the
   * bubble's vertical axis (BUBBLE.md §B) and uses the SAME centi codec as x/z —
   * the arena is a sphere, so its vertical extent is the same radius.
   */
  @type("int16") x = 0;
  @type("int16") y = 0;
  @type("int16") z = 0;
  /** Heading (yaw), uint16 (decode with shared `decodeHeading`). */
  @type("uint16") heading = 0;
  /**
   * Nose elevation, int16 via the signed `encodePitch`/`decodePitch` pair — NOT
   * the heading codec, which folds negatives into 0..2π (see quantize.ts).
   */
  @type("int16") pitch = 0;
  /** Velocity, int16 centi-units. */
  @type("int16") vx = 0;
  @type("int16") vz = 0;
  @type("float32") hull = 0;
  /** Resolved max hull (ship class + upgrades + module passives) — for HUD bars. */
  @type("float32") hullMax = 0;
  /** Sum of active shield-module absorb reservoirs. */
  @type("float32") shieldPool = 0;
  @type("float32") energyCur = 0;
  /** Resolved capacitor max (ship class + upgrades + module passives). */
  @type("float32") energyMax = 0;
  @type("float32") heatCur = 0;
  /** Resolved heat capacity (ship class + upgrades + module passives). */
  @type("float32") heatCapacity = 0;
  /**
   * Commanded throttle (the ship's live `FlightState` value, 0 when it has
   * none), normalized 0..1 as uint8 — decode with shared `decodeUnit`. Clients
   * read the REAL value for engine trails/boost curves instead of inferring one
   * from displacement (FLIGHT.md §1/§5).
   */
  @type("uint8") throttle = 0;
  /** Sensor lock warm-up, normalized 0..1 as uint8 (shared `decodeUnit`). */
  @type("uint8") lockProgress = 0;
  /** True once the lock completed — the sim's weapons gate (FLIGHT.md §2). */
  @type("boolean") locked = false;
  /**
   * Entity the sensors are warming/holding, or -1 for none. Replicated with the
   * two fields above because they are one reading: `lockProgress` alone cannot
   * tell the HUD which enemy to bracket, and the reticle is the whole point of
   * sending lock state to a client (FLIGHT.md §4).
   */
  @type("number") targetId = -1;
  @type([ModuleState]) modules = new ArraySchema<ModuleState>();
  /** Highest client order seq applied for this player (reconciliation). */
  @type("number") lastProcessedSeq = 0;
  @type("boolean") connected = true;
}

/** Missiles only (beams/kinetics are events). Keyed by sim entity id string. */
export class ProjectileState extends Schema {
  @type("number") entityId = 0;
  @type("int16") x = 0;
  /** Bubble vertical axis, same centi codec as x/z (BUBBLE.md §B). */
  @type("int16") y = 0;
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
