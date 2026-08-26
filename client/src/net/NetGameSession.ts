/* eslint-disable @typescript-eslint/no-explicit-any -- Colyseus schema state is runtime-generated. */
import {
  checkWireState,
  decodeAsteroidDestroyed,
  decodeSnapshot,
  isReplicatedPlayerAlive,
  wireFindKey,
  wireValues,
  FlagTrailAccumulator,
  attitudeNear,
  facingVec,
  flightStep,
  headingOf,
  interpolateFrame,
  len3,
  orthonormalizeUp,
  pitchOf,
  pitchTuningOf,
  resolveShipStats,
  resolveStaticStep,
  spellAttitude,
  StaticWorld,
  MSG_ORDER,
  createLogger,
  type ArenaConfig,
  resolveRockMesh,
  resolveRockShape,
  type AsteroidConfig,
  type ConfigService,
  type EntityId,
  type FlightParams,
  type GamemodeConfig,
  type ModuleConfig,
  type Order,
  type ShipConfig,
  type Attitude,
  type ShipSnapshot,
  type SimEvent,
  type SimEventMessage,
  type Snapshot,
  type SteerState,
  type TuningConfig,
  type UpgradeLevels,
  type FrameAttitude,
} from "@space-arena/shared";
import { GameSession } from "../game/GameSession.js";
import { KineticTracerField } from "./kineticTracers.js";
import { NetClient, type ArenaJoinOptions } from "./NetClient.js";
import type { SeatReservation } from "colyseus.js";
import {
  adaptiveRenderDelay,
  angularVelocity,
  bracket,
  createSnapshotClock,
  ExtrapolationBlender,
  hermiteFrame,
  hermitePosition,
  p90ArrivalGap,
  RENDER_DELAY_CEIL_MS,
  stampSnapshot,
  STATIONARY_CHORD_SQ,
  timeBasedPull,
} from "./interpolation.js";

const log = createLogger("NetGameSession");
/**
 * Snapshot buffer depth. Sized in PATCHES, so it scales with the patch cadence:
 * 64 at the 60 Hz cadence is ~1.07 s of history — it must comfortably cover the
 * 350 ms render-delay ceiling plus the extrapolation window, and 32 (the 15 Hz
 * sizing) would have left only ~533 ms.
 */
const MAX_SNAPSHOTS = 64;
/**
 * Arrival-gap ring depth — deliberately DECOUPLED from MAX_SNAPSHOTS: the p90
 * estimator wants to remember a Wi-Fi burst for a couple of seconds after the
 * network calms down (~2.1 s at 60 Hz), and the ring is just numbers, so depth
 * costs nothing.
 */
const ARRIVAL_GAP_WINDOW = 128;
const SNAP_DISTANCE = 3; // world units: larger prediction error snaps instead of blending
const PENDING_TOGGLE_MS = 800; // optimistic module-state overlay lifetime
/**
 * Minimum age gap (ms) between the two samples the local player's velocity may
 * be differenced across, when a sample carries no replicated velocity.
 * Differencing ADJACENT samples at the 16.7 ms patch cadence amplifies the
 * 0.1-unit position quantization into ±6 u/s of noise per axis; a ≥50 ms
 * baseline keeps it under ±2 u/s, at the cost of the estimate being centred a
 * few samples further back — fine for a fallback whose only consumer is the
 * velocity a prediction snap adopts.
 */
const MIN_VELOCITY_BASELINE_MS = 50;

/**
 * The wire decoders now live in `shared/src/net/decodeState.ts` — unchanged, and
 * still only ever called from here in production. They moved so that the SERVER
 * can import them too: the round-trip test in
 * `server/src/rooms/state/replicate.test.ts` runs this exact decoder against a
 * real `ArenaState` that the real replication writer just filled in, which is
 * the only way the two halves of the protocol are ever exercised together
 * instead of separately against hand-written literals.
 *
 * Re-exported from here because that is where every existing consumer imports
 * them from, and because "the client's decoder" is still what they are.
 */
