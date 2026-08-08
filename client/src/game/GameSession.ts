import {
  ArenaSimulation,
  botCosmeticFor,
  MatchStatsAccumulator,
  BotDriver,
  createLogger,
  deriveRng,
  generateBotNames,
  hardpointsOf,
  pickBotShip,
  randomBotFitting,
  resolveBotRoster,
  type ConfigService,
  type EntityId,
  type ModuleConfig,
  type Order,
  type ShipConfig,
  type SimEvent,
  type Snapshot,
} from "@space-arena/shared";

const log = createLogger("GameSession");

/** Hull flown when the caller names none (or names one this pack does not have). */
const DEFAULT_PLAYER_SHIP = "ship.interceptor";

/** The requested hull if this pack actually has it, else the stock one. */
function resolvePlayerShipId(configs: ConfigService, requested: string | null | undefined): string {
  if (requested && configs.get<ShipConfig>("ship", requested)) return requested;
  if (requested) log.warn(`unknown ship ${requested}; flying ${DEFAULT_PLAYER_SHIP}`);
  return DEFAULT_PLAYER_SHIP;
}

/**
 * The requested fitting, sanitised against `ship`'s sockets: an entry is kept
 * only where the hull HAS that hardpoint and the hardpoint accepts the module's
 * family. Anything else becomes an empty slot rather than a spawn-time throw —
 * a stale loadout in localStorage must never block a match. An entirely empty
 * (or absent) request falls back to the hull's `defaultFitting`, since a ship
 * with no modules at all is not a playable state.
 */
function resolvePlayerFitting(
  configs: ConfigService,
  ship: ShipConfig,
  requested: readonly (string | null)[] | null | undefined,
): readonly (string | null)[] {
  if (!requested?.length) return ship.defaultFitting;
  const hardpoints = hardpointsOf(ship);
  const fitting = requested.slice(0, hardpoints.length).map((moduleId, index) => {
    if (!moduleId) return null;
    const family = configs.get<ModuleConfig>("module", moduleId)?.family;
    if (!family) return null;
    return hardpoints[index]?.accepts.includes(family) ? moduleId : null;
  });
  if (fitting.every((m) => m === null)) return ship.defaultFitting;
  return fitting;
}

/**
 * Owns an authoritative {@link ArenaSimulation} for single-player practice mode.
 *
 * The client is a thin shell over the shared sim: it feeds fixed ticks in from
 * the render-loop {@link import("@space-arena/shared").GameLoop} and exposes the
 * two most recent snapshots (for render interpolation) plus the events drained
 * this frame (for the render/HUD layer). It never re-implements game logic.
 *
 * Interpolation contract: {@link tick} is called once per fixed sim step. On each
 * step the previous snapshot is retired to `prevSnapshot` and a fresh one becomes
 * `curSnapshot`. Frames that run zero ticks leave both untouched while the loop's
 * `alpha` advances, so the renderer always has a stable [prev, cur] pair to lerp
 * between. Events accumulate across all ticks in a frame and are drained once.
 */
/** Additive practice options (Phase 5 5.1 integration B). */
export interface GameSessionOptions {
  /** Local pilot handle for loading/MVP presentation (online names replicate). */
  playerDisplayName?: string;
  /**
   * Bot wiring. `undefined` (default) ⇒ spawn the gamemode config's
   * `bots.roster`, if it declares one. `null` ⇒ never spawn bots (used by
   * {@link import("../net/NetGameSession.js").NetGameSession}, whose ships all
   * come from server state).
   */
  bots?: null;
  /**
   * Override for bot decision randomness. Omitted ⇒ each bot gets its own
   * stream derived from the session seed + its entity id, which is already
   * deterministic — this exists so a test can pin a specific sequence.
   */
  botRng?: () => number;
  /**
   * The hull the PLAYER flies (owner 2026-07-31 — the Hangar's choice reaches
   * offline practice too). Unknown or unfittable ids fall back to the default
   * hull rather than throwing on the way into a match.
   */
  playerShipId?: string | null;
  /**
   * The player's fitting as a POSITIONAL module-id array (index = hardpoint
   * index, `null` = empty) — the Hangar's working loadout. Omitted, empty or
   * invalid ⇒ the hull's `defaultFitting`.
   */
  playerFitting?: readonly (string | null)[] | null;
  /**
   * The paint the PLAYER flies in (`cosmetic.*`), from the Shop's per-hull
   * selection. Omitted/unknown/inapplicable ⇒ the hull's authored look; the sim
   * gates it at the spawn seam, so nothing here has to pre-validate it.
   */
  playerCosmeticId?: string | null;
}

