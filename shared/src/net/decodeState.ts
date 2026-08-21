/* eslint-disable @typescript-eslint/no-explicit-any -- Colyseus schema state is runtime-generated. */
import type { ArenaConfig } from "../schemas/arena.js";
import type {
  AsteroidSnapshot,
  ModuleSnapshot,
  ShipSnapshot,
  Snapshot,
  TeamScore,
} from "../sim/ArenaSimulation.js";
import { orthonormalizeUp, upFromAttitude } from "../sim/frame.js";
import { decodeFlagState, decodeModuleState } from "./protocol.js";
import { decodeCenti, decodeHeading, decodePitch, decodeUnit } from "./quantize.js";

/**
 * The client's wire decoders: replicated Colyseus state → the shared
 * {@link Snapshot} every renderer, HUD and bot already reads.
 *
 * ## Why this lives in `shared` and not in the client
 *
 * These functions are pure client code — `NetGameSession` re-exports every one
 * of them and is still their only production caller. They sit here because
 * `shared` is the only package the SERVER can also import, and the round-trip
 * test in `server/src/rooms/state/replicate.test.ts` has to run the real
 * decoder against a real `ArenaState` the real replication writer just filled
 * in. That test cannot live on the client: `ArenaState` needs
 * `experimentalDecorators` + `useDefineForClassFields:false`, which the client
 * project does not enable, and the client's `rootDir` refuses server sources
 * anyway. Hosting the decoders here is what makes writer and reader meet in one
 * process at all — without it the two halves of the protocol are only ever
 * exercised separately, against hand-written literals that drift.
 *
 * Everything here is PURE over its wire input. The stateful/graphics-bound
 * parts of decoding (the rock geometry cache, the entity-id ↔ session-id
 * bookkeeping, prediction) deliberately stayed behind in `NetGameSession`.
 *
 * The input type is `any` throughout for the same reason it always was: a
 * Colyseus state instance is rebuilt on the client from a runtime reflection
 * payload, so there is no generated type to bind against. The field NAMES are
 * held to the contract in `./wireFields.ts` instead.
 */

/* ------------------------------------------------------------------------- *
 * Wire container helpers.
 *
 * A replicated collection arrives as a MapSchema/ArraySchema in production and
 * as a plain object or Map in tests, so every read goes through these three.
 * ------------------------------------------------------------------------- */

/** Values of a MapSchema/ArraySchema/Map, or of a plain object. */
export function wireValues(value: any): any[] {
  return value?.values ? [...value.values()] : Object.values(value ?? {});
}

/** One keyed entry of a MapSchema, or of a plain object. */
export function wireGet(value: any, key: string): any {
  return value?.get ? value.get(key) : value?.[key];
}

/** The key `target` is stored under — how a client finds its OWN player entry. */
export function wireFindKey(map: any, target: any): string | undefined {
  if (map?.entries) for (const [k, v] of map.entries()) if (v === target) return k;
  return undefined;
}

/**
 * Room lifecycle + replicated countdown → the snapshot's phase. A room that has
 * not started yet ("waiting") is reported as `countdown` too: its sim is not
 * being ticked at all, so "frozen, cannot move or fire, GO is still ahead"
 * describes it exactly, and every consumer (HUD overlay, predictor, bots) then
 * needs only ONE rule instead of a waiting special case.
 */
export function decodeRoomPhase(matchPhase: unknown, countdownRemaining: number): Snapshot["phase"] {
  if (matchPhase === "waiting") return "waiting";
  if (matchPhase === "ended") return "ended";
  return countdownRemaining > 0 ? "countdown" : "live";
}

/** A roster entry persists across respawn, but only live entries are render/sim snapshots. */
export function isReplicatedPlayerAlive(player: { alive?: unknown }): boolean {
  return player.alive !== false;
}

/**
 * Replicated paint → the offline snapshot's optional field. The wire carries ""
 * for "authored look" (a schema string has no null), and the standard paint id
 * means the same thing, so both decode to ABSENT — the renderer then has exactly
 * one case to handle, identically online and offline.
 */
export function decodeCosmeticId(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  return raw;
}

