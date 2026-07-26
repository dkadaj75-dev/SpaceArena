/* eslint-disable @typescript-eslint/no-explicit-any -- Colyseus schema state is runtime-generated. */
import {
  decodeCenti,
  decodeHeading,
  decodeModuleState,
  decodeUnit,
  flightStep,
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
  type ShipSnapshot,
  type SimEvent,
  type SimEventMessage,
  type Snapshot,
  type SteerState,
  type TuningConfig,
  type UpgradeLevels,
} from "@space-arena/shared";
import { GameSession } from "../game/GameSession.js";
import { NetClient, type ArenaJoinOptions } from "./NetClient.js";
import { bracket, lerpHeading } from "./interpolation.js";

const log = createLogger("NetGameSession");
const MAX_SNAPSHOTS = 32;
const SNAP_DISTANCE = 3; // world units: larger prediction error snaps instead of blending
const PENDING_TOGGLE_MS = 800; // optimistic module-state overlay lifetime

interface TimedSnapshot { time: number; snapshot: Snapshot }
interface PendingToggle { sentAt: number; fromState: string; optimistic: "deploying" | "retracting" }
/** The three axes of a `flight` order, as the predictor remembers them. */
interface PredictedFlight { throttle: number; turn: number; boost: boolean }

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
  private readonly arena: ArenaConfig;
  private readonly netConfigs: ConfigService;

  // --- local-player prediction ---
  private readonly pred: SteerState = { pos: { x: 0, z: 0 }, vel: { x: 0, z: 0 }, heading: 0 };
  private predActive = false; // becomes true once seeded from a server snapshot
  /**
   * The flight input the SERVER is believed to be integrating — i.e. the last
   * flight order we sent, kept until another replaces it. `flight` orders are
   * level-triggered (FLIGHT.md §1): the sim keeps applying the stored
   * `FlightState` every tick, so the predictor must do the same rather than
   * consuming the order once.
   */
  private predFlight: PredictedFlight | null = null;
  /** Flight state of the last ACCEPTED order — what a rejection rolls back to. */
  private acceptedFlight: PredictedFlight | null = null;
  /** In-flight flight orders by seq, so an ack knows which state it confirmed. */
  private readonly seqFlight = new Map<number, PredictedFlight>();
  private errX = 0; // server − predicted, decayed into pred each frame
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
    const tuning = configs.getAll<TuningConfig>("tuning")[0];
    this.renderDelay = tuning?.netRenderDelayMs ?? 100;
    this.correctionRate = tuning?.netCorrectionRate ?? 12;
    this.fakeLagMs = Number(new URLSearchParams(location.search).get("fakelag")) || 0;
  }

  static async join(
    configs: ConfigService,
    options: ArenaJoinOptions,
    local: LocalPredictionHints = {},
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
        const flight = session.seqFlight.get(ack.seq);
        session.seqFlight.delete(ack.seq);
        if (ack.accepted) {
          session.ordersAcked++;
          if (flight) session.acceptedFlight = flight;
        } else {
          session.ordersRejected++;
          log.warn(`order ${ack.seq} rejected: ${ack.reason ?? "unknown"}`);
          // A rejected FLIGHT order never reached the sim's FlightState, so the
          // server is still integrating the last accepted one — roll the
          // predictor back to it rather than flying an input nobody has.
          if (kind === "flight") session.predFlight = session.acceptedFlight;
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
    const room = await session.net.connect(options);

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
  override get destroyedTargets(): number { return 0; }
  override teamOf(id: EntityId): number | undefined { return this.current.ships.find((ship) => ship.id === id)?.team; }
  override get playerTeam(): number { return this.teamOf(this.playerId) ?? 0; }
  override shipConfigIdFor(id: EntityId): string | undefined { return this.shipIds.get(id); }

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
      const flight: PredictedFlight = { throttle: order.throttle, turn: order.turn, boost: order.boost };
      this.predFlight = flight;
      this.seqFlight.set(seq, flight);
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
    this.seqFlight.clear();
  }

  get correctionError(): number { return Math.hypot(this.errX, this.errZ); }
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
    this.applyPrediction(dt, now);
    this.applyPendingToggles(now);
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
      this.pred.pos.z = player.pos.z;
      this.pred.vel.x = 0;
      this.pred.vel.z = 0;
      this.pred.heading = player.heading;
      this.predActive = true;
    }

    // RESOLVED engine stats, never `cfg.core.engine`: a module or upgrade that
    // changes nominalSpeed/accel/turnRate makes a base-stats predictor wrong on
    // EVERY tick under continuous flight, which no correction blend can hide
    // (FLIGHT.md §5).
    const engine = this.resolvedEngine(cfg, player);

    if (this.predFlight) {
      flightStep(
        this.pred,
        {
          throttle: this.predFlight.throttle,
          turn: this.predFlight.turn,
          boostMult: this.predFlight.boost ? this.predBoostMult(player) : 1,
        },
        engine,
        dt,
      );
    }

    // Blend server error into the prediction; snap when badly wrong.
    this.errX = player.pos.x - this.pred.pos.x;
    this.errZ = player.pos.z - this.pred.pos.z;
    if (Math.hypot(this.errX, this.errZ) > SNAP_DISTANCE) {
      this.pred.pos.x = player.pos.x;
      this.pred.pos.z = player.pos.z;
      this.pred.heading = player.heading;
      this.errX = 0;
      this.errZ = 0;
      // Diverging this far means the server is steering differently (a
      // collision, or an order rejection racing its ack) — defer to server
      // motion. `predFlight` is deliberately NOT cleared: the server is still
      // integrating that state, so dropping it would leave the predictor inert
      // while the real ship keeps flying (the exact opposite of the fix).
    } else {
      const pull = 1 - Math.exp(-this.correctionRate * dt);
      this.pred.pos.x += this.errX * pull;
      this.pred.pos.z += this.errZ * pull;
      // While the local player is flying, heading is a client input — pull it
      // gently so a patch cannot jerk the nose (and the camera with it).
      const steering = this.predFlight !== null;
      this.pred.heading = lerpHeading(this.pred.heading, player.heading, steering ? 0.15 : pull);
    }

    // Render the local player from the predictor.
    player.pos.x = this.pred.pos.x;
    player.pos.z = this.pred.pos.z;
    player.heading = this.pred.heading;
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
      if (this.playerId !== id && this.net.room?.sessionId && findKey(state.players, p) === this.net.room.sessionId)
        (this as { playerId: number }).playerId = id;
      return {
        id,
        team: p.team,
        pos: { x: decodeCenti(p.x), z: decodeCenti(p.z) },
        heading: decodeHeading(p.heading),
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
      pos: p.position,
      radius: p.scale ?? 1,
      state: mapGet(state.asteroids, String(i))?.destroyed ? ("destroyed" as const) : ("intact" as const),
    }));
    const projectiles = mapValues(state.projectiles).map((p: any) => ({
      id: p.entityId,
      kind: "missile" as const,
      pos: { x: decodeCenti(p.x), z: decodeCenti(p.z) },
      heading: decodeHeading(p.heading),
    }));
    return {
      tick: Math.round((state.matchTimer ?? 0) * 30),
      elapsed: state.matchTimer ?? 0,
      phase: state.matchPhase === "ended" ? "ended" : "live",
      winnerTeam: state.winnerTeam === -1 ? null : state.winnerTeam,
      ships,
      asteroids,
      projectiles,
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
    shieldPool: m.shieldPool ?? 0,
  }));
}

function mapValues(value: any): any[] { return value?.values ? [...value.values()] : Object.values(value ?? {}); }
function mapGet(value: any, key: string): any { return value?.get ? value.get(key) : value?.[key]; }
function findKey(map: any, target: any): string | undefined {
  if (map?.entries) for (const [k, v] of map.entries()) if (v === target) return k;
  return undefined;
}
function interpolate(a: Snapshot, b: Snapshot, t: number): Snapshot {
  const ships = b.ships.map((s) => {
    const p = a.ships.find((x) => x.id === s.id) ?? s;
    return {
      ...s,
      pos: { x: p.pos.x + (s.pos.x - p.pos.x) * t, z: p.pos.z + (s.pos.z - p.pos.z) * t },
      heading: lerpHeading(p.heading, s.heading, t),
      modules: s.modules.map((m) => ({ ...m })),
    };
  });
  return { ...b, ships };
}
