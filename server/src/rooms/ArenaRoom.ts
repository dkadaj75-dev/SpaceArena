import { Room, type Client } from "@colyseus/core";
import {
  ArenaSimulation,
  BotDriver,
  deriveRng,
  resolveBackfillBot,
  teamSizeOf,
  SIM_TICK_RATE,
  createLogger,
  encodeCenti,
  encodeHeading,
  encodeModuleState,
  encodePitch,
  encodeUnit,
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
import type { HardpointMap, ModuleConfig, UpgradeLevels } from "@space-arena/shared";
import { getConfigService } from "../configService.js";
import { verifyAccessToken } from "../auth/tokens.js";
import { fittingsRepo, ownedModulesRepo, profilesRepo, shipUpgradesRepo } from "../db/repos.js";
import { hardpointMapToFitting, validateFitting } from "../api/fittingValidation.js";
import { finalizeMatch, type Participant } from "../progression/service.js";
import { getMetrics, instrumentClientEgress } from "../telemetry/metrics.js";
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
/** Fallback wait before bot backfill when the gamemode omits `bots.backfillWaitMs`. */
const DEFAULT_BOT_BACKFILL_MS = 15000;
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
  /** `botprofile` id used for empty-slot backfill (overrides `gamemode.bots.defaultProfile`). */
  botProfile?: string;
  /** Override the gamemode's `bots.backfillWaitMs`. 0 backfills as soon as someone joins. */
  botBackfillMs?: number;
  seed?: number;
  /** Created by the authenticated queue and immediately locked for its reservations. */
  matchmaking?: boolean;
}

interface JoinOptions {
  shipId?: string;
  name?: string;
  /** Access-token JWT; verified in onAuth to resolve the user id. */
  token?: string;
  /** Saved fitting to spawn with (must belong to the authed user). */
  fittingId?: string;
}

/** Result of {@link ArenaRoom.onAuth}, stored on `client.auth`. */
interface AuthData {
  userId: string | null;
}

interface OrderRate {
  windowStart: number;
  count: number;
  abuse: number;
}

export class ArenaRoom extends Room<ArenaState> {
  /**
   * The content pack this room runs on, **pinned at creation** (§11 6.7).
   *
   * An admin content import swaps the process-wide ConfigService for a new
   * instance mid-flight. Reading the singleton on every lookup would let one
   * match resolve its arena from the old pack and a late joiner's ship from the
   * new one — silently mixed rules. Capturing the instance once makes the
   * guarantee simple and honest instead: **a match plays out entirely on the
   * pack that was live when its room was created; the next room created uses the
   * new pack.** No live migration, and none pretended.
   */
  private configs!: ReturnType<typeof getConfigService>;
  private sim!: ArenaSimulation;
  private gamemode!: GamemodeConfig;
  private arena!: ArenaConfig;
  private maxOrdersPerSec = DEFAULT_MAX_ORDERS_PER_SEC;
  private minPlayers = 2;
  /**
   * The match seed, kept because the sim is not its only consumer: every bot
   * driver derives its own RNG stream from it (see {@link backfillBots}), so a
   * room re-created with the same seed replays the same bot behaviour.
   */
  private seed = 1;
  /**
   * Whether this match grants progression. Client-supplied `practiceTarget` or
   * `minPlayers` overrides (which enable trivially-winnable solo rooms) mark the
   * match ineligible — results are still recorded, but no credits/XP are granted.
   */
  private rewardsEligible = true;

  /** sessionId/dummy-key → sim entity id, for every ship this room owns. */
  private readonly keyToEntity = new Map<string, EntityId>();
  private readonly entityToKey = new Map<EntityId, string>();
  /** Human client session ids (excludes dummies), for team balancing. */
  private readonly humanSessions = new Set<string>();
  private readonly orderRates = new Map<string, OrderRate>();
  /** Placement index → asteroid sim entity id (stable across the match). */
  private asteroidEntityIds: EntityId[] = [];
  private endTimer: ReturnType<typeof setTimeout> | null = null;

