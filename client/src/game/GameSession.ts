import {
  ArenaSimulation,
  createLogger,
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
/** Spread positions for practice dummies, within the interceptor's weapon range of the player spawn. */
const DUMMY_POSITIONS = [
  { x: 20, z: 20 },
  { x: 30, z: 4 },
  { x: 6, z: 30 },
];

export class GameSession {
  readonly sim: ArenaSimulation;
  readonly playerId: EntityId;
  /** First spawned dummy id, kept for back-compat with any single-target callers. */
  readonly dummyId: EntityId;
  /** All practice-dummy entity ids (one per `winCondition.count` for `destroyTargets`). */
  readonly dummyIds: EntityId[] = [];

  private prev: Snapshot;
  private cur: Snapshot;
  private readonly frameEvents: SimEvent[] = [];
  private readonly shipConfigIds = new Map<EntityId, string>();
  private readonly dummyIdSet: Set<EntityId>;
  private destroyedTargetsCount = 0;

  constructor(
    private readonly configs: ConfigService,
    arenaId = "arena.ring-nebula",
    gamemodeId = "gamemode.practice",
    seed = 1,
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
    const wc = this.sim.world.gamemode.winCondition;
    const dummyCount = wc.type === "destroyTargets" ? wc.count : 1;
    for (let i = 0; i < dummyCount; i++) {
      const pos = DUMMY_POSITIONS[i % DUMMY_POSITIONS.length]!;
      const id = this.sim.spawnPlayerAt(shipId, fitting, 1, pos, Math.PI);
      this.shipConfigIds.set(id, shipId);
      this.dummyIds.push(id);
    }
    this.dummyId = this.dummyIds[0]!;
    this.dummyIdSet = new Set(this.dummyIds);

    this.prev = this.sim.snapshot();
    this.cur = this.prev;

    log.info("practice session ready", {
      arena: arenaId,
      gamemode: gamemodeId,
      playerId: this.playerId,
      dummyIds: this.dummyIds,
    });
  }

  /** Advance one fixed sim step. Retires the current snapshot and drains events. */
  tick(fixedDt: number): void {
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
    return this.cur.ships.find((s) => s.id === id)?.team;
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
