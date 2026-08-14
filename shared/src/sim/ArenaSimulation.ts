import type { ConfigService } from "../core/ConfigService.js";
import { resolveCosmeticFor } from "../content/cosmetics.js";
import type { ArenaConfig, GamemodeConfig, TuningConfig } from "../schemas/index.js";
import type { EntityId, FlagState, ModuleState, ShipCore, TargetRef } from "./components.js";
import type { SimEvent } from "./events.js";
import type { Order } from "./orders.js";
import { clamp } from "./math.js";
import { deriveRng } from "./rng.js";
import { matchCountdownSecOf } from "./tuningDefaults.js";
import type { UpgradeLevels } from "./resolveStats.js";
import { spawnAsteroid, spawnShipFromConfig } from "./spawn.js";
import { collisionSystem } from "./systems/CollisionSystem.js";
import { cleanupSystem } from "./systems/CleanupSystem.js";
import { ctfSystem, returnFlagHome, tryCapture } from "./systems/CtfSystem.js";
import { combatSystem, latchFireState } from "./systems/CombatSystem.js";
import { energySystem } from "./systems/EnergySystem.js";
import { jettisonSystem } from "./systems/JettisonSystem.js";
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
  /** Dynamic rounds remaining; 0 for weapons without a clip. */
  rounds?: number;
  /**
   * This module's OWN heat (heat/energy overhaul 2026-08-07). The HUD's heat
   * ring is `heat / heatCapacity`; there is no ship heat pool to fall back on.
   */
  heat: number;
  /**
   * Resolved capacity of this module's heat store, already multiplied by the
   * hull. **0 means the module has no heat ring at all** — that is the signal a
   * renderer reads, not a special-case list of families.
   */
  heatCapacity: number;
  /** This module's OWN energy charge (boost tank, shield reserve, …). */
  energy: number;
  /**
   * Resolved capacity of this module's energy tank, already multiplied by the
   * hull. **0 means the module has no energy ring at all.**
   */
  energyCapacity: number;
  stateTimer: number;
  cycleTimer: number;
  /**
   * True while a `fire.mode: "continuous"` weapon is channelling. The client
   * draws its persistent beam from this flag alone — a channel emits one fire
   * event when it starts and none afterwards, so there is no per-shot event
   * stream to render from. Always false for `held`/`semi` modules.
   */
  channeling: boolean;
  /**
   * Shield absorb reservoir — the charge left in a MITIGATION module's tank, and
   * 0 for everything else. Redundant with {@link ModuleSnapshot.energy} by
   * construction (it is the same number for a shield), and kept as its own field
   * because the hull's shield arc and the ship visuals want "how much shielding
   * is up" without resolving each module's config to ask which tanks count.
   */
  shieldPool: number;
}

export interface ShipSnapshot {
  id: EntityId;
  team: number;
  /** Bubble position; `y` is the vertical axis (BUBBLE.md §A). */
  pos: { x: number; y: number; z: number };
  /** Authoritative collision radius used by navigation clearance. */
  colliderRadius?: number;
  heading: number;
  /** Nose elevation in radians, positive climbing. */
  pitch: number;
  /**
   * Authoritative ship-up axis (unit, ⊥ nose) — the roll degree of freedom the
   * two Euler coordinates cannot carry. Everything that renders or plans in the
   * ship's frame (hull pose, chase camera, radar, bots) must read THIS rather
   * than reconstructing an up from heading/pitch, which is exactly the lossy
   * step that produced the steep-pitch barrel roll.
   */
  up: { x: number; y: number; z: number };
  hull: number;
  hullMax: number;
  targetId: EntityId | null;
  /**
   * Commanded throttle 0..1 — the ship's actual FlightState value, 0 when it has
   * none (unordered or move-order driven). Client signals read this instead of
   * inferring engine output from per-snapshot displacement.
   */
  throttle: number;
  /** Authoritative velocity, used by predictive bot steering. */
  velocity?: { x: number; y: number; z: number };
  /** Resolved sensor range; exposes no information beyond normal lock rules. */
  sensorRange?: number;
  /**
   * Lock progress on `targetId`, normalized 0..1 of the ship's resolved
   * `sensors.lockTimeSec` (FLIGHT.md §2) — the reticle ring reads this directly
   * so the HUD never needs the ship's stat block.
   */
  lockProgress: number;
  /** True while the lock is complete; weapons only fire in this state. */
  locked: boolean;
  /**
   * Equipped paint (`cosmetic.*`), or ABSENT for the hull's authored look. The
   * renderer receives the target hull's base paint for absent or stale ids — the
   * standard paint exists so a shop selection is never undefined, not so it can
   * mean different pixels. Validated at the spawn seam (offline) and again by
   * the room (online); a snapshot never carries an id the pack does not have.
   */
  cosmeticId?: string;
  modules: ModuleSnapshot[];
}

