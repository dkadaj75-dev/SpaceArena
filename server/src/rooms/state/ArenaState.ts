import { Schema, MapSchema, ArraySchema, type } from "@colyseus/schema";

/**
 * Colyseus schema state for an arena match. Mirrors the shared sim snapshot
 * *minimally* — only what a client cannot derive locally from configs + events:
 *
 *  - Static asteroid *layout* is NOT synced (both sides load it from the arena
 *    config); only the per-placement `destroyed` flag travels (task 2.10).
 *  - Beams and kinetics are one-shot fire events (protocol `fireEvent`), NOT
 *    schema entities. Only **missiles** get a {@link ProjectileState} entry
 *    (task 2.7).
 *  - Positions and per-ship VELOCITY are quantized to int16 deci-units and
 *    headings to uint16 (see shared `net/quantize`), documented there. Velocity
 *    rides for ships only — see the note on {@link PlayerState.vx}; missiles
 *    and decoys still send position alone.
 *
 * Uses @colyseus/schema's `@type` decorators (server tsconfig enables
 * `experimentalDecorators` + `useDefineForClassFields:false`, the combination
 * schema 3.x's legacy decorators require).
 */

/** Per-fitted-module remote-visible state (drives deploy/shield/cooldown visuals). */
export class ModuleState extends Schema {
  /** Fitted module config id (so the client can resolve the module without the fitting). */
  @type("string") moduleId = "";
  /** Hardpoint index this module occupies (client toggles address by this). */
  @type("uint8") hardpointIndex = 0;
  /** §2.3 state machine code (see shared `MODULE_STATE_CODE`). */
  @type("uint8") state = 0;
  /** Remaining seconds in a timed state (deploying/retracting). */
  @type("float32") stateTimer = 0;
  /** Dynamic rounds remaining (0 for modules without an authored clip). */
  @type("uint8") rounds = 0;
  /**
   * This module's OWN energy tank and its resolved capacity (boost bottle,
   * shield reserve, active utility). The button's energy ring is
   * `energy / energyCapacity`; a capacity of 0 means no energy ring.
   */
  @type("float32") energy = 0;
  @type("float32") energyCapacity = 0;
  /** Weapon cooldown countdown (seconds) — drives fire-cadence visuals. */
  @type("float32") cycleTimer = 0;
  /**
   * True while a `fire.mode: "continuous"` weapon is channelling. The ONE piece
   * of new replicated state the continuous beam needs: a channel deliberately
   * emits no per-tick fire event, so without this flag a client has nothing to
   * draw the persistent beam from. Always false for held/semi weapons.
   */
  @type("boolean") channeling = false;
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
  /** Explicit bot disclosure; disconnected humans are not bots. */
  @type("boolean") isBot = false;
  /** False during the authoritative death-to-respawn gap. */
  @type("boolean") alive = true;
  /**
   * Equipped paint (`cosmetic.*`), or "" for the hull's authored look (protocol
   * 5). Validated server-side at join — ownership AND target — so a client
   * can only ever make its OWN ship look like something it bought, and an
   * invalid request replicates as standard rather than as a rejection.
   */
  @type("string") cosmeticId = "";
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
  /**
   * Authoritative ship-up axis (unit, ⊥ nose) — the roll degree of freedom that
   * heading/pitch cannot carry (flight-frame handoff, protocol v3). All three
   * components travel as float32 (fine at current ship counts); the client
   * normalizes on decode. Clients must interpolate/render the FRAME from this,
   * never reconstruct an up from the two Euler coordinates.
   */
  @type("float32") upX = 0;
  @type("float32") upY = 1;
  @type("float32") upZ = 0;

