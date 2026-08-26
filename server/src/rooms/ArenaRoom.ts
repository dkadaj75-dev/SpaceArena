import { Room, type Client } from "@colyseus/core";
import { randomInt, randomUUID } from "node:crypto";
import {
  ArenaSimulation,
  BotDriver,
  createBotDriver,
  deriveRng,
  generateBotName,
  pickBotShip,
  randomBotFitting,
  resolveBackfillBot,
  resolveBotRoster,
  botCosmeticFor,
  resolveCosmeticFor,
  teamSizeOf,
  SIM_TICK_RATE,
  createLogger,
  loadoutFittingId,
  orderMessageSchema,
  MSG_ORDER,
  MSG_ORDER_ACK,
  MSG_FIRE_EVENT,
  MSG_SIM_EVENT,
  MSG_MATCH_STATS,
  MatchStatsAccumulator,
  type ArenaConfig,
  type GamemodeConfig,
  type ShipConfig,
  type TuningConfig,
  type EntityId,
  type Order,
  type SimEvent,
  type OrderRejectReason,
  type FireEventMessage,
  type SimEventMessage,
} from "@space-arena/shared";
import type { HardpointMap, ModuleConfig, UpgradeLevels } from "@space-arena/shared";
import { getConfigService } from "../configService.js";
import { verifyAccessToken } from "../auth/tokens.js";
import { fittingsRepo, ownedModulesRepo, profilesRepo, selectedCosmeticsRepo, shipUpgradesRepo } from "../db/repos.js";
import { ownedCosmeticIds } from "../api/ownership.js";
import { hardpointMapToFitting, pruneStaleFitting, validateFitting } from "../api/fittingValidation.js";
import { finalizeMatch, type Participant } from "../progression/service.js";
import { getMetrics, instrumentClientEgress } from "../telemetry/metrics.js";
import { ArenaState, PlayerState, ModuleState, AsteroidState } from "./state/ArenaState.js";
import { applySnapshot, syncShipState } from "./state/replicate.js";

const log = createLogger("ArenaRoom");

/** Fixed sim step in seconds (matches the shared 60 Hz sim; see 0.9). */
const FIXED_DT = 1 / SIM_TICK_RATE;
/** Fixed sim step in milliseconds, the unit the tick accumulator runs in. */
const FIXED_DT_MS = 1000 / SIM_TICK_RATE;
/**
 * Sim ticks per replicated patch — the room's patch cadence, PHASE-LOCKED to the
 * simulation instead of run off a timer of its own.
 *
 * Until 2026-08-18 this was `setPatchRate(50)`: a second, INDEPENDENT interval
 * broadcasting at 20 Hz beside a 30 Hz sim. Nothing synchronised the two, so a
 * patch carried whichever tick happened to be the most recent when its timer
 * fired — consecutive patches one tick apart, then two, alternating forever, on
 * a perfect network. The client's `stampSnapshot` can absorb that in TIMING (it
 * files each sample under the server's own `matchTimer` rather than its arrival
 * instant), but it cannot undo the SAMPLING: half of all patches carried a
 * world the client had already been shown. Broadcasting from the sim loop makes
 * every patch carry a FRESH tick, exactly `PATCH_EVERY_TICKS` apart.
 *
 * ONE tick (16.7 ms at the 60 Hz sim, 2026-08-24) is the fast-paced choice: it
 * quarters the sampling interval the client interpolates across (66.7 ms → 16.7
 * ms), lets the render-delay floor drop from 100 ms to 50 ms, and halves the
 * worst-case order-to-visible latency quantization. The cost is bandwidth —
 * every patch carries the same changed-field set (kinematics change every
 * tick), so patches barely shrink and per-client egress is ~4x the old 15 Hz
 * cadence: ~27-60 kB/s per client for a 10-ship room (measured field
 * arithmetic, telemetry/metrics.ts tracks the real figure). Raise this to 2 if
 * a deployment needs the bandwidth back — every client constant adapts (the
 * adaptive render delay measures arrival gaps rather than assuming them).
 */