export interface AsteroidSnapshot {
  id: EntityId;
  configId: string;
  pos: { x: number; y: number; z: number };
  radius: number;
  /** Authoritative collision radius; `radius` remains the drawn radius. */
  colliderRadius?: number;
  state: string;
}

/**
 * A drifting jettisoned heatsink (owner 2026-07-31). Replicated so remote
 * clients can render the lure and see why their missiles turned.
 */
export interface DecoySnapshot {
  id: EntityId;
  team: number;
  pos: { x: number; y: number; z: number };
  radius: number;
  /** Remaining life as a 0..1 fraction, for a burn-out fade. */
  lifeFraction: number;
}

/**
 * A capture-the-flag flag (owner 2026-07-31), with everything a HUD, a renderer
 * or a bot needs to play the objective: where it is, who has it, how long a
 * dropped one has left, and the wake behind it.
 */
export interface FlagSnapshot {
  id: EntityId;
  /** The team it BELONGS to (defends it), not the team holding it. */
  team: number;
  state: FlagState;
  carrierId: EntityId | null;
  pos: { x: number; y: number; z: number };
  /** Base position — where it returns to and where its owners score. */
  home: { x: number; y: number; z: number };
  baseRadius: number;
  /** Contact radius for taking or returning this flag. */
  pickupRadius?: number;
  /** Seconds left before a dropped flag returns itself; 0 when not dropped. */
  dropRemaining: number;
  /** Wake positions, oldest first. Empty while the flag is home. */
  trail: { x: number; y: number; z: number }[];
}

export interface ProjectileSnapshot {
  id: EntityId;
  kind: "kinetic" | "missile";
  pos: { x: number; y: number; z: number };
  heading: number;
  /** Authoritative 3D travel vector; omitted by remote wire snapshots. */
  velocity?: { x: number; y: number; z: number };
}

/**
 * Match phase. `countdown` is the frozen 3-2-1 lead-in every match opens with
 * (`tuning.matchCountdownSec`); `elapsed` only starts moving at `live`.
 */
export type MatchPhase = "waiting" | "countdown" | "live" | "ended";

/**
 * Slack on the countdown's zero test, in seconds. The fixed step is `1/30`, which
 * is not representable in binary, so subtracting it 90 times from 3 leaves a
 * few hundred attoseconds behind — enough to cost a 91st frozen tick and to leave
 * `countdownRemaining` at 4e-16 rather than 0 for a whole tick. Any threshold far
 * below one tick and far above the accumulated error does the job identically on
 * every machine (IEEE-754 doubles are deterministic), which is what matters:
 * every sim built from the same pack picks the same tick.
 */
const COUNTDOWN_EPSILON = 1e-9;

/** One team's running kill count (frag-limit scoreboards; draws stay visible). */
export interface TeamScore {
  team: number;
  kills: number;
  /**
   * Flag captures (owner 2026-07-31). Always present, always 0 outside a
   * capture-the-flag mode — a scoreboard that has to ask "is this CTF?" before
   * reading a number is a scoreboard that will read the wrong one.
   */
  captures: number;
}

