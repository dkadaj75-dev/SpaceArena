/* eslint-disable @typescript-eslint/no-explicit-any -- Colyseus schema state is runtime-generated. */
import {
  decodeCenti,
  decodeFlagState,
  decodeHeading,
  decodeModuleState,
  decodePitch,
  decodeUnit,
  attitudeNear,
  facingVec,
  flightStep,
  headingOf,
  interpolateFrame,
  len3,
  orthonormalizeUp,
  pitchOf,
  upFromAttitude,
  pitchTuningOf,
  resolveShipStats,
  MSG_ORDER,
  createLogger,
  type ArenaConfig,
  type ConfigService,
  type EntityId,
  type FlightParams,
  type GamemodeConfig,
  type Order,
  type ShipConfig,
  type Attitude,
  type ShipSnapshot,
  type SimEvent,
  type SimEventMessage,
  type Snapshot,
  type SteerState,
  type TeamScore,
  type TuningConfig,
  type UpgradeLevels,
  type FrameAttitude,
} from "@space-arena/shared";
import { GameSession } from "../game/GameSession.js";
import { NetClient, type ArenaJoinOptions } from "./NetClient.js";
import type { SeatReservation } from "colyseus.js";
import { bracket, timeBasedPull } from "./interpolation.js";

const log = createLogger("NetGameSession");
const MAX_SNAPSHOTS = 32;
const SNAP_DISTANCE = 3; // world units: larger prediction error snaps instead of blending
const PENDING_TOGGLE_MS = 800; // optimistic module-state overlay lifetime

interface TimedSnapshot { time: number; snapshot: Snapshot }
interface PendingToggle { sentAt: number; fromState: string; optimistic: "deploying" | "retracting" }
/** The three axes of a `flight` order, as the predictor remembers them. */
export interface PredictedFlight {
  throttle: number;
  turn: number;
  /**
   * Pitch stick, -1..1 (BUBBLE.md §A). On the wire as of T2; the HUD does not
   * produce it until T3, so it still reads 0 for a human pilot today. Stored
   * unconditionally (rather than optionally, as the order carries it) because
   * the predictor is a mirror of the sim's HELD state, where an absent axis and
   * a centred stick are the same thing.
   */
  pitchStick: number;
  boost: boolean;
  /** Echoed for reconciliation even though movement prediction never reads it. */
  fire: boolean;
}

/**
 * Sequence-aware bookkeeping for the level-triggered `flight` orders in flight
 * between this client and the server (FLIGHT.md §1). Pure and socket-free, so
 * the ack orderings that matter can be exercised directly.
 *
 * `flight` orders are STATE, not impulses: the server integrates the last one it
 * accepted, every tick, until another replaces it. A rejection therefore has to
 * roll the predictor back to the last state the server actually holds — but only
 * when the rejected order is still the newest thing we sent. Accept(A),
 * reject(B), accept(C) is an ordinary sequence under any loss or validation
 * hiccup, and a naive rollback on B would put the predictor back on A while the
 * server flies C, with nothing left to correct it: the predictor would sit
 * wrong until the next input, blending against a ship that is steering
 * elsewhere.
 */
export class FlightReconciler {
  /** State the predictor integrates: the newest flight order believed to be live. */
  private predicted: PredictedFlight | null = null;
  /** State of the newest ACCEPTED order — what a rollback falls back to. */
  private accepted: PredictedFlight | null = null;
  private acceptedSeq = -1;
  /** Sent-but-unacked flight states by seq. */
  private readonly inFlight = new Map<number, PredictedFlight>();
  /** Newest flight seq sent, acked or not. */
  private newestSeq = -1;

  /** The flight state the predictor should be integrating right now. */
  get current(): PredictedFlight | null {
    return this.predicted;
  }

  /** Record a flight order handed to the transport. */
  sent(seq: number, flight: PredictedFlight): void {
    this.predicted = flight;
    this.inFlight.set(seq, flight);
    if (seq > this.newestSeq) this.newestSeq = seq;
  }

  /**
   * Fold in an ack. Safe to call for every ack: a seq that was not a flight
   * order is a no-op.
   */
  acked(seq: number, accepted: boolean): void {
    const flight = this.inFlight.get(seq);
    if (flight === undefined) return;
    this.inFlight.delete(seq);
    if (accepted) {
      // Newest accepted wins: a straggling ack for an older seq must not
      // resurrect a state the server has already superseded.
      if (seq >= this.acceptedSeq) {
        this.accepted = flight;
        this.acceptedSeq = seq;
      }
      return;
    }
    // Rejected: the server never stored this state, so it is still integrating
    // the last accepted one — unless we have since sent something newer, which
    // is what it is really flying. Rolling back then would be the bug.
    if (seq === this.newestSeq) this.predicted = this.accepted;
  }

  clear(): void {
    this.inFlight.clear();
  }
}

/**
 * Move the predictor bodily onto an authoritative sample. Velocity is REPLACED,
 * never carried over: a snap happens precisely when the server is steering
 * differently from the prediction — an asteroid impact cancels most of the
 * ship's velocity, say — and keeping the predictor's nominal speed makes it
 * race away from the corrected position on the very next frame, snap back, and
 * oscillate for as long as the input is held.
 */
