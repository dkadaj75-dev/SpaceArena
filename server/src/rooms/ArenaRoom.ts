import { Room, type Client } from "@colyseus/core";
import {
  ArenaSimulation,
  SIM_TICK_RATE,
  createLogger,
  encodeCenti,
  encodeHeading,
  encodeModuleState,
  orderMessageSchema,
  MSG_ORDER,
  MSG_ORDER_ACK,
  MSG_FIRE_EVENT,
  MSG_SIM_EVENT,
  type ArenaConfig,
  type GamemodeConfig,
  type ShipConfig,
  type TuningConfig,
  type EntityId,
  type Order,
  type SimEvent,
  type ShipSnapshot,
  type OrderRejectReason,
  type FireEventMessage,
  type SimEventMessage,
} from "@space-arena/shared";
import { getConfigService } from "../configService.js";
import { ArenaState, PlayerState, ProjectileState, ModuleState, AsteroidState } from "./state/ArenaState.js";

const log = createLogger("ArenaRoom");

/** Fixed sim step in seconds (matches the shared 30 Hz sim; see 0.9). */
const FIXED_DT = 1 / SIM_TICK_RATE;
/** Colyseus patch interval (ms) — 50 ms = 20 Hz, per Phase 2 perf notes. */
const PATCH_RATE_MS = 50;
/** Grace period after match end before the room disconnects everyone. */
const MATCH_END_GRACE_MS = 8000;
/** Reconnection window (seconds) offered on an unconsented leave. */
const RECONNECT_WINDOW_S = 30;
/** Default order rate cap (orders/sec) if tuning omits `maxOrdersPerSec`. */
const DEFAULT_MAX_ORDERS_PER_SEC = 20;
/** Sustained-abuse threshold: kick a client after this many rate-limited orders. */
const ABUSE_KICK_THRESHOLD = 40;

/** Practice-dummy spawn spread (mirrors client GameSession). */
const DUMMY_POSITIONS = [
  { x: 20, z: 20 },
  { x: 30, z: 4 },
  { x: 6, z: 30 },
];

interface CreateOptions {
  gamemode: string;
  arena?: string;
  /** MVP testing: start once this many humans have joined (default = maxClients). */
  minPlayers?: number;
  /** Spawn static team-1 dummy ships so a solo player has something to shoot. */
  practiceTarget?: boolean;
  seed?: number;
}

interface JoinOptions {
  shipId?: string;
  name?: string;
}

interface OrderRate {
  windowStart: number;
  count: number;
  abuse: number;
}

export class ArenaRoom extends Room<ArenaState> {
  private sim!: ArenaSimulation;
  private gamemode!: GamemodeConfig;
  private arena!: ArenaConfig;
  private maxOrdersPerSec = DEFAULT_MAX_ORDERS_PER_SEC;
  private minPlayers = 2;

  /** sessionId/dummy-key → sim entity id, for every ship this room owns. */
  private readonly keyToEntity = new Map<string, EntityId>();
  private readonly entityToKey = new Map<EntityId, string>();
  /** Human client session ids (excludes dummies), for team balancing. */
  private readonly humanSessions = new Set<string>();
  private readonly orderRates = new Map<string, OrderRate>();
  /** Placement index → asteroid sim entity id (stable across the match). */
  private asteroidEntityIds: EntityId[] = [];
  private endTimer: ReturnType<typeof setTimeout> | null = null;

  // Phase 3 adds JWT verification here; for now every join is allowed.
  onAuth(): boolean {
    // TODO(Phase 3): verify JWT, resolve playerId, load owned fitting.
    return true;
  }

  onCreate(options: CreateOptions): void {
    const configs = getConfigService();

    const gamemode = configs.get<GamemodeConfig>("gamemode", options.gamemode);
    if (!gamemode) throw new Error(`unknown gamemode: ${options.gamemode}`);
    this.gamemode = gamemode;

    const arenaId = options.arena ?? gamemode.defaultArena ?? this.pickDefaultArena(configs);
    const arena = configs.get<ArenaConfig>("arena", arenaId);
    if (!arena) throw new Error(`unknown arena: ${arenaId}`);
    this.arena = arena;

    const tuning = configs.getAll<TuningConfig>("tuning")[0];
    this.maxOrdersPerSec = tuning?.maxOrdersPerSec ?? DEFAULT_MAX_ORDERS_PER_SEC;

    this.maxClients = gamemode.teams === "2v2" ? 4 : 2;
    this.minPlayers = Math.max(1, options.minPlayers ?? this.maxClients);

    this.sim = new ArenaSimulation(configs, arenaId, options.gamemode, options.seed ?? 1);

    const state = new ArenaState();
    state.matchPhase = "waiting";
    this.setState(state);

    // Seed asteroid dynamic state (layout itself comes from the arena config).
    this.asteroidEntityIds = this.sim.world.asteroidIds();
    this.asteroidEntityIds.forEach((id, i) => {
      const tag = this.sim.world.asteroids.get(id)!;
      const a = new AsteroidState();
      a.hp = Number.isFinite(tag.hp) ? tag.hp : -1; // -1 == indestructible
      a.destroyed = tag.state === "destroyed";
      state.asteroids.set(String(i), a);
    });

    if (options.practiceTarget) this.spawnPracticeDummies();

    this.setSimulationInterval(() => this.update(), 1000 / SIM_TICK_RATE);
    this.setPatchRate(PATCH_RATE_MS);

    this.onMessage(MSG_ORDER, (client, message) => this.handleOrder(client, message));

    log.info("room created", {
      gamemode: gamemode.id,
      arena: arenaId,
      maxClients: this.maxClients,
      minPlayers: this.minPlayers,
      practiceTarget: !!options.practiceTarget,
    });
  }

