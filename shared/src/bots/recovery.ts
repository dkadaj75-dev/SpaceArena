import type { ArenaBounds } from "../schemas/arena.js";
import type { Vec3 } from "../schemas/common.js";
import type { ShipSnapshot, Snapshot } from "../sim/ArenaSimulation.js";
import type { EntityId } from "../sim/components.js";
import { clamp, dist3, segmentIntersectsSphere } from "../sim/math.js";
import type { BotPlan, FlightCommand } from "./behaviors.js";
import { steerForPoint } from "./flight.js";

/** Commanded throttle below which a motionless hull is holding, not stalled. */
const COMMANDED_STALL_THROTTLE = 0.2;
/** How long a contact or a commanded stall must persist before the guard arms. */
const STALL_MS = 1_500;
/** Displacement inside which the hull counts as not having moved. */
const STALL_RADIUS = 1;
/** Rendered-extent allowance on top of the collider gap when judging contact. */
const VISUAL_MARGIN = 0.35;
const ESCAPE_CLEARANCE = 4;
const ESCAPE_AIM_DISTANCE = 30;
const ESCAPE_RADIUS_MULT = 3;
const ESCAPE_AIM_RADIUS_MULT = 12;
const ANTIPARALLEL_BIAS = 0.35;
/** Nose-to-normal alignment above which thrust creates real separation. */
const ESCAPE_NOSE_DOT = 0.12;
/**
 * Longest a single escape may own the command. The escape releases on MEASURED
 * clearance, which is the honest test; this is the backstop that keeps the
 * guard from ever becoming an absorbing state (the 69639cd law) if a hull is
 * wedged somewhere its outward normal cannot free it. Releasing hands the plan
 * back — the arming rule immediately re-measures, so a genuinely stuck hull
 * re-arms with a freshly composed normal rather than pressing the same one.
 */
const ESCAPE_MAX_MS = 6_000;
/**
 * Hull speed above which a command IS converting into travel. Contact at speed
 * is a graze, not a wedge — a bot skimming a rock on its way somewhere is
 * flying, and arming the guard on it would fight the route it is following.
 */
const WEDGE_SPEED = 0.75;
/** Route-around waypoint clearance beyond the blocker's rendered radius. */
const ROUTE_CLEARANCE = 2;
const ROUTE_THROTTLE = 0.65;

const FLOOR_LOOKAHEAD_SEC = 2.5;
const FLOOR_NOMINAL_SPEED = 20;
/** Below this hull speed a floor-avoidance throttle cut would strand the ship. */
const FLOOR_STALL_SPEED = 4;
/** Way the predictive cut always leaves a stalled hull, so it can fly out. */
const FLOOR_STALL_THROTTLE = 0.3;
const FLOOR_RECOVERY_CLEARANCE_MULT = 4;
const FLOOR_BAND = 4;

export interface RecoveryEnv {
  /** Arena floor plane. Omit for fully enclosed/unfloored arenas. */
  floorY?: number;
  /** Enclosing arena shell; its inside is a rest surface. */
  arenaBounds?: ArenaBounds;
  /** Maximum rendered hull extent, when larger than the gameplay collider. */
  visualRadius?: number;
  /** Seeded per-bot side, used as the deterministic tangent tie-break. */
  orbitSign: 1 | -1;
}

/** Steering rates and limits the floor branch needs from the driver. */
export interface RecoverySteering {
  turnRate: number;
  pitchRate: number;
  horizonSec: number;
  toleranceRad: number;
  maxPitchRad: number | null;
}