export class GameSession {
  readonly sim: ArenaSimulation;
  readonly matchStats: MatchStatsAccumulator;
  readonly playerId: EntityId;
  /**
   * Bot drivers by ship entity id (5.1). Public so a debug overlay (5.3) can read
   * `driver.lastDecision` — behaviour, utility scores, chosen move point.
   */
  readonly bots = new Map<EntityId, BotDriver>();
  private readonly playerDisplayName: string;
  /**
   * Player-like display name per bot entity (owner 2026-07-31). Deterministic
   * from the session seed, so a replay fields the same roster.
   */
  readonly botNames = new Map<EntityId, string>();

  private prev: Snapshot;
  private cur: Snapshot;
  private readonly frameEvents: SimEvent[] = [];
  private readonly shipConfigIds = new Map<EntityId, string>();
  private elapsedMs = 0;

  constructor(
    private readonly configs: ConfigService,
    arenaId = "arena.ring-nebula",
    gamemodeId = "gamemode.practice-bots-1v1",
    seed = 1,
    options: GameSessionOptions = {},
  ) {
    this.playerDisplayName = options.playerDisplayName?.trim() || "Pilot";
    this.sim = new ArenaSimulation(configs, arenaId, gamemodeId, seed);
    this.matchStats = new MatchStatsAccumulator((id) => this.sim.teamOf(id));

    // The Hangar's ship/fitting when the caller passes one, else the stock
    // interceptor on its default fitting.
    const shipId = resolvePlayerShipId(configs, options.playerShipId);
    const ship = configs.get<ShipConfig>("ship", shipId);
    if (!ship) throw new Error(`GameSession: unknown ship ${shipId}`);
    const fitting = resolvePlayerFitting(configs, ship, options.playerFitting);

    // Player: team 0 at its spawn point.
    this.playerId = this.sim.spawnPlayer(shipId, fitting, 0, undefined, options.playerCosmeticId ?? null);
    this.shipConfigIds.set(this.playerId, shipId);

    // Bots are spawned from the gamemode config's `bots.roster` unless the
    // caller opts out.
    const gamemode = this.sim.world.gamemode;
    const roster = options.bots === null ? [] : resolveBotRoster(gamemode, configs);
    // One stream for every roster decision, derived from the session seed: same
    // seed ⇒ same hulls, same fittings, same names.
    const rosterRng = deriveRng(seed, 0xb0715);
    const names = generateBotNames(rosterRng, roster.length);
    const randomize = gamemode.bots?.randomizeLoadouts === true;
    for (const [rosterIndex, slot] of roster.entries()) {
      const shipId = randomize && !slot.fitting
        ? pickBotShip(configs, rosterRng, slot.shipId, gamemode.bots?.shipPool)
        : slot.shipId;
      const botShip = configs.get<ShipConfig>("ship", shipId);
      if (!botShip) continue;
      // Match the authoritative ArenaRoom seam: adaptive random rolls compare
      // against the player's resolved, socket-legal fitting. Keeping this as an
      // optional final argument preserves the authored-archetype fallback when
      // no player fitting exists (and fixed roster fittings remain untouched).
      const botFitting = slot.fitting ?? (randomize
        ? randomBotFitting(configs, shipId, rosterRng, slot.profile, fitting)
        : botShip.defaultFitting);
      // Bots wear a free universal paint, keyed off the session seed + roster
      // slot rather than drawn from `rosterRng`: dressing them must not shift
      // the stream that picks their hulls and fittings.
      const id = this.sim.spawnPlayer(
        shipId,
        botFitting,
        slot.team,
        undefined,
        botCosmeticFor(configs, seed, rosterIndex),
      );
      this.shipConfigIds.set(id, shipId);
      this.botNames.set(id, names[rosterIndex] ?? `Bot ${rosterIndex + 1}`);
      // Seeded from the SESSION seed + the bot's entity id, so a practice match
      // replayed on the same seed produces the same opponents rather than a
      // fresh `Math.random` roll of orbit signs and decision jitter.
      // `options.botRng` still wins, for tests that want a specific stream.
      this.bots.set(
        id,
        new BotDriver({
          entityId: id,
          profile: slot.profile,
          configs,
          rng: options.botRng ?? deriveRng(seed, id),
          arenaBounds: this.sim.world.arena.bounds,
          floorY: this.sim.world.arena.bounds.shape === "sphere" ? this.sim.world.arena.bounds.floorY : undefined,
          visualRadius: botShip.render.modelScale,
        }),
      );
    }

    this.prev = this.sim.snapshot();
    this.cur = this.prev;

    log.info("practice session ready", {
      arena: arenaId,
      gamemode: gamemodeId,
      playerId: this.playerId,
      botIds: [...this.bots.keys()],
    });
  }