/**
 * Decode a replicated `PlayerState.modules` ArraySchema into `ModuleSnapshot[]`,
 * reading `hardpointIndex`/`moduleId`/`cycleTimer`/the energy store verbatim from
 * the wire state — never synthesized from array position or the ship config's
 * `defaultFitting`. The modules array is sparse-safe (see `spawn.ts`): a
 * fitting like `{0: laser, 2: shield}` replicates two entries whose own
 * `hardpointIndex` fields are 0 and 2, NOT array positions 0 and 1, so every
 * consumer (ShipSocketRig, ModuleButtons, pending-toggle overlay) must look
 * modules up by `hardpointIndex`, never by index into this array.
 */
export function decodeModules(raw: any): ModuleSnapshot[] {
  return wireValues(raw).map((m: any) => ({
    hardpointIndex: m.hardpointIndex,
    moduleId: m.moduleId,
    state: decodeModuleState(m.state),
    rounds: m.rounds ?? 0,
    // Per-module store: the two numbers the
    // button rings are drawn from. Capacities are resolved server-side against
    // the hull, so they are replicated rather than recomputed from the config.
    energy: m.energy ?? 0,
    energyCapacity: m.energyCapacity ?? 0,
    stateTimer: m.stateTimer,
    cycleTimer: m.cycleTimer,
    channeling: m.channeling ?? false,
    shieldPool: m.shieldPool ?? 0,
  }));
}

/**
 * Decode the replicated ship-up axis (float32 on the wire): normalized and
 * Gram–Schmidt-corrected against the decoded nose, because the three float32
 * components are individually rounded and the frame must stay orthonormal.
 * A missing/degenerate up (a pre-v3 peer in a mixed-version dev setup, a
 * zeroed field) falls back to the derived roll-less up for the same nose —
 * always a legal frame.
 */
export function decodeUp(
  upX: unknown,
  upY: unknown,
  upZ: unknown,
  heading: number,
  pitch: number,
): { x: number; y: number; z: number } {
  const x = Number(upX);
  const y = Number(upY);
  const z = Number(upZ);
  const up = { x, y, z };
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    return upFromAttitude(heading, pitch, up);
  }
  return orthonormalizeUp(heading, pitch, up);
}

/**
 * Replicated velocity triple → the snapshot's optional `velocity`, or
 * `undefined` when the wire carries nothing usable.
 *
 * "Nothing usable" is an all-zero (or non-finite, or missing) triple, and that
 * is the whole point of the check: a peer running a pre-velocity server sends no
 * field at all, `?? 0` turns that into a legal-looking standstill, and every
 * consumer would then confidently draw a cruising hull as parked. Reporting
 * ABSENCE routes all three consumers to their documented fallbacks instead — and
 * costs nothing for a ship that really is stopped, since those fallbacks derive
 * zero from its unchanging position anyway.
 */
export function decodeVelocity(
  vx: unknown,
  vy: unknown,
  vz: unknown,
): { x: number; y: number; z: number } | undefined {
  const x = Number(vx);
  const y = Number(vy);
  const z = Number(vz);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return undefined;
  if (x === 0 && y === 0 && z === 0) return undefined;
  return { x: decodeCenti(x), y: decodeCenti(y), z: decodeCenti(z) };
}