  // --- bots (5.1) ---
  /** Bot entity id → its driver. Drivers emit orders through the human pipeline. */
  private readonly botDrivers = new Map<EntityId, BotDriver>();
  private botBackfillTimer: ReturnType<typeof setTimeout> | null = null;
  private botBackfillMs = DEFAULT_BOT_BACKFILL_MS;
  private botProfileOverride: string | undefined;
  /** Created by the matchmaking queue: both seats reserved for real players. */
  private matchmade = false;
  /** Sim-clock milliseconds fed to the bot drivers (their decision cadence). */
  private botClockMs = 0;

  /** sessionId → authenticated userId (null for anon/dummy). */
  private readonly sessionUserId = new Map<string, string | null>();
  /** Ship entity id → frags scored this match (for perKill rewards). */
  private readonly fragsByEntity = new Map<EntityId, number>();

  // --- telemetry (6.6/6.8) --------------------------------------------------
  /**
   * True only while {@link broadcastPatch} is on the stack, so the egress byte
   * counter can tell a state patch from an ordinary message. Read by
   * `instrumentClientEgress`; see telemetry/metrics.ts for why this is the only
   * seam Colyseus 0.16 offers.
   */
  private patchPhase = false;
  /** Humans who joined at any point this match (leavers included). */
  private humansJoined = 0;
  /** Bots spawned by backfill this match. */
  private botsSpawned = 0;

  get inPatchPhase(): boolean {
    return this.patchPhase;
  }

  /**
   * Verify the access-token JWT from `options.token` → resolve the userId.
   * Fails CLOSED: an anonymous (tokenless/invalid-token) join is allowed only
   * when DEV_ALLOW_ANON==='1' AND we are not in production; otherwise rejected.
   */
  onAuth(_client: Client, options: JoinOptions): AuthData {
    const userId = options.token ? verifyAccessToken(options.token) : null;
    if (userId) return { userId };
    if (process.env.DEV_ALLOW_ANON === "1" && process.env.NODE_ENV !== "production") {
      log.warn("anonymous join allowed (DEV_ALLOW_ANON=1, non-production)");
      return { userId: null };
    }
    throw new Error("unauthorized: missing or invalid token");
  }

  onCreate(options: CreateOptions): void {
    // Pin the pack for this room's whole life — see the `configs` field doc.
    const configs = getConfigService();
    this.configs = configs;

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
    // Anti-farming: overrides that enable trivial solo wins forfeit rewards.
    this.rewardsEligible = options.practiceTarget !== true && options.minPlayers === undefined;

    this.seed = options.seed ?? 1;
    this.sim = new ArenaSimulation(configs, arenaId, options.gamemode, this.seed);

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

    this.botProfileOverride = options.botProfile;
    this.botBackfillMs = options.botBackfillMs ?? gamemode.bots?.backfillWaitMs ?? DEFAULT_BOT_BACKFILL_MS;
    this.matchmade = options.matchmaking === true;

    if (options.practiceTarget) this.spawnPracticeDummies();

    this.setSimulationInterval(() => this.update(), 1000 / SIM_TICK_RATE);
    this.setPatchRate(PATCH_RATE_MS);

    this.onMessage(MSG_ORDER, (client, message) => this.handleOrder(client, message));

    getMetrics().registerRoom(this.roomId, gamemode.id);

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
    const configs = this.configs;
    const userId = (client.auth as AuthData | undefined)?.userId ?? null;

    // Reward-farming guard (3b): one authenticated user may hold only one slot.
    if (userId !== null && [...this.sessionUserId.values()].includes(userId)) {
      throw new Error("already-in-room");
    }

    const { shipId, fitting } = this.resolveFitting(configs, userId, options);
    const ship = configs.get<ShipConfig>("ship", shipId);
    if (!ship) throw new Error(`no ship config available (wanted ${shipId})`);

    const team = this.assignTeam();
    // Apply the player's persisted upgrade purchases to their spawned stats.
    const upgradeLevels = this.loadUpgradeLevels(userId, shipId);
    const entityId = this.sim.spawnPlayer(shipId, fitting, team, upgradeLevels);

    const ps = new PlayerState();
    ps.entityId = entityId;
    ps.team = team;
    ps.shipId = shipId;
    ps.displayName = this.resolveDisplayName(userId, options);
    ps.connected = true;
    // One ModuleState per fitted (non-empty) module; empty hardpoints get none.
    const fittedCount = fitting.filter((m) => m !== null).length;
    for (let i = 0; i < fittedCount; i++) ps.modules.push(new ModuleState());
    this.state.players.set(client.sessionId, ps);

    this.keyToEntity.set(client.sessionId, entityId);
    this.entityToKey.set(entityId, client.sessionId);
    this.humanSessions.add(client.sessionId);
    this.sessionUserId.set(client.sessionId, userId);
    this.fragsByEntity.set(entityId, 0);
    this.orderRates.set(client.sessionId, { windowStart: Date.now(), count: 0, abuse: 0 });
    this.humansJoined++;

    // Count this client's outbound bytes (6.6 patch-bytes/s). The wrapper lives
    // on the client object, so it is collected with the client — nothing to undo.
    instrumentClientEgress(client, this.roomId, this);
    getMetrics().setClientCount(this.roomId, this.clients.length);

    this.syncShipState(entityId, ps);

    log.info("client joined", { sessionId: client.sessionId, team, entityId, shipId, userId });
    this.maybeStart();
  }

