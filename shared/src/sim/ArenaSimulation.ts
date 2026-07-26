import type { ConfigService } from "../core/ConfigService.js";
import type { ArenaConfig, GamemodeConfig, TuningConfig } from "../schemas/index.js";
import type { EntityId, ModuleState, ShipCore, TargetRef } from "./components.js";
import type { SimEvent } from "./events.js";
import type { Order } from "./orders.js";
import { clamp } from "./math.js";
import type { UpgradeLevels } from "./resolveStats.js";
import { spawnAsteroid, spawnShipFromConfig } from "./spawn.js";
import { collisionSystem } from "./systems/CollisionSystem.js";
import { cleanupSystem } from "./systems/CleanupSystem.js";
import { combatSystem } from "./systems/CombatSystem.js";
import { energySystem } from "./systems/EnergySystem.js";
import { moduleSystem } from "./systems/ModuleSystem.js";
import { navigationSystem } from "./systems/NavigationSystem.js";
import { projectileSystem } from "./systems/ProjectileSystem.js";
import { targetingSystem } from "./systems/TargetingSystem.js";
import { World } from "./World.js";

export interface ModuleSnapshot {
  moduleId: string;
  /** Hardpoint index this module occupies (stable; toggle addresses by this). */
  hardpointIndex: number;
  state: ModuleState;
  heat: number;
  stateTimer: number;
  cycleTimer: number;
  /** Shield-family absorb reservoir (0 for non-shield modules); see ModuleRuntime. */
  shieldPool: number;
}

export interface ShipSnapshot {
  id: EntityId;
  team: number;
  /** Bubble position; `y` is the vertical axis (BUBBLE.md §A). */
  pos: { x: number; y: number; z: number };
  heading: number;
  /** Nose elevation in radians, positive climbing. */
  pitch: number;
  hull: number;
  hullMax: number;
  energy: { cur: number; max: number };
  heat: { cur: number; capacity: number };
  targetId: EntityId | null;
  /**
   * Commanded throttle 0..1 — the ship's actual FlightState value, 0 when it has
   * none (unordered or move-order driven). Client signals read this instead of
   * inferring engine output from per-snapshot displacement.
   */
  throttle: number;
  /**
   * Lock progress on `targetId`, normalized 0..1 of the ship's resolved
   * `sensors.lockTimeSec` (FLIGHT.md §2) — the reticle ring reads this directly
   * so the HUD never needs the ship's stat block.
   */
  lockProgress: number;
  /** True while the lock is complete; weapons only fire in this state. */
  locked: boolean;
  modules: ModuleSnapshot[];
}

export interface AsteroidSnapshot {
  id: EntityId;
  configId: string;
  pos: { x: number; y: number; z: number };
  radius: number;
  state: string;
}

export interface ProjectileSnapshot {
  id: EntityId;
  kind: "kinetic" | "missile";
  pos: { x: number; y: number; z: number };
  heading: number;
  /** Authoritative 3D travel vector; omitted by remote wire snapshots. */
  velocity?: { x: number; y: number; z: number };
}

export interface Snapshot {
  tick: number;
  elapsed: number;
  phase: "live" | "ended";
  winnerTeam: number | null;
  ships: ShipSnapshot[];
  asteroids: AsteroidSnapshot[];
  projectiles: ProjectileSnapshot[];
}

/**
 * Facade wrapping a {@link World} and the fixed system pipeline. Built from arena
 * + gamemode configs; identical on client and server. Deterministic given the
 * same seed + order stream + dt sequence.
 *
 * System run order (documented, order matters):
 *   1. NavigationSystem  — apply move/flight orders, steer/avoid, boost
 *   2. ModuleSystem      — toggle orders + deploy/retract/overheat-cooldown timers
 *   3. TargetingSystem   — resolve TargetRef + advance/drain the sensor lock
 *   4. CombatSystem      — auto-fire beams/kinetics/missiles (lock+range+LoS+energy)
 *   5. EnergySystem      — regen/drain/brown-out; heat gen/overheat/dissipation/critical
 *   6. ProjectileSystem  — move/home/expire/hit
 *   7. CollisionSystem   — ship-asteroid, ship-ship, boundary
 *   8. CleanupSystem     — remove destroyed ships
 */
export class ArenaSimulation {
  readonly world: World;
  private elapsed = 0;
  private tickNo = 0;
  private phase: "live" | "ended" = "live";
  private winnerTeam: number | null = null;
  private readonly teamScores = new Map<number, number>();
  private readonly teamsEverPresent = new Set<number>();
  private destroyedShips = 0;