export interface Snapshot {
  tick: number;
  elapsed: number;
  phase: MatchPhase;
  /**
   * Kill count per team that has ever fielded a ship, ascending by team id.
   * Kills credit the KILLER's team (`entityDestroyed.killerId`); environment
   * deaths (asteroids, boundary) credit nobody. Drives the top-of-screen
   * team scoreboard and the `fragLimit` win condition alike.
   */
  teamScores: TeamScore[];
  /**
   * Seconds left on the start countdown, `0` once the match is live. Display
   * with `Math.ceil` — the sim emits a `countdownTick` event on each whole-second
   * boundary so a HUD never has to detect the edge itself.
   */
  countdownRemaining: number;
  /** Online room lobby wait; absent from the standalone simulation. */
  lobbyRemainingSec?: number;
  winnerTeam: number | null;
  ships: ShipSnapshot[];
  asteroids: AsteroidSnapshot[];
  projectiles: ProjectileSnapshot[];
  decoys: DecoySnapshot[];
  /** Capture-the-flag flags; empty in every other mode. */
  flags: FlagSnapshot[];
}

/**
 * Facade wrapping a {@link World} and the fixed system pipeline. Built from arena
 * + gamemode configs; identical on client and server. Deterministic given the
 * same seed + order stream + dt sequence.
 *
 * ## Start countdown (`tuning.matchCountdownSec`)
 *
 * A match opens in the `countdown` phase and only reaches `live` once the timer
 * has been ticked down IN SIM TIME. The mechanic is deliberately "suspend the
 * integration", not "reject the orders":
 *
 *  - `NavigationSystem` and `ModuleSystem` still run, but with **dt = 0**, so a
 *    flight order is drained and STORED in its `FlightState` while heading,
 *    pitch, velocity and position are mathematically untouched. A player (or
 *    bot) holding full throttle through the countdown therefore accelerates on
 *    the very first live tick instead of losing a beat re-sending the order.
 *    Draining rather than queueing also means a mashed module button toggles
 *    once per press, not N times at GO.
 *  - Nothing else runs: no targeting, no combat, no projectiles, no collisions,
 *    no win-condition evaluation. Ships cannot move and cannot fire, and no lock
 *    can warm up early.
 *  - `elapsed` (match time, and the `timeLimit` win condition) starts at GO;
 *    `tick` counts every processed tick, countdown included.
 *
 * Determinism is trivial here — the countdown reads no RNG and no clock — so two
 * sims built from the same pack and fed the same dt sequence reach `live` on the
 * same tick, which is the whole point of moving this into the sim.
 *
 * System run order while live (documented, order matters):
 *   1. NavigationSystem  — apply move/flight orders, steer/avoid, boost
 *   2. ModuleSystem      — toggle orders + deploy/retract/overheat-cooldown timers
 *   3. TargetingSystem   — resolve TargetRef + advance/drain the sensor lock
 *   4. CombatSystem      — auto-fire beams/kinetics/missiles (lock+range+LoS)
 *   5. EnergySystem      — per-module tanks (drain/refill) and racks (heat/cool/lockout)
 *   6. ProjectileSystem  — move/home/expire/hit
 *   7. CollisionSystem   — ship-asteroid, ship-ship, boundary
 *   8. CleanupSystem     — remove destroyed ships
 */
export class ArenaSimulation {
  readonly world: World;
  private elapsed = 0;
  private tickNo = 0;
  private phase: MatchPhase;
  private countdownRemaining: number;
  /** Whole-second value last announced by a `countdownTick` event (-1 = none yet). */
  private lastCountdownAnnounced = -1;
  private winnerTeam: number | null = null;
  private readonly teamScores = new Map<number, number>();
  /** Flag captures per team (capture-the-flag only). */
  private readonly teamCaptures = new Map<number, number>();
  private readonly teamsEverPresent = new Set<number>();
  private destroyedShips = 0;
  /**
   * What each live ship was spawned AS, kept so `gamemode.respawn` can rebuild
   * it after a death — same ship, same fitting, same upgrades, same entity id.
   */
  private readonly spawnRecords = new Map<
    EntityId,
    {
      shipId: string;
      fitting: readonly (string | null)[];
      team: number;
      upgradeLevels?: UpgradeLevels;
      /** Equipped paint, kept with the record so a respawn comes back wearing it. */
      cosmeticId?: string;
    }
  >();
  /** Deaths waiting out `respawn.delay`, in death order. */
  private readonly pendingRespawns: { entityId: EntityId; timer: number }[] = [];
  /** Deterministic spawn-point picker for respawns (own stream off the session seed). */
  private readonly respawnRng: () => number;

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
    // Its own derived stream: respawn placement must not perturb any other
    // seeded randomness (bot decisions, spawn scatter) and vice versa.
    this.respawnRng = deriveRng(seed, 0x5e5f);