const PATCH_EVERY_TICKS = 1;
/** Nominal ms between patches, for logs and telemetry — derived, never a timer. */
const PATCH_INTERVAL_MS = (PATCH_EVERY_TICKS * 1000) / SIM_TICK_RATE;
/**
 * Catch-up bound for the fixed-timestep accumulator (see {@link update}): at
 * most this many sim ticks run per timer callback, and a single callback's
 * wall-clock delta is clamped to the same budget. 8 ticks is 133 ms — enough to
 * absorb an ordinary GC pause or event-loop stall without the sim clock losing
 * time, while a stall longer than that sheds the backlog instead of freezing
 * the room in a burst of catch-up ticks (and a non-monotonic Date.now step —
 * the clock Colyseus reads — can never fast-forward a match).
 */
const MAX_CATCHUP_TICKS = 8;
/** Grace period after match end before the room disconnects everyone. */
const MATCH_END_GRACE_MS = 8000;
/** Reconnection window (seconds) offered on an unconsented leave. */
const RECONNECT_WINDOW_S = 30;
/** Fallback wait before bot backfill when the gamemode omits `bots.backfillWaitMs`. */
const DEFAULT_BOT_BACKFILL_MS = 10000;
/** Default order rate cap (orders/sec) if tuning omits `maxOrdersPerSec`. */
const DEFAULT_MAX_ORDERS_PER_SEC = 20;
/** Sustained-abuse threshold: kick a client after this many rate-limited orders. */
const ABUSE_KICK_THRESHOLD = 40;

interface InternalCreateOverrides {
  minPlayers?: number;
  botProfile?: string;
  botBackfillMs?: number;
  seed?: number;
}

interface CreateOptions {
  gamemode: string;
  arena?: string;
  __internalArenaToken?: string;
  __internal?: InternalCreateOverrides;
}

const INTERNAL_ARENA_TOKEN = randomUUID();

/** Process-local server seam; browser lookalikes cannot forge the random token. */
export function internalArenaCreateOptions(
  gamemode: string,
  overrides: InternalCreateOverrides = {},
): CreateOptions {
  return { gamemode, __internalArenaToken: INTERNAL_ARENA_TOKEN, __internal: overrides };
}

interface JoinOptions {
  shipId?: string;
  name?: string;
  /** Access-token JWT; verified in onAuth to resolve the user id. */
  token?: string;
  /** Saved fitting to spawn with (must belong to the authed user). */
  fittingId?: string;
  /**
   * Paint to fly in (`cosmetic.*`). Omitted ⇒ the user's saved selection for the
   * spawned hull. Anything the joiner does not own, or that does not apply to
   * the hull, is silently flown as the authored look — a cosmetic is never worth
   * refusing a join over.
   */
  cosmeticId?: string;
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
  private humanStartThreshold = 2;
  /**
   * The match seed, kept because the sim is not its only consumer: every bot
   * driver derives its own RNG stream from it (see {@link backfillBots}), so a
   * room re-created with the same seed replays the same bot behaviour.
   */
  private seed = 1;
  /** Rewards come only from the gamemode config; bot backfill stays eligible. */
  private rewardsEligible = true;

  /** session id / bot key → sim entity id, for every ship this room owns. */
  private readonly keyToEntity = new Map<string, EntityId>();
  private readonly entityToKey = new Map<EntityId, string>();
  /** Human client session ids (excludes bots), for team balancing. */
  private readonly humanSessions = new Set<string>();
  private readonly humanFittings = new Map<string, readonly (string | null)[]>();
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
  private lobbyDeadlineMs: number | null = null;
  /** Sim-clock milliseconds fed to the bot drivers (their decision cadence). */
  private botClockMs = 0;

  /** sessionId → authenticated userId (null for anonymous clients and bots). */
  private readonly sessionUserId = new Map<string, string | null>();
  /** Ship entity id → frags scored this match (for perKill rewards). */
  private readonly fragsByEntity = new Map<EntityId, number>();
  private matchStats!: MatchStatsAccumulator;

  // --- telemetry (6.6/6.8) --------------------------------------------------
  /**
   * True only while {@link broadcastPatch} is on the stack, so the egress byte
   * counter can tell a state patch from an ordinary message. Read by
   * `instrumentClientEgress`; see telemetry/metrics.ts for why this is the only
   * seam Colyseus 0.16 offers.
   */
  private patchPhase = false;
  /** Sim ticks since the last patch; see {@link PATCH_EVERY_TICKS}. */
  private ticksSincePatch = 0;
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