/**
 * **L0 — the survive layer** (D1, owner 2026-08-08). One controller owns the
 * whole of "the hull is not making progress against a physical constraint",
 * replacing three guards that used to compose only by accident of call order:
 * predictive floor avoidance, the no-progress surface watchdog with its tangent
 * escape, and the route-around-blocker.
 *
 * The invariants it inherits are law, and each one is a bug that shipped:
 *
 * - **Rendered proximity is not contact** (e108828). Contact is the COLLIDER gap
 *   falling inside the band this hull's own rendered extent overhangs its
 *   collider by — an obstacle that merely LOOKS like it is touching (a colossal
 *   lapping over a fighter) is something to route around, not something to push
 *   off. A ship that only looks grounded is flying.
 * - **A guard may never become an absorbing state** (69639cd). Every override
 *   here either provably moves the hull (thrust along an outward normal, a
 *   throttle floor under the predictive cut) or releases within a bounded time.
 * - **Legitimate holds never arm it.** A zero-throttle loiter with no contact is
 *   a bot waiting, and waiting is not stuck.
 *
 * The response ladder, highest first:
 *   1. the plan's aim corridor is blocked by rendered scenery ⇒ route around it
 *      (a tangent waypoint, inside L0 so nothing below can steer it back);
 *   2. real contact ⇒ reorient onto the composed outward normal of ALL active
 *      contacts and thrust to hull-scaled clearance;
 *   3. predicted floor crash ⇒ climb from the hull's own altitude, led 45° along
 *      the nose, with a throttle floor under the cut.
 *
 * Rungs 1-2 rewrite the PLAN (so behaviour steering cannot cancel them); rung 3
 * rewrites the assembled COMMAND, because a crash prediction is about the path
 * the sticks just produced. That is the only seam, and it is one-way: while an
 * escape owns flight, the floor branch does not run.
 */
export class RecoveryController {
  private readonly env: RecoveryEnv;
  private escape: { key: string; normal: Required<Vec3>; side: 1 | -1; sinceMs: number } | null = null;
  private stall: { key: string; sinceMs: number; anchor: Required<Vec3> } | null = null;
  private commandedStall: { sinceMs: number; anchor: Required<Vec3> } | null = null;
  private floorRecovering = false;
  private floorStrength = 0;

  constructor(env: RecoveryEnv) {
    this.env = env;
  }

  reset(): void {
    this.escape = null;
    this.stall = null;
    this.commandedStall = null;
    this.floorRecovering = false;
    this.floorStrength = 0;
  }

  /** True while a contact escape owns the command (the floor branch stands down). */
  get owningFlight(): boolean {
    return this.escape !== null;
  }

  /** True while the LATCHED floor climb is commanding a recovery. */
  get climbing(): boolean {
    return this.floorRecovering;
  }

  /** How much of the last command the predictive floor branch owned, 0..1. */
  get floorAvoidance(): number {
    return this.floorStrength;
  }

  /**
   * Rungs 1-2. Returns the plan to fly — the caller's own plan when nothing is
   * wrong, a routed or escaping plan when it is.
   *
   * `commandedThrottle` is the throttle the ship is CURRENTLY integrating (the
   * last order sent), not the plan's: the question is whether a powered command
   * has failed to move the hull, and the plan is only a proposal.
   */
  plan(
    snapshot: Snapshot,
    self: ShipSnapshot,
    plan: BotPlan | null,
    nowMs: number,
    commandedThrottle: number,
  ): BotPlan | null {
    const contacts = this.activeContacts(snapshot, self);
    const stalled = this.commandedProgressFailed(self, nowMs, commandedThrottle);

    if (this.escape) {
      const surface = surfaceByKey(snapshot, self, this.env.floorY, this.env.arenaBounds, this.escape.key);
      const separated = !surface || surface.clearance >= this.exitClearance(self);
      if (separated || nowMs - this.escape.sinceMs >= ESCAPE_MAX_MS) {
        this.escape = null;
        this.stall = null;
        return plan;
      }
      return this.escapePlan(self, contacts, surface);
    }

    // Two independent ways to arm, and they are deliberately not chained: a
    // stationary window against a surface we are touching, OR a commanded
    // progress failure (which has already measured its own window, so it must
    // not wait for a second one). A hull still travelling is not wedged whatever
    // it is touching — contact at speed is a graze.
    const nearest = contacts[0] ?? null;
    const speed = self.velocity ? Math.hypot(self.velocity.x, self.velocity.y, self.velocity.z) : Infinity;
    let contactArmed = false;
    if (!nearest || speed >= WEDGE_SPEED) {
      this.stall = null;
    } else {
      const held = this.stall
        && this.stall.key === nearest.key
        && dist3(this.stall.anchor, self.pos) <= this.stallRadius(self);
      if (!held) this.stall = { key: nearest.key, sinceMs: nowMs, anchor: point(self.pos) };
      else contactArmed = nowMs - this.stall!.sinceMs >= STALL_MS;
    }
    if (!contactArmed && !stalled) return plan;

    // Rung 1: the way ahead is scenery, not a wall we are already against.
    const routed = this.routeAround(snapshot, self, plan, contacts);
    if (routed) return routed;

    // Rung 2: commit to an outward escape. Only a REAL contact can be pushed
    // off — a commanded stall touching nothing has no surface to escape, and
    // aiming at the outward normal of the nearest thing in the arena would fly
    // a healthy bot away from its own route.
    if (!nearest) return plan;
    this.escape = { key: nearest.key, normal: nearest.normal, side: this.env.orbitSign, sinceMs: nowMs };
    return this.escapePlan(self, contacts, nearest);
  }

