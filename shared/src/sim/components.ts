import type { DamageType } from "../schemas/common.js";

/** Entity handle. Plain integer allocated by the World. */
export type EntityId = number;

/** Planar transform on the arena ground plane (2.5D sim). */
export interface Transform2D {
  pos: { x: number; z: number };
  heading: number;
}

export interface Velocity {
  x: number;
  z: number;
}

/**
 * Persistent continuous-flight input (FLIGHT.md §1). Written by a `flight` order
 * and NEVER auto-cleared — NavigationSystem integrates the last received state
 * every tick until another flight order replaces it. It is the only thing that
 * moves a ship under power.
 */
export interface FlightState {
  /** Fraction of nominal speed the pilot is asking for, 0..1. */
  throttle: number;
  /**
   * Turn-rate fraction, -1..1. Positive turns in the same direction a positive
   * `turnToward` delta does (the client maps stick-right to whichever sign reads
   * as screen-right under the chase cam).
   */
  turn: number;
  /** True while the pilot holds boost (resolved against a fitted boost module). */
  boost: boolean;
}

/** Resolved ship stats (ship class + upgrade tracks at level 0 for now). */
export interface ShipCore {
  hull: number;
  hullMax: number;
  /** Innate shield hp. 0 in MVP — shielding comes from active shield modules. */
  shield: number;
  shieldMax: number;
  resists: { kinetic: number; energy: number };
  engine: { nominalSpeed: number; accel: number; turnRate: number };
  capacitor: { cur: number; max: number; regen: number };
  /** `cur` is the shared ship heat pool = sum of module heats (recomputed each tick). */
  heat: { cur: number; capacity: number; dissipation: number; criticalDamagePerSec: number };
  /** Resolved sensor suite driving the lock cone (FLIGHT.md §2). `coneDeg` is the FULL width. */
  sensors: { lockRange: number; lockTimeSec: number; coneDeg: number };
}

export type ModuleState =
  | "retracted"
  | "deploying"
  | "active"
  | "retracting"
  | "overheated";

/** Per-fitted-module runtime state (the generic §2.3 state machine). */
export interface ModuleRuntime {
  moduleId: string;
  /** Index into the ship fitting / hardpoint order. */
  hardpointIndex: number;
  state: ModuleState;
  /** Remaining seconds in a timed state (deploying/retracting/overheated). */
  stateTimer: number;
  /** This module's own heat vs its `overheatThreshold`. */
  heat: number;
  /** Weapon cooldown countdown (seconds). */
  cycleTimer: number;
  /** Set true by nav/combat when the module actually did work this tick. */
  workedThisTick: boolean;
  /**
   * Shield-family absorb reservoir (damage points). Regenerates at
   * `mitigation.absorbPerSecond` up to a 1-second cap while the shield is active;
   * drained as it soaks damage. 0 for non-shield modules.
   */
  shieldPool: number;
  /** Guards one-shot overheat self-damage. */
  overheatDamaged: boolean;
}

export interface ModulesComp {
  modules: ModuleRuntime[];
}

/**
 * Current auto-selected target plus its lock state (FLIGHT.md §2). Targeting is
 * fully automatic — there is no manual pin; TargetingSystem picks the candidate
 * and holds it while it stays lockable (the sticky-candidate rule).
 */
export interface TargetRef {
  targetId: EntityId | null;
  /**
   * Seconds of accumulated lock, 0..`sensors.lockTimeSec`. Accrues at 1x while
   * the candidate is in the cone, drains at `tuning.lockDecayMult` while it is
   * not; the target is dropped when it reaches 0.
   */
  lockProgress: number;
  /** True once `lockProgress` filled; stays true while progress > 0. Weapons need it. */
  locked: boolean;
}

export interface ColliderComp {
  radius: number;
}

export interface Team {
  team: number;
}

export interface AsteroidTag {
  configId: string;
  hp: number;
  maxHp: number;
  destructible: boolean;
  impactDamage: number;
  /** Asset state id (`intact` / `destroyed`). */
  state: string;
}

export interface Projectile {
  kind: "kinetic" | "missile";
  damage: number;
  damageType: DamageType;
  speed: number;
  turnRate?: number;
  /** Remaining lifetime in seconds. */
  lifetime: number;
  ownerId: EntityId;
  ownerTeam: number;
  targetId?: EntityId;
  radius: number;
}