    this.maxClients = teamSizeOf(gamemode) * 2;
    const internal = options.__internalArenaToken === INTERNAL_ARENA_TOKEN ? options.__internal : undefined;
    this.humanStartThreshold = Math.min(this.maxClients, Math.max(1, internal?.minPlayers ?? this.maxClients));
    this.rewardsEligible = true;

    this.seed = internal?.seed ?? randomInt(1, 0x7fffffff);
    this.sim = new ArenaSimulation(configs, arenaId, options.gamemode, this.seed);
    this.matchStats = new MatchStatsAccumulator((id) => this.sim.teamOf(id));

    const state = new ArenaState();
    state.matchPhase = "waiting";
    // Seeded before the first tick so a joining client already knows how long
    // the lead-in is and can render "3" the moment the room goes live.
    state.countdownRemaining = this.sim.snapshot().countdownRemaining;
    this.setState(state);

    // Seed asteroid dynamic state (layout itself comes from the arena config).
    this.asteroidEntityIds = this.sim.world.asteroidIds();
    this.asteroidEntityIds.forEach((id, i) => {
      const tag = this.sim.world.asteroids.get(id)!;
      const a = new AsteroidState();
      a.destroyed = tag.state === "destroyed";
      state.asteroids.set(String(i), a);
    });

    this.botProfileOverride = internal?.botProfile;
    this.botBackfillMs = internal?.botBackfillMs ?? gamemode.bots?.backfillWaitMs ?? DEFAULT_BOT_BACKFILL_MS;

    // The callback's argument is Colyseus' clock.deltaTime — the REAL wall
    // milliseconds since the previous fire — which is what makes the fixed
    // timestep in `update` honest. The interval itself is only a wake-up
    // cadence: Node truncates it to integer ms and fires late under load, and
    // neither error reaches the sim clock any more (see `update`).
    this.setSimulationInterval((deltaMs) => this.update(deltaMs), 1000 / SIM_TICK_RATE);
    // 0 disables colyseus' own patch interval entirely (see the `patchRate`
    // setter in @colyseus/core's Room: 0 and null both clear it and start
    // nothing). `update()` calls `broadcastPatch()` itself, phase-locked to the
    // sim — see PATCH_EVERY_TICKS.
    this.setPatchRate(0);

    this.onMessage(MSG_ORDER, (client, message) => this.handleOrder(client, message));

    getMetrics().registerRoom(this.roomId, gamemode.id);

