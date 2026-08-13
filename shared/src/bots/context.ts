import type { BotprofileConfig } from "../schemas/botprofile.js";
import type { ProjectileSnapshot, ShipSnapshot, Snapshot } from "../sim/ArenaSimulation.js";
import type { EntityId } from "../sim/components.js";
import { hasLineOfSightAmong, type LosCircle } from "../sim/los.js";
import { dist3 } from "../sim/math.js";
import type { BotRole } from "./roleAllocator.js";
import type { StaticWorld } from "../collision/staticWorld.js";
import type { NavRoute } from "./navRoute.js";

/** Per-behaviour tunables straight out of the botprofile config (`baseWeight` + catchall). */
export type BehaviorParams = BotprofileConfig["behaviors"][string];

/** A missile judged to be inbound on the bot, with its current distance. */
export interface IncomingMissile {
  projectile: ProjectileSnapshot;
  distance: number;
  /** Normalized authoritative travel direction used by the 3D dodge plan. */
  direction: { x: number; y: number; z: number };
}

/**
 * Everything a behaviour scorer is allowed to look at: a read-only view derived
 * from the same {@link Snapshot} the renderer consumes, plus the bot's profile.
 * Bots never touch sim internals — this is the whole world to them.
 */
export interface BotContext {
  readonly snapshot: Snapshot;
  readonly self: ShipSnapshot;
  readonly profile: BotprofileConfig;
  readonly enemies: readonly ShipSnapshot[];
  readonly allies: readonly ShipSnapshot[];
  /** Currently intended target (see {@link pickTarget}), or null. */
  readonly target: ShipSnapshot | null;
  /**
   * TRUE 3D distance to {@link target}; `Infinity` when there is none. Planar
   * would lie in the bubble (BUBBLE.md §D) — the sim's lock range, weapon range
   * and collisions are all 3D since T1, so a range band measured on (x,z) would
   * have a bot "in the band" while the enemy sits 40 units above it.
   */
  readonly distance: number;
  /** Line of sight to {@link target} (same segment-vs-circle math as the sim). */
  readonly hasLoS: boolean;
  readonly hullFraction: number;
  /**
   * How hot the bot's HOTTEST rack is, 0..1 of that module's own capacity
   * (heat/energy overhaul 2026-08-07 — there is no ship pool to read). The
   * hottest rack is the one that decides whether the trigger is about to lock,
   * which is exactly what `moduleDiscipline.heatShutdownAt` is asking about.
   */
  readonly heatFraction: number;
  /**
   * The EMPTIEST module tank, 0..1 of its own capacity (boost bottle, shield
   * reserve, active utility); 1 when the bot carries no energy-bearing module at
   * all. `energyReserve` / `minEnergyFraction` compare against this, so a
   * drained boost bottle reads as "low energy" without pretending every tank on
   * the hull is one shared pool.
   */
  readonly energyFraction: number;
  /** True when no fitted shield module is active / holding absorb pool. */
  readonly shieldDown: boolean;
  /** Profile `preferredRange` unpacked (already ordered min ≤ max). */
  readonly preferredMin: number;
  readonly preferredMax: number;
  /** Longest fitted weapon range (0 when the bot has no weapons). */
  readonly weaponRange: number;
  /**
   * Hull turn rate in rad/s, as the driver currently knows it (see
   * `BotDriver` calibration); 0 means "not measured yet". Behaviours do not
   * normally need it — the driver converts their aim point into a `turn` axis —
   * but it is here so an overlay can reason about how sharp a stick input is.
   */
  readonly turnRate: number;
  /**
   * Hull PITCH rate in rad/s per unit stick, as the driver currently knows it
   * (`turnRate × tuning.pitchRateMult` in the sim, measured the same way);
   * 0 means "not measured yet".
   */
  readonly pitchRate: number;
  /** Control horizon in seconds the driver plans a turn over (its decision interval). */
  readonly turnHorizonSec: number;
  /** Live asteroid colliders usable as cover / LoS blockers. */
  readonly blockers: readonly LosCircle[];
  /** Static terrain used by sensing and objective route visibility checks. */
  readonly staticWorld?: StaticWorld;
  /** Session-shared precomputed arena route graph. */
  readonly navRoute?: NavRoute;
  /** Enemy missiles currently closing on this bot, nearest first. */
  readonly incomingMissiles: readonly IncomingMissile[];
  /**
   * The team job this bot holds this allocation window (`allocateTeamRoles`).
   * `free` means no claim, which is what lets the combat behaviours own the
   * decision. Non-CTF snapshots are always `free`.
   */
  readonly role: BotRole;
  /** Stable per-bot orbit direction (+1/-1) so kiting does not jitter. */
  readonly orbitSign: 1 | -1;
  /** Injected RNG (deterministic in tests). */
  readonly rng: () => number;
  /** BotDriver-owned update tick, used for deterministic fire burst timing. */
  readonly driverTick: number;
}

/** Half-angle (radians) within which a missile's heading counts as "inbound". */
const INBOUND_CONE = Math.PI / 3;