/** One replicated `PlayerState` → the shared `ShipSnapshot` the whole client reads. */
export function decodeShip(p: any): ShipSnapshot {
  const heading = decodeHeading(p.heading);
  const pitch = decodePitch(p.pitch ?? 0);
  return {
    id: Number(p.entityId),
    team: p.team,
    // Full 3D (BUBBLE.md §B): `y` rides the same centi codec as x/z, while
    // `pitch` uses the SIGNED int16 pair — decoding it with `decodeHeading`
    // would turn every nose-down attitude into a ~2π-off climb.
    pos: { x: decodeCenti(p.x), y: decodeCenti(p.y ?? 0), z: decodeCenti(p.z) },
    heading,
    pitch,
    up: decodeUp(p.upX, p.upY, p.upZ, heading, pitch),
    // Authoritative velocity (units/sec), same int16 deci-unit codec as `pos`.
    // ABSENT rather than a zero vector when the wire carries nothing usable: the
    // consumers (Hermite tangents, bounded dead reckoning, the HUD speed
    // readout) all have a defined fallback for "this sample has no velocity",
    // and `{0,0,0}` would instead assert that a moving ship is stopped. A ship
    // genuinely at rest is indistinguishable from an absent field here, which is
    // harmless: the fallbacks agree with zero for a stationary hull.
    velocity: decodeVelocity(p.vx, p.vy, p.vz),
    hull: p.hull,
    // Server-resolved maxima (upgrade + passive-resolved), replicated verbatim —
    // never reconstructed from the base ship config, which would ignore
    // upgrade tracks and utility-module passives (capacitor battery).
    hullMax: p.hullMax,
    // Flight + sensor state, quantized server-side by `encodeUnit`
    // (FLIGHT.md §5). `targetId` travels as -1 for "none" because the
    // schema field is a plain number.
    targetId: p.targetId === undefined || p.targetId < 0 ? null : Number(p.targetId),
    throttle: decodeUnit(p.throttle ?? 0),
    // Tenths of a second on the wire (see ArenaState.launchHold).
    launchHold: (p.launchHold ?? 0) / 10,
    launchLocked: Boolean(p.launchLocked),
    lockProgress: decodeUnit(p.lockProgress ?? 0),
    locked: Boolean(p.locked),
    cosmeticId: decodeCosmeticId(p.cosmeticId),
    modules: decodeModules(p.modules),
  };
}

/** Live (non-corpse) roster entries, decoded. */
export function decodeShips(raw: any): ShipSnapshot[] {
  return wireValues(raw).filter(isReplicatedPlayerAlive).map(decodeShip);
}

/** Missiles are the only schema-replicated projectile; beams/kinetics are events. */
export function decodeProjectiles(raw: any): Snapshot["projectiles"] {
  return wireValues(raw).map((p: any) => ({
    id: p.entityId,
    kind: "missile" as const,
    pos: { x: decodeCenti(p.x), y: decodeCenti(p.y ?? 0), z: decodeCenti(p.z) },
    heading: decodeHeading(p.heading),
  }));
}

/**
 * The ONLY dynamic bit of an asteroid on the wire. Rocks are static and
 * identical on both sides, so the room replicates hp/destroyed and the client
 * rebuilds position, radius and geometry from the arena config — which is why
 * this is a single-field reader rather than a whole `decodeAsteroids`: the rest
 * of an `AsteroidSnapshot` is never sent.
 */
export function decodeAsteroidDestroyed(raw: any, placementIndex: number): boolean {
  return wireGet(raw, String(placementIndex))?.destroyed === true;
}

/**
 * Replicated team scores → snapshot shape, ascending by team id. Accepts the
 * current `{kills,captures}` entries and the former numeric-kills wire shape.
 */
export function decodeTeamScores(raw: any): TeamScore[] {
  const out: TeamScore[] = [];
  if (raw?.entries) {
    for (const [key, score] of raw.entries()) out.push(decodeTeamScore(key, score));
  } else if (raw) {
    for (const key of Object.keys(raw)) out.push(decodeTeamScore(key, raw[key]));
  }
  out.sort((a, b) => a.team - b.team);
  return out;
}

function decodeTeamScore(key: unknown, raw: any): TeamScore {
  return typeof raw === "number"
    ? { team: Number(key), kills: Number(raw), captures: 0 }
    : { team: Number(key), kills: Number(raw?.kills ?? 0), captures: Number(raw?.captures ?? 0) };
}

/** Pure wire decoder for jettisoned countermeasure pods. */
export function decodeDecoys(raw: any): Snapshot["decoys"] {
  return wireValues(raw).map((d: any) => ({
    id: Number(d.entityId),
    team: Number(d.team),
    pos: { x: decodeCenti(d.x), y: decodeCenti(d.y ?? 0), z: decodeCenti(d.z) },
    radius: Number(d.radius),
    lifeFraction: Number(d.lifeFraction),
  }));
}

type TrailPoint = { x: number; y: number; z: number };

/** Stateful client-side counterpart of the sim's CTF `pushTrail`. */
export class FlagTrailAccumulator {
  private readonly trails = new Map<number, TrailPoint[]>();