export {
  decodeCosmeticId,
  decodeDecoys,
  decodeFlags,
  decodeModules,
  decodeRoomPhase,
  decodeShip,
  decodeSnapshot,
  decodeTeamScores,
  decodeUp,
  isReplicatedPlayerAlive,
  FlagTrailAccumulator,
} from "@space-arena/shared";

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
  /**
   * True while the predictor is running on a ROLLBACK rather than on the last
   * order the player sent — i.e. a rejection put it back on `accepted`, and no
   * new input has replaced that since. The flag exists for one race: reject(B)
   * can arrive BEFORE the ack of the older accept(A) it rolls back to, in which
   * case the rollback lands on a stale (possibly null) `accepted` while the
   * server is really integrating A. Without the flag the straggling accept(A)
   * would only update `accepted`, leaving the predictor inert (null) or stale
   * until the player next moves the stick — which for a held-steady input
   * (flight orders are level-triggered and only re-sent on change) can be many
   * seconds of pure rubber-band.
   */
  private rolledBack = false;

  /** The flight state the predictor should be integrating right now. */
  get current(): PredictedFlight | null {
    return this.predicted;
  }

  /** Record a flight order handed to the transport. */
  sent(seq: number, flight: PredictedFlight): void {
    this.predicted = flight;
    this.rolledBack = false;
    this.inFlight.set(seq, flight);
    if (seq > this.newestSeq) this.newestSeq = seq;
  }

  /**
   * Fold in an ack. Safe to call for every ack: a seq that was not a flight
   * order is a no-op.
   */
  acked(seq: number, accepted: boolean): boolean {
    const flight = this.inFlight.get(seq);
    if (flight === undefined) return false;
    this.inFlight.delete(seq);
    if (accepted) {
      // Newest accepted wins: a straggling ack for an older seq must not
      // resurrect a state the server has already superseded.
      if (seq >= this.acceptedSeq) {
        this.accepted = flight;
        this.acceptedSeq = seq;
        // A straggler landing AFTER a rollback, with nothing newer in flight:
        // the server is integrating THIS state (it accepted it and holds
        // nothing later), so the predictor adopts it — see `rolledBack`.
        if (this.rolledBack && this.inFlight.size === 0) {
          this.predicted = flight;
          this.rolledBack = false;
        }
      }
      return false;
    }
    // Rejected: the server never stored this state, so it is still integrating
    // the last accepted one — unless we have since sent something newer, which
    // is what it is really flying. Rolling back then would be the bug.
    if (seq === this.newestSeq) {
      this.predicted = this.accepted;
      this.rolledBack = true;
      return true;
    }
    return false;
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
  snapped: boolean;
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
    return { x: 0, y: 0, z: 0, snapped: true };
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
  return { x: errX, y: errY, z: errZ, snapped: false };
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
  /** Authored minimum render delay; the adaptive delay never goes below it. */
  private readonly renderDelayFloor: number;
  /** Live render delay — widened instantly under patch jitter, narrowed slowly. */
  private renderDelay: number;
  /**
   * Recent patch arrival gaps (ms), the signal the adaptive delay reads. A small
   * ring: old gaps must age out or one Wi-Fi burst would pin the delay at its
   * ceiling for the rest of the match.
   */
  private readonly arrivalGaps: number[] = [];
  /** Cached p90 of `arrivalGaps` — recomputed per PATCH, read per frame. */
  private arrivalGapP90: number | null = null;
  private lastPatchAt: number | null = null;
  /** Hard ceiling on the adaptive render delay; `netRenderDelayMaxMs` overrides it. */
  private readonly renderDelayCeil: number;
  /**
   * Maps the server's `matchTimer` onto the local playback timeline, so the
   * buffer is spaced by SIMULATED time rather than by receive time. See
   * {@link stampSnapshot} — this is what stops remote hulls surging 1.33x/0.67x
   * at 10 Hz because the room ticks at 30 Hz and patches at 20 Hz.
   */
  private readonly snapClock = createSnapshotClock();
  /**
   * Bounded dead reckoning for REMOTE hulls on a starved buffer, plus the
   * rewind-free way back onto the interpolated path. See
   * {@link ExtrapolationBlender} — it carries per-ship state, so it lives with
   * the session rather than being rebuilt per frame.
   */
  private readonly extrapolation = new ExtrapolationBlender();
  private readonly correctionRate: number;
  private readonly shipIds = new Map<EntityId, string>();
  private readonly displayNames = new Map<EntityId, string>();
  private readonly botEntities = new Set<EntityId>();
  private readonly arena: ArenaConfig;
  private readonly netConfigs: ConfigService;
  /** Display-only kinetic rounds, reconstructed from fire events (see module doc). */
  private readonly kineticTracers = new KineticTracerField();
  /** Pitch knobs for the predictor, read from the same tuning pack as the sim. */
  private readonly pitchTuning: { pitchRateMult: number; maxPitchRad: number | null };
  /** Immutable static collision data shared with the authoritative simulation. */
  private readonly staticWorld: StaticWorld;
  private readonly staticRule: GamemodeConfig["boundaryRule"];
  private readonly tuning: TuningConfig | undefined;

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
  /** One-shot latch for the wire field-name check — see {@link receiveState}. */
  private wireChecked = false;
  /** Latched by {@link dispose}: nothing on this session runs again. */
  private disposed = false;

  // --- telemetry (NetDebugOverlay) ---
  ordersSent = 0;
  ordersAcked = 0;
  ordersRejected = 0;
  rttMs = 0; // exponentially smoothed via order acks
  patchesReceived = 0;
  patchesPerSec = 0;
  /** Debug counters: authoritative corrections that teleported prediction. */
  predictionSnaps = 0;
  /** Debug counters: rejected newest flight orders that restored accepted input. */
  predictionRollbacks = 0;
  private patchWindowStart = performance.now();
  private patchWindowCount = 0;
  onOrderRejected: ((reason: string) => void) | null = null;
  /** Per-player progression summary sent once, after the match ends (auth'd participants only). */
  onMatchRewards: ((event: Extract<SimEventMessage, { type: "matchRewards" }>) => void) | null = null;
  /**
   * Every decoded authoritative state, including the ones that arrive while the
   * room is still `waiting` and nothing is ticking this session. The launch
   * screen listens here to grow its team rosters as pilots (and the room's
   * backfill bots) land, and to learn the moment the room goes live.
   */
  onSnapshot: ((snapshot: Snapshot) => void) | null = null;
  /** Newest decoded state — see {@link onSnapshot} and `rosterSnapshot`. */
  private latest: Snapshot | null = null;

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
    // GameSession's construction already built the immutable world from this
    // arena/config snapshot. Reuse it so an online session owns exactly one BVH
    // set rather than decoding the same collision config twice.
    this.staticWorld = this.sim.world.staticWorld;
    this.staticRule = configs.get<GamemodeConfig>("gamemode", gamemodeId)!.boundaryRule;
    this.flagTrailLength = configs.get<GamemodeConfig>("gamemode", gamemodeId)?.ctf?.trailLength ?? 0;
    const tuning = configs.getAll<TuningConfig>("tuning")[0];
    this.tuning = tuning;
    this.pitchTuning = pitchTuningOf(tuning);
    this.renderDelayFloor = tuning?.netRenderDelayMs ?? 100;
    this.renderDelay = this.renderDelayFloor;
    // Never below the floor: a ceiling under the authored delay would make the
    // adaptive delay fight the designer's own minimum every frame.
    this.renderDelayCeil = Math.max(this.renderDelayFloor, tuning?.netRenderDelayMaxMs ?? RENDER_DELAY_CEIL_MS);
    this.correctionRate = tuning?.netCorrectionRate ?? 12;
    this.fakeLagMs = Number(new URLSearchParams(location.search).get("fakelag")) || 0;
  }

  /**
   * Nominal / mean / bounding radii for one asteroid config, resolved once per
   * config per session. The offline sim carries these on its asteroid entities;
   * online there are no asteroid entities at all, so they are rebuilt here from
   * the same shape the sim resolves — which is what keeps the bots' snapshot-only
   * geometry identical on both paths.
   */
  private rockGeometry(configId: string): { radius: number; mean: number; bound: number } {
    const cached = this.rockGeometryCache.get(configId);
    if (cached) return cached;
    const cfg = this.netConfigs.get<AsteroidConfig>("asteroid", configId);
    const radius = cfg?.radius ?? 1;
    const shape = cfg?.shape ? resolveRockShape(cfg.shape) : null;
    const mesh = !shape && cfg ? resolveRockMesh(cfg) : null;
    const geometry = shape
      ? { radius, mean: radius * shape.meanRadius, bound: radius * shape.maxRadius }
      : mesh
        ? { radius, mean: radius * mesh.meanRadius, bound: radius * mesh.maxRadius }
        : { radius, mean: radius * (cfg?.colliderScale ?? 1), bound: radius * (cfg?.colliderScale ?? 1) };
    this.rockGeometryCache.set(configId, geometry);
    return geometry;
  }

  private readonly rockGeometryCache = new Map<string, { radius: number; mean: number; bound: number }>();

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
        if (session.flight.acked(ack.seq, ack.accepted)) session.predictionRollbacks++;
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
      session.deferred(() => {
        session.events.push({
          type: "projectileFired",
          ownerId: event.shooterEntityId,
          moduleId: event.moduleId,
          kind: event.type,
          targetId: event.targetEntityId,
        });
        // Kinetic rounds are not replicated (missiles are the only schema
        // projectile), so the fire event is the ONLY thing the client ever
        // hears about one — the visible round is reconstructed here.
        if (event.type === "kinetic") session.spawnKineticTracer(event.shooterEntityId, event.targetEntityId, event.moduleId);
      });
    session.net.onSimEvent = (event) =>
      session.deferred(() => {
        // matchRewards isn't a sim.SimEvent (it's a net-only per-player message,
        // never produced by the shared sim) — route it to its own callback
        // instead of smuggling it through the sim event queue.
        if (event.type === "matchRewards") {
          session.onMatchRewards?.(event);
          return;
        }
        // A kinetic damage report naming a shooter retires that shooter's
        // oldest tracer, so the visible round ends where the sim says the hit
        // landed instead of flying on through the hull. Same-frame with the
        // event push above: the view's evidence-first despawn then draws the
        // impact from the very damage report that ended the round.
        if (event.type === "damage" && event.damageType === "kinetic" && event.sourceId !== null) {
          session.kineticTracers.onKineticDamage(event.sourceId);
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

  /**
   * Network sessions are advanced by Colyseus patches, not the local GameLoop —
   * and, since the buffer is resampled per DRAWN FRAME (see
   * {@link sampleForRender}), not by the fixed step either. Deliberately inert:
   * sampling here as well would resample the buffer at fixed-step instants that
   * no alpha in the renderer corresponds to.
   */
  override tick(_fixedDt: number): void {}

  /**
   * Resample the snapshot buffer at the instant this frame is drawn.
   *
   * The returned alpha is 1, not the loop accumulator's: `current` is already
   * the state at `now`, so there is nothing left for the renderer to blend
   * toward. `previous` stays the LAST FRAME's sample, which is what every
   * consumer that differences the pair (bank roll, the speed readout, view
   * spawn/despawn checks) actually wants. See {@link GameSession.sampleForRender}
   * for why the old fixed-step sampling was the source of the online judder.
   */
  override sampleForRender(_loopAlpha: number): number {
    if (this.disposed) return 1;
    this.renderAt(performance.now());
    return 1;
  }
  override get prevSnapshot(): Snapshot { return this.previous; }
  override get curSnapshot(): Snapshot { return this.current; }
  /**
   * Newest decoded server state, NOT the interpolated pair: before the match
   * runtime exists nothing calls `tick`, so `curSnapshot` is still the first
   * patch and would show a roster of one.
   */
  override get rosterSnapshot(): Snapshot { return this.latest ?? this.current; }
  override get isEnded(): boolean { return this.current.phase === "ended"; }
  override teamOf(id: EntityId): number | undefined { return this.current.ships.find((ship) => ship.id === id)?.team; }
  override get playerTeam(): number { return this.teamOf(this.playerId) ?? 0; }
  override shipConfigIdFor(id: EntityId): string | undefined { return this.shipIds.get(id); }
  override displayNameFor(id: EntityId): string | undefined { return this.displayNames.get(id); }
  override isBotFor(id: EntityId): boolean { return this.botEntities.has(id); }

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

  /**
   * Kill this session for good (main.ts `endMatch`). The page outlives the
   * match, so "stop using it" is not enough — every route back INTO it has to
   * be cut, or a late patch/message decodes into a session the app has already
   * discarded and drives HUD, views and audio from the menu.
   *
   * The socket goes first (so the room is left even if a later step throws),
   * then the callbacks the app installed on this object, then the buffers.
   * Idempotent, and `deferred`/`tick` are inert afterwards.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.net.dispose();
    this.onSnapshot = null;
    this.onOrderRejected = null;
    this.onMatchRewards = null;
    this.snapshots.length = 0;
    this.events.length = 0;
    this.kineticTracers.clear();
    this.lagQueue.length = 0;
    this.flight.clear();
    this.flagTrails.clear();
    this.extrapolation.clear();
  }

  /** True once {@link dispose} ran — the session accepts no further work. */
  get isDisposed(): boolean { return this.disposed; }

  /** Prediction error magnitude in 3D — the same figure the snap test uses. */
  get correctionError(): number { return Math.hypot(this.errX, this.errY, this.errZ); }
  get bufferDepth(): number { return this.snapshots.length; }

  /** Run `fn` now, or after the artificial latency window when ?fakelag= is set. */
  private deferred(fn: () => void): void {
    // A disposed session accepts no more work — including the fakelag queue,
    // whose entries would otherwise fire minutes after the match ended.
    if (this.disposed) return;
    if (this.fakeLagMs <= 0) return fn();
    this.lagQueue.push({ at: performance.now() + this.fakeLagMs, fn });
  }

  private drainLagQueue(now: number): void {
    while (this.lagQueue.length && this.lagQueue[0]!.at <= now) this.lagQueue.shift()!.fn();
  }

  private receiveState(state: any): void {
    // The client half of the wire field-name contract (see
    // `shared/src/net/wireFields.ts`). CI already asserts the server's schema
    // against the same frozen list; this is the backstop for the case no test
    // can see — a DEPLOYED server whose schema drifted from the bundle this
    // browser is running, which decodes as a screen full of silent `?? 0`.
    //
    // Latched to the first patch on purpose. `receiveState` is the netcode's
    // hot path at 20 Hz; an Object.keys walk per patch would allocate on every
    // one of them to re-answer a question whose answer cannot change inside a
    // single room connection. Reported rather than thrown for the same reason:
    // a schema mismatch is a broken HUD, but a throw here is a dead client.
    if (!this.wireChecked) {
      this.wireChecked = true;
      for (const problem of checkWireState(state)) log.error("wire schema mismatch —", problem);
    }
    // Arrival instant BEFORE the decode: the decode itself costs real time at
    // the 60 Hz patch cadence, and stamping after it would fold that cost into
    // both the arrival-gap jitter measurement and the snapshot clock's offset
    // observations.
    const now = performance.now();
    const snap = this.decode(state);
    this.latest = snap;
    // The buffer is spaced by the SERVER's clock, not by receive time — see
    // `stampSnapshot`. A reset means the mapping changed under us (the match went
    // live and `matchTimer` left 0; a reconnect; a restart), so everything already
    // buffered is filed against a timeline that no longer exists and has to go.
    const stamp = stampSnapshot(this.snapClock, snap.elapsed * 1000, now);
    if (stamp.reset) {
      this.snapshots.length = 0;
      // The live render delay goes back to the authored floor with it. It is a
      // measurement OF the discarded timeline — and specifically, a lobby holds
      // `matchTimer` at 0 for its whole length, which leaves the buffer's newest
      // timestamp minutes behind `now` and pegs the shortfall term at the ceiling.
      // Carrying that into the match would open every round with ~350 ms of
      // display latency, bled off at 15 ms/s: sixteen seconds of lag for nothing.
      // `arrivalGaps` deliberately survives — it measures the network, which a
      // clock reset says nothing about.
      this.renderDelay = this.renderDelayFloor;
      // Everything keyed to the DISCARDED timeline goes with it: the blender's
      // drawn-position anchors would otherwise hand back residuals measured
      // against positions from the dead timeline (its own class doc names a
      // clock reset as exactly what `clear` is for), and a flag's accumulated
      // wake belongs to the old match.
      this.extrapolation.clear();
      this.flagTrails.clear();
    }
    if (this.snapshots.length === 0) {
      // First authoritative state: replace the inherited local-sim snapshot
      // immediately so consumers built right after join() see server entities,
      // not the practice sim's ships (ids/positions would be wrong).
      this.previous = snap;
      this.current = snap;
    }
    this.snapshots.push({ time: stamp.timeMs, snapshot: snap });
    if (this.snapshots.length > MAX_SNAPSHOTS) this.snapshots.shift();
    // Feed the adaptive render delay (see `renderAt`): ~2.1 s of gap history at
    // the nominal patch rate, enough to see a Wi-Fi burst coming and to forget
    // it once the network calms down. The p90 is computed HERE, once per patch,
    // because it can only change when a gap lands — recomputing (and sorting a
    // copy) per rendered frame was pure hot-path churn.
    if (this.lastPatchAt !== null) {
      this.arrivalGaps.push(now - this.lastPatchAt);
      if (this.arrivalGaps.length > ARRIVAL_GAP_WINDOW) this.arrivalGaps.shift();
      this.arrivalGapP90 = p90ArrivalGap(this.arrivalGaps);
    }
    this.lastPatchAt = now;
    this.patchesReceived++;
    this.patchWindowCount++;
    if (now - this.patchWindowStart >= 1000) {
      this.patchesPerSec = (this.patchWindowCount * 1000) / (now - this.patchWindowStart);
      this.patchWindowStart = now;
      this.patchWindowCount = 0;
    }
    this.onSnapshot?.(snap);
  }

  private renderAt(now: number): void {
    this.drainLagQueue(now);
    const dt = Math.max(0, Math.min(0.1, (now - this.lastRenderMs) / 1000));
    this.lastRenderMs = now;
    // Adapt the render delay to the patch cadence actually observed — a fixed
    // delay leaves the bracket dry the moment arrivals burst past it, and a dry
    // bracket is a remote ship frozen at the newest snapshot until the next
    // patch shoves it forward. See adaptiveRenderDelay for the measurements.
    //
    // The SHORTFALL is the closed-loop half of that: how far this frame's render
    // point has actually overrun the newest buffered sample, measured rather than
    // predicted. It is the direct signal that the delay is too tight, and it
    // reads zero whenever the buffer is healthy.
    const newest = this.snapshots.length > 0 ? this.snapshots[this.snapshots.length - 1]!.time : null;
    const shortfall = newest === null ? 0 : Math.max(0, now - this.renderDelay - newest);
    this.renderDelay = adaptiveRenderDelay(
      this.renderDelay,
      this.arrivalGapP90,
      this.renderDelayFloor,
      dt,
      this.renderDelayCeil,
      shortfall,
    );
    const b = bracket(this.snapshots, now - this.renderDelay);
    if (!b) return;
    // `leadMs` is 0 on every healthy frame. It is non-zero only when the render
    // point has overrun the newest sample — the starve `shortfall` above has
    // just widened the delay for — and it is the BOUNDED lead the remote hulls
    // dead-reckon along instead of freezing. See `ExtrapolationBlender`.
    const [a, z, t, leadMs] = b;
    // The samples flanking the bracketed segment feed the C1 position curve for
    // remote ships (see `interpolate`). Identity lookup, not a re-search: these
    // are the very objects `bracket` just returned, and the buffer is ≤32 long.
    const ia = this.snapshots.indexOf(a);
    const iz = this.snapshots.indexOf(z);
    const before = ia > 0 ? this.snapshots[ia - 1]! : null;
    const after = iz >= 0 && iz + 1 < this.snapshots.length ? this.snapshots[iz + 1]! : null;

    this.previous = this.current;
    const frame = interpolate(a, z, t, before, after, this.playerId, {
      blender: this.extrapolation,
      leadMs,
      dtSeconds: dt,
    });
    // Synthetic kinetic rounds ride the same projectiles array the pool
    // renderer already draws. COPY before appending: `interpolate` reuses the
    // buffered snapshot's array by reference, and pushing into that would leak
    // tracers into the interpolation history.
    if (this.kineticTracers.size > 0) {
      frame.projectiles = frame.projectiles.slice();
      this.kineticTracers.sample(now, frame.projectiles);
    }
    this.current = frame;
    this.trackServerVelocity(a, z);
    this.applyPrediction(dt, leadMs);
    this.applyPendingToggles(now);
  }

  /**
   * Launch the visible round for one kinetic fire event, from the DISPLAYED
   * world: origin at the displayed shooter, aim at the displayed target (the
   * sim aims a kinetic at the target's current position and leads nothing, so
   * this reproduces the real trajectory up to interpolation error), ballistics
   * from the module config. Display-only — damage stays entirely the sim's.
   */
  private spawnKineticTracer(shooterId: EntityId, targetId: EntityId | null, moduleId: string): void {
    const shooter = this.current.ships.find((s) => s.id === shooterId);
    if (!shooter) return; // shooter not displayed yet — nothing to launch from
    const fire = this.netConfigs.get<ModuleConfig>("module", moduleId)?.fire;
    const speed = fire?.projectile?.speed ?? 60;
    const lifetime = fire?.projectile?.lifetime ?? 1.5;
    const ttlSec = Math.min(lifetime, fire?.range !== undefined && speed > 0 ? fire.range / speed : lifetime);
    const target = targetId === null ? undefined : this.current.ships.find((s) => s.id === targetId);
    const dir = { x: 0, y: 0, z: 0 };
    if (target) {
      dir.x = target.pos.x - shooter.pos.x;
      dir.y = target.pos.y - shooter.pos.y;
      dir.z = target.pos.z - shooter.pos.z;
    } else {
      facingVec(shooter.heading, shooter.pitch, dir);
    }
    const len = Math.hypot(dir.x, dir.y, dir.z);
    if (!(len > 1e-6)) return;
    // Muzzle a hull-length ahead so the round never spawns inside the shooter.
    const muzzle = 1.2;
    this.kineticTracers.spawn(
      shooterId,
      performance.now(),
      {
        x: shooter.pos.x + (dir.x / len) * muzzle,
        y: shooter.pos.y + (dir.y / len) * muzzle,
        z: shooter.pos.z + (dir.z / len) * muzzle,
      },
      dir,
      { speed, ttlSec },
    );
  }

  /**
   * Keep the local player's authoritative velocity up to date. Only a snap reads
   * it, but it has to be measured continuously: at the moment of a snap the
   * interesting sample pair is already in the past.
   *
   * The REPLICATED velocity is preferred over differencing the bracketed pair,
   * and the difference matters at exactly the moment this value is used. A
   * difference is the segment's AVERAGE velocity, centred half a patch (33 ms)
   * in the past and computed from two centi-quantized positions — and a snap
   * fires precisely when the server did something abrupt (an asteroid impact
   * that cancelled most of the ship's speed), where an average across the
   * impact is a velocity the ship never had. Adopting it makes the ship sprint
   * away from the corrected position and snap back, which is the oscillation
   * {@link snapPrediction} exists to prevent. The newest sample's own velocity
   * is the post-impact one.
   *
   * Differencing remains the fallback for a sample with no replicated velocity
   * (a pre-velocity server, a hull decoded as an all-zero triple).
   */
  private trackServerVelocity(a: TimedSnapshot, z: TimedSnapshot): void {
    const to = z.snapshot.ships.find((s) => s.id === this.playerId);
    let v = to?.velocity;
    if (!v && to) {
      // Fallback differencing, against a baseline at least
      // MIN_VELOCITY_BASELINE_MS old rather than the adjacent sample: at the
      // 16.7 ms patch cadence an adjacent-pair difference is dominated by the
      // position codec's quantization (see the constant's doc). Walk back from
      // the bracketed sample; the segment start `a` remains the last resort for
      // a buffer too young to offer one.
      let from: TimedSnapshot | null = null;
      for (let i = this.snapshots.indexOf(z) - 1; i >= 0; i--) {
        const s = this.snapshots[i]!;
        if (z.time - s.time >= MIN_VELOCITY_BASELINE_MS) {
          from = s;
          break;
        }
      }
      from ??= a !== z ? a : null;
      const fromShip = from?.snapshot.ships.find((s) => s.id === this.playerId);
      if (from && fromShip) v = sampledVelocity(fromShip.pos, to.pos, (z.time - from.time) / 1000);
    }
    this.serverVel.x = v?.x ?? 0;
    this.serverVel.y = v?.y ?? 0;
    this.serverVel.z = v?.z ?? 0;
  }

  /**
   * Advance the local predictor and pull it toward server truth (2.5).
   *
   * `leadMs` is `bracket`'s bounded overrun — non-zero only while the snapshot
   * buffer is STARVED. During a starve the correction pull is suspended: the
   * interpolated correction target is clamped to the frozen newest sample, and
   * pulling toward a parked target at `netCorrectionRate` reaches equilibrium
   * (err = speed/rate) within ~85 ms — the LOCAL hull decelerated into a crawl
   * glued near the stale sample, while every remote hull dead-reckoned smoothly
   * past it. The predictor free-integrating IS the local ship's extrapolator;
   * the pull resumes on the first wet frame and repays whatever error the
   * starve left, exactly as it does after any patch gap.
   */
  private applyPrediction(dt: number, leadMs: number): void {
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
          // ONE speed multiplier, exactly as the sim composes it
          // (`NavigationSystem`): boost when asked for and granted, times
          // whatever a slowing ray is taking off this hull. The slow is
          // replicated (`PlayerState.slowFactor`) precisely so the predictor
          // can see it — without it a slowed local player would predict full
          // speed for the whole four seconds and be dragged back by the
          // correction blend the entire time (FLIGHT.md §5).
          boostMult: (held.boost ? this.predBoostMult(player) : 1) * (1 - (player.slowFactor ?? 0)),
        },
        engine,
        dt,
      );
      this.resolvePredictedStatics(cfg.collider.radius, dt);
    }

    // Blend server error into the prediction; snap when badly wrong. Suspended
    // while the buffer is starved — see the method doc.
    if (leadMs <= 0) {
      const err = correctPrediction(this.pred, player, this.serverVel, {
        steering: held !== null,
        dt,
        correctionRate: this.correctionRate,
      });
      this.errX = err.x;
      this.errY = err.y;
      this.errZ = err.z;
      if (err.snapped) this.predictionSnaps++;
    }

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

  /** Static mesh then box-boundary resolution, in the server helper's order. */
  private resolvePredictedStatics(radius: number, dt: number): void {
    if (this.staticWorld.isEmpty && this.arena.bounds.shape !== "box") return;
    const state = {
      position: this.pred.pos,
      velocity: this.pred.vel,
      heading: this.pred.heading,
      pitch: this.pred.pitch,
      up: this.pred.up,
    };
    resolveStaticStep(
      {
        staticWorld: this.staticWorld,
        bounds: this.arena.bounds,
        rule: this.staticRule,
      },
      state,
      radius,
      dt,
    );
    this.pred.heading = state.heading;
    this.pred.pitch = state.pitch;
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
    if (levels) key += `|${levels.hull},${levels.engine},${levels.energy}`;
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
   * module is `active` WITH energy headroom (`resolveBoostMult`), so
   * gate on the replicated module state too — an unspent boost request would
   * otherwise predict a speed the server never gives. Energy headroom is
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
    const snap = decodeSnapshot(state, {
      arena: this.arena,
      asteroids: this.decodeAsteroids(state),
      trails: this.flagTrails,
      trailLength: this.flagTrailLength,
    });
    this.cachePlayerIdentities(state);
    return snap;
  }

  /**
   * Rocks are STATIC and identical on both sides, so the room replicates only
   * which ones have been destroyed and the client rebuilds the rest from the
   * arena config — which is why this stays here rather than in the shared
   * decoder: everything except `state` comes from configs and the local
   * mesh-geometry cache. `id` is the placement index, which is also what tumble
   * is keyed on (`shared/src/collision/rockPose.ts`) — offline the ids are sim
   * entity ids and `placementIndex` carries the same number.
   */
  private decodeAsteroids(state: any): Snapshot["asteroids"] {
    // Rocks are static: everything below except `state` is a pure function of
    // the arena config, and `state` flips at most a handful of times per match.
    // Rebuilding the whole array per patch allocated an object + position per
    // rock at the patch rate (60 Hz × dozens of rocks) for data that had not
    // changed — so the previous array is reused BY REFERENCE until a destroyed
    // bit actually differs. Snapshots may share it because asteroid entries are
    // read-only by convention everywhere (a new array is built on change, so
    // buffered history keeps its own pre-destruction view).
    const cached = this.asteroidSnapshotCache;
    if (cached && cached.length === this.arena.asteroidPlacements.length) {
      let dirty = false;
      for (let i = 0; i < cached.length; i++) {
        const destroyed = decodeAsteroidDestroyed(state.asteroids, i);
        if ((cached[i]!.state === "destroyed") !== destroyed) {
          dirty = true;
          break;
        }
      }
      if (!dirty) return cached;
    }
    const rebuilt = this.arena.asteroidPlacements.map((p, i) => {
      const geometry = this.rockGeometry(p.asteroidId);
      const scale = p.scale ?? 1;
      return {
        id: i,
        placementIndex: i,
        rotationY: p.rotation ?? 0,
        configId: p.asteroidId,
        pos: { x: p.position.x, y: p.position.y ?? 0, z: p.position.z },
        radius: geometry.radius * scale,
        colliderRadius: geometry.mean * scale,
        boundRadius: geometry.bound * scale,
        state: decodeAsteroidDestroyed(state.asteroids, i) ? ("destroyed" as const) : ("intact" as const),
      };
    });
    this.asteroidSnapshotCache = rebuilt;
    return rebuilt;
  }

  /** Last decoded rock list — reused by reference until a destroyed bit flips. */
  private asteroidSnapshotCache: Snapshot["asteroids"] | null = null;

  /**
   * Roster-side bookkeeping the snapshot itself does not carry: which ship
   * config / display name / bot flag belongs to an entity id, and which entity
   * is US. Dead entries are skipped for the same reason they are dropped from
   * the snapshot — a corpse's roster row is stale until it respawns.
   *
   * Kept separate from the decode so the decoder can stay pure and be shared
   * with the server's round-trip test. It runs after `decodeSnapshot` and
   * before `decode` returns, so every consumer still sees the caches populated
   * for the snapshot it is handed, exactly as when this was one fused loop.
   */
  private cachePlayerIdentities(state: any): void {
    const sessionId = this.net.room?.sessionId;
    for (const p of wireValues(state.players)) {
      if (!isReplicatedPlayerAlive(p)) continue;
      const id = Number(p.entityId);
      this.shipIds.set(id, String(p.shipId));
      this.displayNames.set(id, String(p.displayName ?? "Pilot"));
      if (p.isBot === true) this.botEntities.add(id);
      else this.botEntities.delete(id);
      if (this.playerId !== id && sessionId && wireFindKey(state.players, p) === sessionId)
        (this as { playerId: number }).playerId = id;
    }
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

/** Scratch frame for snapshot interpolation — reset per ship, copied out below. */
const lerpFrame: FrameAttitude = { heading: 0, pitch: 0, up: { x: 0, y: 1, z: 0 } };

/**
 * Scratch orientation samples handed to {@link hermiteFrame}, and the scratch
 * the dead-reckoned frame comes back in.
 *
 * `interpolate` runs per ship per DRAWN frame, so none of this may allocate.
 * `up` is aliased to the snapshot's own vector rather than copied — the curve
 * only ever reads it.
 */
interface FrameSample {
  time: number;
  heading: number;
  pitch: number;
  up: { readonly x: number; readonly y: number; readonly z: number };
}
const framePrev: FrameSample = { time: 0, heading: 0, pitch: 0, up: { x: 0, y: 1, z: 0 } };
const frameFrom: FrameSample = { time: 0, heading: 0, pitch: 0, up: { x: 0, y: 1, z: 0 } };
const frameTo: FrameSample = { time: 0, heading: 0, pitch: 0, up: { x: 0, y: 1, z: 0 } };
const frameNext: FrameSample = { time: 0, heading: 0, pitch: 0, up: { x: 0, y: 1, z: 0 } };
const frameOmega = { x: 0, y: 0, z: 0 };
const frameNose = { x: 0, y: 0, z: 0 };
const frameOut = { nose: { x: 0, y: 0, z: 0 }, up: { x: 0, y: 1, z: 0 } };

function fillFrame(dst: FrameSample, time: number, ship: ShipSnapshot): FrameSample {
  dst.time = time;
  dst.heading = ship.heading;
  dst.pitch = ship.pitch;
  dst.up = ship.up;
  return dst;
}

/**
 * The dead-reckoning half of a rendered frame, threaded through {@link interpolate}.
 *
 * Optional because most callers (tests, the pacing suite) want the pure blend
 * with no session state attached. Passing it in is what turns a starved buffer
 * from a freeze into a bounded, rewind-free extrapolation.
 */
export interface ExtrapolateOptions {
  /** Per-ship residual state; lives on the session, not the frame. */
  blender: ExtrapolationBlender;
  /** `bracket`'s bounded overrun past the newest sample; 0 when healthy. */
  leadMs: number;
  /** Frame delta, for the residual decay. */
  dtSeconds: number;
}

/**
 * Blend the bracketed snapshot pair into the frame's render state.
 *
 * REMOTE ship positions ride the C1 Hermite curve ({@link hermitePosition})
 * through the samples flanking the segment: plain lerp is C0, and its velocity
 * step at every sample boundary reads as a faint shudder at 60 fps even under a
 * perfect playback timeline. The curve's tangents are the samples' own
 * REPLICATED velocities where the wire carries them; `before`/`after` are the
 * buffer neighbours of `a`/`b` and supply the finite-difference fallback for a
 * sample that does not. A ship missing from every one of those (just spawned,
 * buffer still filling, no velocity) degrades that end of its curve to the old
 * lerp.
 *
 * The LOCAL player's position stays plain lerp on purpose: it is not a display
 * position — the hull renders from the predictor — it is the CORRECTION TARGET
 * `applyPrediction` pulls the predictor toward every frame, and the correction
 * constants (netCorrectionRate, snap distances, the manoeuvre-lag budget) were
 * all measured against the lerped target. Remote smoothing is display-only
 * polish and must not steer the predictor.
 *
 * `elapsed` is interpolated with everything else, and has to be: it is the
 * client's MATCH CLOCK, and copying it verbatim off `b` left it stepping in
 * 50 ms server-patch jumps while the frame around it moved smoothly. Everything
 * driven by it inherited the step — asteroid spin and decoy tumble are posed
 * directly from `cur.elapsed` (so every rock in the arena stuttered at the patch
 * rate, whether or not a ship was near it), and `cur.elapsed - prev.elapsed` is
 * the denominator of two RATES (the hull's bank roll, the HUD speed readout),
 * which read zero on most frames and one whole patch interval on the rest.
 */
export function interpolate(
  a: TimedSnapshot,
  b: TimedSnapshot,
  t: number,
  before: TimedSnapshot | null,
  after: TimedSnapshot | null,
  localPlayerId: EntityId,
  extrapolate?: ExtrapolateOptions,
): Snapshot {
  const live = extrapolate ? new Set<EntityId>() : null;
  const ships = b.snapshot.ships.map((s) => {
    live?.add(s.id);
    const p = a.snapshot.ships.find((x) => x.id === s.id) ?? s;
    const pos = { x: 0, y: 0, z: 0 };
    if (s.id === localPlayerId) {
      // The ORIENTATION is interpolated as one frame (nose + up nlerp'd and
      // re-orthonormalized), never as heading and pitch independently: near the
      // poles the heading coordinate's scale is unbounded, so two adjacent
      // samples can differ by a large heading for a tiny real rotation, and a
      // coordinate lerp sweeps the hull through a rotation it never made.
      interpolateFrame(p.heading, p.pitch, p.up, s.heading, s.pitch, s.up, t, lerpFrame);
      pos.x = p.pos.x + (s.pos.x - p.pos.x) * t;
      pos.y = p.pos.y + (s.pos.y - p.pos.y) * t;
      pos.z = p.pos.z + (s.pos.z - p.pos.z) * t;
    } else {
      const pPrev = before?.snapshot.ships.find((x) => x.id === s.id);
      const pNext = after?.snapshot.ships.find((x) => x.id === s.id);
      // The two segment endpoints hand their REPLICATED velocity to the curve,
      // which uses `M = v·h` in place of a finite difference wherever it has
      // one. `pPrev`/`pNext` still travel because a sample that carries no
      // velocity (a pre-velocity server, a decoded all-zero triple) falls back
      // to the old Catmull-Rom tangent at that end.
      hermitePosition(
        pPrev ? { time: before!.time, pos: pPrev.pos } : null,
        { time: a.time, pos: p.pos, vel: p.velocity },
        { time: b.time, pos: s.pos, vel: s.velocity },
        pNext ? { time: after!.time, pos: pNext.pos } : null,
        t,
        pos,
        // Wire-codec noise floor: segments under ~1.5 quantization steps draw
        // straight instead of feeding codec noise into the tangent guards.
        STATIONARY_CHORD_SQ,
      );
      // The ORIENTATION rides the matching C1 curve through the same four
      // samples — angular velocity continuous through every knot, where the
      // nlerp above steps it. See `hermiteFrame`: with no flanking samples it
      // reduces to that nlerp exactly, so the buffer edges are unchanged.
      hermiteFrame(
        pPrev ? fillFrame(framePrev, before!.time, pPrev) : null,
        fillFrame(frameFrom, a.time, p),
        fillFrame(frameTo, b.time, s),
        pNext ? fillFrame(frameNext, after!.time, pNext) : null,
        t,
        lerpFrame,
      );
      // Bounded dead reckoning on a starved buffer, and the residual it repays
      // afterwards. A no-op whenever the buffer is healthy — `leadMs` is 0 and
      // no residual is outstanding — so the curves above are what get drawn.
      // Position and orientation are carried TOGETHER: a hull that keeps flying
      // with a frozen nose is a worse lie than one that stops altogether.
      if (extrapolate) {
        extrapolate.blender.resolve(s.id, pos, s.velocity, extrapolate.leadMs, extrapolate.dtSeconds, pos);
        // Measured on EVERY frame, not only dry ones: the hand-back frame needs
        // the last known turn rate to re-anchor on `drawn + ω·dt` rather than on
        // `drawn`, and anchoring on `drawn` alone draws exactly zero rotation
        // that frame — the freeze this removes, relocated to the recovery. Same
        // reasoning, and the same one-frame stall, as the positional `v·dt`.
        const omega = angularVelocity(p, s, (b.time - a.time) / 1000, frameOmega);
        facingVec(lerpFrame.heading, lerpFrame.pitch, frameNose);
        extrapolate.blender.resolveFrame(
          s.id,
          frameNose,
          lerpFrame.up,
          omega,
          extrapolate.leadMs,
          extrapolate.dtSeconds,
          frameOut,
        );
        spellAttitude(frameOut.nose.x, frameOut.nose.y, frameOut.nose.z, frameOut.up, lerpFrame);
        lerpFrame.up.x = frameOut.up.x;
        lerpFrame.up.y = frameOut.up.y;
        lerpFrame.up.z = frameOut.up.z;
        orthonormalizeUp(lerpFrame.heading, lerpFrame.pitch, lerpFrame.up);
      }
    }
    return {
      ...s,
      pos,
      heading: lerpFrame.heading,
      pitch: lerpFrame.pitch,
      up: { x: lerpFrame.up.x, y: lerpFrame.up.y, z: lerpFrame.up.z },
      // Only the LOCAL ship's modules are ever written to on a rendered frame
      // (`applyPendingToggles` overlays the optimistic deploy/retract state), so
      // only that one needs defensive copies. Cloning every remote ship's
      // modules as well cost ~4 short-lived objects per remote hull per DRAWN
      // frame — several thousand a second whose only job was to be collected.
      modules: s.id === localPlayerId ? s.modules.map((m) => ({ ...m })) : s.modules,
    };
  });
  if (live) extrapolate!.blender.retain(live);
  const elapsed = a.snapshot.elapsed + (b.snapshot.elapsed - a.snapshot.elapsed) * t;
  return {
    ...b.snapshot,
    elapsed,
    ships,
    projectiles: lerpPositions(a.snapshot.projectiles, b.snapshot.projectiles, t),
    decoys: lerpPositions(a.snapshot.decoys, b.snapshot.decoys, t),
    flags: lerpPositions(a.snapshot.flags, b.snapshot.flags, t),
  };
}

/**
 * Position-lerp one entity list against its counterpart in the older snapshot,
 * matched by id.
 *
 * Ships had this and nothing else did: `projectiles`, `decoys` and `flags` came
 * off the newer snapshot verbatim. Offline that is invisible, because the
 * renderer blends the pair itself with the loop's alpha — but an online session
 * hands the renderer `alpha = 1` (it has already resampled for this frame, see
 * `sampleForRender`), so verbatim meant those three STEPPED at the 20 Hz patch
 * rate while every hull around them moved smoothly. Missiles were the loudest:
 * `EntityView.syncProjectiles` poses a missile along its frame-to-frame
 * displacement, which was zero on ~2 frames in 3 and a whole patch-step on the
 * rest, so the nose snapped between the velocity pose and the flat replicated
 * heading several times a second. A carried CTF flag showed it too, jittering
 * against the smoothly-drawn hull carrying it.
 *
 * Entities with no counterpart in the older snapshot (a missile launched inside
 * this segment) are passed through BY REFERENCE, as is the whole list at `t = 1`:
 * nothing mutates these three on a rendered frame — only ships are written to —
 * so sharing is free, and the alternative is an allocation per shot per frame.
 */
function lerpPositions<T extends { id: number; pos: { x: number; y: number; z: number } }>(
  from: readonly T[],
  to: readonly T[],
  t: number,
): T[] {
  if (t >= 1 || to.length === 0) return to as T[];
  const out: T[] = new Array(to.length);
  for (let i = 0; i < to.length; i++) {
    const s = to[i]!;
    let p: T | undefined;
    for (let j = 0; j < from.length; j++) if (from[j]!.id === s.id) { p = from[j]!; break; }
    out[i] = p
      ? { ...s, pos: { x: p.pos.x + (s.pos.x - p.pos.x) * t, y: p.pos.y + (s.pos.y - p.pos.y) * t, z: p.pos.z + (s.pos.z - p.pos.z) * t } }
      : s;
  }
  return out;
}