  /** Advance one fixed sim step. Retires the current snapshot and drains events. */
  tick(fixedDt: number): void {
    this.driveBots(fixedDt);
    this.sim.tick(fixedDt);
    this.prev = this.cur;
    this.cur = this.sim.snapshot();
    const evs = this.sim.getEvents();
    this.matchStats.consume(evs, this.cur.elapsed);
    for (let i = 0; i < evs.length; i++) {
      const ev = evs[i]!;
      this.frameEvents.push(ev);
    }
  }

  /**
   * Feed every live bot the current snapshot and push its orders through the
   * normal order queue — the exact path a human tap takes. A DEAD bot is not
   * dropped any more: respawn modes rebuild the ship under the same entity id
   * (`ArenaSimulation.processRespawns`), so the driver just goes quiet while the
   * ship is gone — with its memory reset once, so calibration and cadence start
   * fresh on the new hull — and resumes when the id comes back.
   */
  private driveBots(fixedDt: number): void {
    if (this.bots.size === 0) return;
    this.elapsedMs += fixedDt * 1000;
    for (const [entityId, driver] of this.bots) {
      if (!this.sim.hasShip(entityId)) {
        driver.reset();
        continue;
      }
      for (const order of driver.update(this.cur, this.elapsedMs)) {
        this.sim.applyOrder(entityId, order);
      }
    }
  }

  /**
   * The arena this session actually resolved (gamemode `defaultArena` / join
   * option / explicit id). THE single source of truth for every client consumer
   * that has to agree with the sim about the arena — scene build, camera pan
   * clamp, minimap bounds (FLIGHT.md §6). Never hardcode an arena id against it.
   */
  get arenaId(): string {
    return this.sim.world.arena.id;
  }

  applyOrder(entityId: EntityId, order: Order): void {
    this.sim.applyOrder(entityId, order);
  }

  /** Convenience: issue an order for the local player ship. */
  order(order: Order): void {
    this.sim.applyOrder(this.playerId, order);
  }

  /** Ship-config id backing a sim entity, so the view layer can pick its recipe. */
  shipConfigIdFor(id: EntityId): string | undefined {
    return this.shipConfigIds.get(id);
  }

  /** Online sessions override this with names replicated by ArenaState. */
  displayNameFor(id: EntityId): string | undefined {
    return id === this.playerId ? this.playerDisplayName : this.botNames.get(id);
  }

  /** Team of a sim ship in the latest snapshot (for enemy checks). */
  teamOf(id: EntityId): number | undefined {
    // Indexed scan, no predicate closure: `playerTeam` reads this from render
    // and input paths that run every frame.
    const ships = this.cur.ships;
    for (let i = 0; i < ships.length; i++) if (ships[i]!.id === id) return ships[i]!.team;
    return undefined;
  }

  get playerTeam(): number {
    return this.teamOf(this.playerId) ?? 0;
  }

  get prevSnapshot(): Snapshot {
    return this.prev;
  }

  get curSnapshot(): Snapshot {
    return this.cur;
  }

  get isEnded(): boolean {
    return this.sim.isEnded;
  }

  /**
   * Events produced since the last drain. The returned array is reused every
   * frame — consume it immediately, do not retain it. Cleared after each call.
   */
  drainFrameEvents(): readonly SimEvent[] {
    return this.frameEvents;
  }

  /** Clears the frame event buffer (call after the render layer has consumed it). */
  clearFrameEvents(): void {
    this.frameEvents.length = 0;
  }
}