export function snapPrediction(
  pred: SteerState,
  pos: { x: number; y: number; z: number },
  heading: number,
  pitch: number,
  vel: { x: number; y: number; z: number },
  up: { x: number; y: number; z: number },
): void {
  pred.pos.x = pos.x;
  pred.pos.y = pos.y;
  pred.pos.z = pos.z;
  pred.heading = heading;
  pred.pitch = pitch;
  pred.up.x = up.x;
  pred.up.y = up.y;
  pred.up.z = up.z;
  pred.vel.x = vel.x;
  pred.vel.y = vel.y;
  pred.vel.z = vel.z;
}

/** Scratch nose vectors + attitude for {@link correctPrediction} (no per-frame alloc). */
const predNose = { x: 0, y: 0, z: 0 };
const sampleNose = { x: 0, y: 0, z: 0 };
const correctedAttitude: Attitude = { heading: 0, pitch: 0 };

/** Residual position error left after a correction pass (the debug overlay reads it). */
export interface CorrectionError {
  x: number;
  y: number;
  z: number;
}

/** Knobs {@link correctPrediction} needs from the session. */
export interface CorrectionParams {
  /** True while the local player is holding a flight input (the attitude is theirs). */
  steering: boolean;
  dt: number;
  /** `tuning.netCorrectionRate` - exponential position pull per second. */
  correctionRate: number;
}

/**
 * Pull the predictor toward one authoritative sample, or snap when it is too far
 * gone (FLIGHT.md 5). Extracted from the session so the ONLINE path can be driven
 * headlessly: a loop is where prediction is hardest, and none of this is
 * reachable through the offline practice session the earlier tests used.
 *
 * ## Why the snap threshold has to scale with speed
 *
 * The predictor is pulled toward the render-DELAYED interpolated state, so its
 * residual is whatever offset makes that pull balance the ship's own motion. On a
 * straight line, or around a simple loop, the two settle almost on top of each
 * other — a held loop measures 0.07 units of residual at render delays from 3 to
 * 20 ticks. A hard PITCHED TURN is different: body-frame yaw couples the two
 * attitude axes (BUBBLE.md §A), the path becomes a tight spiral, and the balance
 * point moves out to ~3.15 units for the shipped interceptor. That is larger than
 * the flat 3-unit snap distance, so a perfectly-predicted manoeuvre would trip the
 * "badly wrong" branch and teleport the ship — online only, on exactly the input a
 * player holds while dogfighting.
 *
 * So while the player is steering, the budget grows with the predictor's own
 * speed: a fast ship is allowed the lag its speed actually produces, a drifting
 * one still gets the tight original threshold. A genuine desync — a collision, a
 * rejected order — diverges without bound and still snaps.
 *
 * All of these numbers are measured in `onlineLoop.test.ts` against a real
 * `ArenaSimulation`, the real int16 codecs and this function; the earlier version
 * of this comment asserted the opposite conclusion from a pure-pitch trajectory
 * alone, which is why the pitched-turn cases are now part of that suite.
 */
export function correctPrediction(
  pred: SteerState,
  sample: {
    pos: { x: number; y: number; z: number };
    heading: number;
    pitch: number;
    up: { x: number; y: number; z: number };
  },
  serverVel: { x: number; y: number; z: number },
  params: CorrectionParams,
): CorrectionError {
  const errX = sample.pos.x - pred.pos.x;
  const errY = sample.pos.y - pred.pos.y;
  const errZ = sample.pos.z - pred.pos.z;
  const speed = len3(pred.vel.x, pred.vel.y, pred.vel.z);
  const limit = params.steering ? steeringSnapDistance(speed) : SNAP_DISTANCE;
  if (Math.hypot(errX, errY, errZ) > limit) {
    // Diverging this far means the server is steering differently (a collision,
    // or an order rejection racing its ack) - defer to server motion, VELOCITY
    // INCLUDED. Adopting the position while keeping the predictor's own speed is
    // what makes a post-collision snap oscillate: the server has shed most of the
    // ship's velocity, the predictor has not, so it sprints past the corrected
    // position and snaps back next frame. The held flight state is deliberately
    // NOT cleared: the server is still integrating it, so dropping it would leave
    // the predictor inert while the real ship keeps flying.
    snapPrediction(pred, sample.pos, sample.heading, sample.pitch, serverVel, sample.up);
    return { x: 0, y: 0, z: 0 };
  }
  const pull = 1 - Math.exp(-params.correctionRate * params.dt);
  pred.pos.x += errX * pull;
  pred.pos.y += errY * pull;
  pred.pos.z += errZ * pull;
  // While the local player is flying, the attitude is a client input - pull it
  // gently so a patch cannot jerk the nose (and the camera with it).
  //
  // The pull acts on the NOSE DIRECTION, not on the two angles separately, and
  // that matters since yaw went body-frame (BUBBLE.md A). `heading` is a
  // coordinate whose scale depends on pitch - a body-frame yaw moves it by
  // `psi / cos(pitch)` - so at steep pitch a tiny difference in where two ships
  // are pointing shows up as a large difference in heading. Pulling the
  // coordinates independently therefore over-corrects: measured on a full-stick
  // pitched turn it moved the rendered nose 0.24 rad in a single frame, four
  // times what the ship can physically rotate in one, which reads as judder.
  // Interpolating the directions and re-deriving the pair corrects by the angle
  // the player can actually see, at every attitude.
  const attitudePull = params.steering ? timeBasedPull(0.15, params.dt) : pull;
  facingVec(pred.heading, pred.pitch, predNose);
  facingVec(sample.heading, sample.pitch, sampleNose);
  const nx = predNose.x + (sampleNose.x - predNose.x) * attitudePull;
  const ny = predNose.y + (sampleNose.y - predNose.y) * attitudePull;
  const nz = predNose.z + (sampleNose.z - predNose.z) * attitudePull;
  const nlen = len3(nx, ny, nz);
  if (nlen > 0) {
    // Spelled continuously with the attitude we already hold, so a predictor
    // flying inverted stays inverted instead of snapping to the upright name for
    // the same direction.
    attitudeNear(headingOf(nx, nz), pitchOf(nx, ny, nz), pred.pitch, correctedAttitude);
    pred.heading = correctedAttitude.heading;
    pred.pitch = correctedAttitude.pitch;
  }
  // The UP AXIS is pulled with the same blend, then re-orthonormalized against
  // the corrected nose — the frame is corrected as one rotation, never as
  // independent coordinates. Skipping this would let the predictor's roll drift
  // from the server's for as long as an input is held, and the hull/camera
  // would visibly twist on the next snap.
  pred.up.x += (sample.up.x - pred.up.x) * attitudePull;
  pred.up.y += (sample.up.y - pred.up.y) * attitudePull;
  pred.up.z += (sample.up.z - pred.up.z) * attitudePull;
  orthonormalizeUp(pred.heading, pred.pitch, pred.up);
  return { x: errX, y: errY, z: errZ };
}



