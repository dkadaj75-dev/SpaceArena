import type { BotprofileConfig } from "../schemas/botprofile.js";
import type { ProjectileSnapshot, ShipSnapshot, Snapshot } from "../sim/ArenaSimulation.js";
import type { EntityId } from "../sim/components.js";
import { hasLineOfSightAmong, type LosCircle } from "../sim/los.js";
import { dist } from "../sim/math.js";

/** Per-behaviour tunables straight out of the botprofile config (`baseWeight` + catchall). */
export type BehaviorParams = BotprofileConfig["behaviors"][string];

/** A missile judged to be inbound on the bot, with its current distance. */
export interface IncomingMissile {
  projectile: ProjectileSnapshot;
  distance: number;
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
  /** Distance to {@link target}; `Infinity` when there is none. */
  readonly distance: number;
  /** Line of sight to {@link target} (same segment-vs-circle math as the sim). */
  readonly hasLoS: boolean;
  readonly hullFraction: number;
  readonly heatFraction: number;
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
  /** Control horizon in seconds the driver plans a turn over (its decision interval). */
  readonly turnHorizonSec: number;
  /** Live asteroid colliders usable as cover / LoS blockers. */
  readonly blockers: readonly LosCircle[];
  /** Enemy missiles currently closing on this bot, nearest first. */
  readonly incomingMissiles: readonly IncomingMissile[];
  /** Stable per-bot orbit direction (+1/-1) so kiting does not jitter. */
  readonly orbitSign: 1 | -1;
  /** Injected RNG (deterministic in tests). */
  readonly rng: () => number;
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
  /** Measured hull turn rate (rad/s); 0 when the driver has not calibrated yet. */
  turnRate?: number;
  /** Seconds the driver plans a turn over; defaults to the profile decision interval. */
  turnHorizonSec?: number;
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
    blockers.push({ pos: a.pos, radius: a.radius });
  }

  const target = input.targetId !== null ? (enemies.find((e) => e.id === input.targetId) ?? null) : null;
  const distance = target ? dist(self.pos, target.pos) : Infinity;
  const hasLoS = target ? hasLineOfSightAmong(self.pos, target.pos, blockers) : false;

  const [rawMin, rawMax] = profile.preferredRange;
  const preferredMin = Math.min(rawMin, rawMax);
  const preferredMax = Math.max(rawMin, rawMax);

  const incomingMissiles: IncomingMissile[] = [];
  for (const p of snapshot.projectiles) {
    if (p.kind !== "missile") continue;
    const d = dist(self.pos, p.pos);
    if (d > input.missileScanRadius) continue;
    // Heading toward us? (Our own outbound missiles point away.)
    const toSelf = Math.atan2(self.pos.z - p.pos.z, self.pos.x - p.pos.x);
    let delta = toSelf - p.heading;
    delta = Math.atan2(Math.sin(delta), Math.cos(delta));
    if (Math.abs(delta) > INBOUND_CONE) continue;
    incomingMissiles.push({ projectile: p, distance: d });
  }
  incomingMissiles.sort((a, b) => a.distance - b.distance || a.projectile.id - b.projectile.id);

  const shieldDown = !self.modules.some((m) => m.state === "active" && m.shieldPool > 0);

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
    heatFraction: self.heat.capacity > 0 ? self.heat.cur / self.heat.capacity : 0,
    energyFraction: self.energy.max > 0 ? self.energy.cur / self.energy.max : 0,
    shieldDown,
    preferredMin,
    preferredMax,
    weaponRange: input.weaponRange,
    turnRate: input.turnRate ?? 0,
    turnHorizonSec: input.turnHorizonSec ?? profile.decisionIntervalMs / 1000,
    blockers,
    incomingMissiles,
    orbitSign: input.orbitSign,
    rng: input.rng,
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