export interface BuildContextInput {
  snapshot: Snapshot;
  self: ShipSnapshot;
  profile: BotprofileConfig;
  weaponRange: number;
  /** Explicit target id (the bot's own choice); falls back to the snapshot's. */
  targetId: EntityId | null;
  /** Radius within which missiles are considered for dodging. */
  missileScanRadius: number;
  orbitSign: 1 | -1;
  rng: () => number;
  /** Team job claim for this bot; defaults to `free` (no objective claim). */
  role?: BotRole;
  /** Measured hull turn rate (rad/s); 0 when the driver has not calibrated yet. */
  turnRate?: number;
  /** Measured hull pitch rate (rad/s per unit stick); 0 when not calibrated yet. */
  pitchRate?: number;
  /** Seconds the driver plans a turn over; defaults to the profile decision interval. */
  turnHorizonSec?: number;
  /** BotDriver-owned update tick; defaults to the snapshot tick for standalone contexts. */
  driverTick?: number;
  staticWorld?: StaticWorld;
  navRoute?: NavRoute;
}

/** Build the read-only decision context for one bot from a snapshot. */
export function buildBotContext(input: BuildContextInput): BotContext {
  const { snapshot, self, profile } = input;
  const enemies: ShipSnapshot[] = [];
  const allies: ShipSnapshot[] = [];
  for (const ship of snapshot.ships) {
    if (ship.id === self.id) continue;
    if (ship.team === self.team) allies.push(ship);
    else enemies.push(ship);
  }

  const blockers: LosCircle[] = [];
  for (const a of snapshot.asteroids) {
    if (a.state === "destroyed") continue;
    blockers.push({ pos: a.pos, radius: a.colliderRadius ?? a.radius });
  }

  const target = input.targetId !== null ? (enemies.find((e) => e.id === input.targetId) ?? null) : null;
  const distance = target ? dist3(self.pos, target.pos) : Infinity;
  const hasLoS = target ? hasLineOfSightAmong(self.pos, target.pos, blockers, input.staticWorld) : false;

  const [rawMin, rawMax] = profile.preferredRange;
  const preferredMin = Math.min(rawMin, rawMax);
  const preferredMax = Math.max(rawMin, rawMax);

  const incomingMissiles: IncomingMissile[] = [];
  for (const p of snapshot.projectiles) {
    if (p.kind !== "missile") continue;
    const d = dist3(self.pos, p.pos);
    if (d > input.missileScanRadius) continue;
    // Authoritative bot snapshots carry velocity, so both closing and the cone
    // are truly 3D. The heading fallback only serves remote/debug snapshots.
    const velocity = p.velocity ?? { x: Math.cos(p.heading), y: 0, z: Math.sin(p.heading) };
    const speed = Math.hypot(velocity.x, velocity.y, velocity.z);
    if (speed === 0 || d === 0) continue;
    const direction = { x: velocity.x / speed, y: velocity.y / speed, z: velocity.z / speed };
    const toSelf = {
      x: (self.pos.x - p.pos.x) / d,
      y: (self.pos.y - p.pos.y) / d,
      z: (self.pos.z - p.pos.z) / d,
    };
    const toward = direction.x * toSelf.x + direction.y * toSelf.y + direction.z * toSelf.z;
    if (toward < Math.cos(INBOUND_CONE)) continue;
    incomingMissiles.push({ projectile: p, distance: d, direction });
  }
  incomingMissiles.sort((a, b) => a.distance - b.distance || a.projectile.id - b.projectile.id);

  const shieldDown = !self.modules.some((m) => m.state === "active" && m.shieldPool > 0);

  // Per-module stores (heat/energy overhaul 2026-08-07): the hottest rack and
  // the emptiest tank, both read straight off the same snapshot the HUD rings do.
  let hottest = 0;
  let emptiest = 1;
  for (const m of self.modules) {
    if (m.heatCapacity > 0) hottest = Math.max(hottest, m.heat / m.heatCapacity);
    if (m.energyCapacity > 0) emptiest = Math.min(emptiest, m.energy / m.energyCapacity);
  }

  return {
    snapshot,
    self,
    profile,
    enemies,
    allies,
    target,
    distance,
    hasLoS,
    hullFraction: self.hullMax > 0 ? self.hull / self.hullMax : 0,
    heatFraction: hottest,
    energyFraction: emptiest,
    shieldDown,
    preferredMin,
    preferredMax,
    weaponRange: input.weaponRange,
    turnRate: input.turnRate ?? 0,
    pitchRate: input.pitchRate ?? 0,
    turnHorizonSec: input.turnHorizonSec ?? profile.decisionIntervalMs / 1000,
    blockers,
    staticWorld: input.staticWorld,
    navRoute: input.navRoute,
    incomingMissiles,
    role: input.role ?? "free",
    orbitSign: input.orbitSign,
    rng: input.rng,
    driverTick: input.driverTick ?? snapshot.tick,
  };
}

/** Read a numeric behaviour param, falling back when absent/not a number. */
export function numParam(params: BehaviorParams, key: string, fallback: number): number {
  const v = (params as Record<string, unknown>)[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** Read a boolean behaviour param, falling back when absent/not a boolean. */
export function boolParam(params: BehaviorParams, key: string, fallback: boolean): boolean {
  const v = (params as Record<string, unknown>)[key];
  return typeof v === "boolean" ? v : fallback;
}

/** Read a string behaviour param, falling back when absent/not a string. */
export function strParam(params: BehaviorParams, key: string, fallback: string): string {
  const v = (params as Record<string, unknown>)[key];
  return typeof v === "string" ? v : fallback;
}

/** Whether a numeric param is present (used to tell "no trigger" from "trigger at 0"). */
export function hasParam(params: BehaviorParams, key: string): boolean {
  return (params as Record<string, unknown>)[key] !== undefined;
}