/**
 * Snap distance while the player is steering: the base blunder threshold plus the
 * positional lag a hard manoeuvre legitimately opens between the predictor and a
 * render-delayed sample (see {@link correctPrediction}).
 *
 * {@link MANOEUVRE_LAG_SEC} is how far behind the sample a steering ship settles,
 * in seconds of its own travel. Deriving the allowance from the predictor's OWN
 * speed keeps it honest: it is the quantity the lag is actually proportional to,
 * so a slow ship gets no slack it has not earned. Sized with headroom over the
 * ~3.15 units a full-stick pitched turn measures at nominal speed.
 */
export function steeringSnapDistance(speed: number): number {
  return SNAP_DISTANCE + Math.max(0, speed) * MANOEUVRE_LAG_SEC;
}

/** How far behind the delayed sample a steering ship settles, in seconds of travel. */
const MANOEUVRE_LAG_SEC = 0.12;

/**
 * Velocity implied by two authoritative samples of the same ship (units/s).
 * Zero when the samples are not separated in time — the honest answer, and the
 * safe one for {@link snapPrediction}, which would otherwise inherit a divide.
 */
export function sampledVelocity(
  from: { x: number; y: number; z: number },
  to: { x: number; y: number; z: number },
  dtSeconds: number,
): { x: number; y: number; z: number } {
  if (!(dtSeconds > 0)) return { x: 0, y: 0, z: 0 };
  return {
    x: (to.x - from.x) / dtSeconds,
    y: (to.y - from.y) / dtSeconds,
    z: (to.z - from.z) / dtSeconds,
  };
}

/**
 * Client-side extras that must NOT travel to the server. `ArenaJoinOptions` is
 * forwarded verbatim to `joinOrCreate`, so anything the client knows purely for
 * its own prediction lives here instead (see `upgradeLevels`).
 */
export interface LocalPredictionHints {
  /**
   * The player's upgrade purchases for the ship they are joining on, as the
   * Hangar last read them from `/api/ships`. Used ONLY to resolve the engine
   * stats the predictor integrates with: the server loads its own copy from the
   * DB at spawn (`ArenaRoom.loadUpgradeLevels`) and remains authoritative, so a
   * wrong value here costs prediction accuracy and nothing else.
   */
  upgradeLevels?: UpgradeLevels;
}

/**
 * Online implementation of the GameSession surface (ROADMAP §7 2.4–2.6).
 *
 * Remote entities: snapshot-buffer interpolation `netRenderDelayMs` behind the
 * newest patch. Local player: optimistic prediction — the held flight input
 * integrates immediately through the shared `flightStep` math (the sim's own
 * mirror, FLIGHT.md §1) using RESOLVED ship stats, and the predicted position is
 * pulled toward server truth with an exponential blend (snap above
 * SNAP_DISTANCE). Module toggles overlay an optimistic deploying/retracting
 * state until the server confirms or PENDING_TOGGLE_MS expires.
 *
 * The predictor advances on the RENDER delta, not the sim's fixed step, so at
 * steady state it tracks the server exactly and during an accel ramp it differs
 * only by the discretization of an identical curve — well inside the blend.
 */
