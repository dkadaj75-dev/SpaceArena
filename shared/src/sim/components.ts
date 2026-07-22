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

/** A pending/active move order. `boost` requests afterburner (double-tap). */
export interface MoveOrder {
  target: { x: number; z: number };
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

/** Current focused/auto target. */
export interface TargetRef {
  targetId: EntityId | null;
  /** True if set by an explicit target order (sticky until death). */
  manual: boolean;
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