  private pickDefaultArena(configs: ReturnType<typeof getConfigService>): string {
    if (configs.get("arena", "arena.ring-nebula")) return "arena.ring-nebula";
    const first = configs.getAll<ArenaConfig>("arena")[0];
    if (!first) throw new Error("no arena configs loaded");
    return first.id;
  }

  onJoin(client: Client, options: JoinOptions): void {
    const configs = getConfigService();
    const shipId =
      options.shipId && configs.get<ShipConfig>("ship", options.shipId)
        ? options.shipId
        : "ship.interceptor";
    const ship = configs.get<ShipConfig>("ship", shipId);
    if (!ship) throw new Error(`no ship config available (wanted ${shipId})`);

    const team = this.assignTeam();
    const entityId = this.sim.spawnPlayer(shipId, ship.defaultFitting, team);

    const ps = new PlayerState();
    ps.entityId = entityId;
    ps.team = team;
    ps.shipId = shipId;
    ps.connected = true;
    for (let i = 0; i < ship.defaultFitting.length; i++) ps.modules.push(new ModuleState());
    this.state.players.set(client.sessionId, ps);

    this.keyToEntity.set(client.sessionId, entityId);
    this.entityToKey.set(entityId, client.sessionId);
    this.humanSessions.add(client.sessionId);
    this.orderRates.set(client.sessionId, { windowStart: Date.now(), count: 0, abuse: 0 });

    this.syncShipState(entityId, ps);

    log.info("client joined", { sessionId: client.sessionId, team, entityId, shipId });
    this.maybeStart();
  }

  private assignTeam(): number {
    // Fewer-count wins (ties → team 0). Gives 1v1 alternation and 2v2 balance.
    let t0 = 0;
    let t1 = 0;
    for (const sid of this.humanSessions) {
      const eid = this.keyToEntity.get(sid);
      if (eid === undefined) continue;
      if (this.sim.teamOf(eid) === 1) t1++;
      else t0++;
    }
    return t1 < t0 ? 1 : 0;
  }

  private spawnPracticeDummies(): void {
    const configs = getConfigService();
    const shipId = "ship.interceptor";
    const ship = configs.get<ShipConfig>("ship", shipId);
    if (!ship) return;
    const wc = this.gamemode.winCondition;
    const count = wc.type === "destroyTargets" ? wc.count : 1;
    for (let i = 0; i < count; i++) {
      const pos = DUMMY_POSITIONS[i % DUMMY_POSITIONS.length]!;
      const entityId = this.sim.spawnPlayerAt(shipId, ship.defaultFitting, 1, pos, Math.PI);
      const key = `dummy-${entityId}`;
      const ps = new PlayerState();
      ps.entityId = entityId;
      ps.team = 1;
      ps.shipId = shipId;
      ps.connected = false;
      for (let m = 0; m < ship.defaultFitting.length; m++) ps.modules.push(new ModuleState());
      this.state.players.set(key, ps);
      this.keyToEntity.set(key, entityId);
      this.entityToKey.set(entityId, key);
      this.syncShipState(entityId, ps);
    }
  }

  private maybeStart(): void {
    if (this.state.matchPhase !== "waiting") return;
    if (this.humanSessions.size >= this.minPlayers) {
      this.state.matchPhase = "live";
      log.info("match live", { players: this.humanSessions.size });
    }
  }