export class NetGameSession extends GameSession {
  readonly net = new NetClient();
  private readonly snapshots: TimedSnapshot[] = [];
  private readonly events: SimEvent[] = [];
  private previous: Snapshot;
  private current: Snapshot;
  private seq = 0;
  private lastRenderMs = performance.now();
  private readonly renderDelay: number;
  private readonly correctionRate: number;
  private readonly shipIds = new Map<EntityId, string>();
  private readonly displayNames = new Map<EntityId, string>();
  private readonly arena: ArenaConfig;
  private readonly netConfigs: ConfigService;
  /** Pitch knobs for the predictor, read from the same tuning pack as the sim. */
  private readonly pitchTuning: { pitchRateMult: number; maxPitchRad: number | null };

  // --- local-player prediction ---
  private readonly pred: SteerState = {
    pos: { x: 0, y: 0, z: 0 },
    vel: { x: 0, y: 0, z: 0 },
    heading: 0,
    pitch: 0,
    up: { x: 0, y: 1, z: 0 },
  };
  private predActive = false; // becomes true once seeded from a server snapshot
  /**
   * The flight input the SERVER is believed to be integrating — i.e. the last
   * flight order we sent, kept until another replaces it, and rolled back by
   * sequence when a rejection lands. `flight` orders are level-triggered
   * (FLIGHT.md §1): the sim keeps applying the stored `FlightState` every tick,
   * so the predictor must do the same rather than consuming the order once.
   */
  private readonly flight = new FlightReconciler();
  /**
   * Local player's velocity as the last two authoritative samples imply it —
   * what a prediction snap adopts (see {@link snapPrediction}). `ShipSnapshot`
   * carries no velocity, so it is differenced from replicated positions.
   */
  private readonly serverVel = { x: 0, y: 0, z: 0 };
  private errX = 0; // server − predicted, decayed into pred each frame
  private errY = 0;
  private errZ = 0;

  // Resolved engine stats for the local ship, cached against what produced them.
  private statsKey = "";
  private statsEngine: FlightParams | null = null;
  /**
   * The player's persisted upgrade purchases, if the client knows them (Hangar
   * read them from `/api/ships`). Prediction-only: the server resolves its own
   * copy at spawn and stays authoritative — see {@link NetGameSession.join}.
   */
  private upgradeLevels: UpgradeLevels | undefined;

  private readonly pendingToggles = new Map<number, PendingToggle>();
  private readonly seqSentAt = new Map<number, number>();
  private readonly seqKinds = new Map<number, Order["kind"]>();
  /** Network flags omit breadcrumbs; rebuild their bounded wakes from patches. */
  private readonly flagTrails = new FlagTrailAccumulator();
  private readonly flagTrailLength: number;

  // --- telemetry (NetDebugOverlay) ---
  ordersSent = 0;
  ordersAcked = 0;
  ordersRejected = 0;
  rttMs = 0; // exponentially smoothed via order acks
  patchesReceived = 0;
  patchesPerSec = 0;
  private patchWindowStart = performance.now();
  private patchWindowCount = 0;
  onOrderRejected: ((reason: string) => void) | null = null;
  /** Per-player progression summary sent once, after the match ends (auth'd participants only). */
  onMatchRewards: ((event: Extract<SimEventMessage, { type: "matchRewards" }>) => void) | null = null;

  /** Artificial inbound latency (?fakelag=ms) for netcode testing. */
  private readonly fakeLagMs: number;
  private readonly lagQueue: { at: number; fn: () => void }[] = [];

  private constructor(configs: ConfigService, arenaId: string, gamemodeId: string) {
    // `bots: null` — online ships (including server bots) all arrive via room
    // state; the local shell sim must not spawn or drive any of its own.
    super(configs, arenaId, gamemodeId, 1, { bots: null });
    this.previous = super.curSnapshot;
    this.current = this.previous;
    this.arena = configs.get<ArenaConfig>("arena", arenaId)!;
    this.netConfigs = configs;
    this.flagTrailLength = configs.get<GamemodeConfig>("gamemode", gamemodeId)?.ctf?.trailLength ?? 0;
    const tuning = configs.getAll<TuningConfig>("tuning")[0];
    this.pitchTuning = pitchTuningOf(tuning ?? ({} as TuningConfig));
    this.renderDelay = tuning?.netRenderDelayMs ?? 100;
    this.correctionRate = tuning?.netCorrectionRate ?? 12;
    this.fakeLagMs = Number(new URLSearchParams(location.search).get("fakelag")) || 0;
  }