  /**
   * Authoritative world velocity in units/second, int16 deci-units — the SAME
   * codec as the position triple above (shared `encodeCenti`/`decodeCenti`), so
   * 0.1 u/s of resolution over ±3276.7 u/s. A cruising interceptor is under
   * 100 u/s, so the range is enormous headroom and the resolution is roughly
   * three orders of magnitude finer than any speed difference an eye or a HUD
   * readout resolves.
   *
   * ## The history, because this field was deliberately absent for a long time
   *
   * A `vx`/`vz` PAIR sat at this spot until protocol 7. Nothing wrote them and
   * nothing read them, so they replicated zeroes for their whole life, and they
   * were deleted with a comment warning against restoring them as they were: a
   * two-component velocity is a 2D subset of a 3D flight model (BUBBLE.md §B —
   * the bubble's vertical axis is a real degree of freedom), so a client that
   * trusted the pair would be wrong the moment a ship pitched. That warning is
   * honoured here — all THREE components travel, with a writer in `replicate.ts`
   * and a decoder in `shared/src/net/decodeState.ts`.
   *
   * The comment also named the then-supported alternative: the client
   * DIFFERENCED the two interpolated snapshot positions it was already holding.
   * That is what this replaces, and the reason is that a difference is not a
   * velocity — it is the average velocity over the segment, delayed by half a
   * segment, carrying the quantization noise of both endpoints amplified by
   * 1/h (at h = 66.7 ms, the ±0.05 u position codec alone is ±1.5 u/s of noise),
   * and undefined at the newest sample, which is exactly where the client's
   * dead-reckoning needs it. Two consumers wanted the real thing:
   *
   *  - `hermitePosition` builds its interpolation tangents from it, replacing
   *    Catmull-Rom finite differences that could only ever describe the samples
   *    already in the buffer;
   *  - the HUD speed readout reads |v| straight off the newest snapshot instead
   *    of differentiating a rendered position against a playback clock.
   */
  @type("int16") vx = 0;
  @type("int16") vy = 0;
  @type("int16") vz = 0;

