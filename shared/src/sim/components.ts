import type { RockSpin } from "../collision/rockPose.js";
import type { ResolvedRockMesh } from "../collision/rockCollider.js";
import type { ResolvedRockShape, RockQuat } from "../collision/rockShape.js";
import type { DamageType } from "../schemas/common.js";
// Type-only, and therefore erased: `resolveStats` imports `ShipCore` back from
// here, so a VALUE import would be a genuine cycle.
import type { UpgradeLevels } from "./resolveStats.js";

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
   * Turn-rate fraction, -1..1. Positive increases heading directly (the same
   * sense as a positive `angleDelta` from current heading to a target; the
   * client maps stick-right to whichever sign reads as screen-right under the
   * chase cam).
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
  /**
   * "Fire everything." True while a ship-wide trigger is held — the PC space
   * bar and every bot, which have no per-weapon control and want the whole
   * broadside. A human on the touch HUD leaves this false and uses
   * {@link FlightState.triggers} instead.
   */
  fire: boolean;
  /** Previous tick's trigger level, retained for wire/input compatibility. */
  firePrev: boolean;
  /**
   * PER-WEAPON triggers (2026-08-21), a bitmask over hardpoint index: bit `i`
   * is set while the pilot holds the button for the weapon in hardpoint `i`.
   *
   * This is what replaced the single FIRE button. A weapon fires when its own
   * bit is held OR when {@link FlightState.fire} is — the two are ORed rather
   * than exclusive, so the keyboard's "everything" trigger and a thumb on one
   * specific gun both work, and neither has to know about the other.
   *
   * Held state like every other axis: the client sets a bit on press and clears
   * it on release, so a held button costs no extra orders.
   */
  triggers: number;
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
  /**
   * Resolved hull-wide RECHARGE multiplier — hull base × every fitted
   * generator's `recharge.multiplier` × passives. Applied to every module's own
   * `energy.rechargePerSec`.
   */
  recharge: { multiplier: number };
  /** Resolved multiplier on every module's authored `energy.capacity`. */
  energyStore: { multiplier: number };
  /** Resolved sensor suite driving the lock cone (FLIGHT.md §2). `coneDeg` is the FULL width. */
  sensors: { lockRange: number; lockTimeSec: number; coneDeg: number };
  /**
   * POWER RAIL (2026-07-31): the instantaneous current the hull can deliver.
   * Every ACTIVE hardpoint module occupies its own `power.draw` out of this,
   * which is what makes two heavy weapons mutually exclusive on a thin rail.
   * Distinct from a module's own energy tank, which is a reservoir drained
   * over time (see {@link ModuleRuntime.energy}).
   */
  power: { capacity: number };
  /**
   * Ship-wide efficiency, the fitted TRANSFORMER's contribution (2026-07-31):
   * every module's energy draw is multiplied by `energyDraw`. 1 = the hull as
   * authored.
   */
  efficiency: { energyDraw: number };
  /**
   * Resolved ROLE PROFILE (`core.combat`) — the hull's own combat multipliers,
   * already defaulted and clamped by {@link import("./resolveStats.js").resolveShipStats}
   * so no consumer has to think about an absent field:
   *
   *  - `damageOutput` scales damage this ship DEALS, per LEAF type, applied at
   *    the top of the damage pipeline (`damage.ts`);
   *  - `rateOfFire` divides the cycle time of a weapon of that authored
   *    `fire.damageType`, or scales a channel's DPS (`CombatSystem`);
   *  - `shieldEfficiency` scales every fitted shield's reserve — tank size at
   *    spawn and refill rate in `EnergySystem`.
   */
  combat: {
    damageOutput: { kinetic: number; energy: number };
    rateOfFire: { kinetic: number; energy: number; hybrid: number };
    shieldEfficiency: number;
  };
}

/**
 * The inputs a ship's {@link ShipCore} was resolved FROM, recorded at spawn.
 *
 * Kept because a resolved core is a one-way projection: given only the core you
 * cannot re-run `resolveShipStats` when the ship's config changes under a live
 * match (the F10 ship tool editing hull, engine or the combat role profile).
 * With these three the re-resolve is exact — same config id, same fitting, same
 * upgrade counts — so a hot edit lands on the ship the pilot is flying instead
 * of waiting for a respawn. See `reresolveShipCore`.
 */
export interface ShipLoadout {
  /** Ship CONFIG id (`ship.brawler`), not the entity id. */
  shipId: string;
  /** Positional fitting: array index is the hardpoint index (see spawn). */
  fittingModuleIds: readonly (string | null)[];
  /** The player's DB upgrade purchase counts; absent ⇒ base stats. */
  upgradeLevels?: UpgradeLevels;
}

export type ModuleState =
  | "retracted"
  | "deploying"
  | "active"
  | "retracting"
  | "reloading";

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
  /** Hull that soak SAVED over the same window (see `DamageTally.avoided`). */
  avoided: Map<number, number>;
  /** Seconds since the last flush. */
  eventTimer: number;
}