    log.info("room created", {
      gamemode: gamemode.id,
      arena: arenaId,
      maxClients: this.maxClients,
      fullAt: this.maxClients,
      patchIntervalMs: PATCH_INTERVAL_MS,
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
    const cosmeticId = this.resolveCosmetic(configs, userId, shipId, options);
    const entityId = this.sim.spawnPlayer(shipId, fitting, team, upgradeLevels, cosmeticId);

    const ps = new PlayerState();
    ps.entityId = entityId;
    ps.team = team;
    ps.shipId = shipId;
    ps.cosmeticId = cosmeticId ?? "";
    ps.displayName = this.resolveDisplayName(userId, options);
    ps.isBot = false;
    // One ModuleState per fitted (non-empty) module; empty hardpoints get none.
    const fittedCount = fitting.filter((m) => m !== null).length;
    for (let i = 0; i < fittedCount; i++) ps.modules.push(new ModuleState());
    this.state.players.set(client.sessionId, ps);

    this.keyToEntity.set(client.sessionId, entityId);
    this.entityToKey.set(entityId, client.sessionId);
    this.humanSessions.add(client.sessionId);
    this.humanFittings.set(client.sessionId, fitting);
    this.sessionUserId.set(client.sessionId, userId);
    this.fragsByEntity.set(entityId, 0);
    this.orderRates.set(client.sessionId, { windowStart: Date.now(), count: 0, abuse: 0 });
    this.humansJoined++;

    // Count this client's outbound bytes (6.6 patch-bytes/s). The wrapper lives
    // on the client object, so it is collected with the client — nothing to undo.
    instrumentClientEgress(client, this.roomId, this);
    getMetrics().setClientCount(this.roomId, this.clients.length);

    syncShipState(this.sim.snapshot(), entityId, ps);
    client.send(MSG_MATCH_STATS, { lines: this.matchStats.all() });

    log.info("client joined", { sessionId: client.sessionId, team, entityId, shipId, userId });
    this.maybeStart();
  }

  /**
   * Pick the ship + ordered module list to spawn, then **validate it** against
   * the joining player's ownership/level and the ship's current sockets (same
   * logic as the REST fitting API). Three sources, in order: a `fittingId` the
   * user owns (legacy — see the branch), then the user's ONE stored loadout for
   * the hull they asked for, then that hull's `defaultFitting`. Whichever wins,
   * an invalid resolved fitting **rejects the join** (Finding 1) rather than
   * spawning an illegal loadout.
   *
   * The one thing that does NOT reject is a STORED fitting gone stale against
   * the current pack (2026-08-22). Sockets are content: the hardpoint pass that
   * cut every hull's mounts left every previously saved fitting addressing slots
   * that moved or vanished, and rejecting those would have locked every player
   * who ever saved a loadout out of the game until they re-fitted. So a stored
   * fitting is PRUNED to what its hull still has ({@link pruneStaleFitting}) and
   * the remainder validated; a prune that empties it falls all the way back to
   * the hull's `defaultFitting`, because a ship with no guns is not a loadout.
   * Ownership and level are enforced on every surviving entry exactly as before,
   * so this widens nothing a client can exploit — it only forgives the pack for
   * changing under a row in the database.
   */
  private resolveFitting(
    configs: ReturnType<typeof getConfigService>,
    userId: string | null,
    options: JoinOptions,
  ): { shipId: string; fitting: (string | null)[] } {
    // Candidate ship + hardpoint map.
    let shipId: string | null = null;
    let hardpointMap: HardpointMap | null = null;

    // A row named OUTRIGHT still wins. Nothing in the shipped client sends this
    // any more (see below), but the option is part of the join wire and an old
    // build with a stale id in `localStorage` still arrives with one — which
    // resolves to "not found" and falls through, rather than wedging the join.
    if (userId && options.fittingId) {
      const fit = fittingsRepo.byId(options.fittingId);
      if (fit && fit.user_id === userId && configs.get<ShipConfig>("ship", fit.ship_id)) {
        shipId = fit.ship_id;
        hardpointMap = this.storedFittingMap(configs, fit.ship_id, fit.hardpointMap, options.fittingId);
      } else {
        log.warn("fitting not found / not owned / unknown ship; using default", { fittingId: options.fittingId, userId });
      }
    }

    // The pilot's ONE loadout for the hull they asked for (owner 2026-08-22).
    // The client sends no fitting id at all now: there is exactly one row per
    // (user, ship) and its id is DERIVED, so the room can look it up from the
    // authenticated user plus the requested hull — which is also why a client
    // can no longer name someone else's row, having nothing to name it with.
    if (!shipId || !hardpointMap) {
      const wanted = options.shipId && configs.get<ShipConfig>("ship", options.shipId) ? options.shipId : null;
      const fit = userId && wanted ? fittingsRepo.byId(loadoutFittingId(userId, wanted)) : undefined;
      if (fit && wanted) {
        shipId = wanted;
        hardpointMap = this.storedFittingMap(configs, wanted, fit.hardpointMap, fit.id);
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
   * A map read out of the DATABASE, forgiven for the pack having changed under
   * it. Shared by both stored-fitting paths above so they cannot disagree about
   * how much staleness a join survives.
   */
  private storedFittingMap(
    configs: ReturnType<typeof getConfigService>,
    shipId: string,
    stored: HardpointMap,
    rowId: string,
  ): HardpointMap {
    const pruned = pruneStaleFitting(configs, shipId, stored);
    if (pruned.dropped.length > 0) {
      log.warn("stored fitting no longer matches the hull's sockets; dropping stale slots", {
        fittingId: rowId,
        shipId,
        dropped: pruned.dropped,
      });
    }
    // Everything dropped ⇒ nothing of this fitting survives the pack. Keep the
    // HULL the player chose and give it its stock loadout: an empty hull is not
    // a loadout, and silently swapping their ship as well would be a second
    // surprise on top of the first.
    if (Object.keys(pruned.map).length > 0) return pruned.map;
    return defaultFittingToHardpointMap(configs.get<ShipConfig>("ship", shipId)!.defaultFitting);
  }

  /**
   * The paint this join actually flies in — the trust boundary for cosmetics.
   * A client may name one, but it must OWN it and it must apply to the hull;
   * anything else resolves to the authored look instead of an error, because a
   * stale selection (older pack, revoked paint) must never cost someone a match.
   * An anonymous join owns nothing, so it always flies standard.
   */
  private resolveCosmetic(
    configs: ReturnType<typeof getConfigService>,
    userId: string | null,
    shipId: string,
    options: JoinOptions,
  ): string | null {
    const requested = options.cosmeticId ?? (userId ? selectedCosmeticsRepo.get(userId, shipId) : undefined);
    const resolved = resolveCosmeticFor(configs, shipId, requested);
    if (!resolved || !userId) return null;
    return ownedCosmeticIds(configs, userId).has(resolved) ? resolved : null;
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
    if (!userId) return { hull: 0, engine: 0, energy: 0 };
    const row = shipUpgradesRepo.get(userId, shipId);
    if (!row) return { hull: 0, engine: 0, energy: 0 };
    return { hull: row.hull_lvl, engine: row.engine_lvl, energy: row.energy_lvl };
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

  private maybeStart(): void {
    if (this.state.matchPhase !== "waiting") return;
    if (this.humanSessions.size >= this.humanStartThreshold) {
      this.clearBotBackfillTimer();
      this.state.matchPhase = "live";
      this.lock();
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
   * gamemode that declares no usable `bots` block.
   */
  private scheduleBotBackfill(): void {
    if (this.botBackfillTimer !== null) return;
    if (this.humanSessions.size === 0) return;
    if (!resolveBackfillBot(this.gamemode, this.configs, this.botProfileOverride)) return;
    this.lobbyDeadlineMs = Date.now() + this.botBackfillMs;
    this.syncLobbyRemaining();
    this.botBackfillTimer = setTimeout(() => {
      this.botBackfillTimer = null;
      this.lobbyDeadlineMs = null;
      this.state.lobbyRemainingSec = 0;
      this.backfillBots();
    }, this.botBackfillMs);
    log.info("bot backfill armed", { waitMs: this.botBackfillMs });
  }

  private clearBotBackfillTimer(): void {
    if (this.botBackfillTimer !== null) clearTimeout(this.botBackfillTimer);
    this.botBackfillTimer = null;
    this.lobbyDeadlineMs = null;
    this.state.lobbyRemainingSec = 0;
  }

  private syncLobbyRemaining(): void {
    const remaining = this.lobbyDeadlineMs === null
      ? 0
      : Math.max(0, Math.ceil((this.lobbyDeadlineMs - Date.now()) / 1000));
    if (this.state.lobbyRemainingSec !== remaining) this.state.lobbyRemainingSec = remaining;
  }

  /**
   * Fill every team up to the gamemode's team size with bots, then start the
   * match. Bots get a schema `PlayerState`, so remote
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
    const authoredRoster = resolveBotRoster(this.gamemode, configs);
    const perTeam = new Map<number, number>();
    for (const eid of this.keyToEntity.values()) {
      const team = this.sim.teamOf(eid);
      if (team === undefined) continue;
      perTeam.set(team, (perTeam.get(team) ?? 0) + 1);
    }

    let spawned = 0;
    // Roster decisions (hull, fitting, name) come off one seeded stream, so two
    // rooms built from the same seed field the same opposition.
    const rosterRng = deriveRng(this.seed, 0xb0715);
    const randomize = this.sim.world.gamemode.bots?.randomizeLoadouts === true;
    const referenceFitting = [...this.humanSessions]
      .map((sessionId) => this.humanFittings.get(sessionId))
      .find((candidate): candidate is readonly (string | null)[] => candidate !== undefined);
    for (let team = 0; team < 2; team++) {
      for (let i = perTeam.get(team) ?? 0; i < teamSize; i++) {
        // Roster parity with the offline path. The client's local fallback
        // (GameSession) reads all three of `profile`, `shipId` and `fitting` off
        // the matched slot; this read only `profile` and always sourced the hull
        // from `backfill`, silently discarding a slot's authored `ship`/`fitting`
        // even though `gamemodeSchema` accepts both.
        //
        // The gate is `!slot?.fitting`, mirroring GameSession exactly, and that
        // detail is load-bearing: simply preferring the slot's hull over
        // `pickBotShip` would SKIP a draw on practice-bots-5v5 and
        // practice-ctf-5v5 (both author a roster AND set randomizeLoadouts), and
        // `rosterRng` also feeds `generateBotName` below — so bot hulls and names
        // on two shipped online modes would change. This form preserves the
        // stream. No shipped roster slot authors `fitting`, and every authored
        // `ship` already equals its mode's `defaultShip`, so today this is a
        // provable no-op; it stops being one the moment content uses the fields.
        const teamRoster = authoredRoster.filter((slot) => slot.team === team);
        const slot = teamRoster.length > 0 ? teamRoster[i % teamRoster.length] : undefined;
        const botProfile = slot?.profile ?? backfill.profile;
        const botShipId = randomize && !slot?.fitting
          ? pickBotShip(configs, rosterRng, slot?.shipId ?? backfill.shipId, this.sim.world.gamemode.bots?.shipPool)
          : (slot?.shipId ?? backfill.shipId);
        const botShip = configs.get<ShipConfig>("ship", botShipId) ?? ship;
        const botFitting = slot?.fitting ?? (randomize
          ? randomBotFitting(configs, botShipId, rosterRng, botProfile, referenceFitting)
          : botShip.defaultFitting);
        // Bots wear a paint authored for their hull, keyed off the room seed + entity id
        // rather than drawn from `rosterRng`: dressing them must not shift the
        // stream that picks their hulls and fittings.
        const botCosmetic = resolveCosmeticFor(configs, botShipId, botCosmeticFor(configs, botShipId, this.seed, spawned));
        const entityId = this.sim.spawnPlayer(botShipId, botFitting, team, undefined, botCosmetic);
        const key = `bot-${entityId}`;
        const ps = new PlayerState();
        ps.entityId = entityId;
        ps.team = team;
        ps.shipId = botShipId;
        ps.cosmeticId = botCosmetic ?? "";
        // A player-like handle, not the profile id: "Rookie" reads as furniture
        // on a scoreboard, "Vortexrunner_77" reads as an opponent.
        ps.displayName = generateBotName(rosterRng);
        ps.isBot = true;
        for (let m = 0; m < botFitting.filter((x) => x !== null).length; m++) ps.modules.push(new ModuleState());
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
          createBotDriver(this.sim.world, entityId, botProfile, botShip, deriveRng(this.seed, entityId)),
        );
        // Snapshot per bot, not hoisted out of the loop: each iteration spawns
        // a ship into the world, so a snapshot taken before the loop would not
        // contain the bots spawned after it.
        syncShipState(this.sim.snapshot(), entityId, ps);
        spawned++;
      }
    }

    this.botsSpawned += spawned;
    log.info("bot backfill complete", { spawned, profile: backfill.profile.id });
    this.state.matchPhase = "live";
    this.lock();
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
        // The ship is only ABSENT while it waits out `gamemode.respawn`: the
        // sim then rebuilds it under this same entity id. Deleting the driver
        // here — as this loop used to — orphaned every bot on its first death:
        // the rebuilt hull never received another order and sat parked at its
        // spawn pad for the rest of the match (the live "bots become inactive"
        // report, CTF and TDM alike). KEEP the driver; it detects the sighting
        // gap itself on the first update after the respawn and starts the new
        // hull from a clean reset (`BotDriver.lastSeenTick`). A driver whose
        // ship never returns (respawn disabled) idles here harmlessly until
        // `dispose` clears the map.
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

    // `matchPhase` is the ROOM's lifecycle, not the sim's phase: it flips to
    // "live" when the players are in, and the sim then spends
    // `tuning.matchCountdownSec` in its own frozen `countdown` phase. Orders are
    // deliberately ACCEPTED throughout that window — the sim stores them without
    // integrating, so a throttle held through "3-2-1" bites the instant GO lands
    // (see ArenaSimulation's countdown doc). Only a room that has not started yet
    // (or has ended) rejects.
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
    // The accepted `seq` goes back on the per-client `orderAck` and nowhere
    // else: reconciliation is a private conversation with the sender, so it has
    // no business in the roster every client decodes (protocol 7 deleted the
    // `lastProcessedSeq` field that used to shadow it).
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
            (Number.isFinite(order.pitchStick) && order.pitchStick >= -1 && order.pitchStick <= 1)) &&
          typeof order.fire === "boolean"
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
      case "jettisonCountermeasure":
        // Takes no arguments, so there is nothing to malform. Whether the fitted
        // pod CAN be jettisoned (and is off cooldown) is a sim rule, not a
        // validation one — an ineligible order is simply spent doing nothing.
        return null;
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
      // A window that ended at or under budget proves the client recovered.
      // Forget prior burst debt; consecutive over-budget windows still retain it.
      if (rate.count <= this.maxOrdersPerSec) rate.abuse = 0;
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
   * Wall-time accumulator carrying fractional sim ticks between timer fires.
   * This is what makes the tick rate genuinely FIXED: the old loop stepped
   * exactly one FIXED_DT per `setInterval` fire, so every millisecond the timer
   * fired late (integer-ms truncation, event-loop load) silently stretched
   * simulated time against wall time — 1-2% drift the client's snapshot clock
   * then had to slew away, and unbounded slowdown under sustained load.
   */
  private tickAccumulatorMs = 0;
  private simTickCount = 0;

  /**
   * Total fixed sim steps this room has executed (lobby ticks included).
   * Test/telemetry probe: one timer fire may run 0, 1 or several fixed steps
   * under the accumulator, so "wait N fires" no longer means "wait N ticks" —
   * the test helper counts THIS instead.
   */
  get totalSimTicks(): number {
    return this.simTickCount;
  }

  /**
   * The fixed-timestep driver: accumulate the REAL elapsed wall time Colyseus
   * hands the simulation callback, run as many fixed `FIXED_DT` steps as have
   * accrued (bounded by {@link MAX_CATCHUP_TICKS} — beyond that the backlog is
   * shed and the match slows rather than fast-forwarding in a burst), then
   * broadcast on the tick-counted patch beat. Each step is wrapped in a
   * duration counter (6.6/6.8) inside {@link stepSim}; the roadmap wants avg
   * tick time in production telemetry, so it is measured always.
   *
   * `deltaMs` defaults to exactly one step so tests that drive the room
   * directly (`advance(room, n)`) remain deterministic: one call, one tick.
   */
  private update(deltaMs: number = FIXED_DT_MS): void {
    // Clamp before accumulating: the Colyseus clock is Date.now-based, so a
    // system clock step can hand back a negative or a multi-second delta, and
    // a laptop resume can hand back minutes. Neither is sim time owed.
    const clamped = Math.min(Math.max(deltaMs, 0), MAX_CATCHUP_TICKS * FIXED_DT_MS);
    this.tickAccumulatorMs += clamped;

    let steps = 0;
    while (this.tickAccumulatorMs >= FIXED_DT_MS) {
      if (steps >= MAX_CATCHUP_TICKS) {
        // Shed what cannot be caught up; keep the sub-tick remainder so the
        // phase of the next tick is still exact.
        this.tickAccumulatorMs %= FIXED_DT_MS;
        break;
      }
      this.tickAccumulatorMs -= FIXED_DT_MS;
      this.stepSim();
      this.ticksSincePatch++;
      this.simTickCount++;
      steps++;
    }

    // PHASE-LOCKED PATCH. Counted and broadcast here, outside `stepSim`'s phase
    // guards, because a patch is not a property of the sim being live: a lobby
    // still replicates `lobbyRemainingSec` and the `matchPhase` flip that ends
    // the wait, and the "ended" state written by `endMatch` above has to reach
    // the clients that are about to see the results screen. Every phase patches
    // on the same tick beat; only the payload differs. A catch-up burst
    // broadcasts ONCE, after its last step — the intermediate ticks' state has
    // been superseded, and the client files the one patch under the server
    // clock, so the segment is simply longer rather than wrong.
    if (this.ticksSincePatch < PATCH_EVERY_TICKS) return;
    this.ticksSincePatch = 0;
    this.broadcastPatch();
  }

  /** The sim half of {@link update}: one fixed step and its replication write. */
  private stepSim(): void {
    if (this.state.matchPhase === "waiting") {
      this.syncLobbyRemaining();
      return;
    }
    if (this.state.matchPhase !== "live") return;
    const startedAt = performance.now();

    if (this.botDrivers.size > 0) this.driveBots();
    this.sim.tick(FIXED_DT);
    const events = this.sim.getEvents();
    const statDeltas = this.matchStats.consume(events, this.state.matchTimer + FIXED_DT);
    if (statDeltas.length > 0) this.broadcast(MSG_MATCH_STATS, { deltas: statDeltas });
    this.trackFrags(events);
    this.relayEvents(events);

    // ONE post-tick snapshot for the whole replication pass. The write side of
    // the wire protocol lives in `state/replicate.ts` and used to open by taking
    // its own — two full rebuilds of identical state, since `snapshot()` is pure
    // and nothing between them touches the sim except one read. (`driveBots`
    // keeps its own: that one is deliberately PRE-tick, taken before any order
    // in the pass is applied so every bot decides against the same world.)
    //
    // `applySnapshot` is a free function over (state, snapshot) precisely so the
    // encoder and the client's real decoder can be run against each other in one
    // process test (`state/replicate.test.ts`) instead of only ever meeting
    // across a websocket.
    const snap = this.sim.snapshot();
    applySnapshot(this.state, snap, this.entityToKey, this.asteroidEntityIds, this.sim.world.asteroids);

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
      if (ev.type === "entityDestroyed" && !ev.isAsteroid) {
        const key = this.entityToKey.get(ev.entityId);
        const player = key ? this.state.players.get(key) : undefined;
        if (player) player.alive = false;
      }
      const passthrough = toSimEventMessage(ev);
      if (passthrough) this.broadcast(MSG_SIM_EVENT, passthrough);
    }
  }

  private endMatch(): void {
    const snap = this.sim.snapshot();
    this.state.matchPhase = "ended";
    const winnerTeam = snap.winnerTeam ?? null;
    this.state.winnerTeam = winnerTeam ?? -1;
    // Transient objective/lure entities do not outlive the match. Clearing the
    // schema maps also tells clients to dispose markers and local flag trails.
    this.state.decoys.clear();
    this.state.flags.clear();
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
    // The roster row STAYS put for the reconnection window — it carries no
    // connection flag (protocol 7 deleted `connected`, which nothing decoded);
    // clients filter the roster on `alive`, and a leaver's ship is only removed
    // by `removePlayer` below.
    if (!consented) {
      try {
        await this.allowReconnection(client, RECONNECT_WINDOW_S);
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
    this.humanFittings.delete(sessionId);
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
    this.humanFittings.clear();
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
        // Presentation detail (owner 2026-08-23): what landed the hit and where.
        // Forwarded verbatim so an online client draws the same impact the
        // offline sim draws from the identical event.
        weapon: ev.weapon,
        pos: ev.pos,
      };
    case "shieldAbsorb":
      return {
        type: "shieldAbsorb",
        targetId: ev.targetId,
        sourceId: ev.sourceId,
        hardpointIndex: ev.hardpointIndex,
        amount: ev.amount,
        hullAvoided: ev.hullAvoided,
        damageType: ev.damageType,
        weapon: ev.weapon,
        pos: ev.pos,
      };
    // Lock flips: one message per acquire/break, which is the rate a lock can
    // physically change at. Without them the online client never plays the
    // lock cue that practice mode plays (FLIGHT.md §2/§4).
    case "lockAcquired":
      return { type: "lockAcquired", entityId: ev.entityId, targetId: ev.targetId };
    case "lockLost":
      return { type: "lockLost", entityId: ev.entityId };
    case "entityDestroyed":
      return {
        type: "entityDestroyed",
        entityId: ev.entityId,
        killerId: ev.killerId,
        isAsteroid: ev.isAsteroid,
        team: ev.team,
        pos: ev.pos,
      };
    case "flagTaken":
      return ev;
    case "flagDropped":
      return ev;
    case "flagReturned":
      return ev;
    case "flagCaptured":
      return ev;
    case "boundaryHit":
      return { type: "boundaryHit", entityId: ev.entityId, rule: ev.rule };
    // Start-countdown beats: three low-rate messages that give both clients the
    // same "3 … 2 … 1 … GO" edges off the authoritative sim clock.
    case "countdownTick":
      return { type: "countdownTick", remaining: ev.remaining };
    case "matchStarted":
      return { type: "matchStarted" };
    case "matchEnded":
      return { type: "matchEnded", winnerTeam: ev.winnerTeam, reason: ev.reason };
    default:
      return null;
  }
}