  static async join(
    configs: ConfigService,
    options: ArenaJoinOptions,
    local: LocalPredictionHints = {},
    reservation?: SeatReservation,
  ): Promise<NetGameSession> {
    const arenaId =
      options.arena ?? configs.get<GamemodeConfig>("gamemode", options.gamemode)?.defaultArena ?? "arena.ring-nebula";
    const session = new NetGameSession(configs, arenaId, options.gamemode);
    session.upgradeLevels = local.upgradeLevels;
    session.net.onOrderAck = (ack) =>
      session.deferred(() => {
        const sentAt = session.seqSentAt.get(ack.seq);
        if (sentAt !== undefined) {
          session.seqSentAt.delete(ack.seq);
          const rtt = performance.now() - sentAt;
          session.rttMs = session.rttMs === 0 ? rtt : session.rttMs * 0.8 + rtt * 0.2;
        }
        const kind = session.seqKinds.get(ack.seq);
        session.seqKinds.delete(ack.seq);
        // A rejected FLIGHT order never reached the sim's FlightState — the
        // reconciler decides, by sequence, whether that means rolling the
        // predictor back (see FlightReconciler).
        session.flight.acked(ack.seq, ack.accepted);
        if (ack.accepted) {
          session.ordersAcked++;
        } else {
          session.ordersRejected++;
          log.warn(`order ${ack.seq} rejected: ${ack.reason ?? "unknown"}`);
          if (kind === "moduleToggle") session.pendingToggles.clear();
          session.onOrderRejected?.(ack.reason ?? "rejected");
        }
      });
    session.net.onFireEvent = (event) =>
      session.deferred(() =>
        session.events.push({
          type: "projectileFired",
          ownerId: event.shooterEntityId,
          moduleId: event.moduleId,
          kind: event.type,
          targetId: event.targetEntityId,
        }),
      );
    session.net.onSimEvent = (event) =>
      session.deferred(() => {
        // matchRewards isn't a sim.SimEvent (it's a net-only per-player message,
        // never produced by the shared sim) — route it to its own callback
        // instead of smuggling it through the sim event queue.
        if (event.type === "matchRewards") {
          session.onMatchRewards?.(event);
          return;
        }
        session.events.push(event as SimEvent);
      });
    session.net.onMatchStats = (message) => session.deferred(() => {
      if (message.lines) for (const line of message.lines) {
        for (const stat of ["kills", "deaths", "assists", "flagsTaken", "flagsDropped", "flagsReturned", "flagsCaptured"] as const) {
          session.matchStats.applyDelta({ entityId: line.entityId, stat, value: line[stat] });
        }
      }
      if (message.deltas) for (const delta of message.deltas) session.matchStats.applyDelta(delta);
    });
    const room = await session.net.connect(options, undefined, reservation);

    // Resolve only once the first state patch has been decoded so playerId and
    // snapshots are valid before views/HUD are constructed around this session.
    await new Promise<void>((resolve) => {
      let first = true;
      room.onStateChange((state) => {
        session.deferred(() => session.receiveState(state));
        if (first) {
          first = false;
          // The deferred decode may still be lag-queued; resolve after it runs.
          session.deferred(resolve);
        }
      });
    });
    return session;
  }

  /** Network sessions are advanced by Colyseus patches, not the local GameLoop. */
  override tick(_fixedDt: number): void {
    this.renderAt(performance.now());
  }
  override get prevSnapshot(): Snapshot { return this.previous; }
  override get curSnapshot(): Snapshot { return this.current; }
  override get isEnded(): boolean { return this.current.phase === "ended"; }
  override teamOf(id: EntityId): number | undefined { return this.current.ships.find((ship) => ship.id === id)?.team; }
  override get playerTeam(): number { return this.teamOf(this.playerId) ?? 0; }
  override shipConfigIdFor(id: EntityId): string | undefined { return this.shipIds.get(id); }
  override displayNameFor(id: EntityId): string | undefined { return this.displayNames.get(id); }

  override order(order: Order): void {
    const seq = this.seq++;
    this.seqSentAt.set(seq, performance.now());
    this.seqKinds.set(seq, order.kind);
    this.net.room?.send(MSG_ORDER, { seq, order });
    this.ordersSent++;

    if (order.kind === "flight") {
      // Level-triggered: this state is what the sim integrates every tick from
      // now on, so the predictor holds it (rather than consuming it once) until
      // the next order replaces it — or an ack rejects it (see `join`).
      this.flight.sent(seq, {
        throttle: order.throttle,
        turn: order.turn,
        pitchStick: order.pitchStick ?? 0,
        boost: order.boost,
        fire: order.fire,
      });
    } else if (order.kind === "moduleToggle") {
      // Keyed by hardpointIndex, not array position — the modules array is
      // sparse-safe (spawn.ts) so a fitting like {0: laser, 2: shield} never
      // has an entry at array index 2.
      const mod = this.current.ships
        .find((s) => s.id === this.playerId)
        ?.modules.find((m) => m.hardpointIndex === order.hardpointIndex);
      if (mod) {
        const retracting = mod.state === "active" || mod.state === "deploying";
        this.pendingToggles.set(order.hardpointIndex, {
          sentAt: performance.now(),
          fromState: mod.state,
          optimistic: retracting ? "retracting" : "deploying",
        });
      }
    }
  }

  override drainFrameEvents(): readonly SimEvent[] { return this.events; }
  override clearFrameEvents(): void { this.events.length = 0; }
  override applyOrder(_entityId: EntityId, order: Order): void { this.order(order); }

  dispose(): void {
    this.net.dispose();
    this.snapshots.length = 0;
    this.events.length = 0;
    this.lagQueue.length = 0;
    this.flight.clear();
    this.flagTrails.clear();
  }

  /** Prediction error magnitude in 3D — the same figure the snap test uses. */
  get correctionError(): number { return Math.hypot(this.errX, this.errY, this.errZ); }
  get bufferDepth(): number { return this.snapshots.length; }

