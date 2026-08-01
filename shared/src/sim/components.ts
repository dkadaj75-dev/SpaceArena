import type { DamageType } from "../schemas/common.js";

/** Entity handle. Plain integer allocated by the World. */
export type EntityId = number;

/**
 * Full 3D transform inside the arena bubble (BUBBLE.md §A, as amended by the
 * 2026-07-30 flight-frame handoff). Orientation is a full orthonormal FRAME:
 * the nose stays derivable from `heading`/`pitch` (both wrap under free pitch),
 * and `up` persists the roll degree of freedom those two coordinates cannot
 * carry. There is still no player roll CONTROL — `up` only ever changes as the
 * integrated consequence of body-frame yaw and pitch (`advanceFrame`), so a ship
 * that never steers near vertical never rolls at all.
 *
 * `up` is authoritative: it is seeded from the derived value at spawn
 * (`seedUp`) and must never be reconstructed from heading/pitch during normal
 * integration — that reconstruction is exactly the lossy step that produced the
 * steep-pitch barrel roll.
 */
export interface Transform3D {
  pos: { x: number; y: number; z: number };
  heading: number;
  /** Nose elevation in radians; positive climbs. 0 for asteroids. */
  pitch: number;
  /** Persisted ship-up axis (unit, ⊥ nose). Derived world-up for asteroids/projectiles. */
  up: { x: number; y: number; z: number };
}

export interface Velocity {
  x: number;
  y: number;
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
  /**
   * Pitch-rate fraction, -1..1. Positive raises the nose. Pitch is HELD state
   * like throttle (BUBBLE.md): a released stick (0) leaves the nose where it is,
   * it does not auto-level. Rate is
   * `pitchStick * engine.turnRate * tuning.pitchRateMult`.
   */
  pitchStick: number;
  /** Boost request; human pilots derive it from the fitted boost module's active state. */
  boost: boolean;
  /** True while the pilot holds the weapon trigger. */
  fire: boolean;
  /** Previous tick's trigger level, used only by the sim for semi-auto edges. */
  firePrev: boolean;
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
  /**
   * POWER RAIL (2026-07-31): the instantaneous current the hull can deliver.
   * Every ACTIVE hardpoint module occupies its own `power.draw` out of this,
   * which is what makes two heavy weapons mutually exclusive on a thin rail.
   * Distinct from `capacitor`, which is a reservoir drained over time.
   */
  power: { capacity: number };
  /**
   * Ship-wide efficiency, the fitted TRANSFORMER's contribution (2026-07-31):
   * every module's energy draw is multiplied by `energyDraw` and its heat
   * generation by `heatGen`. 1 = the hull as authored.
   */
  efficiency: { energyDraw: number; heatGen: number };
}

export type ModuleState =
  | "retracted"
  | "deploying"
  | "active"
  | "retracting"
  | "overheated";

/**
 * Banked damage from a channelling `continuous` weapon. Damage itself is applied
 * to the target every tick (`fire.damage * dt`); only the *events* are banked
 * here and flushed at a fixed low cadence, so a channel costs ~4 events/second
 * instead of one per tick per beam. Sim-internal, never replicated.
 */
export interface ChannelRuntime {
  /** Entity the banked amounts belong to; a target change flushes first. */
  targetId: EntityId;
  /** Hull damage dealt since the last flush. */
  hull: number;
  /** Damage soaked since the last flush, by absorbing shield hardpoint index. */
  absorbed: Map<number, number>;
  /** Seconds since the last flush. */
  eventTimer: number;
}

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
  /** Weapon cooldown countdown (seconds). Always 0 for `fire.mode: "continuous"`. */
  cycleTimer: number;
  /**
   * True on every tick a `continuous` weapon is CHANNELLING (trigger held and
   * every gate passing). Replicated — it is the only thing that tells a client to
   * draw a persistent beam, since a channel emits no per-tick fire events. Always
   * false for `held`/`semi` modules.
   */
  channeling: boolean;
  /**
   * Sim-internal channel accumulator; `null` until the module first channels and
   * cleared when it stops. NEVER replicated — the wire carries only
   * {@link ModuleRuntime.channeling}.
   */
  channel: ChannelRuntime | null;
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
  /**
   * Radius the rock is DRAWN at, which is larger than its collision sphere (see
   * `asteroid.colliderScale`). Snapshots report this, so the renderer, the radar
   * reason about the rock you can see; gameplay collision, navigation, and
   * line-of-sight use the smaller sphere in `world.colliders`.
   */
  visualRadius: number;
  /** Asset state id (`intact` / `destroyed`). */
  state: string;
}

/**
 * A jettisoned heatsink drifting in space (owner 2026-07-31). It is not a ship
 * and cannot be shot down — it is a LURE: for `lifetime` seconds it is the
 * hottest thing around, so enemy auto-lock prefers it over a hull and homing
 * missiles already in flight re-seek it. `team` is the team that dropped it, so
 * it only ever distracts the OTHER side.
 */
export interface Decoy {
  team: number;
  /** Remaining lifetime in seconds. */
  lifetime: number;
  /** Total authored lifetime, so a renderer can fade it out. */
  maxLifetime: number;
  radius: number;
}

/** Where a capture-the-flag flag is right now. */
export type FlagState = "home" | "carried" | "dropped";

/**
 * A capture-the-flag flag (owner 2026-07-31). The entity carries the transform;
 * this is the rest of it. One per team, spawned from `arena.flagBases` when the
 * gamemode authors a `ctf` block.
 */
export interface Flag {
  /** The team this flag BELONGS to — the one that must defend it. */
  team: number;
  state: FlagState;
  /** Ship carrying it, or null. Always an enemy of {@link Flag.team}. */
  carrierId: EntityId | null;
  /** Seconds left before a dropped flag returns itself home. */
  dropTimer: number;
  /** Base position: where it sits at home and where it returns to. */
  home: { x: number; y: number; z: number };
  /** Capture/return sphere of its base. */
  baseRadius: number;
  /** Fly within this of the flag to take it. */
  pickupRadius: number;
  /**
   * Wake behind a moving flag, oldest first, bounded by the mode's
   * `trailLength`. Drawn in 3D and on the radar; cleared when the flag is home
   * (a flag on its stand is not going anywhere).
   */
  trail: { x: number; y: number; z: number }[];
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
