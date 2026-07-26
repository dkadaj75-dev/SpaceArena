import type { ConfigService } from "../core/ConfigService.js";
import type { ArenaConfig, GamemodeConfig, TuningConfig } from "../schemas/index.js";
import type {
  AsteroidTag,
  ColliderComp,
  EntityId,
  FlightState,
  ModulesComp,
  Projectile,
  ShipCore,
  TargetRef,
  Team,
  Transform2D,
  Velocity,
} from "./components.js";
import type { SimEvent } from "./events.js";
import type { Order, QueuedOrder } from "./orders.js";
import { Rng } from "./rng.js";
import { SpatialHash } from "./spatialHash.js";

/**
 * ECS-lite container: an id allocator, plain-map component stores, an outgoing
 * event queue and an incoming order queue. Systems are plain functions that read
 * and mutate these stores; nothing here knows about rendering. Fully
 * deterministic — no wall-clock, seeded Rng for any randomness.
 */
export class World {
  private nextId = 1;
  readonly entities = new Set<EntityId>();

  // Component stores (plain maps; fine at arena scale).
  readonly transforms = new Map<EntityId, Transform2D>();
  readonly velocities = new Map<EntityId, Velocity>();
  /** Persistent flight input per ship (level-triggered; see {@link FlightState}). */
  readonly flightStates = new Map<EntityId, FlightState>();
  readonly shipCores = new Map<EntityId, ShipCore>();
  readonly modules = new Map<EntityId, ModulesComp>();
  readonly targets = new Map<EntityId, TargetRef>();
  readonly colliders = new Map<EntityId, ColliderComp>();
  readonly teams = new Map<EntityId, Team>();
  readonly asteroids = new Map<EntityId, AsteroidTag>();
  readonly projectiles = new Map<EntityId, Projectile>();

  readonly events: SimEvent[] = [];
  private readonly orderQueue: QueuedOrder[] = [];

  readonly rng: Rng;
  readonly spatial: SpatialHash;

  /** Per-tick LoS cache keyed by ordered entity-pair. Cleared each tick. */
  readonly losCache = new Map<number, boolean>();

  /** Remaining impact-damage immunity per ship/asteroid pair (seconds). Persistent. */
  readonly impactCooldowns = new Map<number, number>();

  constructor(
    readonly configs: ConfigService,
    readonly tuning: TuningConfig,
    readonly arena: ArenaConfig,
    readonly gamemode: GamemodeConfig,
    seed = 1,
  ) {
    this.rng = new Rng(seed);
    this.spatial = new SpatialHash(tuning.spatialCellSize ?? 16);
  }

  createEntity(): EntityId {
    const id = this.nextId++;
    this.entities.add(id);
    return id;
  }

  destroyEntity(id: EntityId): void {
    this.entities.delete(id);
    this.transforms.delete(id);
    this.velocities.delete(id);
    this.flightStates.delete(id);
    this.shipCores.delete(id);
    this.modules.delete(id);
    this.targets.delete(id);
    this.colliders.delete(id);
    this.teams.delete(id);
    this.asteroids.delete(id);
    this.projectiles.delete(id);
  }

  isAlive(id: EntityId): boolean {
    return this.entities.has(id);
  }

  /** Enqueue an order for an entity (mirrors the netcode `room.send("order")`). */
  queueOrder(entityId: EntityId, order: Order): void {
    this.orderQueue.push({ entityId, order });
  }

  /** Remove and return all queued orders of a given kind (id order preserved). */
  takeOrders<K extends Order["kind"]>(kind: K): Array<QueuedOrder & { order: Extract<Order, { kind: K }> }> {
    const out: Array<QueuedOrder & { order: Extract<Order, { kind: K }> }> = [];
    for (let i = this.orderQueue.length - 1; i >= 0; i--) {
      if (this.orderQueue[i]!.order.kind === kind) {
        out.unshift(this.orderQueue.splice(i, 1)[0] as QueuedOrder & { order: Extract<Order, { kind: K }> });
      }
    }
    return out;
  }

  emit(event: SimEvent): void {
    this.events.push(event);
  }

  /** Drain the event queue (caller relays to render/netcode). */
  drainEvents(): SimEvent[] {
    const out = this.events.splice(0, this.events.length);
    return out;
  }

  /** Ship entity ids in ascending order (deterministic iteration). */
  shipIds(): EntityId[] {
    return Array.from(this.shipCores.keys()).sort((a, b) => a - b);
  }

  asteroidIds(): EntityId[] {
    return Array.from(this.asteroids.keys()).sort((a, b) => a - b);
  }

  projectileIds(): EntityId[] {
    return Array.from(this.projectiles.keys()).sort((a, b) => a - b);
  }
}