  /**
   * Pick the ship + ordered module list to spawn, then **validate it** against
   * the joining player's ownership/level and the ship's current sockets (same
   * logic as the REST fitting API). An authed user passing a `fittingId` they own
   * loads that fitting; otherwise fall back to the requested (or default) ship's
   * `defaultFitting`. Either way, an invalid resolved fitting **rejects the join**
   * (Finding 1) rather than spawning an illegal loadout.
   */
  private resolveFitting(
    configs: ReturnType<typeof getConfigService>,
    userId: string | null,
    options: JoinOptions,
  ): { shipId: string; fitting: (string | null)[] } {
    // Candidate ship + hardpoint map.
    let shipId: string | null = null;
    let hardpointMap: HardpointMap | null = null;

    if (userId && options.fittingId) {
      const fit = fittingsRepo.byId(options.fittingId);
      if (fit && fit.user_id === userId && configs.get<ShipConfig>("ship", fit.ship_id)) {
        shipId = fit.ship_id;
        hardpointMap = fit.hardpointMap;
      } else {
        log.warn("fitting not found / not owned / unknown ship; using default", { fittingId: options.fittingId, userId });
      }
    }

    if (!shipId || !hardpointMap) {
      shipId = options.shipId && configs.get<ShipConfig>("ship", options.shipId) ? options.shipId : "ship.interceptor";
      const ship = configs.get<ShipConfig>("ship", shipId);
      if (!ship) throw new Error(`no ship config available (wanted ${shipId})`);
      hardpointMap = defaultFittingToHardpointMap(ship.defaultFitting);
    }

    const { owned, level } = this.ownershipContext(configs, userId);
    const result = validateFitting(configs, shipId, hardpointMap, owned, level);
    if (!result.ok) {
      throw new Error(`invalid-fitting: ${result.code}: ${result.message}`);
    }
    const ship = configs.get<ShipConfig>("ship", shipId)!;
    return { shipId, fitting: hardpointMapToFitting(ship, hardpointMap) };
  }

  /**
   * The module-ownership set + profile level used to validate a join fitting.
   * Authenticated users get their real owned modules + level. Anonymous
   * (DEV_ALLOW_ANON) players implicitly hold the free starter kit (every
   * `price: 0` module) at level 1 — enough to validate any ship's default fit.
   */
  private ownershipContext(
    configs: ReturnType<typeof getConfigService>,
    userId: string | null,
  ): { owned: Set<string>; level: number } {
    if (userId) {
      const owned = new Set(ownedModulesRepo.byUser(userId).map((r) => r.module_id));
      const level = profilesRepo.byUser(userId)?.level ?? 1;
      return { owned, level };
    }
    const owned = new Set(configs.getAll<ModuleConfig>("module").filter((m) => m.price === 0).map((m) => m.id));
    return { owned, level: 1 };
  }

