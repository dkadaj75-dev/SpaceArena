import {
  ArenaSimulation,
  botCosmeticFor,
  MatchStatsAccumulator,
  BotDriver,
  createBotDriver,
  createLogger,
  deriveRng,
  facingVec,
  generateBotNames,
  hardpointsOf,
  mirrorAttitude,
  pickBotShip,
  randomBotFitting,
  resolveBackfillBot,
  resolveBotRoster,
  teamSizeOf,
  type BotprofileConfig,
  type ConfigService,
  type EntityId,
  type ModuleConfig,
  type Order,
  type ShipConfig,
  type ShipSnapshot,
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
   * Fill every open team slot with local bots after applying the authored
   * roster. Used by the no-server fallback so an online mode keeps the same
   * team size and rules on a static host. Omitted for normal authored practice;
   * `bots: null` still disables every bot.
   */
  fillBotTeams?: boolean;
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

/**
 * One ship placed into a RUNNING offline sim, on demand (owner 2026-08-08 —
 * the tutorial spawns its hulk and then its drone at the step that teaches
 * each, never both at once).
 *
 * Deliberately minimal, and deliberately offline-only: an online room's ships
 * all come from server state, so `NetGameSession` inherits this and must never
 * be handed one. The whole seam is "put a ship in front of the player":
 *
 *  - `profile` present ⇒ it gets a {@link BotDriver} and fights back;
 *  - `profile` absent  ⇒ it is an inert hulk. No driver means no orders, which
 *    means it never moves and never fires — that is the disarmed practice
 *    target, expressed as an absence rather than as a special ship class.
 */
export interface ScriptedSpawn {
  shipId: string;
  /** Positional fitting (index = hardpoint index). Omitted ⇒ nothing fitted at all. */
  fitting?: readonly (string | null)[];
  team?: number;
  /** Placed this many world units along the player's current nose. */
  aheadDistance?: number;
  /**
   * Hull to start at, clamped to the hull it resolved. A tutorial target has to
   * die inside a lesson, and the shipped hulls are balanced for a 8–45 s duel.
   */
  hull?: number;
  /** Bot profile id. Omitted ⇒ inert. */
  profile?: string;
  /** Name for the reticle and the kill feed. */
  displayName?: string;
}

/** Where a scripted spawn goes when the player's ship is gone (or was never there). */
const SCRIPTED_FALLBACK_DISTANCE = 45;

// Scratch for {@link GameSession.spawnScripted} — a spawn is rare, but the
// module-scope convention here is that nothing in a session allocates vectors.
const scriptedFacing = { x: 0, y: 0, z: 0 };
const scriptedAttitude = { heading: 0, pitch: 0 };

export class GameSession {
  readonly sim: ArenaSimulation;
  readonly matchStats: MatchStatsAccumulator;
  readonly playerId: EntityId;
  /**
   * Bot drivers by ship entity id (5.1). Public so a debug overlay (5.3) can read
   * `driver.lastDecision` — behaviour, utility scores, chosen move point.
   */
  readonly bots = new Map<EntityId, BotDriver>();
  /** Shared terrain query object used by sim, bots, prediction, and debug LoS. */
  get botStaticWorld() { return this.sim.world.staticWorld; }
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
    private readonly seed = 1,
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
    if (options.bots !== null && options.fillBotTeams) {
      const fallback = resolveBackfillBot(gamemode, configs);
      if (fallback) {
        const teamSize = teamSizeOf(gamemode);
        const occupied = new Map<number, number>([[0, 1]]); // the local player is team 0
        for (const slot of roster) occupied.set(slot.team, (occupied.get(slot.team) ?? 0) + 1);
        for (let team = 0; team < 2; team++) {
          const authoredForTeam = roster.filter((slot) => slot.team === team);
          for (let i = occupied.get(team) ?? 0; i < teamSize; i++) {
            const template = authoredForTeam.length > 0 ? authoredForTeam[i % authoredForTeam.length] : undefined;
            roster.push({
              profile: template?.profile ?? fallback.profile,
              shipId: template?.shipId ?? fallback.shipId,
              team,
              ...(template?.fitting ? { fitting: template.fitting } : {}),
            });
          }
        }
      }
    }
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
      // Bots wear a paint authored for their hull, keyed off the session seed + roster
      // slot rather than drawn from `rosterRng`: dressing them must not shift
      // the stream that picks their hulls and fittings.
      const id = this.sim.spawnPlayer(
        shipId,
        botFitting,
        slot.team,
        undefined,
        botCosmeticFor(configs, shipId, seed, rosterIndex),
      );
      this.shipConfigIds.set(id, shipId);
      this.botNames.set(id, names[rosterIndex] ?? `Bot ${rosterIndex + 1}`);
      // Seeded from the SESSION seed + the bot's entity id, so a practice match
      // replayed on the same seed produces the same opponents rather than a
      // fresh `Math.random` roll of orbit signs and decision jitter.
      // `options.botRng` still wins, for tests that want a specific stream.
      this.bots.set(
        id,
        createBotDriver(this.sim.world, id, slot.profile, botShip, options.botRng ?? deriveRng(seed, id)),
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

  /**
   * Place one scripted ship in front of the player, mid-match (see
   * {@link ScriptedSpawn}). Returns its entity id, or `null` when there is no
   * live player ship to place it in front of.
   *
   * It goes on the player's NOSE, at `aheadDistance`, facing back at them: a
   * tutorial that told a new pilot to shoot something behind their own tail
   * would be teaching the wrong first lesson. Everything else — stat
   * resolution, cosmetics, snapshot replication, kill events — is the ordinary
   * spawn path, so the rest of the client cannot tell a scripted ship from a
   * roster one.
   */
  spawnScripted(spawn: ScriptedSpawn): EntityId | null {
    const ship = this.configs.get<ShipConfig>("ship", spawn.shipId);
    if (!ship) {
      log.warn(`scripted spawn: unknown ship ${spawn.shipId}`);
      return null;
    }
    const self = this.shipSnapshot(this.playerId);
    const distance = spawn.aheadDistance ?? SCRIPTED_FALLBACK_DISTANCE;
    facingVec(self?.heading ?? 0, self?.pitch ?? 0, scriptedFacing);
    const origin = self?.pos ?? { x: 0, y: 0, z: 0 };
    const pos = {
      x: origin.x + scriptedFacing.x * distance,
      y: origin.y + scriptedFacing.y * distance,
      z: origin.z + scriptedFacing.z * distance,
    };
    // Nose to nose: heading is the player's, mirrored; pitch mirrored with it.
    mirrorAttitude(self?.heading ?? 0, self?.pitch ?? 0, scriptedAttitude);
    const fitting = spawn.fitting ?? [];
    const team = spawn.team ?? 1;
    const id = this.sim.spawnPlayerAt(
      spawn.shipId,
      fitting,
      team,
      pos,
      scriptedAttitude.heading,
      undefined,
      scriptedAttitude.pitch,
      null,
    );
    this.shipConfigIds.set(id, spawn.shipId);
    if (spawn.displayName) this.botNames.set(id, spawn.displayName);
    if (spawn.hull !== undefined) {
      const core = this.sim.world.shipCores.get(id);
      // A pre-wrecked hulk, not a weaker hull class: `hullMax` is untouched, so
      // the damage bars and the death path read exactly as they always do.
      if (core) core.hull = Math.min(spawn.hull, core.hullMax);
    }
    const profile = spawn.profile
      ? this.configs.get<BotprofileConfig>("botprofile", spawn.profile)
      : undefined;
    if (spawn.profile && !profile) log.warn(`scripted spawn: unknown bot profile ${spawn.profile}`);
    if (profile) {
      this.bots.set(id, createBotDriver(this.sim.world, id, profile, ship, deriveRng(this.seed, id)));
    }
    // The freshly spawned ship must exist in the snapshot the very next frame
    // reads, not one tick later — the director highlights it immediately.
    this.cur = this.sim.snapshot();
    log.info("scripted spawn", { id, ship: spawn.shipId, driven: Boolean(spawn.profile) });
    return id;
  }

  /** Indexed scan for a ship in the latest snapshot. */
  private shipSnapshot(id: EntityId): ShipSnapshot | undefined {
    const ships = this.cur.ships;
    for (let i = 0; i < ships.length; i++) if (ships[i]!.id === id) return ships[i];
    return undefined;
  }

  /** Ship-config id backing a sim entity, so the view layer can pick its recipe. */
  shipConfigIdFor(id: EntityId): string | undefined {
    return this.shipConfigIds.get(id);
  }

  /** Online sessions override this with names replicated by ArenaState. */
  displayNameFor(id: EntityId): string | undefined {
    return id === this.playerId ? this.playerDisplayName : this.botNames.get(id);
  }

  /** Whether an entity is server/local AI; online sessions override from schema. */
  isBotFor(id: EntityId): boolean {
    return this.bots.has(id);
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

  /**
   * The newest AUTHORITATIVE state, for consumers that run before a match
   * runtime exists (the launch screen's team rosters). Offline that is simply
   * the current snapshot; an online session overrides it, because nothing ticks
   * its interpolator until the match is activated and `curSnapshot` would still
   * be the very first patch (see NetGameSession).
   */
  get rosterSnapshot(): Snapshot {
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