  /** Run `fn` now, or after the artificial latency window when ?fakelag= is set. */
  private deferred(fn: () => void): void {
    if (this.fakeLagMs <= 0) return fn();
    this.lagQueue.push({ at: performance.now() + this.fakeLagMs, fn });
  }

  private drainLagQueue(now: number): void {
    while (this.lagQueue.length && this.lagQueue[0]!.at <= now) this.lagQueue.shift()!.fn();
  }

  private receiveState(state: any): void {
    const snap = this.decode(state);
    const now = performance.now();
    if (this.snapshots.length === 0) {
      // First authoritative state: replace the inherited local-sim snapshot
      // immediately so consumers built right after join() see server entities,
      // not the practice sim's ships (ids/positions would be wrong).
      this.previous = snap;
      this.current = snap;
    }
    this.snapshots.push({ time: now, snapshot: snap });
    if (this.snapshots.length > MAX_SNAPSHOTS) this.snapshots.shift();
    this.patchesReceived++;
    this.patchWindowCount++;
    if (now - this.patchWindowStart >= 1000) {
      this.patchesPerSec = (this.patchWindowCount * 1000) / (now - this.patchWindowStart);
      this.patchWindowStart = now;
      this.patchWindowCount = 0;
    }
  }

  private renderAt(now: number): void {
    this.drainLagQueue(now);
    const b = bracket(this.snapshots, now - this.renderDelay);
    if (!b) return;
    const [a, z, t] = b;
    const dt = Math.max(0, Math.min(0.1, (now - this.lastRenderMs) / 1000));
    this.lastRenderMs = now;

    this.previous = this.current;
    this.current = interpolate(a.snapshot, z.snapshot, t);
    this.trackServerVelocity(a, z);
    this.applyPrediction(dt, now);
    this.applyPendingToggles(now);
  }

  /**
   * Keep the local player's authoritative velocity up to date by differencing
   * the two snapshots currently being interpolated between. Only a snap reads
   * it, but it has to be measured continuously: at the moment of a snap the
   * interesting sample pair is already in the past.
   */
  private trackServerVelocity(a: TimedSnapshot, z: TimedSnapshot): void {
    const from = a.snapshot.ships.find((s) => s.id === this.playerId);
    const to = z.snapshot.ships.find((s) => s.id === this.playerId);
    const v = from && to ? sampledVelocity(from.pos, to.pos, (z.time - a.time) / 1000) : { x: 0, y: 0, z: 0 };
    this.serverVel.x = v.x;
    this.serverVel.y = v.y;
    this.serverVel.z = v.z;
  }

  /** Advance the local predictor and pull it toward server truth (2.5). */
  private applyPrediction(dt: number, now: number): void {
    void now;
    const player = this.current.ships.find((s) => s.id === this.playerId);
    if (!player) {
      this.predActive = false;
      return;
    }
    const cfg = this.netConfigs.get<ShipConfig>("ship", this.shipIds.get(this.playerId) ?? "");
    if (!cfg) return;

    if (!this.predActive) {
      // Seed from the first authoritative sample.
      this.pred.pos.x = player.pos.x;
      this.pred.pos.y = player.pos.y;
      this.pred.pos.z = player.pos.z;
      this.pred.vel.x = 0;
      this.pred.vel.y = 0;
      this.pred.vel.z = 0;
      this.pred.heading = player.heading;
      this.pred.pitch = player.pitch;
      this.pred.up.x = player.up.x;
      this.pred.up.y = player.up.y;
      this.pred.up.z = player.up.z;
      this.predActive = true;
    }

    // RESOLVED engine stats, never `cfg.core.engine`: a module or upgrade that
    // changes nominalSpeed/accel/turnRate makes a base-stats predictor wrong on
    // EVERY tick under continuous flight, which no correction blend can hide
    // (FLIGHT.md §5).
    const engine = this.resolvedEngine(cfg, player);

    // Suspended during the start countdown exactly as the sim suspends its own
    // integration: the server is storing our held flight state without moving
    // the ship, so a predictor that integrated it would run away from truth for
    // three whole seconds and then be dragged back by the correction blend.
    const held = this.current.phase === "live" ? this.flight.current : null;
    if (held) {
      flightStep(
        this.pred,
        {
          throttle: held.throttle,
          turn: held.turn,
          pitchStick: held.pitchStick,
          boostMult: held.boost ? this.predBoostMult(player) : 1,
        },
        engine,
        dt,
      );
    }

    // Blend server error into the prediction; snap when badly wrong.
    const err = correctPrediction(this.pred, player, this.serverVel, {
      steering: held !== null,
      dt,
      correctionRate: this.correctionRate,
    });
    this.errX = err.x;
    this.errY = err.y;
    this.errZ = err.z;

    // Render the local player from the predictor — frame included.
    player.pos.x = this.pred.pos.x;
    player.pos.y = this.pred.pos.y;
    player.pos.z = this.pred.pos.z;
    player.heading = this.pred.heading;
    player.pitch = this.pred.pitch;
    player.up.x = this.pred.up.x;
    player.up.y = this.pred.up.y;
    player.up.z = this.pred.up.z;
  }