  /**
   * Rung 3 — predictive floor-crash prevention, blended over the assembled
   * command. Utility owns the stick above the band and increasingly yields as
   * impact approaches; this is deliberately an overlay, not a position clamp.
   *
   * The three fixes from the parked-nose-down deadlock (69639cd) are preserved
   * exactly: the climb target is relative to the hull's OWN altitude, it is led
   * 45° along the nose instead of straight overhead (a point directly above a
   * nose-down hull is the singular case of the two-axis body decomposition), and
   * the throttle cut keeps a floor under it while the hull is slow, because a
   * stalled hull's projection reads the plan's throttle and would otherwise
   * predict a crash forever.
   */
  avoidFloor(self: ShipSnapshot, cmd: FlightCommand, steering: RecoverySteering): FlightCommand {
    this.floorStrength = 0;
    if (this.env.floorY === undefined) return cmd;
    const radius = self.colliderRadius ?? 0;
    // The terrain mesh has visual relief, but collision is the authored floor
    // plane. Keep a small hull clearance without treating normal lunar spawn/
    // base altitude (y=8..10) as an emergency band.
    const clearance = Math.max(radius * FLOOR_RECOVERY_CLEARANCE_MULT, radius + 3);
    const safeY = this.env.floorY + clearance;
    const noseY = Math.sin(self.pitch);
    const observedVy = self.velocity?.y ?? 0;
    const projectedVy = Math.min(observedVy, noseY * FLOOR_NOMINAL_SPEED * cmd.throttle);
    const predictedY = self.pos.y + projectedVy * FLOOR_LOOKAHEAD_SEC;
    const recoveryExitY = safeY + Math.max(radius, 2);
    if (self.pos.y <= safeY) this.floorRecovering = true;
    else if (self.pos.y >= recoveryExitY && predictedY >= safeY) this.floorRecovering = false;
    if (!this.floorRecovering && predictedY >= safeY) return cmd;

    const strength = this.floorRecovering ? 1 : clamp((safeY - predictedY) / FLOOR_BAND, 0, 1);
    this.floorStrength = strength;
    const rise = Math.max(safeY, self.pos.y) + FLOOR_BAND - self.pos.y;
    const lift = steerForPoint(
      self.pos,
      self.heading,
      self.pitch,
      {
        x: self.pos.x + Math.cos(self.heading) * rise,
        y: self.pos.y + rise,
        z: self.pos.z + Math.sin(self.heading) * rise,
      },
      {
        turnRate: steering.turnRate,
        pitchRate: steering.pitchRate,
        horizonSec: steering.horizonSec,
        toleranceRad: steering.toleranceRad,
        maxPitchRad: steering.maxPitchRad,
      },
      self.up,
    );
    const speed = self.velocity ? Math.hypot(self.velocity.x, self.velocity.y, self.velocity.z) : Infinity;
    return {
      turn: cmd.turn + (lift.turn - cmd.turn) * strength,
      pitchStick: cmd.pitchStick + (lift.pitchStick - cmd.pitchStick) * strength,
      // Rotation is speed-independent; retain enough thrust to turn the new
      // upward attitude into actual separation instead of hovering in a cut.
      throttle: this.floorRecovering
        ? (self.pitch > 0.12 ? Math.max(cmd.throttle, 0.7) : Math.max(cmd.throttle * 0.5, 0.25))
        : Math.max(
            cmd.throttle * (1 - strength) + (self.pitch > 0 ? Math.min(cmd.throttle, 0.35) : 0) * strength,
            speed < FLOOR_STALL_SPEED ? Math.min(cmd.throttle, FLOOR_STALL_THROTTLE) : 0,
          ),
      boost: strength < 0.15 && cmd.boost,
    };
  }