  private handleOrder(client: Client, raw: unknown): void {
    const parsed = orderMessageSchema.safeParse(raw);
    if (!parsed.success) {
      this.ack(client, typeof (raw as { seq?: number })?.seq === "number" ? (raw as { seq: number }).seq : -1, false, "malformed");
      return;
    }
    const { seq, order } = parsed.data;

    if (this.rateLimited(client)) {
      this.ack(client, seq, false, "rate-limited");
      return;
    }

    if (this.state.matchPhase !== "live") {
      this.ack(client, seq, false, "not-live");
      return;
    }

    const entityId = this.keyToEntity.get(client.sessionId);
    if (entityId === undefined || !this.sim.hasShip(entityId)) {
      this.ack(client, seq, false, "no-entity");
      return;
    }

    const reason = this.validateOrder(entityId, order);
    if (reason) {
      this.ack(client, seq, false, reason);
      return;
    }

    this.sim.applyOrder(entityId, order);
    const ps = this.state.players.get(client.sessionId);
    if (ps) ps.lastProcessedSeq = seq;
    this.ack(client, seq, true);
  }

  private validateOrder(entityId: EntityId, order: Order): OrderRejectReason | null {
    switch (order.kind) {
      case "move":
        return this.inBounds(order.target.x, order.target.z) ? null : "out-of-bounds";
      case "moduleToggle": {
        const mods = this.sim.world.modules.get(entityId);
        if (!mods || order.hardpointIndex >= mods.modules.length) return "bad-hardpoint";
        return null;
      }
      case "target": {
        if (order.targetId === null) return null;
        if (!this.sim.hasShip(order.targetId)) return "bad-target";
        if (this.sim.teamOf(order.targetId) === this.sim.teamOf(entityId)) return "bad-target";
        return null;
      }
    }
  }

  private inBounds(x: number, z: number): boolean {
    const b = this.arena.bounds;
    if (b.shape === "circle") return x * x + z * z <= b.radius * b.radius;
    return Math.abs(x) <= b.width / 2 && Math.abs(z) <= b.height / 2;
  }

  private rateLimited(client: Client): boolean {
    const now = Date.now();
    const rate = this.orderRates.get(client.sessionId) ?? { windowStart: now, count: 0, abuse: 0 };
    if (now - rate.windowStart >= 1000) {
      rate.windowStart = now;
      rate.count = 0;
    }
    rate.count++;
    this.orderRates.set(client.sessionId, rate);
    if (rate.count > this.maxOrdersPerSec) {
      rate.abuse++;
      if (rate.abuse >= ABUSE_KICK_THRESHOLD) {
        log.warn("kicking client for sustained order spam", { sessionId: client.sessionId });
        client.leave(4290); // custom close code: rate-limit kick
      }
      return true;
    }
    return false;
  }

  private ack(client: Client, seq: number, accepted: boolean, reason?: OrderRejectReason): void {
    client.send(MSG_ORDER_ACK, reason ? { seq, accepted, reason } : { seq, accepted });
  }

  private update(): void {
    if (this.state.matchPhase !== "live") return;

    this.sim.tick(FIXED_DT);
    const events = this.sim.getEvents();
    this.relayEvents(events);

    this.writeState();
    this.state.matchTimer = this.sim.snapshot().elapsed;

    if (this.sim.isEnded && this.state.matchPhase === "live") this.endMatch();
  }

  private relayEvents(events: SimEvent[]): void {
    for (const ev of events) {
      if (ev.type === "projectileFired") {
        if (ev.kind === "beam" || ev.kind === "kinetic") {
          const msg: FireEventMessage = {
            type: ev.kind,
            moduleId: ev.moduleId,
            shooterEntityId: ev.ownerId,
            targetEntityId: ev.targetId,
          };
          this.broadcast(MSG_FIRE_EVENT, msg);
        }
        // missiles are schema entities — no fire event needed.
        continue;
      }
      const passthrough = toSimEventMessage(ev);
      if (passthrough) this.broadcast(MSG_SIM_EVENT, passthrough);
    }
  }

  private writeState(): void {
    const snap = this.sim.snapshot();

    // Ships (players + dummies).
    for (const ship of snap.ships) {
      const key = this.entityToKey.get(ship.id);
      if (!key) continue;
      const ps = this.state.players.get(key);
      if (!ps) continue;
      this.applyShipSnapshot(ps, ship);
    }

    // Missiles only (beams/kinetics are events).
    const liveMissiles = new Set<string>();
    for (const p of snap.projectiles) {
      if (p.kind !== "missile") continue;
      const pk = String(p.id);
      liveMissiles.add(pk);
      let proj = this.state.projectiles.get(pk);
      if (!proj) {
        proj = new ProjectileState();
        proj.entityId = p.id;
        this.state.projectiles.set(pk, proj);
      }
      const qx = encodeCenti(p.pos.x);
      const qz = encodeCenti(p.pos.z);
      const qh = encodeHeading(p.heading);
      if (proj.x !== qx) proj.x = qx;
      if (proj.z !== qz) proj.z = qz;
      if (proj.heading !== qh) proj.heading = qh;
    }
    for (const pk of [...this.state.projectiles.keys()]) {
      if (!liveMissiles.has(pk)) this.state.projectiles.delete(pk);
    }

    // Asteroids: hp/destroyed only.
    this.asteroidEntityIds.forEach((id, i) => {
      const tag = this.sim.world.asteroids.get(id);
      if (!tag) return;
      const a = this.state.asteroids.get(String(i));
      if (!a) return;
      const hp = Number.isFinite(tag.hp) ? tag.hp : -1;
      const destroyed = tag.state === "destroyed";
      if (a.hp !== hp) a.hp = hp;
      if (a.destroyed !== destroyed) a.destroyed = destroyed;
    });
  }

