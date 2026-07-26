import {
  ArenaSimulation,
  BotDriver,
  createLogger,
  deriveRng,
  resolveBotRoster,
  type ConfigService,
  type EntityId,
  type Order,
  type ShipConfig,
  type SimEvent,
  type Snapshot,
} from "@space-arena/shared";

const log = createLogger("GameSession");

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
/**
 * Practice-dummy placement, expressed in the PLAYER'S SPAWN FRAME: `ahead` is
 * along the spawn's 3D facing (heading AND pitch, BUBBLE.md §C), `abeam` is to
 * its left. Resolved against whatever spawn point the arena actually handed the
 * player, so the dummies land in the sensor cone at lock range on any arena — an
 * absolute position only worked while every arena was ring-nebula-sized
 * (FLIGHT.md §6 makes the practice default a radius-300 field), and a planar
 * frame would only work while every spawn sat on y = 0.
 */
const DUMMY_OFFSETS = [
  { ahead: 30, abeam: 0 },
  { ahead: 34, abeam: 12 },
  { ahead: 34, abeam: -12 },
];

/** Additive practice options (Phase 5 5.1 integration B). */
export interface GameSessionOptions {
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
}

export class GameSession {
  readonly sim: ArenaSimulation;
  readonly playerId: EntityId;
  /**
   * First spawned dummy id, kept for back-compat with any single-target callers.
   * `undefined` in a bots-roster mode, which spawns no static dummies.
   */
  readonly dummyId: EntityId | undefined;
  /** All practice-dummy entity ids (one per `winCondition.count` for `destroyTargets`). */
  readonly dummyIds: EntityId[] = [];
  /**
   * Bot drivers by ship entity id (5.1). Public so a debug overlay (5.3) can read
   * `driver.lastDecision` — behaviour, utility scores, chosen move point.
   */
  readonly bots = new Map<EntityId, BotDriver>();

  private prev: Snapshot;
  private cur: Snapshot;
  private readonly frameEvents: SimEvent[] = [];
  private readonly shipConfigIds = new Map<EntityId, string>();
  /** Ships that count toward the "Targets: x/y" objective (dummies and/or bots). */
  private readonly dummyIdSet: Set<EntityId>;
  private destroyedTargetsCount = 0;
  private elapsedMs = 0;

  constructor(
    private readonly configs: ConfigService,
    arenaId = "arena.ring-nebula",
    gamemodeId = "gamemode.practice",
    seed = 1,
    options: GameSessionOptions = {},
  ) {
    this.sim = new ArenaSimulation(configs, arenaId, gamemodeId, seed);

    const shipId = "ship.interceptor";
    const ship = configs.get<ShipConfig>("ship", shipId);
    if (!ship) throw new Error(`GameSession: unknown ship ${shipId}`);
    const fitting = ship.defaultFitting;

    // Player: team 0 at its spawn point.
    this.playerId = this.sim.spawnPlayer(shipId, fitting, 0);
    this.shipConfigIds.set(this.playerId, shipId);

    // Static dummy targets on team 1, placed within weapon range of the
    // player so combat is immediately testable. Receive no orders. Count
    // follows the gamemode's `destroyTargets` win condition (falls back to a
    // single dummy for other win-condition types).
    // Bots (5.1): spawned from the gamemode config's `bots.roster` unless the
    // caller opts out. A mode with a roster replaces the static dummies — the
    // existing dummy flow is untouched for modes without one.
    const gamemode = this.sim.world.gamemode;
    const roster = options.bots === null ? [] : resolveBotRoster(gamemode, configs);
    for (const slot of roster) {
      const botShip = configs.get<ShipConfig>("ship", slot.shipId);
      if (!botShip) continue;
      const id = this.sim.spawnPlayer(slot.shipId, botShip.defaultFitting, slot.team);
      this.shipConfigIds.set(id, slot.shipId);
      // Seeded from the SESSION seed + the bot's entity id, so a practice match
      // replayed on the same seed produces the same opponents rather than a
      // fresh `Math.random` roll of orbit signs and decision jitter.
      // `options.botRng` still wins, for tests that want a specific stream.
      this.bots.set(
        id,
        new BotDriver({ entityId: id, profile: slot.profile, configs, rng: options.botRng ?? deriveRng(seed, id) }),
      );
    }

    const wc = this.sim.world.gamemode.winCondition;
    const dummyCount = roster.length > 0 ? 0 : wc.type === "destroyTargets" ? wc.count : 1;
    // Read the spawn the sim actually gave the player and lay the dummies out
    // relative to it (see DUMMY_OFFSETS). They face the same way the player
    // does, so the player starts behind them and outside THEIR sensor cone —
    // targeting is automatic now, and a dummy that opens fire is not a dummy.
    const spawn = this.sim.world.transforms.get(this.playerId)!;
    const cos = Math.cos(spawn.heading);
    const sin = Math.sin(spawn.heading);
    // `ahead` follows the nose in 3D; `abeam` stays horizontal, which keeps the
    // trio on one level instead of tilting the whole firing line with the spawn.
    const cosPitch = Math.cos(spawn.pitch);
    const sinPitch = Math.sin(spawn.pitch);
    for (let i = 0; i < dummyCount; i++) {
      const off = DUMMY_OFFSETS[i % DUMMY_OFFSETS.length]!;
      const pos = {
        x: spawn.pos.x + cos * cosPitch * off.ahead - sin * off.abeam,
        y: spawn.pos.y + sinPitch * off.ahead,
        z: spawn.pos.z + sin * cosPitch * off.ahead + cos * off.abeam,
      };
      const id = this.sim.spawnPlayerAt(shipId, fitting, 1, pos, spawn.heading);
      this.shipConfigIds.set(id, shipId);
      this.dummyIds.push(id);
    }
    this.dummyId = this.dummyIds[0];
    this.dummyIdSet = new Set([...this.dummyIds, ...this.bots.keys()]);

    this.prev = this.sim.snapshot();
    this.cur = this.prev;

    log.info("practice session ready", {
      arena: arenaId,
      gamemode: gamemodeId,
      playerId: this.playerId,
      dummyIds: this.dummyIds,
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
    for (let i = 0; i < evs.length; i++) {
      const ev = evs[i]!;
      if (ev.type === "entityDestroyed" && !ev.isAsteroid && this.dummyIdSet.has(ev.entityId)) {
        this.destroyedTargetsCount += 1;
      }
      this.frameEvents.push(ev);
    }
  }

  /**
   * Feed every live bot the current snapshot and push its orders through the
   * normal order queue — the exact path a human tap takes. Dead bots are
   * dropped. Called before the sim step so orders land on this tick.
   */
  private driveBots(fixedDt: number): void {
    if (this.bots.size === 0) return;
    this.elapsedMs += fixedDt * 1000;
    for (const [entityId, driver] of this.bots) {
      if (!this.sim.hasShip(entityId)) {
        this.bots.delete(entityId);
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

  /** Practice-mode dummies destroyed so far (drives the "Targets: x/y" HUD line). */
  get destroyedTargets(): number {
    return this.destroyedTargetsCount;
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
