/* eslint-disable @typescript-eslint/no-explicit-any -- Colyseus schema state is runtime-generated. */
import {
  decodeCenti,
  decodeHeading,
  decodeModuleState,
  seekStep,
  MSG_ORDER,
  createLogger,
  type ArenaConfig,
  type ConfigService,
  type EntityId,
  type GamemodeConfig,
  type Order,
  type ShipConfig,
  type SimEvent,
  type Snapshot,
  type SteerState,
  type TuningConfig,
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

/**
 * Online implementation of the GameSession surface (ROADMAP §7 2.4–2.6).
 *
 * Remote entities: snapshot-buffer interpolation `netRenderDelayMs` behind the
 * newest patch. Local player: optimistic prediction — move orders integrate
 * immediately via the shared `seekStep` math and the predicted position is
 * pulled toward server truth with an exponential blend (snap above
 * SNAP_DISTANCE). Module toggles overlay an optimistic deploying/retracting
 * state until the server confirms or PENDING_TOGGLE_MS expires.
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
  private predTarget: { x: number; z: number } | null = null;
  private predBoost = false;
  private errX = 0; // server − predicted, decayed into pred each frame
  private errZ = 0;

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

  /** Artificial inbound latency (?fakelag=ms) for netcode testing. */
  private readonly fakeLagMs: number;
  private readonly lagQueue: { at: number; fn: () => void }[] = [];

  private constructor(configs: ConfigService, arenaId: string, gamemodeId: string) {
    super(configs, arenaId, gamemodeId);
    this.previous = super.curSnapshot;
    this.current = this.previous;
    this.arena = configs.get<ArenaConfig>("arena", arenaId)!;
    this.netConfigs = configs;
    const tuning = configs.getAll<TuningConfig>("tuning")[0];
    this.renderDelay = tuning?.netRenderDelayMs ?? 100;
    this.correctionRate = tuning?.netCorrectionRate ?? 12;
    this.fakeLagMs = Number(new URLSearchParams(location.search).get("fakelag")) || 0;
  }

  static async join(configs: ConfigService, options: ArenaJoinOptions): Promise<NetGameSession> {
    const arenaId =
      options.arena ?? configs.get<GamemodeConfig>("gamemode", options.gamemode)?.defaultArena ?? "arena.ring-nebula";
    const session = new NetGameSession(configs, arenaId, options.gamemode);
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
        if (ack.accepted) session.ordersAcked++;
        else {
          session.ordersRejected++;
          log.warn(`order ${ack.seq} rejected: ${ack.reason ?? "unknown"}`);
          // A rejected move must stop the local predictor, or it seeks a target
          // the server refused and out-runs the correction blend indefinitely.
          if (kind === "move") session.predTarget = null;
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
    session.net.onSimEvent = (event) => session.deferred(() => session.events.push(event as SimEvent));
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

    if (order.kind === "move") {
      // Optimistic: begin seeking immediately; server correction absorbs drift.
      this.predTarget = { x: order.target.x, z: order.target.z };
      this.predBoost = order.boost;
      this.events.push({ type: "moveOrderSet", entityId: this.playerId, target: { ...order.target }, boost: order.boost });
    } else if (order.kind === "target") {
      this.events.push({ type: "targetSet", entityId: this.playerId, targetId: order.targetId });
    } else if (order.kind === "moduleToggle") {
      const mod = this.current.ships.find((s) => s.id === this.playerId)?.modules[order.hardpointIndex];
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

    if (this.predTarget) {
      const tuning = this.netConfigs.getAll<TuningConfig>("tuning")[0];
      const arrived = seekStep(
        this.pred,
        this.predTarget,
        {
          nominalSpeed: cfg.core.engine.nominalSpeed,
          accel: cfg.core.engine.accel,
          turnRate: cfg.core.engine.turnRate,
          arrivalRadius: tuning?.arrivalRadius ?? 10,
          arrivalStop: 1.5,
          speedMult: this.predBoost ? boostMult(this.netConfigs, cfg) : 1,
        },
        dt,
      );
      if (arrived) this.predTarget = null;
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
      // Diverging this far means the server is steering differently (avoidance
      // detour, rejected order raced the ack) — defer to server motion.
      this.predTarget = null;
    } else {
      const pull = 1 - Math.exp(-this.correctionRate * dt);
      this.pred.pos.x += this.errX * pull;
      this.pred.pos.z += this.errZ * pull;
      this.pred.heading = lerpHeading(this.pred.heading, player.heading, this.predTarget ? 0.15 : pull);
    }

    // Render the local player from the predictor.
    player.pos.x = this.pred.pos.x;
    player.pos.z = this.pred.pos.z;
    player.heading = this.pred.heading;
  }

  /** Optimistic module button feedback until the server echoes the change. */
  private applyPendingToggles(now: number): void {
    if (this.pendingToggles.size === 0) return;
    const player = this.current.ships.find((s) => s.id === this.playerId);
    if (!player) return;
    for (const [idx, pending] of this.pendingToggles) {
      const mod = player.modules[idx];
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
      const cfg = this.netConfigs.get<ShipConfig>("ship", shipId);
      return {
        id,
        team: p.team,
        pos: { x: decodeCenti(p.x), z: decodeCenti(p.z) },
        heading: decodeHeading(p.heading),
        hull: p.hull,
        hullMax: cfg?.core.hull.base ?? p.hull,
        energy: { cur: p.energyCur, max: cfg?.core.energy.capacitor ?? p.energyCur },
        heat: { cur: p.heatCur, capacity: cfg?.core.heat.capacity ?? p.heatCur },
        targetId: null,
        modules: mapValues(p.modules).map((m: any, i: number) => ({
          moduleId: cfg?.defaultFitting[i] ?? "",
          state: decodeModuleState(m.state),
          heat: m.heat,
          stateTimer: m.stateTimer,
          cycleTimer: 0,
          shieldPool: m.shieldPool ?? 0,
        })),
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

function boostMult(configs: ConfigService, ship: ShipConfig): number {
  for (const modId of ship.defaultFitting) {
    const mod = configs.get<import("@space-arena/shared").ModuleConfig>("module", modId);
    if (mod?.boost) return mod.boost.speedMult;
  }
  return 1;
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