  constructor(
    private readonly configs: ConfigService,
    arenaId: string,
    gamemodeId: string,
    seed = 1,
  ) {
    const arena = configs.get<ArenaConfig>("arena", arenaId);
    if (!arena) throw new Error(`unknown arena: ${arenaId}`);
    const gamemode = configs.get<GamemodeConfig>("gamemode", gamemodeId);
    if (!gamemode) throw new Error(`unknown gamemode: ${gamemodeId}`);
    const tuning = configs.getAll<TuningConfig>("tuning")[0];
    if (!tuning) throw new Error("no tuning config loaded");

    this.world = new World(configs, tuning, arena, gamemode, seed);

    for (const p of arena.asteroidPlacements) {
      spawnAsteroid(this.world, configs, p.asteroidId, p.position, p.scale ?? 1);
    }
  }

  /**
   * Spawn a ship for `team` at the next free spawn point for that team.
   * `upgradeLevels` (optional, additive) are the player's DB upgrade purchase
   * counts, applied by the stat resolver; omitted ⇒ base stats.
   */
  spawnPlayer(
    shipId: string,
    fitting: readonly (string | null)[],
    team: number,
    upgradeLevels?: UpgradeLevels,
  ): EntityId {
    const spawns = this.world.arena.spawnPoints.filter((s) => s.team === team);
    const used = this.world.shipIds().length;
    const sp = spawns[used % Math.max(1, spawns.length)] ?? this.world.arena.spawnPoints[0]!;
    this.teamsEverPresent.add(team);
    return spawnShipFromConfig(
      this.world,
      this.configs,
      shipId,
      fitting,
      team,
      sp.position,
      sp.heading,
      upgradeLevels,
      sp.pitch ?? 0,
    );
  }

  /**
   * Spawn a ship at an explicit position (used by tests/practice placement).
   * `pos.y` and `pitch` default to the old ground-plane, level values.
   */
  spawnPlayerAt(
    shipId: string,
    fitting: readonly (string | null)[],
    team: number,
    pos: { x: number; y?: number; z: number },
    heading = 0,
    upgradeLevels?: UpgradeLevels,
    pitch = 0,
  ): EntityId {
    this.teamsEverPresent.add(team);
    return spawnShipFromConfig(this.world, this.configs, shipId, fitting, team, pos, heading, upgradeLevels, pitch);
  }

  applyOrder(entityId: EntityId, order: Order): void {
    this.world.queueOrder(entityId, order);
  }

  /**
   * Remove a ship from the sim (e.g. a player disconnecting for good). Silently
   * no-ops if the id is not a live ship. Additive helper for the netcode layer;
   * does not emit destruction events (this is a leave, not a kill).
   */
  removeShip(entityId: EntityId): void {
    if (!this.world.shipCores.has(entityId)) return;
    this.world.destroyEntity(entityId);
  }

  /** Whether an entity id is a live ship in this sim. */
  hasShip(entityId: EntityId): boolean {
    return this.world.shipCores.has(entityId);
  }

  /** Team of a live ship, or undefined. */
  teamOf(entityId: EntityId): number | undefined {
    return this.world.teams.get(entityId)?.team;
  }

  /** Advance one fixed sim step. */
  tick(dt: number): void {
    if (this.phase === "ended") return;
    const w = this.world;

    // Per-tick reset.
    w.losCache.clear();
    for (const id of w.shipIds()) {
      const mods = w.modules.get(id);
      if (!mods) continue;
      for (const m of mods.modules) {
        m.workedThisTick = false;
      }
    }

    // Rebuild broadphase (ships + asteroids) from current positions.
    w.spatial.clear();
    for (const id of w.asteroidIds()) {
      const t = w.transforms.get(id)!;
      const c = w.colliders.get(id)!;
      if (w.asteroids.get(id)!.state !== "destroyed") w.spatial.insert(id, t.pos.x, t.pos.z, c.radius);
    }
    for (const id of w.shipIds()) {
      const t = w.transforms.get(id)!;
      const c = w.colliders.get(id)!;
      w.spatial.insert(id, t.pos.x, t.pos.z, c.radius);
    }

    navigationSystem(w, dt);
    moduleSystem(w, dt);
    targetingSystem(w, dt);
    combatSystem(w, dt);
    energySystem(w, dt);
    projectileSystem(w, dt);
    collisionSystem(w, dt);
    cleanupSystem(w);

    this.elapsed += dt;
    this.tickNo += 1;
    this.evaluateWinCondition();
  }