  @type("float32") hull = 0;
  /** Resolved max hull (ship class + upgrades + module passives) — for HUD bars. */
  @type("float32") hullMax = 0;
  /**
   * Sum of active shield-module reserves — the hull's shield arc. The ship-wide
   * energy field is GONE with the 2026-08-07 overhaul: energy lives per module,
   * on {@link ModuleState}, because that is where the pilot spends it.
   */
  @type("float32") shieldPool = 0;
  /**
   * Commanded throttle (the ship's live `FlightState` value, 0 when it has
   * none), normalized 0..1 as uint8 — decode with shared `decodeUnit`. Clients
   * read the REAL value for engine trails/boost curves instead of inferring one
   * from displacement (FLIGHT.md §1/§5).
   */
  @type("uint8") throttle = 0;
  /**
   * Seconds left on the ship's pad hold (respawn 3-2-1-0), in tenths as uint8
   * (0..255 = 0..25.5 s). 0 once control has returned.
   */
  @type("uint8") launchHold = 0;
  /**
   * True while the sim owns this hull — pad hold or launch run — and the
   * pilot's orders are dropped. Not derivable from `launchHold`: the opening
   * wave's countdown is the MATCH countdown, so it flies its run with
   * `launchHold` already at 0. The client's spawn cinematic keys off this.
   */
  @type("boolean") launchLocked = false;
  /** Sensor lock warm-up, normalized 0..1 as uint8 (shared `decodeUnit`). */
  @type("uint8") lockProgress = 0;
  /** True once the lock completed — the sim's weapons gate (FLIGHT.md §2). */
  @type("boolean") locked = false;
  /**
   * Fraction of this hull's top speed a slowing ray is currently removing,
   * normalized 0..1 as uint8 (shared `encodeUnit`/`decodeUnit`) — 0 for a ship
   * flying free (owner 2026-08-22).
   *
   * It has to travel, and it cannot be derived on either side. A remote client
   * needs it to draw the slowed hull; the SLOWED client needs it because its own
   * predictor folds it into the same multiplier boost uses, and a predictor that
   * did not know would run away from the server for the whole four seconds and
   * then be dragged back by the correction blend (FLIGHT.md §5). A uint8 is
   * ample: the authored band is 0.1..0.6 and the field is a visual/predictive
   * scale, not an authority on anyone's position.
   */
  @type("uint8") slowFactor = 0;
  /**
   * Entity the sensors are warming/holding, or -1 for none. Replicated with the
   * two fields above because they are one reading: `lockProgress` alone cannot
   * tell the HUD which enemy to bracket, and the reticle is the whole point of
   * sending lock state to a client (FLIGHT.md §4).
   */
  @type("number") targetId = -1;
  @type([ModuleState]) modules = new ArraySchema<ModuleState>();
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

/**
 * Asteroid dynamic state only; position/radius come from the arena config.
 *
 * Intact/destroyed is the whole payload: a rock's remaining `hp` used to travel
 * too, but no client ever decoded it (there is no rock health bar), so it was
 * deleted with protocol 7. Damage numbers reach the client as `simEvent`s.
 */
export class AsteroidState extends Schema {
  @type("boolean") destroyed = false;
}

/** A jettisoned countermeasure lure; keyed by its stable sim entity id. */
export class DecoyState extends Schema {
  @type("number") entityId = 0;
  @type("uint8") team = 0;
  @type("int16") x = 0;
  @type("int16") y = 0;
  @type("int16") z = 0;
  @type("float32") radius = 0;
  @type("float32") lifeFraction = 0;
}

/** Dynamic CTF objective state. Static base data comes from the arena config. */
export class FlagState extends Schema {
  @type("number") entityId = 0;
  @type("uint8") team = 0;
  /** See shared `FLAG_STATE_CODE`. */
  @type("uint8") state = 0;
  @type("int16") x = 0;
  @type("int16") y = 0;
  @type("int16") z = 0;
  /** Sim entity id of the carrier, or -1. */
  @type("number") carrierEntityId = -1;
  @type("float32") dropRemaining = 0;
}

/** Both scoreboard dimensions for one team. */
export class TeamScoreState extends Schema {
  @type("uint16") kills = 0;
  @type("uint16") captures = 0;
}

export class ArenaState extends Schema {
  /** "waiting" | "live" | "ended". */
  @type("string") matchPhase = "waiting";
  /** Elapsed live seconds. */
  @type("float32") matchTimer = 0;
  /**
   * Seconds left on the sim's frozen 3-2-1 start countdown, 0 once the match is
   * really live (see `ArenaSimulation`). Server-driven so BOTH clients count the
   * same numbers off the same authoritative timer — a client-local countdown
   * would drift by exactly the two players' clock/latency difference, which is
   * the one thing "everyone starts at the same time" cannot tolerate.
   *
   * The room lobby has its own `lobbyRemainingSec`; this value is only displayed
   * after `matchPhase` becomes `"live"` and the sim countdown begins.
   */
  @type("float32") countdownRemaining = 0;
  /** Server-authored lobby wait remaining before empty seats are backfilled. */
  @type("float32") lobbyRemainingSec = 0;
  /** Winning team, or -1 for none/draw. */
  @type("int8") winnerTeam = -1;
  /**
   * Kill/capture counts per team (keyed by team id as a string).
   */
  @type({ map: TeamScoreState }) teamScores = new MapSchema<TeamScoreState>();
  /** Keyed by client sessionId. */
  @type({ map: PlayerState }) players = new MapSchema<PlayerState>();
  /** Missiles only. Keyed by sim entity id (string). */
  @type({ map: ProjectileState }) projectiles = new MapSchema<ProjectileState>();
  /** Keyed by arena-config placement index (string). */
  @type({ map: AsteroidState }) asteroids = new MapSchema<AsteroidState>();
  /** Jettisoned countermeasure pods, keyed by sim entity id. */
  @type({ map: DecoyState }) decoys = new MapSchema<DecoyState>();
  /** CTF flags, keyed by stable sim entity id. */
  @type({ map: FlagState }) flags = new MapSchema<FlagState>();
}