  /** True only after a sustained powered command has failed to move the hull. */
  private commandedProgressFailed(self: ShipSnapshot, nowMs: number, commandedThrottle: number): boolean {
    if (commandedThrottle < COMMANDED_STALL_THROTTLE) {
      this.commandedStall = null;
      return false;
    }
    if (!this.commandedStall || dist3(this.commandedStall.anchor, self.pos) > this.stallRadius(self)) {
      this.commandedStall = { sinceMs: nowMs, anchor: point(self.pos) };
      return false;
    }
    return nowMs - this.commandedStall.sinceMs >= STALL_MS;
  }

  /**
   * Every surface whose COLLIDER gap has fallen inside the rendered-overhang
   * band, nearest first. Both extents count: the lesson of the twin-titans
   * heavies is that a hull can be visually buried in a rock while both colliders
   * still report clearance, and the lesson before that is that rendered
   * proximity on its own is not contact either. The band is the honest middle.
   */
  private activeContacts(snapshot: Snapshot, self: ShipSnapshot): RestSurface[] {
    const own = this.ownOverhang(self);
    const found: RestSurface[] = [];
    for (const surface of restSurfaces(snapshot, self, this.env.floorY, this.env.arenaBounds)) {
      // The band is the OWN hull's rendered overhang, not the obstacle's. A
      // colossal whose rendered shell laps over the hull while both colliders
      // still report clearance is a ROUTE problem (rung 1) — calling it contact
      // hijacked every slow flag arrival on lunar-crater and put both CTF
      // acceptance seeds back on the 600 s cap.
      if (surface.clearance <= VISUAL_MARGIN + own) found.push(surface);
    }
    return found.sort((a, b) => a.clearance - b.clearance || (a.key < b.key ? -1 : 1));
  }

  private ownOverhang(self: ShipSnapshot): number {
    const radius = self.colliderRadius ?? 0;
    return Math.max(0, (this.env.visualRadius ?? radius) - radius);
  }

  private stallRadius(self: ShipSnapshot): number {
    return Math.max(STALL_RADIUS, (self.colliderRadius ?? 0) / 1.4);
  }

  private exitClearance(self: ShipSnapshot): number {
    const radius = self.colliderRadius ?? 0;
    return Math.max(ESCAPE_CLEARANCE, radius * ESCAPE_RADIUS_MULT, this.ownOverhang(self) + radius * 2);
  }

  /**
   * A target behind rendered scenery is a ROUTE problem, not a contact one.
   * Replace the through-rock bearing with a deterministic tangent waypoint
   * outside the rendered obstacle; because it changes the plan's destination
   * rather than nudging the stick, the winning behaviour's own steering cannot
   * cancel it.
   */
  private routeAround(
    snapshot: Snapshot,
    self: ShipSnapshot,
    plan: BotPlan | null,
    contacts: readonly RestSurface[],
  ): BotPlan | null {
    if (!plan?.aim) return null;
    // A blocker the hull is ALREADY touching is not a route problem: the corridor
    // test is trivially true from inside the inflated sphere, so routing here
    // would swallow every contact and the outward escape below could never run.
    const touching = new Set(contacts.map((contact) => contact.key));
    const ownVisual = this.env.visualRadius ?? self.colliderRadius ?? 0;
    const aim = point(plan.aim);
    let blocker: Snapshot["asteroids"][number] | null = null;
    let distance = Infinity;
    for (const asteroid of snapshot.asteroids) {
      if (asteroid.state === "destroyed" || touching.has(`collider:${asteroid.id}`)) continue;
      const radius = asteroid.radius + ownVisual + VISUAL_MARGIN;
      if (!segmentIntersectsSphere(self.pos, aim, asteroid.pos, radius)) continue;
      const candidate = dist3(self.pos, asteroid.pos);
      if (candidate < distance) {
        blocker = asteroid;
        distance = candidate;
      }
    }
    if (!blocker) return null;
    const dx = self.pos.x - blocker.pos.x;
    const dz = self.pos.z - blocker.pos.z;
    const planar = Math.hypot(dx, dz);
    const nx = planar > 1e-6 ? dx / planar : Math.cos(self.heading);
    const nz = planar > 1e-6 ? dz / planar : Math.sin(self.heading);
    const clearance = blocker.radius + ownVisual + ROUTE_CLEARANCE;
    return {
      ...plan,
      aim: {
        x: blocker.pos.x + (nx - nz * this.env.orbitSign) * clearance,
        y: self.pos.y,
        z: blocker.pos.z + (nz + nx * this.env.orbitSign) * clearance,
      },
      throttle: Math.max(plan.throttle, ROUTE_THROTTLE),
      arrive: false,
      boost: false,
    };
  }