  /**
   * Load a user's persisted per-track upgrade purchase counts for `shipId`.
   * Anonymous joins (no userId) or ships never upgraded resolve to all-zero
   * (base stats). Counts feed the shared stat resolver at spawn.
   */
  private loadUpgradeLevels(userId: string | null, shipId: string): UpgradeLevels {
    if (!userId) return { hull: 0, engine: 0, energy: 0, heat: 0 };
    const row = shipUpgradesRepo.get(userId, shipId);
    if (!row) return { hull: 0, engine: 0, energy: 0, heat: 0 };
    return { hull: row.hull_lvl, engine: row.engine_lvl, energy: row.energy_lvl, heat: row.heat_lvl };
  }

  private resolveDisplayName(userId: string | null, options: JoinOptions): string {
    if (userId) {
      const profile = profilesRepo.byUser(userId);
      if (profile) return profile.display_name;
    }
    return options.name ?? "Anon";
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
    const configs = this.configs;
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
      this.clearBotBackfillTimer();
      this.state.matchPhase = "live";
      log.info("match live", { players: this.humanSessions.size });
      return;
    }
    this.scheduleBotBackfill();
  }

  // -------------------------------------------------------------------------
  // Bot backfill (ROADMAP §7 2.8 wait logic → §10A 5.1 real bots)
  // -------------------------------------------------------------------------

  /**
   * Arm the backfill timer once the first human is in and the room is still
   * short of players. When it fires, every empty team slot is filled with a
   * {@link BotDriver}-driven ship and the match starts. Off entirely for a
   * gamemode that declares no `bots` block and no `botProfile` room option.
   */
  private scheduleBotBackfill(): void {
    if (this.botBackfillTimer !== null) return;
    // A matchmade room's second seat belongs to a real reserved player — a bot
    // must never take it (a slow-connecting opponent would arrive mid-fight
    // against a bot in their own chair). No-shows end via the reservation
    // expiry + min-player flow instead.
    if (this.matchmade) return;
    if (this.humanSessions.size === 0) return;
    if (!resolveBackfillBot(this.gamemode, this.configs, this.botProfileOverride)) return;
    this.botBackfillTimer = setTimeout(() => {
      this.botBackfillTimer = null;
      this.backfillBots();
    }, this.botBackfillMs);
    log.info("bot backfill armed", { waitMs: this.botBackfillMs });
  }

  private clearBotBackfillTimer(): void {
    if (this.botBackfillTimer === null) return;
    clearTimeout(this.botBackfillTimer);
    this.botBackfillTimer = null;
  }

  /**
   * Fill every team up to the gamemode's team size with bots, then start the
   * match. Bots get a schema `PlayerState` exactly like a dummy does, so remote
   * clients render them with no client-side changes.
   */
  private backfillBots(): void {
    if (this.state.matchPhase !== "waiting") return;
    const configs = this.configs;
    const backfill = resolveBackfillBot(this.gamemode, configs, this.botProfileOverride);
    if (!backfill) return;
    const ship = configs.get<ShipConfig>("ship", backfill.shipId);
    if (!ship) return;

    const teamSize = teamSizeOf(this.gamemode);
    const perTeam = new Map<number, number>();
    for (const eid of this.keyToEntity.values()) {
      const team = this.sim.teamOf(eid);
      if (team === undefined) continue;
      perTeam.set(team, (perTeam.get(team) ?? 0) + 1);
    }

    let spawned = 0;
    for (let team = 0; team < 2; team++) {
      for (let i = perTeam.get(team) ?? 0; i < teamSize; i++) {
        const entityId = this.sim.spawnPlayer(backfill.shipId, ship.defaultFitting, team);
        const key = `bot-${entityId}`;
        const ps = new PlayerState();
        ps.entityId = entityId;
        ps.team = team;
        ps.shipId = backfill.shipId;
        ps.displayName = backfill.profile.name ?? backfill.profile.id;
        ps.connected = false;
        for (let m = 0; m < ship.defaultFitting.filter((x) => x !== null).length; m++) ps.modules.push(new ModuleState());
        this.state.players.set(key, ps);
        this.keyToEntity.set(key, entityId);
        this.entityToKey.set(entityId, key);
        this.fragsByEntity.set(entityId, 0);
        // Seeded per bot: `Math.random` here would make two rooms created with
        // the same seed diverge on the very first decision (orbit sign, jitter,
        // boost rolls), which is exactly what a repro or a replay needs not to
        // happen. Entity id salts the stream so co-spawned bots differ.
        this.botDrivers.set(
          entityId,
          new BotDriver({ entityId, profile: backfill.profile, configs, rng: deriveRng(this.seed, entityId) }),
        );
        this.syncShipState(entityId, ps);
        spawned++;
      }
    }

    this.botsSpawned += spawned;
    log.info("bot backfill complete", { spawned, profile: backfill.profile.id });
    this.state.matchPhase = "live";
  }

  /**
   * Drive every live bot: feed it the read-only snapshot and push its orders
   * through the **same validation + rate budget + apply path** a human order
   * takes, so bots can never issue an order a player could not.
   *
   * The budget matters even though every shipped profile is far below it: the
   * botprofile schema accepts a `decisionIntervalMs` as low as one sim tick, and
   * a single decision can emit a flight order plus one toggle per hardpoint, so
   * a content edit alone could put a bot above the human cap. Bots have no
   * `Client` and cannot be kicked, so an over-budget bot order is just dropped —
   * the ship keeps flying its last (level-triggered) flight state.
   */
  private driveBots(): void {
    this.botClockMs += FIXED_DT * 1000;
    const snapshot = this.sim.snapshot();
    for (const [entityId, driver] of this.botDrivers) {
      if (!this.sim.hasShip(entityId)) {
        this.botDrivers.delete(entityId);
        this.orderRates.delete(botRateKey(entityId));
        continue;
      }
      for (const order of driver.update(snapshot, this.botClockMs)) {
        if (this.validateOrder(entityId, order)) continue; // same rules as humans
        if (this.overBudget(botRateKey(entityId))) continue; // same cap as humans
        this.sim.applyOrder(entityId, order);
      }
    }
  }

  private handleOrder(client: Client, raw: unknown): void {
    // Rate-limit BEFORE parsing. A malformed message costs the server a Zod
    // parse and an ack exactly like a valid one, so counting only the orders
    // that parse hands an authenticated client a free, unbounded channel: spam
    // an unknown discriminant and every message is served, none counted, and
    // the abuse counter never reaches the kick threshold. Every inbound order
    // message counts against the same budget, whatever its shape.
    const seq = typeof (raw as { seq?: number })?.seq === "number" ? (raw as { seq: number }).seq : -1;
    if (this.rateLimited(client)) {
      this.ack(client, seq, false, "rate-limited");
      return;
    }

    const parsed = orderMessageSchema.safeParse(raw);
    if (!parsed.success) {
      this.ack(client, seq, false, "malformed");
      return;
    }
    const { order } = parsed.data;

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
      case "flight":
        // Range guard only, and deliberately redundant with `orderSchema`: bots
        // reach this path without ever crossing the wire (FLIGHT.md §7 — same
        // validation for bot and human), so the axis bounds are enforced here too.
        // `pitchStick` is optional on the wire too (BUBBLE.md §B): pitch is held
        // state, so an absent axis means "no pitch change", the same thing a
        // centred stick means. When a caller does supply it (bots today, the HUD
        // from T3) it is held to exactly the same bounds as `turn` — identical
        // semantics either side of the trust boundary.
        return Number.isFinite(order.throttle) &&
          Number.isFinite(order.turn) &&
          order.throttle >= 0 &&
          order.throttle <= 1 &&
          order.turn >= -1 &&
          order.turn <= 1 &&
          (order.pitchStick === undefined ||
            (Number.isFinite(order.pitchStick) && order.pitchStick >= -1 && order.pitchStick <= 1))
          ? null
          : "malformed";
      case "moduleToggle": {
        const mods = this.sim.world.modules.get(entityId);
        // Address by hardpoint index (sparse-safe): a module must occupy it.
        if (!mods || !mods.modules.some((m) => m.hardpointIndex === order.hardpointIndex)) {
          return "bad-hardpoint";
        }
        return null;
      }
    }
  }

  private rateLimited(client: Client): boolean {
    if (!this.overBudget(client.sessionId)) return false;
    const rate = this.orderRates.get(client.sessionId)!;
    rate.abuse++;
    if (rate.abuse >= ABUSE_KICK_THRESHOLD) {
      log.warn("kicking client for sustained order spam", { sessionId: client.sessionId });
      client.leave(4290); // custom close code: rate-limit kick
    }
    return true;
  }

  /**
   * Charge one order to `key`'s one-second budget and report whether it blew it.
   * The window logic is shared by humans and bots so the two are held to the
   * SAME cap; only the consequences differ (a client can be kicked, a bot's
   * order is simply dropped).
   */
  private overBudget(key: string): boolean {
    const now = Date.now();
    const rate = this.orderRates.get(key) ?? { windowStart: now, count: 0, abuse: 0 };
    if (now - rate.windowStart >= 1000) {
      rate.windowStart = now;
      rate.count = 0;
    }
    rate.count++;
    this.orderRates.set(key, rate);
    return rate.count > this.maxOrdersPerSec;
  }

  private ack(client: Client, seq: number, accepted: boolean, reason?: OrderRejectReason): void {
    client.send(MSG_ORDER_ACK, reason ? { seq, accepted, reason } : { seq, accepted });
  }

  /**
   * The fixed simulation step, wrapped in a duration counter (6.6/6.8). The two
   * `performance.now()` calls cost well under a microsecond against a 33 ms
   * budget, and the roadmap wants avg tick time in production telemetry — so
   * this is measured always, not behind a dev flag.
   */
  private update(): void {
    if (this.state.matchPhase !== "live") return;
    const startedAt = performance.now();

    if (this.botDrivers.size > 0) this.driveBots();
    this.sim.tick(FIXED_DT);
    const events = this.sim.getEvents();
    this.trackFrags(events);
    this.relayEvents(events);

    this.writeState();
    this.state.matchTimer = this.sim.snapshot().elapsed;

    getMetrics().recordTick(this.roomId, performance.now() - startedAt);

    if (this.sim.isEnded && this.state.matchPhase === "live") this.endMatch();
  }

  /**
   * Mark the patch window so wrapped `Client.raw` writes are attributed to state
   * patches rather than to messages. `applyPatches` is synchronous, so the flag
   * cannot straddle two patches; `finally` keeps it honest if encoding throws.
   */
  override broadcastPatch(): boolean {
    this.patchPhase = true;
    try {
      return super.broadcastPatch();
    } finally {
      this.patchPhase = false;
    }
  }

  /**
   * Attribute kills for perKill rewards. Kill attribution uses the sim's
   * `entityDestroyed.killerId` (the only attribution the sim exposes); ship kills
   * on an enemy ship count, asteroid destructions and team-kills do not.
   */
  private trackFrags(events: SimEvent[]): void {
    for (const ev of events) {
      if (ev.type !== "entityDestroyed" || ev.isAsteroid || ev.killerId === null) continue;
      const killer = ev.killerId;
      if (!this.fragsByEntity.has(killer)) continue;
      const killerTeam = this.sim.teamOf(killer);
      if (killerTeam !== undefined && killerTeam === ev.team) continue; // no team-kill credit
      this.fragsByEntity.set(killer, (this.fragsByEntity.get(killer) ?? 0) + 1);
    }
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
      const qy = encodeCenti(p.pos.y);
      const qz = encodeCenti(p.pos.z);
      const qh = encodeHeading(p.heading);
      if (proj.x !== qx) proj.x = qx;
      if (proj.y !== qy) proj.y = qy;
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
    const qy = encodeCenti(ship.pos.y);
    const qz = encodeCenti(ship.pos.z);
    const qh = encodeHeading(ship.heading);
    const qp = encodePitch(ship.pitch);
    if (ps.x !== qx) ps.x = qx;
    if (ps.y !== qy) ps.y = qy;
    if (ps.z !== qz) ps.z = qz;
    if (ps.heading !== qh) ps.heading = qh;
    if (ps.pitch !== qp) ps.pitch = qp;
    if (ps.hull !== ship.hull) ps.hull = ship.hull;
    // Resolved maxima (ship class + upgrades + module passives): the sim already
    // resolved these into the snapshot at spawn, so mirror them straight through.
    if (ps.hullMax !== ship.hullMax) ps.hullMax = ship.hullMax;
    if (ps.energyCur !== ship.energy.cur) ps.energyCur = ship.energy.cur;
    if (ps.energyMax !== ship.energy.max) ps.energyMax = ship.energy.max;
    if (ps.heatCur !== ship.heat.cur) ps.heatCur = ship.heat.cur;
    if (ps.heatCapacity !== ship.heat.capacity) ps.heatCapacity = ship.heat.capacity;

    // Flight + sensor state (FLIGHT.md §5). `throttle` and `lockProgress` are
    // already normalized 0..1 in the snapshot, so they quantize through the same
    // `encodeUnit` the client decodes with — no per-field scaling anywhere else.
    const qThrottle = encodeUnit(ship.throttle);
    const qLock = encodeUnit(ship.lockProgress);
    if (ps.throttle !== qThrottle) ps.throttle = qThrottle;
    if (ps.lockProgress !== qLock) ps.lockProgress = qLock;
    if (ps.locked !== ship.locked) ps.locked = ship.locked;
    const targetId = ship.targetId ?? -1;
    if (ps.targetId !== targetId) ps.targetId = targetId;

    let shieldPool = 0;
    for (let i = 0; i < ship.modules.length; i++) {
      const m = ship.modules[i]!;
      shieldPool += m.shieldPool;
      const target = ps.modules[i];
      if (!target) {
        const ms = new ModuleState();
        ms.moduleId = m.moduleId;
        ms.hardpointIndex = m.hardpointIndex;
        ms.state = encodeModuleState(m.state);
        ms.stateTimer = m.stateTimer;
        ms.heat = m.heat;
        ms.cycleTimer = m.cycleTimer;
        ms.shieldPool = m.shieldPool;
        ps.modules.push(ms);
        continue;
      }
      if (target.moduleId !== m.moduleId) target.moduleId = m.moduleId;
      if (target.hardpointIndex !== m.hardpointIndex) target.hardpointIndex = m.hardpointIndex;
      const code = encodeModuleState(m.state);
      if (target.state !== code) target.state = code;
      if (target.stateTimer !== m.stateTimer) target.stateTimer = m.stateTimer;
      if (target.heat !== m.heat) target.heat = m.heat;
      if (target.cycleTimer !== m.cycleTimer) target.cycleTimer = m.cycleTimer;
      if (target.shieldPool !== m.shieldPool) target.shieldPool = m.shieldPool;
    }
    if (ps.shieldPool !== shieldPool) ps.shieldPool = shieldPool;
  }

  private endMatch(): void {
    const snap = this.sim.snapshot();
    this.state.matchPhase = "ended";
    const winnerTeam = snap.winnerTeam ?? null;
    this.state.winnerTeam = winnerTeam ?? -1;
    this.lock();
    log.info("match ended", { winnerTeam: this.state.winnerTeam });

    this.persistAndReward(snap.winnerTeam ?? null, snap.elapsed);

    this.endTimer = setTimeout(() => this.disconnect(), MATCH_END_GRACE_MS);
  }

  /**
   * Persist the match result and grant progression to authenticated players,
   * then mirror each player's rewards back as a `matchRewards` simEvent. Best-
   * effort: a persistence error must not crash the room's end sequence.
   */
  private persistAndReward(winnerTeam: number | null, durationS: number): void {
    try {
      const configs = this.configs;
      const participants: Participant[] = [];
      const userToSession = new Map<string, string>();
      for (const [key, ps] of this.state.players) {
        const userId = this.sessionUserId.get(key) ?? null;
        if (userId) userToSession.set(userId, key);
        participants.push({
          userId,
          team: ps.team,
          frags: this.fragsByEntity.get(ps.entityId) ?? 0,
          entityId: ps.entityId,
        });
      }

      const summaries = finalizeMatch(configs, {
        mode: this.gamemode.id,
        arenaId: this.arena.id,
        winnerTeam,
        durationS,
        participants,
        rewardsEligible: this.rewardsEligible,
        // Telemetry (6.8): who was actually in this match. Counted across the
        // whole match rather than read off `state.players` at the end, so a
        // player who rage-quits at 4-4 still counts as having played.
        roomId: this.roomId,
        playerCount: this.humansJoined,
        botCount: this.botsSpawned,
      });

      for (const summary of summaries) {
        const sessionId = userToSession.get(summary.userId);
        if (!sessionId) continue;
        const client = this.clients.find((c) => c.sessionId === sessionId);
        if (!client) continue;
        const msg: SimEventMessage = {
          type: "matchRewards",
          credits: summary.credits,
          xp: summary.xp,
          newLevel: summary.newLevel,
          leveledUp: summary.leveledUp,
        };
        client.send(MSG_SIM_EVENT, msg);
      }
    } catch (err) {
      log.error("failed to persist/reward match", err);
    }
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
    this.sessionUserId.delete(sessionId);
    if (entityId !== undefined) this.fragsByEntity.delete(entityId);
    this.state.players.delete(sessionId);
    getMetrics().setClientCount(this.roomId, this.clients.length);
    log.info("client removed", { sessionId, entityId });
  }

  /**
   * Teardown (6.6 dispose audit). Everything this room owns that outlives a tick
   * is released here: both `setTimeout` handles, every bot driver (each holds a
   * profile config and a decision-state closure), the sim's entity maps, and the
   * room's slot in the metrics registry. Colyseus itself clears
   * `setSimulationInterval`, the patch interval and `this.clock`; the two raw
   * `setTimeout`s below are ours and are *not* covered by that.
   */
  onDispose(): void {
    if (this.endTimer) {
      clearTimeout(this.endTimer);
      this.endTimer = null;
    }
    this.clearBotBackfillTimer();
    this.botDrivers.clear();
    this.keyToEntity.clear();
    this.entityToKey.clear();
    this.humanSessions.clear();
    this.sessionUserId.clear();
    this.fragsByEntity.clear();
    this.orderRates.clear();
    this.asteroidEntityIds = [];
    getMetrics().unregisterRoom(this.roomId);
    log.info("room disposed", { gamemode: this.gamemode?.id });
  }
}

/** Order-budget key for a bot ship. Distinct namespace from client session ids. */
function botRateKey(entityId: EntityId): string {
  return `bot-rate-${entityId}`;
}

/** Convert a positional `defaultFitting` into a validate-able hardpoint map (skip empties). */
function defaultFittingToHardpointMap(defaultFitting: readonly (string | null)[]): HardpointMap {
  const map: HardpointMap = {};
  defaultFitting.forEach((moduleId, i) => {
    if (moduleId) map[String(i)] = moduleId;
  });
  return map;
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
    // Lock flips: one message per acquire/break, which is the rate a lock can
    // physically change at. Without them the online client never plays the
    // lock cue that practice mode plays (FLIGHT.md §2/§4).
    case "lockAcquired":
      return { type: "lockAcquired", entityId: ev.entityId, targetId: ev.targetId };
    case "lockLost":
      return { type: "lockLost", entityId: ev.entityId };
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