  /**
   * The local ship's RESOLVED engine stats — the same {@link resolveShipStats}
   * stack the sim ran at spawn, fed the replicated fitting plus the client's
   * known upgrade levels. Cached against ship id + fitted module ids + upgrade
   * levels, because that is everything the resolution depends on and none of it
   * changes on a typical frame.
   */
  private resolvedEngine(cfg: ShipConfig, player: ShipSnapshot): FlightParams {
    const levels = this.upgradeLevels;
    let key = cfg.id;
    for (const m of player.modules) key += `|${m.moduleId}`;
    if (levels) key += `|${levels.hull},${levels.engine},${levels.energy},${levels.heat}`;
    if (key !== this.statsKey || !this.statsEngine) {
      const fittedModuleIds = player.modules.map((m) => m.moduleId);
      const core = resolveShipStats(cfg, this.netConfigs, { fittedModuleIds, upgradeLevels: levels });
      this.statsEngine = {
        nominalSpeed: core.engine.nominalSpeed,
        accel: core.engine.accel,
        turnRate: core.engine.turnRate,
        // Pitch knobs come from tuning, not the ship: the same source the sim
        // reads, defaulted in one place so the mirrors cannot drift.
        ...this.pitchTuning,
      };
      this.statsKey = key;
    }
    return this.statsEngine;
  }

  /**
   * Boost multiplier for the predictor. The sim only grants boost while the
   * module is `active` WITH energy and heat headroom (`resolveBoostMult`), so
   * gate on the replicated module state too — an unspent boost request would
   * otherwise predict a speed the server never gives. Energy/heat headroom is
   * left to the correction blend: it is a per-tick server-side condition, and
   * predicting it wrong costs a fraction of a tick, not a persistent offset.
   */
  private predBoostMult(player: ShipSnapshot): number {
    const active: string[] = [];
    for (const m of player.modules) if (m.state === "active") active.push(m.moduleId);
    return boostMult(this.netConfigs, active);
  }

  /** Optimistic module button feedback until the server echoes the change. */
  private applyPendingToggles(now: number): void {
    if (this.pendingToggles.size === 0) return;
    const player = this.current.ships.find((s) => s.id === this.playerId);
    if (!player) return;
    for (const [idx, pending] of this.pendingToggles) {
      // Keyed by hardpointIndex, not array position — see the moduleToggle
      // order handler above for why positional indexing is unsafe here.
      const mod = player.modules.find((m) => m.hardpointIndex === idx);
      if (!mod || mod.state !== pending.fromState || now - pending.sentAt > PENDING_TOGGLE_MS) {
        this.pendingToggles.delete(idx);
        continue;
      }
      mod.state = pending.optimistic;
    }
  }

  private decode(state: any): Snapshot {
    const ships = mapValues(state.players).map((p: any) => {
      const id = Number(p.entityId);
      const shipId = String(p.shipId);
      this.shipIds.set(id, shipId);
      this.displayNames.set(id, String(p.displayName ?? "Pilot"));
      if (this.playerId !== id && this.net.room?.sessionId && findKey(state.players, p) === this.net.room.sessionId)
        (this as { playerId: number }).playerId = id;
      const heading = decodeHeading(p.heading);
      const pitch = decodePitch(p.pitch ?? 0);
      return {
        id,
        team: p.team,
        // Full 3D (BUBBLE.md §B): `y` rides the same centi codec as x/z, while
        // `pitch` uses the SIGNED int16 pair — decoding it with `decodeHeading`
        // would turn every nose-down attitude into a ~2π-off climb.
        pos: { x: decodeCenti(p.x), y: decodeCenti(p.y ?? 0), z: decodeCenti(p.z) },
        heading,
        pitch,
        up: decodeUp(p.upX, p.upY, p.upZ, heading, pitch),
        hull: p.hull,
        // Server-resolved maxima (upgrade + passive-resolved), replicated verbatim —
        // never reconstructed from the base ship config, which would ignore
        // upgrade tracks and utility-module passives (capacitor battery, heat sink).
        hullMax: p.hullMax,
        energy: { cur: p.energyCur, max: p.energyMax },
        heat: { cur: p.heatCur, capacity: p.heatCapacity },
        // Flight + sensor state, quantized server-side by `encodeUnit`
        // (FLIGHT.md §5). `targetId` travels as -1 for "none" because the
        // schema field is a plain number.
        targetId: p.targetId === undefined || p.targetId < 0 ? null : Number(p.targetId),
        throttle: decodeUnit(p.throttle ?? 0),
        lockProgress: decodeUnit(p.lockProgress ?? 0),
        locked: Boolean(p.locked),
        modules: decodeModules(p.modules),
      };
    });
    const asteroids = this.arena.asteroidPlacements.map((p, i) => ({
      id: i,
      configId: p.asteroidId,
      pos: { x: p.position.x, y: p.position.y ?? 0, z: p.position.z },
      radius: p.scale ?? 1,
      state: mapGet(state.asteroids, String(i))?.destroyed ? ("destroyed" as const) : ("intact" as const),
    }));
    const projectiles = mapValues(state.projectiles).map((p: any) => ({
      id: p.entityId,
      kind: "missile" as const,
      pos: { x: decodeCenti(p.x), y: decodeCenti(p.y ?? 0), z: decodeCenti(p.z) },
      heading: decodeHeading(p.heading),
    }));
    const decoys = decodeDecoys(state.decoys);
    const flags = decodeFlags(
      state.flags,
      this.arena,
      this.flagTrails,
      this.flagTrailLength,
    );
    // Phase from the room lifecycle + the sim's replicated countdown. A room
    // that has not started yet ("waiting") is reported as `countdown` too: its
    // sim is not being ticked at all, so "frozen, cannot move or fire, GO is
    // still ahead" describes it exactly, and every consumer (HUD overlay,
    // predictor, bots) then needs only ONE rule instead of a waiting special case.
    const countdownRemaining = Math.max(0, Number(state.countdownRemaining ?? 0));
    const phase: Snapshot["phase"] =
      state.matchPhase === "ended"
        ? "ended"
        : state.matchPhase !== "live" || countdownRemaining > 0
          ? "countdown"
          : "live";
    return {
      tick: Math.round((state.matchTimer ?? 0) * 30),
      elapsed: state.matchTimer ?? 0,
      phase,
      teamScores: decodeTeamScores(state.teamScores),
      countdownRemaining,
      winnerTeam: state.winnerTeam === -1 ? null : state.winnerTeam,
      ships,
      asteroids,
      projectiles,
      decoys,
      flags,
    };
  }
}