  /**
   * Fly out along the composed outward normal of every active contact — a hull
   * wedged in the seam between the floor and a rock has two constraints, and
   * pushing off only the nearest one presses it into the other.
   */
  private escapePlan(self: ShipSnapshot, contacts: readonly RestSurface[], fallback: RestSurface | null): BotPlan {
    const normal = composeNormal(contacts, fallback?.normal ?? this.escape!.normal);
    this.escape!.normal = normal;
    const noseDot = Math.cos(self.pitch) * Math.cos(self.heading) * normal.x
      + Math.sin(self.pitch) * normal.y
      + Math.cos(self.pitch) * Math.sin(self.heading) * normal.z;
    // A direction exactly opposite the nose is singular in the two-axis body
    // decomposition: both candidate turn planes are equally valid. Give that
    // case a deterministic tangential component so recovery cannot command
    // turn=0, pitch=0, throttle=0 forever while nose-in against a surface.
    const tangentLength = Math.hypot(normal.x, normal.z);
    const tx = tangentLength > 1e-6 ? -normal.z / tangentLength : 1;
    const tz = tangentLength > 1e-6 ? normal.x / tangentLength : 0;
    const bias = noseDot < -0.9 ? ANTIPARALLEL_BIAS * this.escape!.side : 0;
    const aimNormal = {
      x: normal.x + tx * bias,
      // Include lift for a mostly vertical wall. A pure planar tangent can still
      // project to signed zero in the persisted body frame at exactly 180
      // degrees; the up component makes the escape direction unambiguous.
      y: normal.y + (Math.abs(normal.y) < 0.9 ? Math.abs(bias) : 0),
      z: normal.z + tz * bias,
    };
    const reach = Math.max(ESCAPE_AIM_DISTANCE, (self.colliderRadius ?? 0) * ESCAPE_AIM_RADIUS_MULT);
    return {
      aim: {
        x: self.pos.x + aimNormal.x * reach,
        y: self.pos.y + aimNormal.y * reach,
        z: self.pos.z + aimNormal.z * reach,
      },
      // Do not rebuild the cancelled inward velocity while turning. As soon as
      // the nose has an outward component, full thrust creates real separation.
      throttle: noseDot > ESCAPE_NOSE_DOT ? 1 : 0,
      boost: false,
      engaged: false,
    };
  }
}

interface ContactCollider { id: EntityId; pos: Required<Vec3>; radius: number; visualRadius?: number }

export interface RestSurface {
  key: string;
  clearance: number;
  normal: Required<Vec3>;
  /** Rendered obstacle extent beyond its authoritative collider. */
  visualOverhang?: number;
}

/** Unit sum of the active contact normals; the fallback covers an empty set. */
function composeNormal(contacts: readonly RestSurface[], fallback: Required<Vec3>): Required<Vec3> {
  let x = 0;
  let y = 0;
  let z = 0;
  for (const contact of contacts) {
    x += contact.normal.x;
    y += contact.normal.y;
    z += contact.normal.z;
  }
  const length = Math.hypot(x, y, z);
  // Exactly opposing contacts (a hull pinned between two walls) cancel; the
  // nearest surface's own normal is then the honest answer.
  if (length < 1e-6) return fallback;
  return { x: x / length, y: y / length, z: z / length };
}