  /** Full ship write (used at join before the first tick). */
  private syncShipState(entityId: EntityId, ps: PlayerState): void {
    const snap = this.sim.snapshot();
    const ship = snap.ships.find((s) => s.id === entityId);
    if (ship) this.applyShipSnapshot(ps, ship);
  }

  private applyShipSnapshot(ps: PlayerState, ship: ShipSnapshot): void {
    const qx = encodeCenti(ship.pos.x);
    const qz = encodeCenti(ship.pos.z);
    const qh = encodeHeading(ship.heading);
    if (ps.x !== qx) ps.x = qx;
    if (ps.z !== qz) ps.z = qz;
    if (ps.heading !== qh) ps.heading = qh;
    if (ps.hull !== ship.hull) ps.hull = ship.hull;
    if (ps.energyCur !== ship.energy.cur) ps.energyCur = ship.energy.cur;
    if (ps.heatCur !== ship.heat.cur) ps.heatCur = ship.heat.cur;

    let shieldPool = 0;
    for (let i = 0; i < ship.modules.length; i++) {
      const m = ship.modules[i]!;
      shieldPool += m.shieldPool;
      const target = ps.modules[i];
      if (!target) {
        const ms = new ModuleState();
        ms.state = encodeModuleState(m.state);
        ms.stateTimer = m.stateTimer;
        ms.heat = m.heat;
        ps.modules.push(ms);
        continue;
      }
      const code = encodeModuleState(m.state);
      if (target.state !== code) target.state = code;
      if (target.stateTimer !== m.stateTimer) target.stateTimer = m.stateTimer;
      if (target.heat !== m.heat) target.heat = m.heat;
    }
    if (ps.shieldPool !== shieldPool) ps.shieldPool = shieldPool;
  }

  private endMatch(): void {
    const snap = this.sim.snapshot();
    this.state.matchPhase = "ended";
    this.state.winnerTeam = snap.winnerTeam ?? -1;
    this.lock();
    log.info("match ended", { winnerTeam: this.state.winnerTeam });
    this.endTimer = setTimeout(() => this.disconnect(), MATCH_END_GRACE_MS);
  }

  async onLeave(client: Client, consented: boolean): Promise<void> {
    const ps = this.state.players.get(client.sessionId);
    if (ps) ps.connected = false;

    if (!consented) {
      try {
        await this.allowReconnection(client, RECONNECT_WINDOW_S);
        const rejoined = this.state.players.get(client.sessionId);
        if (rejoined) rejoined.connected = true;
        log.info("client reconnected", { sessionId: client.sessionId });
        return;
      } catch {
        // fall through to final removal
      }
    }

    this.removePlayer(client.sessionId);
  }

  private removePlayer(sessionId: string): void {
    const entityId = this.keyToEntity.get(sessionId);
    if (entityId !== undefined) {
      this.sim.removeShip(entityId);
      this.entityToKey.delete(entityId);
    }
    this.keyToEntity.delete(sessionId);
    this.humanSessions.delete(sessionId);
    this.orderRates.delete(sessionId);
    this.state.players.delete(sessionId);
    log.info("client removed", { sessionId, entityId });
  }

  onDispose(): void {
    if (this.endTimer) clearTimeout(this.endTimer);
    log.info("room disposed", { gamemode: this.gamemode?.id });
  }
}

function toSimEventMessage(ev: SimEvent): SimEventMessage | null {
  switch (ev.type) {
    case "damage":
      return {
        type: "damage",
        targetId: ev.targetId,
        sourceId: ev.sourceId,
        amount: ev.amount,
        damageType: ev.damageType,
        isAsteroid: ev.isAsteroid,
      };
    case "shieldAbsorb":
      return { type: "shieldAbsorb", targetId: ev.targetId, hardpointIndex: ev.hardpointIndex, amount: ev.amount };
    case "entityDestroyed":
      return { type: "entityDestroyed", entityId: ev.entityId, killerId: ev.killerId, isAsteroid: ev.isAsteroid, team: ev.team };
    case "boundaryHit":
      return { type: "boundaryHit", entityId: ev.entityId, rule: ev.rule };
    case "matchEnded":
      return { type: "matchEnded", winnerTeam: ev.winnerTeam, reason: ev.reason };
    default:
      return null;
  }
}