/**
 * Boost speed multiplier for the CURRENTLY FITTED modules — the ship's
 * `defaultFitting` is only what a fresh spawn starts with; a saved fitting
 * (Hangar, task 4.5) can swap the boost module or drop it entirely, so this
 * must read the actual replicated module ids, not the ship config's default.
 */
export function boostMult(configs: ConfigService, fittedModuleIds: readonly string[]): number {
  for (const modId of fittedModuleIds) {
    const mod = configs.get<import("@space-arena/shared").ModuleConfig>("module", modId);
    if (mod?.boost) return mod.boost.speedMult;
  }
  return 1;
}

/**
 * Decode a replicated `PlayerState.modules` ArraySchema into `ModuleSnapshot[]`,
 * reading `hardpointIndex`/`moduleId`/`cycleTimer`/`shieldPool` verbatim from
 * the wire state — never synthesized from array position or the ship config's
 * `defaultFitting`. The modules array is sparse-safe (see `spawn.ts`): a
 * fitting like `{0: laser, 2: shield}` replicates two entries whose own
 * `hardpointIndex` fields are 0 and 2, NOT array positions 0 and 1, so every
 * consumer (ShipSocketRig, ModuleButtons, pending-toggle overlay) must look
 * modules up by `hardpointIndex`, never by index into this array.
 *
 * Exported standalone (pure over its `raw` input) so the sparse-fitting
 * decode contract has a direct regression test independent of a live
 * Colyseus room.
 */
export function decodeModules(raw: any): Snapshot["ships"][number]["modules"] {
  return mapValues(raw).map((m: any) => ({
    hardpointIndex: m.hardpointIndex,
    moduleId: m.moduleId,
    state: decodeModuleState(m.state),
    heat: m.heat,
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

/** Pure wire decoder for jettisoned heatsinks. */
export function decodeDecoys(raw: any): Snapshot["decoys"] {
  return mapValues(raw).map((d: any) => ({
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
  const flags = mapValues(raw).map((f: any) => {
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

function mapValues(value: any): any[] { return value?.values ? [...value.values()] : Object.values(value ?? {}); }
function mapGet(value: any, key: string): any { return value?.get ? value.get(key) : value?.[key]; }
function findKey(map: any, target: any): string | undefined {
  if (map?.entries) for (const [k, v] of map.entries()) if (v === target) return k;
  return undefined;
}
/** Scratch frame for snapshot interpolation — reset per ship, copied out below. */
const lerpFrame: FrameAttitude = { heading: 0, pitch: 0, up: { x: 0, y: 1, z: 0 } };

function interpolate(a: Snapshot, b: Snapshot, t: number): Snapshot {
  const ships = b.ships.map((s) => {
    const p = a.ships.find((x) => x.id === s.id) ?? s;
    // The ORIENTATION is interpolated as one frame (nose + up nlerp'd and
    // re-orthonormalized), never as heading and pitch independently: near the
    // poles the heading coordinate's scale is unbounded, so two adjacent
    // samples can differ by a large heading for a tiny real rotation, and a
    // coordinate lerp sweeps the hull through a rotation it never made.
    interpolateFrame(p.heading, p.pitch, p.up, s.heading, s.pitch, s.up, t, lerpFrame);
    return {
      ...s,
      pos: {
        x: p.pos.x + (s.pos.x - p.pos.x) * t,
        y: p.pos.y + (s.pos.y - p.pos.y) * t,
        z: p.pos.z + (s.pos.z - p.pos.z) * t,
      },
      heading: lerpFrame.heading,
      pitch: lerpFrame.pitch,
      up: { x: lerpFrame.up.x, y: lerpFrame.up.y, z: lerpFrame.up.z },
      modules: s.modules.map((m) => ({ ...m })),
    };
  });
  return { ...b, ships };
}