    // Resolved once at construction, NOT per tick: a tuning hot-reload halfway
    // through a countdown must not lengthen the lead-in one client is already
    // counting down (the offline World re-resolves tuning by id every access).
    this.countdownRemaining = matchCountdownSecOf(tuning);
    this.phase = this.countdownRemaining > 0 ? "countdown" : "live";

    for (const p of arena.asteroidPlacements) {
      spawnAsteroid(this.world, configs, p.asteroidId, p.position, p.scale ?? 1);
    }
    this.spawnFlags(arena, gamemode);
  }

  /**
   * Stand up one flag per authored base (owner 2026-07-31). Only a gamemode with
   * a `ctf` block does this: an arena may carry flag bases and still be played
   * as a deathmatch, in which case they are scenery the sim never touches.
   *
   * A team with no base simply has no flag. That is a content mistake rather
   * than a crash — the match is still playable, it just cannot be won on
   * captures — so it is left to the content gate to complain about.
   */
  private spawnFlags(arena: ArenaConfig, gamemode: GamemodeConfig): void {
    const rules = gamemode.ctf;
    if (!rules) return;
    for (const base of arena.flagBases ?? []) {
      const home = { x: base.position.x, y: base.position.y ?? 0, z: base.position.z };
      const id = this.world.createEntity();
      this.world.transforms.set(id, {
        pos: { ...home },
        heading: 0,
        pitch: 0,
        up: { x: 0, y: 1, z: 0 },
      });
      this.world.flags.set(id, {
        team: base.team,
        state: "home",
        carrierId: null,
        dropTimer: 0,
        home,
        baseRadius: base.radius,
        pickupRadius: rules.pickupRadius,
        trail: [],
      });
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
    cosmeticId?: string | null,
  ): EntityId {
    const spawns = this.world.arena.spawnPoints.filter((s) => s.team === team);
    const used = this.world.shipIds().length;
    const sp = spawns[used % Math.max(1, spawns.length)] ?? this.world.arena.spawnPoints[0]!;
    this.teamsEverPresent.add(team);
    const id = spawnShipFromConfig(
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
    this.spawnRecords.set(id, { shipId, fitting, team, upgradeLevels, cosmeticId: this.paintFor(shipId, cosmeticId) });
    return id;
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
    cosmeticId?: string | null,
  ): EntityId {
    this.teamsEverPresent.add(team);
    const id = spawnShipFromConfig(this.world, this.configs, shipId, fitting, team, pos, heading, upgradeLevels, pitch);
    this.spawnRecords.set(id, { shipId, fitting, team, upgradeLevels, cosmeticId: this.paintFor(shipId, cosmeticId) });
    return id;
  }

  /**
   * Gate a requested paint against the pack at the SPAWN seam, so no snapshot
   * can carry an id that is unknown or illegal for the hull wearing it. Standard
   * (and anything rejected) is stored as absent — see {@link ShipSnapshot.cosmeticId}.
   */
  private paintFor(shipId: string, cosmeticId: string | null | undefined): string | undefined {
    return resolveCosmeticFor(this.configs, shipId, cosmeticId);
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
    // A deliberate leave forgets the spawn record too — a disconnected player
    // must not keep respawning as a ghost.
    this.spawnRecords.delete(entityId);
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
    if (this.phase === "countdown") {
      this.tickCountdown(dt);
      return;
    }
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
    w.spatial.setCellSize(w.tuning.spatialCellSize ?? 16);
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
    // Before targeting: a heatsink jettisoned this tick must already be luring
    // this tick, and its decoy must exist before missiles pick a seeker head.
    jettisonSystem(w, dt);
    targetingSystem(w, dt);
    combatSystem(w, dt);
    energySystem(w, dt);
    projectileSystem(w, dt);
    collisionSystem(w, dt);
    // Between collision and cleanup on purpose: a carrier killed this tick still
    // has a transform, so its flag drops where it died rather than at the origin.
    ctfSystem(w, dt);
    cleanupSystem(w);
    latchFireState(w);

    this.elapsed += dt;
    this.tickNo += 1;
    this.processCaptures();
    this.processRespawns(dt);
    this.evaluateWinCondition();
  }

  /**
   * Cash any completed run (owner 2026-07-31): a carrier standing in its own
   * base, with its own team's flag at home, scores and the flag goes back.
   *
   * Scoring lives here rather than in CtfSystem because the score is the
   * MATCH's, not the flag's — the same reason kills are tallied in
   * `evaluateWinCondition` instead of in CombatSystem.
   */
  private processCaptures(): void {
    if (!this.world.gamemode.ctf) return;
    for (const flagId of this.world.flagIds()) {
      const flag = this.world.flags.get(flagId)!;
      const scored = tryCapture(this.world, flagId, flag);
      if (!scored) continue;
      const captures = (this.teamCaptures.get(scored.team) ?? 0) + 1;
      this.teamCaptures.set(scored.team, captures);
      this.world.emit({
        type: "flagCaptured",
        flagId,
        flagTeam: flag.team,
        carrierId: scored.carrierId,
        scoringTeam: scored.team,
        captures,
      });
      returnFlagHome(this.world, flagId, flag);
    }
  }

  /**
   * Respawn pipeline (`gamemode.respawn`): a destroyed ship with a spawn record
   * waits out `respawn.delay`, then is rebuilt UNDER ITS OLD ENTITY ID at one of
   * its team's spawn points, picked by the sim's own seeded stream — "somewhere
   * in the map", but always an authored-safe pad, never inside a rock. The id
   * reuse is the whole trick: the local player id, bot drivers, the server's
   * PlayerState and every HUD binding survive the death untouched.
   *
   * Timers advance BEFORE this tick's deaths are scheduled, so a fresh death
   * always waits the full delay. Relies on the same host invariant the win
   * condition tally does: events are drained once per tick.
   */
  private processRespawns(dt: number): void {
    const respawn = this.world.gamemode.respawn;
    if (!respawn.enabled) return;

    for (let i = this.pendingRespawns.length - 1; i >= 0; i--) {
      const pending = this.pendingRespawns[i]!;
      pending.timer -= dt;
      if (pending.timer > 0) continue;
      this.pendingRespawns.splice(i, 1);
      const record = this.spawnRecords.get(pending.entityId);
      if (!record) continue; // left the match while dead — no ghost respawns
      if (this.world.isAlive(pending.entityId)) continue; // already back (defensive)
      const spawns = this.world.arena.spawnPoints.filter((s) => s.team === record.team);
      const sp =
        spawns.length > 0
          ? spawns[Math.min(spawns.length - 1, Math.floor(this.respawnRng() * spawns.length))]!
          : this.world.arena.spawnPoints[0]!;
      spawnShipFromConfig(
        this.world,
        this.configs,
        record.shipId,
        record.fitting,
        record.team,
        sp.position,
        sp.heading,
        record.upgradeLevels,
        sp.pitch ?? 0,
        pending.entityId,
      );
    }

    for (const ev of this.world.events) {
      if (ev.type !== "entityDestroyed" || ev.isAsteroid) continue;
      if (!this.spawnRecords.has(ev.entityId)) continue;
      // One pending per entity: a host that skips a drain re-presents the same
      // event next tick, and a duplicate would try to restore a live id later.
      let alreadyPending = false;
      for (const pending of this.pendingRespawns) {
        if (pending.entityId === ev.entityId) {
          alreadyPending = true;
          break;
        }
      }
      if (alreadyPending || this.world.isAlive(ev.entityId)) continue;
      this.pendingRespawns.push({ entityId: ev.entityId, timer: respawn.delay });
    }
  }

  /**
   * One countdown tick: intake orders with zero integration, run the timer down,
   * announce each whole second, and flip to `live` at zero. See the class doc
   * for why this suspends the integration rather than rejecting the orders.
   *
   * `tickNo` advances (a processed tick is a processed tick) but `elapsed` does
   * not — match time, and therefore the `timeLimit` win condition, begins at GO.
   */
  private tickCountdown(dt: number): void {
    navigationSystem(this.world, 0);
    moduleSystem(this.world, 0);
    this.tickNo += 1;

    // A non-finite dt cannot be allowed to poison the timer into a match that
    // never starts; treat it as "no time passed".
    this.countdownRemaining = Math.max(0, this.countdownRemaining - (Number.isFinite(dt) ? dt : 0));
    if (this.countdownRemaining <= COUNTDOWN_EPSILON) {
      this.countdownRemaining = 0;
      this.phase = "live";
      this.world.emit({ type: "matchStarted" });
      return;
    }
    const shown = Math.ceil(this.countdownRemaining);
    if (shown !== this.lastCountdownAnnounced) {
      this.lastCountdownAnnounced = shown;
      this.world.emit({ type: "countdownTick", remaining: shown });
    }
  }

  private evaluateWinCondition(): void {
    // Tally destructions produced this tick (events not yet drained).
    for (const ev of this.world.events) {
      if (ev.type === "entityDestroyed" && !ev.isAsteroid) {
        this.destroyedShips += 1;
        // The killer's team scores. Environment and self deaths (boundary,
        // asteroid impact, overheat — `killerId: null`) and team-kills instead
        // credit the team OPPOSING the victim, so every ship death moves the
        // scoreboard (owner report 2026-07-31: a boundary death "did not
        // count"). Only decidable when the victim faces exactly one other team.
        let credit = ev.killerId !== null ? this.world.teams.get(ev.killerId)?.team : undefined;
        if (credit === undefined || credit === ev.team) {
          const others = [...this.teamsEverPresent].filter((t) => t !== ev.team);
          credit = others.length === 1 ? others[0] : undefined;
        }
        if (credit !== undefined) this.teamScores.set(credit, (this.teamScores.get(credit) ?? 0) + 1);
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
    } else if (wc.type === "captureLimit") {
      for (const [team, captures] of this.teamCaptures) {
        if (captures >= wc.count) {
          ended = true;
          winner = team;
          break;
        }
      }
    }

    // Hard time cap layered over ANY win condition (frag-limit modes need a
    // guaranteed end): whoever leads when it lands wins; a tie is a DRAW.
    const cap = this.world.gamemode.timeLimitCapSec;
    if (!ended && cap !== undefined && this.elapsed >= cap) {
      ended = true;
      winner = this.topTeam();
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

  /**
   * Who is ahead. In a capture-the-flag match that means CAPTURES — a team that
   * lost the fight but won the objective has won the match — with kills only as
   * the tiebreak. Everywhere else it is kills, as it always was. A genuine tie
   * returns null, which the caller reads as a draw.
   */
  private topTeam(): number | null {
    const isCtf = this.world.gamemode.ctf !== undefined;
    let best: number | null = null;
    let bestPrimary = -1;
    let bestSecondary = -1;
    let tie = false;
    for (const team of this.teamsEverPresent) {
      const kills = this.teamScores.get(team) ?? 0;
      const primary = isCtf ? (this.teamCaptures.get(team) ?? 0) : kills;
      const secondary = isCtf ? kills : 0;
      if (primary > bestPrimary || (primary === bestPrimary && secondary > bestSecondary)) {
        bestPrimary = primary;
        bestSecondary = secondary;
        best = team;
        tie = false;
      } else if (primary === bestPrimary && secondary === bestSecondary) {
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

  /** Current match phase (countdown / live / ended). */
  get matchPhase(): MatchPhase {
    return this.phase;
  }

  /** Seconds left on the start countdown; 0 once live. */
  get countdown(): number {
    return this.countdownRemaining;
  }

  snapshot(): Snapshot {
    const w = this.world;
    const ships: ShipSnapshot[] = w.shipIds().map((id) => {
      const core = w.shipCores.get(id)!;
      const tf = w.transforms.get(id)!;
      const mods = w.modules.get(id)!;
      const ref = w.targets.get(id);
      const velocity = w.velocities.get(id)!;
      return {
        id,
        team: w.teams.get(id)!.team,
        pos: { x: tf.pos.x, y: tf.pos.y, z: tf.pos.z },
        colliderRadius: w.colliders.get(id)!.radius,
        heading: tf.heading,
        pitch: tf.pitch,
        up: { x: tf.up.x, y: tf.up.y, z: tf.up.z },
        hull: core.hull,
        hullMax: core.hullMax,
        targetId: ref?.targetId ?? null,
        throttle: w.flightStates.get(id)?.throttle ?? 0,
        velocity: { x: velocity.x, y: velocity.y, z: velocity.z },
        sensorRange: core.sensors.lockRange,
        // Normalized against the ship's own resolved lock time, so a module that
        // shortens lockTimeSec still reads as a full ring at full lock. A resolved
        // lockTimeSec of 0 (a passive strong enough to zero it out) locks
        // instantly, so report the flag rather than dividing by zero.
        lockProgress: lockFraction(core, ref),
        locked: ref?.locked ?? false,
        cosmeticId: this.spawnRecords.get(id)?.cosmeticId,
        modules: mods.modules.map((m) => ({
          moduleId: m.moduleId,
          hardpointIndex: m.hardpointIndex,
          state: m.state,
          rounds: m.rounds,
          heat: m.heat,
          heatCapacity: m.heatCapacity,
          energy: m.energy,
          energyCapacity: m.energyCapacity,
          stateTimer: m.stateTimer,
          cycleTimer: m.cycleTimer,
          channeling: m.channeling,
          shieldPool: m.absorbs ? m.energy : 0,
        })),
      };
    });
    const asteroids: AsteroidSnapshot[] = w.asteroidIds().map((id) => {
      const tf = w.transforms.get(id)!;
      const tag = w.asteroids.get(id)!;
      return {
        id,
        configId: tag.configId,
        pos: { x: tf.pos.x, y: tf.pos.y, z: tf.pos.z },
        // The DRAWN radius, not the (smaller) collision sphere — this feeds the
        // renderer and radar. Gameplay geometry uses `colliderRadius` below.
        radius: tag.visualRadius,
        colliderRadius: w.colliders.get(id)!.radius,
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
    const decoys: DecoySnapshot[] = w.decoyIds().map((id) => {
      const tf = w.transforms.get(id)!;
      const d = w.decoys.get(id)!;
      return {
        id,
        team: d.team,
        pos: { x: tf.pos.x, y: tf.pos.y, z: tf.pos.z },
        radius: d.radius,
        lifeFraction: d.maxLifetime > 0 ? Math.max(0, Math.min(1, d.lifetime / d.maxLifetime)) : 0,
      };
    });
    const flags: FlagSnapshot[] = w.flagIds().map((id) => {
      const tf = w.transforms.get(id)!;
      const f = w.flags.get(id)!;
      return {
        id,
        team: f.team,
        state: f.state,
        carrierId: f.carrierId,
        pos: { x: tf.pos.x, y: tf.pos.y, z: tf.pos.z },
        home: { x: f.home.x, y: f.home.y, z: f.home.z },
        baseRadius: f.baseRadius,
        pickupRadius: f.pickupRadius,
        dropRemaining: f.state === "dropped" ? Math.max(0, f.dropTimer) : 0,
        trail: f.trail.map((p) => ({ x: p.x, y: p.y, z: p.z })),
      };
    });
    const teamScores: TeamScore[] = [...this.teamsEverPresent]
      .sort((a, b) => a - b)
      .map((team) => ({
        team,
        kills: this.teamScores.get(team) ?? 0,
        captures: this.teamCaptures.get(team) ?? 0,
      }));
    return {
      tick: this.tickNo,
      elapsed: this.elapsed,
      phase: this.phase,
      teamScores,
      countdownRemaining: this.countdownRemaining,
      winnerTeam: this.winnerTeam,
      ships,
      asteroids,
      projectiles,
      decoys,
      flags,
    };
  }
}

/** Lock progress as a 0..1 fraction of the ship's own resolved `lockTimeSec`. */
function lockFraction(core: ShipCore, ref: TargetRef | undefined): number {
  if (!ref) return 0;
  if (core.sensors.lockTimeSec <= 0) return ref.locked ? 1 : 0;
  return clamp(ref.lockProgress / core.sensors.lockTimeSec, 0, 1);
}
