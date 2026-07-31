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
  Transform3D,
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
  readonly transforms = new Map<EntityId, Transform3D>();
  readonly velocities = new Map<EntityId, Velocity>();
  /** Persistent flight input per ship (level-triggered; see {@link FlightState}). */
  readonly flightStates = new Map<EntityId, FlightState>();
  /**
   * Last ordered trigger level. Kept separately because a tick may temporarily
   * OR several queued fire edges while the final order remains the next tick's
   * standing level.
   */
  readonly flightFireLevels = new Map<EntityId, boolean>();
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
  private readonly initialTuning: TuningConfig;

  /** Per-tick LoS cache keyed by ordered entity-pair. Cleared each tick. */
  readonly losCache = new Map<number, boolean>();

  /** Remaining impact-damage immunity per ship/asteroid pair (seconds). Persistent. */
  readonly impactCooldowns = new Map<number, number>();

  /** Ships touching the arena boundary on the previous collision tick (event-edge latch). */
  readonly boundaryContacts = new Set<EntityId>();

  constructor(
    readonly configs: ConfigService,
    tuning: TuningConfig,
    readonly arena: ArenaConfig,
    readonly gamemode: GamemodeConfig,
    seed = 1,
  ) {
    this.initialTuning = tuning;
    this.rng = new Rng(seed);
    this.spatial = new SpatialHash(tuning.spatialCellSize ?? 16);
  }

  /**
   * Offline editor changes use the same ConfigService instance as the practice
   * sim, so re-resolve tuning by id instead of pinning the startup object.
   * Server rooms pin an entire ConfigService instance, preserving online pack
   * coherence while still allowing offline hot tuning.
   */
  get tuning(): TuningConfig {
    return this.configs.get<TuningConfig>("tuning", this.initialTuning.id) ?? this.initialTuning;
  }

  createEntity(): EntityId {
    const id = this.nextId++;
    this.entities.add(id);
    return id;
  }

  /**
   * Re-register a PREVIOUSLY destroyed entity id — how a respawn keeps a ship's
   * identity stable for everything bound to it (the local player id, bot
   * drivers, the server's PlayerState, HUD views). Only ids handed out by
   * {@link createEntity} and since destroyed are legal; re-registering a live
   * id is a programming error and throws.
   */
  restoreEntity(id: EntityId): void {
    if (this.entities.has(id)) throw new Error(`restoreEntity: ${id} is still alive`);
    if (id >= this.nextId) throw new Error(`restoreEntity: ${id} was never allocated`);
    this.entities.add(id);
  }

  destroyEntity(id: EntityId): void {
    this.entities.delete(id);
    this.transforms.delete(id);
    this.velocities.delete(id);
    this.flightStates.delete(id);
    this.flightFireLevels.delete(id);
    this.shipCores.delete(id);
    this.modules.delete(id);
    this.targets.delete(id);
    this.colliders.delete(id);
    this.teams.delete(id);
    this.asteroids.delete(id);
    this.projectiles.delete(id);
    this.boundaryContacts.delete(id);
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