  update(id: number, state: Snapshot["flags"][number]["state"], pos: TrailPoint, maxLength: number): TrailPoint[] {
    if (state === "home" || maxLength <= 0) {
      this.trails.delete(id);
      return [];
    }
    const trail = this.trails.get(id) ?? [];
    const last = trail[trail.length - 1];
    if (!last || distance(last, pos) >= 0.5) {
      if (last && distance(last, pos) > maxLength) trail.length = 0;
      trail.push({ ...pos });
      let length = 0;
      for (let i = trail.length - 1; i > 0; i--) {
        length += distance(trail[i]!, trail[i - 1]!);
        if (length > maxLength) {
          trail.splice(0, i - 1);
          break;
        }
      }
    }
    this.trails.set(id, trail);
    return trail.map((point) => ({ ...point }));
  }

  retain(ids: ReadonlySet<number>): void {
    for (const id of this.trails.keys()) if (!ids.has(id)) this.trails.delete(id);
  }

  clear(): void { this.trails.clear(); }
}

/** Decode dynamic flag state and join it with static arena base data. */
export function decodeFlags(
  raw: any,
  arena: ArenaConfig,
  trails: FlagTrailAccumulator,
  trailLength: number,
): Snapshot["flags"] {
  const live = new Set<number>();
  const flags = wireValues(raw).map((f: any) => {
    const id = Number(f.entityId);
    live.add(id);
    const team = Number(f.team);
    const state = decodeFlagState(Number(f.state));
    const pos = { x: decodeCenti(f.x), y: decodeCenti(f.y ?? 0), z: decodeCenti(f.z) };
    const base = arena.flagBases?.find((candidate) => candidate.team === team);
    return {
      id,
      team,
      state,
      carrierId: f.carrierEntityId === undefined || Number(f.carrierEntityId) < 0 ? null : Number(f.carrierEntityId),
      pos,
      home: base ? { x: base.position.x, y: base.position.y ?? 0, z: base.position.z } : { ...pos },
      baseRadius: base?.radius ?? 0,
      dropRemaining: state === "dropped" ? Math.max(0, Number(f.dropRemaining ?? 0)) : 0,
      trail: trails.update(id, state, pos, trailLength),
    };
  });
  trails.retain(live);
  return flags;
}

function distance(a: TrailPoint, b: TrailPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/**
 * Everything {@link decodeSnapshot} needs that the wire deliberately does NOT
 * carry.
 *
 * `asteroids` is passed in fully built rather than decoded here because a rock's
 * position, radius and collision geometry come from the arena config and its
 * mesh-derived radii are cached client-side; only `state` comes off the wire,
 * via {@link decodeAsteroidDestroyed}. The server's round-trip test passes an
 * empty list and asserts the destroyed flags directly.
 */
export interface WireDecodeContext {
  /** Static CTF base data (flag home positions and radii). */
  arena: ArenaConfig;
  /** Rocks, rebuilt from the arena config with their wire `state` applied. */
  asteroids: AsteroidSnapshot[];
  /** Flag wakes, which the wire omits and the client accumulates locally. */
  trails: FlagTrailAccumulator;
  /** `gamemode.ctf.trailLength`; 0 disables wakes entirely. */
  trailLength: number;
}

/**
 * The whole replicated state → one {@link Snapshot}. This IS the client's
 * decoder: `NetGameSession.decode` builds the rock list, calls this, and does
 * nothing else to the wire data.
 */
export function decodeSnapshot(state: any, ctx: WireDecodeContext): Snapshot {
  const countdownRemaining = Math.max(0, Number(state.countdownRemaining ?? 0));
  return {
    tick: Math.round((state.matchTimer ?? 0) * 30),
    elapsed: state.matchTimer ?? 0,
    phase: decodeRoomPhase(state.matchPhase, countdownRemaining),
    teamScores: decodeTeamScores(state.teamScores),
    countdownRemaining,
    lobbyRemainingSec: Math.max(0, Number(state.lobbyRemainingSec ?? 0)),
    winnerTeam: state.winnerTeam === -1 ? null : state.winnerTeam,
    ships: decodeShips(state.players),
    asteroids: ctx.asteroids,
    projectiles: decodeProjectiles(state.projectiles),
    decoys: decodeDecoys(state.decoys),
    flags: decodeFlags(state.flags, ctx.arena, ctx.trails, ctx.trailLength),
  };
}