  private evaluateWinCondition(): void {
    // Tally destructions produced this tick (events not yet drained).
    for (const ev of this.world.events) {
      if (ev.type === "entityDestroyed" && !ev.isAsteroid) {
        this.destroyedShips += 1;
        if (ev.killerId !== null) {
          const kt = this.world.teams.get(ev.killerId)?.team;
          if (kt !== undefined) this.teamScores.set(kt, (this.teamScores.get(kt) ?? 0) + 1);
        }
      }
    }
    if (this.phase === "ended") return;

    const wc = this.world.gamemode.winCondition;
    let ended = false;
    let winner: number | null = null;
    let reason: "winCondition" | "elimination" = "winCondition";

    if (wc.type === "destroyTargets") {
      if (this.destroyedShips >= wc.count) {
        ended = true;
        winner = this.topTeam();
      }
    } else if (wc.type === "fragLimit") {
      for (const [team, score] of this.teamScores) {
        if (score >= wc.count) {
          ended = true;
          winner = team;
          break;
        }
      }
    } else if (wc.type === "timeLimit") {
      if (this.elapsed >= wc.seconds) {
        ended = true;
        winner = this.topTeam();
      }
    }

    // Implicit elimination rule (default on): a fully-wiped team loses; the last
    // surviving team wins. This is what makes the *player* lose a practice match.
    if (!ended && this.world.gamemode.eliminationEndsMatch !== false) {
      const alive = new Set<number>();
      for (const id of this.world.shipIds()) alive.add(this.world.teams.get(id)!.team);
      let anyEliminated = false;
      for (const team of this.teamsEverPresent) {
        if (!alive.has(team)) anyEliminated = true;
      }
      if (anyEliminated) {
        ended = true;
        winner = alive.size === 1 ? [...alive][0]! : null;
        reason = "elimination";
      }
    }

    if (ended) {
      this.phase = "ended";
      this.winnerTeam = winner;
      this.world.emit({ type: "matchEnded", winnerTeam: winner, reason });
    }
  }

  private topTeam(): number | null {
    let best: number | null = null;
    let bestScore = -1;
    let tie = false;
    for (const [team, score] of this.teamScores) {
      if (score > bestScore) {
        bestScore = score;
        best = team;
        tie = false;
      } else if (score === bestScore) {
        tie = true;
      }
    }
    return tie ? null : best;
  }

  getEvents(): SimEvent[] {
    return this.world.drainEvents();
  }

  get isEnded(): boolean {
    return this.phase === "ended";
  }

  snapshot(): Snapshot {
    const w = this.world;
    const ships: ShipSnapshot[] = w.shipIds().map((id) => {
      const core = w.shipCores.get(id)!;
      const tf = w.transforms.get(id)!;
      const mods = w.modules.get(id)!;
      const ref = w.targets.get(id);
      return {
        id,
        team: w.teams.get(id)!.team,
        pos: { x: tf.pos.x, y: tf.pos.y, z: tf.pos.z },
        heading: tf.heading,
        pitch: tf.pitch,
        hull: core.hull,
        hullMax: core.hullMax,
        energy: { cur: core.capacitor.cur, max: core.capacitor.max },
        heat: { cur: core.heat.cur, capacity: core.heat.capacity },
        targetId: ref?.targetId ?? null,
        throttle: w.flightStates.get(id)?.throttle ?? 0,
        // Normalized against the ship's own resolved lock time, so a module that
        // shortens lockTimeSec still reads as a full ring at full lock. A resolved
        // lockTimeSec of 0 (a passive strong enough to zero it out) locks
        // instantly, so report the flag rather than dividing by zero.
        lockProgress: lockFraction(core, ref),
        locked: ref?.locked ?? false,
        modules: mods.modules.map((m) => ({
          moduleId: m.moduleId,
          hardpointIndex: m.hardpointIndex,
          state: m.state,
          heat: m.heat,
          stateTimer: m.stateTimer,
          cycleTimer: m.cycleTimer,
          shieldPool: m.shieldPool,
        })),
      };
    });
    const asteroids: AsteroidSnapshot[] = w.asteroidIds().map((id) => {
      const tf = w.transforms.get(id)!;
      const col = w.colliders.get(id)!;
      const tag = w.asteroids.get(id)!;
      return {
        id,
        configId: tag.configId,
        pos: { x: tf.pos.x, y: tf.pos.y, z: tf.pos.z },
        radius: col.radius,
        state: tag.state,
      };
    });
    const projectiles: ProjectileSnapshot[] = w.projectileIds().map((id) => {
      const tf = w.transforms.get(id)!;
      const velocity = w.velocities.get(id)!;
      return {
        id,
        kind: w.projectiles.get(id)!.kind,
        pos: { x: tf.pos.x, y: tf.pos.y, z: tf.pos.z },
        heading: tf.heading,
        velocity: { x: velocity.x, y: velocity.y, z: velocity.z },
      };
    });
    return {
      tick: this.tickNo,
      elapsed: this.elapsed,
      phase: this.phase,
      winnerTeam: this.winnerTeam,
      ships,
      asteroids,
      projectiles,
    };
  }
}

/** Lock progress as a 0..1 fraction of the ship's own resolved `lockTimeSec`. */
function lockFraction(core: ShipCore, ref: TargetRef | undefined): number {
  if (!ref) return 0;
  if (core.sensors.lockTimeSec <= 0) return ref.locked ? 1 : 0;
  return clamp(ref.lockProgress / core.sensors.lockTimeSec, 0, 1);
}