/** Per-fitted-module runtime state (the generic §2.3 state machine). */
export interface ModuleRuntime {
  moduleId: string;
  /** Index into the ship fitting / hardpoint order. */
  hardpointIndex: number;
  state: ModuleState;
  /**
   * Remaining seconds in a timed state (deploying/retracting).
   */
  stateTimer: number;
  /** Rounds left in an authored clip; 0 for modules without a clip. */
  rounds: number;
  /** This module's own energy charge, 0..{@link ModuleRuntime.energyCapacity}. */
  energy: number;
  /**
   * Resolved capacity of this module's energy tank (authored `energy.capacity` ×
   * the hull's `energyStore.multiplier`), or 0 for a module that needs none.
   * Resolved once at spawn: the HUD's energy ring is `energy / energyCapacity`.
   */
  energyCapacity: number;
  /**
   * True for a module whose energy tank doubles as a damage-absorbing shield
   * reserve (anything authoring `mitigation`). Cached at spawn so the per-tick
   * damage path and the snapshot never have to re-read the config.
   */
  absorbs: boolean;
  /** Weapon cooldown countdown (seconds). Always 0 for `fire.mode: "continuous"`. */
  cycleTimer: number;
  /**
   * True on every tick a `continuous` weapon is CHANNELLING (trigger held and
   * every gate passing). Replicated — it is the only thing that tells a client to
   * draw a persistent beam, since a channel emits no per-tick fire events. Always
   * false for discrete modules.
   */
  channeling: boolean;
  /**
   * Sim-internal channel accumulator; `null` until the module first channels and
   * cleared when it stops. NEVER replicated — the wire carries only
   * {@link ModuleRuntime.channeling}.
   */
  channel: ChannelRuntime | null;
  /** Set true by nav/combat/damage when the module actually did work this tick. */
  workedThisTick: boolean;
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

/**
 * A SLOW currently sitting on a ship (owner 2026-08-22) — what a slowing-ray
 * pulse leaves behind. One per ship, never a list, and that is the stacking
 * rule made structural rather than enforced by arithmetic:
 *
 *  - a second pulse from ANY source REFRESHES the timer;
 *  - the STRONGEST factor wins while both would be running.
 *
 * Two rays therefore never multiply into a parked hull, and a wing focusing one
 * target gets exactly the effect the best ray among them authored. See
 * `AbilitySystem.applySlow`.
 */
export interface SlowEffect {
  /**
   * Fraction of top speed REMOVED, 0..1 — the authored `slow.factor` of
   * whichever pulse is currently strongest.
   */
  factor: number;
  /** Seconds left before the hull is free again. */
  remaining: number;
  /** Whoever landed the pulse that set the current factor; for FX and telemetry. */
  sourceId: EntityId | null;
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
   * Radius the rock is DRAWN at — for a shaped rock this is the NOMINAL radius
   * its shape field is expressed in, so the drawn surface reaches
   * `shape.maxRadius` of it in the fattest direction and `shape.minRadius` in
   * the thinnest. Snapshots report it so the renderer and radar reason about the
   * rock you can see.
   */
  visualRadius: number;
  /**
   * Index of this rock in `arena.asteroidPlacements`. The identity the CLIENT
   * shares with the sim (entity ids are allocated per-World and an online client
   * never sees them), so it is what tumble and pose are derived from.
   */
  placementIndex: number;
  /**
   * Resolved body shape, or `null` when the rock does not author a field.
   * Shared by every placement of the same config — never mutated per entity.
   */
  shape: ResolvedRockShape | null;
  /**
   * Resolved collision MESH, for a rock drawn from a GLB. Consulted only when
   * {@link AsteroidTag.shape} is null; `null` on both leaves the legacy sphere.
   * Shared per config exactly as `shape` is — one BVH, many placements.
   */
  mesh: ResolvedRockMesh | null;
  /** Deterministic tumble; see `collision/rockPose.ts`. */
  spin: RockSpin;
  /** Authored placement yaw, applied under the tumble. */
  baseRotationY: number;
  /**
   * Cached world orientation and the match time it was computed for. Recomputed
   * at most once per rock per tick, and only for rocks something actually
   * queries — most rocks in an arena are never touched on a given tick.
   */
  orientation: RockQuat;
  orientationTime: number;
  /**
   * Largest solid sphere centred on the body, world units. Anything inside it is
   * rock for certain, so it is the CONSERVATIVE stand-in for consumers that can
   * only reason about spheres.
   */
  innerRadius: number;
  /** Mean surface radius, world units — the honest single-sphere approximation. */
  meanRadius: number;
  /** Asset state id (`intact` / `destroyed`). */
  state: string;
}

/**
 * A jettisoned countermeasure pod drifting in space (owner 2026-07-31). It is not a ship
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