function restSurfaces(
  snapshot: Snapshot,
  self: ShipSnapshot,
  floorY: number | undefined,
  arenaBounds: ArenaBounds | undefined,
): RestSurface[] {
  const out: RestSurface[] = [];
  if (floorY !== undefined) {
    out.push({
      key: "floor",
      clearance: self.pos.y - floorY - (self.colliderRadius ?? 0),
      normal: { x: 0, y: 1, z: 0 },
    });
  }
  const shell = arenaShellSurface(self, arenaBounds);
  if (shell) out.push(shell);
  for (const asteroid of snapshot.asteroids) {
    if (asteroid.state === "destroyed") continue;
    out.push(colliderRestSurface(self, {
      id: asteroid.id,
      pos: asteroid.pos,
      radius: asteroid.colliderRadius ?? asteroid.radius,
      visualRadius: asteroid.radius,
    }));
  }
  for (const ship of snapshot.ships) {
    if (ship.id !== self.id) out.push(colliderRestSurface(self, { id: ship.id, pos: ship.pos, radius: ship.colliderRadius ?? 0 }));
  }
  return out;
}

function surfaceByKey(
  snapshot: Snapshot,
  self: ShipSnapshot,
  floorY: number | undefined,
  arenaBounds: ArenaBounds | undefined,
  key: string,
): RestSurface | null {
  if (key === "floor") {
    return floorY === undefined ? null : {
      key,
      clearance: self.pos.y - floorY - (self.colliderRadius ?? 0),
      normal: { x: 0, y: 1, z: 0 },
    };
  }
  if (key === "arena:shell") return arenaShellSurface(self, arenaBounds);
  const id = Number(key.slice("collider:".length));
  const collider = colliderById(snapshot, self, id);
  return collider ? colliderRestSurface(self, collider) : null;
}

function arenaShellSurface(self: ShipSnapshot, bounds: ArenaBounds | undefined): RestSurface | null {
  if (!bounds || bounds.shape !== "sphere") return null;
  const length = Math.hypot(self.pos.x, self.pos.y, self.pos.z) || 1;
  return {
    key: "arena:shell",
    clearance: bounds.radius - (self.colliderRadius ?? 0) - length,
    // The playable volume is inside the shell, so its escape normal is inward.
    normal: { x: -self.pos.x / length, y: -self.pos.y / length, z: -self.pos.z / length },
  };
}

function colliderRestSurface(self: ShipSnapshot, collider: ContactCollider): RestSurface {
  const dx = self.pos.x - collider.pos.x;
  const dy = self.pos.y - collider.pos.y;
  const dz = self.pos.z - collider.pos.z;
  const length = Math.hypot(dx, dy, dz) || 1;
  return {
    key: `collider:${collider.id}`,
    clearance: length - (self.colliderRadius ?? 0) - collider.radius,
    normal: { x: dx / length, y: dy / length, z: dz / length },
    visualOverhang: Math.max(0, (collider.visualRadius ?? collider.radius) - collider.radius),
  };
}

function colliderById(snapshot: Snapshot, self: ShipSnapshot, id: EntityId): ContactCollider | null {
  const asteroid = snapshot.asteroids.find((candidate) => candidate.id === id && candidate.state !== "destroyed");
  if (asteroid) return {
    id,
    pos: asteroid.pos,
    radius: asteroid.colliderRadius ?? asteroid.radius,
    visualRadius: asteroid.radius,
  };
  const ship = snapshot.ships.find((candidate) => candidate.id === id && candidate.id !== self.id);
  return ship ? { id, pos: ship.pos, radius: ship.colliderRadius ?? 0 } : null;
}

/** Copy an aim/position point, normalising the optional `y` a plan may omit. */
function point(value: Vec3): Required<Vec3> {
  return { x: value.x, y: value.y ?? 0, z: value.z };
}
