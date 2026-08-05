import { beforeAll, describe, expect, it } from "vitest";
import type { ConfigService } from "../core/ConfigService.js";
import type { TuningConfig } from "../schemas/index.js";
import { ArenaSimulation } from "./ArenaSimulation.js";
import { applyDamageToShip } from "./damage.js";
import { angleDelta, facingVec } from "./math.js";
import { seedUp } from "./frame.js";
import { spawnAsteroid, spawnProjectile, spawnShipFromConfig } from "./spawn.js";
import { collisionSystem } from "./systems/CollisionSystem.js";
import { navigationSystem } from "./systems/NavigationSystem.js";
import { projectileSystem } from "./systems/ProjectileSystem.js";
import { INTERCEPTOR_FITTING, loadTestConfigs, makeWorld, rebuildSpatial } from "./testutil.js";
import { World } from "./World.js";

const DT = 1 / 30;

let configs: ConfigService;
beforeAll(async () => {
  configs = await loadTestConfigs();
});

describe("CollisionSystem boundary", () => {
  it("damages and bounces a ship diving through a sphere floor", () => {
    const base = makeWorld(configs, {
      gamemodeOverride: {
        boundaryRule: { type: "damageAndBounce", damagePerSec: 30, restitution: 0.8 },
      },
    });
    if (base.arena.bounds.shape !== "sphere") throw new Error("test arena must be spherical");
    const world = new World(
      configs,
      base.tuning,
      { ...base.arena, bounds: { ...base.arena.bounds, floorY: -20 } },
      base.gamemode,
    );
    const id = spawnShipFromConfig(
      world,
      configs,
      "ship.interceptor",
      INTERCEPTOR_FITTING,
      0,
      { x: 0, y: -20, z: 0 },
      0,
    );
    const colliderRadius = world.colliders.get(id)!.radius;
    world.transforms.get(id)!.pos.y = -20 + colliderRadius - 1;
    world.velocities.get(id)!.y = -10;
    const before = world.shipCores.get(id)!.hull;

    collisionSystem(world, DT);

    expect(world.shipCores.get(id)!.hull).toBeCloseTo(before - 1);
    expect(world.velocities.get(id)!.y).toBeCloseTo(8);
    expect(world.transforms.get(id)!.pos.y).toBeCloseTo(-20 + colliderRadius);
  });

  it("bounces a ship off the bubble", () => {
    const world = makeWorld(configs, {
      gamemodeOverride: { boundaryRule: { type: "bounce", restitution: 1 } },
    });
    const radius = world.arena.bounds.shape === "sphere" ? world.arena.bounds.radius : 0;
    const id = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, { x: radius - 1, z: 0 }, 0);
    world.velocities.get(id)!.x = 30;
    collisionSystem(world, DT);
    expect(world.velocities.get(id)!.x).toBeLessThan(0); // reflected inward
    const p = world.transforms.get(id)!.pos;
    expect(Math.sqrt(p.x * p.x + p.z * p.z)).toBeLessThanOrEqual(radius);
  });

  it("damages a ship that leaves a damaging boundary", () => {
    const world = makeWorld(configs, { gamemodeId: "gamemode.duel-1v1" }); // boundary: damage
    const radius = world.arena.bounds.shape === "sphere" ? world.arena.bounds.radius : 0;
    const id = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, { x: radius + 10, z: 0 }, 0);
    const before = world.shipCores.get(id)!.hull;
    collisionSystem(world, DT);
    expect(world.shipCores.get(id)!.hull).toBeLessThan(before);
    expect(world.events.some((e) => e.type === "boundaryHit")).toBe(true);
  });

  it("composite contact deals damage and reflects outward velocity", () => {
    const world = makeWorld(configs, {
      gamemodeOverride: {
        boundaryRule: { type: "damageAndBounce", damagePerSec: 30, restitution: 0.8 },
      },
    });
    const radius = world.arena.bounds.shape === "sphere" ? world.arena.bounds.radius : 0;
    const id = spawnShipFromConfig(
      world,
      configs,
      "ship.interceptor",
      INTERCEPTOR_FITTING,
      0,
      { x: radius + 10, z: 0 },
      0,
    );
    world.velocities.get(id)!.x = 30;
    const before = world.shipCores.get(id)!.hull;

    collisionSystem(world, DT);

    expect(world.shipCores.get(id)!.hull).toBeCloseTo(before - 1);
    expect(world.velocities.get(id)!.x).toBeLessThan(0);
    expect(world.events).toContainEqual(
      expect.objectContaining({ type: "boundaryHit", entityId: id, rule: "damageAndBounce" }),
    );
  });

  it("reflects powered flight attitude so held thrust separates and boundary damage stops", () => {
    const world = makeWorld(configs, {
      gamemodeOverride: {
        boundaryRule: { type: "damageAndBounce", damagePerSec: 30, restitution: 0.8 },
      },
    });
    const radius = world.arena.bounds.shape === "sphere" ? world.arena.bounds.radius : 0;
    const id = spawnShipFromConfig(
      world,
      configs,
      "ship.interceptor",
      INTERCEPTOR_FITTING,
      0,
      { x: radius - 1.5, z: 0 },
      0,
    );
    world.queueOrder(id, { kind: "flight", throttle: 1, turn: 0, pitchStick: 0, boost: false, fire: true });

    let contactHull: number | null = null;
    let contactRadius = 0;
    for (let tick = 0; tick < 30 && contactHull === null; tick++) {
      navigationSystem(world, DT);
      collisionSystem(world, DT);
      if (world.events.some((event) => event.type === "boundaryHit" && event.entityId === id)) {
        contactHull = world.shipCores.get(id)!.hull;
        const pos = world.transforms.get(id)!.pos;
        contactRadius = Math.hypot(pos.x, pos.y, pos.z);
      }
      world.drainEvents();
    }

    expect(contactHull).not.toBeNull();
    expect(Math.abs(world.transforms.get(id)!.heading)).toBeGreaterThan(Math.PI / 2);
    for (let tick = 0; tick < 20; tick++) {
      navigationSystem(world, DT);
      collisionSystem(world, DT);
      world.drainEvents();
    }
    const end = world.transforms.get(id)!.pos;
    expect(Math.hypot(end.x, end.y, end.z)).toBeLessThan(contactRadius - 2);
    expect(world.shipCores.get(id)!.hull).toBe(contactHull);
  });

  it("reflects an INVERTED attitude without snapping it upright", () => {
    // Free pitch (BUBBLE.md §A) means a ship can reach the rim mid-loop. The
    // reflected DIRECTION is unambiguous, but the (heading, pitch) pair naming it
    // is not, and the naive `atan2`/`asin` decomposition always answers the
    // upright spelling — which for an inverted ship means heading jumps by ~PI
    // and pitch by ~1.5 rad for a reflection that barely moved the nose. Every
    // consumer that interpolates attitude (the mesh, the chase camera, remote
    // ships) would render a violent manoeuvre that never happened.
    const world = makeWorld(configs, {
      gamemodeOverride: { boundaryRule: { type: "bounce", restitution: 1 } },
    });
    const radius = world.arena.bounds.shape === "sphere" ? world.arena.bounds.radius : 0;
    const id = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 0, z: 0 }, 0);
    const tf = world.transforms.get(id)!;
    // Over the top of a loop, climbing out through the roof of the bubble. The
    // persisted up must be re-seeded with the poked attitude — the frame is
    // authoritative now, and a mid-loop ship carries the INVERTED derived up.
    tf.pos.y = radius - 1;
    tf.heading = 0.4;
    tf.pitch = 2.6; // inverted: cos < 0, nose still rising
    Object.assign(tf.up, seedUp(0.4, 2.6));
    const beforeHeading = tf.heading;
    const beforePitch = tf.pitch;
    const beforeNose = facingVec(tf.heading, tf.pitch, { x: 0, y: 0, z: 0 });
    world.velocities.get(id)!.y = 30;

    collisionSystem(world, DT);

    // The nose really was reflected — its vertical component changed sign.
    const afterNose = facingVec(tf.heading, tf.pitch, { x: 0, y: 0, z: 0 });
    expect(beforeNose.y).toBeGreaterThan(0);
    expect(afterNose.y).toBeLessThan(0);
    // ...and horizontally it is unchanged, which is what a reflection off the
    // roof means. Checking the DIRECTION, not the spelling.
    expect(afterNose.x).toBeCloseTo(beforeNose.x, 12);
    expect(afterNose.z).toBeCloseTo(beforeNose.z, 12);
    // The spelling stayed continuous: still inverted, and the heading is
    // UNTOUCHED — a reflection off the roof is a pure elevation flip, so in the
    // right spelling pitch simply negates and yaw does not move at all. The
    // upright spelling would instead have swung the heading by PI.
    expect(Math.cos(tf.pitch)).toBeLessThan(0);
    expect(tf.heading).toBeCloseTo(beforeHeading, 12);
    expect(tf.pitch).toBeCloseTo(-beforePitch, 12);
    // Short-arc distance travelled by the pitch value, which crosses ±PI here:
    // ~1.08 rad, not the ~5.2 a naive subtraction would report and not the ~3.14
    // the upright spelling would have jumped.
    expect(Math.abs(angleDelta(beforePitch, tf.pitch))).toBeLessThan(1.1);
  });

  it("still reflects an UPRIGHT attitude to the plain upright spelling", () => {
    // The continuity rule must not disturb the ordinary case: a level-ish ship
    // bouncing off the roof gets exactly the attitude the old atan2/asin pair
    // produced, which is also the only spelling a legacy-clamped pack can hold.
    const world = makeWorld(configs, {
      gamemodeOverride: { boundaryRule: { type: "bounce", restitution: 1 } },
    });
    const radius = world.arena.bounds.shape === "sphere" ? world.arena.bounds.radius : 0;
    const id = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 0, z: 0 }, 0);
    const tf = world.transforms.get(id)!;
    tf.pos.y = radius - 1;
    tf.heading = 0.4;
    tf.pitch = 0.9;
    world.velocities.get(id)!.y = 30;

    collisionSystem(world, DT);

    expect(tf.pitch).toBeCloseTo(-0.9, 12);
    expect(tf.heading).toBeCloseTo(0.4, 12);
    expect(Math.cos(tf.pitch)).toBeGreaterThan(0);
  });

  it("emits one boundary edge while a ship continuously grinds a warning wall", () => {
    const world = makeWorld(configs, {
      gamemodeOverride: { boundaryRule: { type: "warning" } },
    });
    const radius = world.arena.bounds.shape === "sphere" ? world.arena.bounds.radius : 0;
    const id = spawnShipFromConfig(
      world,
      configs,
      "ship.interceptor",
      INTERCEPTOR_FITTING,
      0,
      { x: radius + 10, z: 0 },
      0,
    );

    for (let tick = 0; tick < 30; tick++) collisionSystem(world, DT);

    expect(
      world.events.filter((event) => event.type === "boundaryHit" && event.entityId === id),
    ).toHaveLength(1);
  });

  it("bounces off the TOP of the bubble, reflecting the vertical velocity", () => {
    // The whole point of a sphere: climbing out is bounded exactly like flying
    // out sideways, and the reflection is 3D (BUBBLE.md §A).
    const world = makeWorld(configs, {
      gamemodeOverride: { boundaryRule: { type: "bounce", restitution: 1 } },
    });
    const radius = world.arena.bounds.shape === "sphere" ? world.arena.bounds.radius : 0;
    const id = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 0, z: 0 }, 0);
    world.transforms.get(id)!.pos.y = radius - 1;
    world.velocities.get(id)!.y = 30;

    collisionSystem(world, DT);

    expect(world.velocities.get(id)!.y).toBeLessThan(0); // reflected back down
    const p = world.transforms.get(id)!.pos;
    expect(Math.hypot(p.x, p.y, p.z)).toBeLessThanOrEqual(radius);
  });

  it("damages a ship that climbs out of a damaging bubble, not just one that flies out flat", () => {
    const world = makeWorld(configs, { gamemodeId: "gamemode.duel-1v1" }); // boundary: damage
    const radius = world.arena.bounds.shape === "sphere" ? world.arena.bounds.radius : 0;
    const id = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 0, z: 0 }, 0);
    world.transforms.get(id)!.pos.y = radius + 10;
    const before = world.shipCores.get(id)!.hull;

    collisionSystem(world, DT);

    expect(world.shipCores.get(id)!.hull).toBeLessThan(before);
    expect(world.transforms.get(id)!.pos.y).toBeLessThanOrEqual(radius);
  });

  it("leaves a ship alone while it is deep inside the bubble but far off the plane", () => {
    const world = makeWorld(configs, { gamemodeId: "gamemode.duel-1v1" });
    const radius = world.arena.bounds.shape === "sphere" ? world.arena.bounds.radius : 0;
    const id = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 0, z: 0 }, 0);
    world.transforms.get(id)!.pos.y = radius * 0.5;
    const before = world.shipCores.get(id)!.hull;

    collisionSystem(world, DT);

    expect(world.shipCores.get(id)!.hull).toBe(before);
    expect(world.events.some((e) => e.type === "boundaryHit")).toBe(false);
  });

  it("enforces the ceiling of a supported rect arena", () => {
    const base = makeWorld(configs, { gamemodeOverride: { boundaryRule: { type: "bounce", restitution: 1 } } });
    const world = new World(
      configs,
      base.tuning,
      { ...base.arena, bounds: { shape: "rect", width: 120, height: 80, verticalExtent: 60 } },
      base.gamemode,
    );
    const id = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 0, y: 31, z: 0 }, 0);
    world.velocities.get(id)!.y = 10;

    collisionSystem(world, DT);

    expect(world.velocities.get(id)!.y).toBeLessThan(0);
    expect(world.transforms.get(id)!.pos.y).toBeLessThan(30);
  });
});

describe("CollisionSystem 3D narrowphase (BUBBLE.md §A)", () => {
  it("does not collide two ships that share an (x,z) cell but are vertically separated", () => {
    const world = makeWorld(configs);
    const a = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 0, z: 0 }, 0);
    const b = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 1, { x: 0, z: 0 }, 0);
    // Same column, well clear vertically. The planar broadphase still offers the
    // pair; only the 3D narrowphase keeps them apart.
    const gap = (world.colliders.get(a)!.radius + world.colliders.get(b)!.radius) * 3;
    world.transforms.get(b)!.pos.y = gap;
    rebuildSpatial(world);

    collisionSystem(world, DT);

    expect(world.transforms.get(a)!.pos).toEqual({ x: 0, y: 0, z: 0 });
    expect(world.transforms.get(b)!.pos).toEqual({ x: 0, y: gap, z: 0 });
  });

  it("pushes two overlapping ships apart along the 3D contact normal", () => {
    const world = makeWorld(configs);
    const a = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 0, z: 0 }, 0);
    const b = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 1, { x: 0, z: 0 }, 0);
    const sumR = world.colliders.get(a)!.radius + world.colliders.get(b)!.radius;
    world.transforms.get(b)!.pos.y = sumR * 0.5; // overlapping, purely vertically
    rebuildSpatial(world);

    collisionSystem(world, DT);

    const pa = world.transforms.get(a)!.pos;
    const pb = world.transforms.get(b)!.pos;
    expect(Math.hypot(pb.x - pa.x, pb.y - pa.y, pb.z - pa.z)).toBeCloseTo(sumR, 6);
    expect(pa.y).toBeLessThan(0); // separated along y, not along an arbitrary axis
    expect(pb.y).toBeGreaterThan(sumR * 0.5);
  });

  it("flies a ship clean over a rock it would have hit on the plane", () => {
    const world = makeWorld(configs);
    const rock = spawnAsteroid(world, configs, "asteroid.large-hazard", { x: 0, z: 0 });
    const id = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 0, z: 0 }, 0);
    const clearance = world.colliders.get(rock)!.radius + world.colliders.get(id)!.radius + 1;
    world.transforms.get(id)!.pos.y = clearance;
    const hullBefore = world.shipCores.get(id)!.hull;
    rebuildSpatial(world);

    collisionSystem(world, DT);

    expect(world.transforms.get(id)!.pos.y).toBe(clearance); // no push-out at all
    expect(world.shipCores.get(id)!.hull).toBe(hullBefore);
  });
});

describe("ProjectileSystem in 3D (BUBBLE.md §A)", () => {
  it("culls ordnance below a sphere floor plus the projectile margin", () => {
    const base = makeWorld(configs);
    if (base.arena.bounds.shape !== "sphere") throw new Error("test arena must be spherical");
    const world = new World(
      configs,
      base.tuning,
      { ...base.arena, bounds: { ...base.arena.bounds, floorY: -20 } },
      base.gamemode,
    );
    const margin = world.tuning.projectileBoundsMargin ?? 20;
    const shooter = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 0, z: 0 }, 0);
    const pid = spawnProjectile(world, {
      kind: "kinetic",
      damage: 10,
      damageType: "kinetic",
      speed: 1,
      lifetime: 60,
      ownerId: shooter,
      ownerTeam: 0,
      pos: { x: 0, y: -20 - margin - 1, z: 0 },
      heading: 0,
    });
    rebuildSpatial(world);

    projectileSystem(world, DT);

    expect(world.projectiles.has(pid)).toBe(false);
  });

  it("misses a target that is only planar-aligned, and hits one it truly passes through", () => {
    for (const [dy, expectHit] of [
      [12, false],
      [0, true],
    ] as const) {
      const world = makeWorld(configs);
      const shooter = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 0, z: 0 }, 0);
      const foe = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 1, { x: 10, z: 0 }, 0);
      world.transforms.get(foe)!.pos.y = dy;
      const pid = spawnProjectile(world, {
        kind: "kinetic",
        damage: 10,
        damageType: "kinetic",
        speed: 200,
        lifetime: 5,
        ownerId: shooter,
        ownerTeam: 0,
        pos: { x: 0, z: 0 },
        heading: 0,
      });
      rebuildSpatial(world);
      const hullBefore = world.shipCores.get(foe)!.hull;

      // A few ticks: long enough for the sweep to cover the 10 units to the foe.
      for (let t = 0; t < 4 && world.projectiles.has(pid); t++) projectileSystem(world, DT);

      expect(world.shipCores.get(foe)!.hull < hullBefore).toBe(expectHit);
      expect(world.projectiles.has(pid)).toBe(!expectHit);
    }
  });

  it("homes a missile onto a climbing target", () => {
    const world = makeWorld(configs);
    const shooter = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 0, z: 0 }, 0);
    const foe = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 1, { x: 40, z: 0 }, 0);
    const target = world.transforms.get(foe)!;
    const pid = spawnProjectile(world, {
      kind: "missile",
      damage: 10,
      damageType: "kinetic",
      speed: 60,
      turnRate: 3,
      lifetime: 6,
      ownerId: shooter,
      ownerTeam: 0,
      targetId: foe,
      pos: { x: 0, z: 0 },
      heading: 0,
    });
    const hullBefore = world.shipCores.get(foe)!.hull;

    // The target climbs steadily; the missile launched level and must pitch up.
    for (let t = 0; t < 120 && world.projectiles.has(pid); t++) {
      target.pos.y += 20 * DT;
      rebuildSpatial(world);
      projectileSystem(world, DT);
    }

    expect(target.pos.y).toBeGreaterThan(10); // it really did climb away from the plane
    expect(world.shipCores.get(foe)!.hull).toBeLessThan(hullBefore);
    expect(world.projectiles.has(pid)).toBe(false);
  });

  it("spends one total homing angular budget on a diagonal 3D bearing", () => {
    const world = makeWorld(configs);
    const shooter = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 0, z: 0 }, 0);
    const foe = spawnShipFromConfig(
      world,
      configs,
      "ship.interceptor",
      INTERCEPTOR_FITTING,
      1,
      { x: 40, y: 40, z: 40 },
      0,
    );
    const pid = spawnProjectile(world, {
      kind: "missile",
      damage: 10,
      damageType: "kinetic",
      speed: 20,
      turnRate: 1,
      lifetime: 5,
      ownerId: shooter,
      ownerTeam: 0,
      targetId: foe,
      pos: { x: 0, z: 0 },
      heading: 0,
    });
    rebuildSpatial(world);

    const dt = 0.2;
    projectileSystem(world, dt);

    const velocity = world.velocities.get(pid)!;
    const turned = Math.acos(velocity.x / Math.hypot(velocity.x, velocity.y, velocity.z));
    expect(turned).toBeCloseTo(dt, 12);
  });

  it("culls ordnance on 3D radial distance, so a shot fired straight up expires", () => {
    const world = makeWorld(configs);
    const radius = world.arena.bounds.shape === "sphere" ? world.arena.bounds.radius : 0;
    const margin = world.tuning.projectileBoundsMargin ?? 20;
    const shooter = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 0, z: 0 }, 0);
    const pid = spawnProjectile(world, {
      kind: "kinetic",
      damage: 10,
      damageType: "kinetic",
      speed: 100,
      lifetime: 60,
      ownerId: shooter,
      ownerTeam: 0,
      pos: { x: 0, y: radius + margin - 1, z: 0 },
      heading: 0,
      pitch: Math.PI / 2, // straight up, inside the bubble by a whisker
    });
    rebuildSpatial(world);

    projectileSystem(world, DT);

    // One tick carries it past radius + margin measured radially, not planar
    // (its x/z never leave the origin).
    expect(world.projectiles.has(pid)).toBe(false);
  });
});

describe("Win conditions", () => {
  it("ends a timeLimit match when time elapses", () => {
    const r = configs.replace({
      id: "gamemode.timed-test",
      type: "gamemode",
      version: 1,
      teams: "1v1",
      winCondition: { type: "timeLimit", seconds: 1 },
      respawn: { enabled: false, delay: 0 },
      boundaryRule: { type: "warning" },
      rewards: { win: 0, loss: 0, perKill: 0 },
    });
    expect(r.ok).toBe(true);
    const sim = new ArenaSimulation(configs, "arena.ring-nebula", "gamemode.timed-test");
    sim.spawnPlayerAt("ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 0, z: 0 });
    for (let i = 0; i < 40 && !sim.isEnded; i++) sim.tick(DT); // 40 ticks > 1s
    expect(sim.isEnded).toBe(true);
  });
});

describe("Offline tuning hot reload", () => {
  it("makes an existing practice world re-read replaced tuning", () => {
    const original = configs.getAll<TuningConfig>("tuning")[0]!;
    const world = makeWorld(configs);
    const changed = { ...structuredClone(original), globalDamageMult: 1.75, spatialCellSize: 23 };

    try {
      expect(configs.replace(changed).ok).toBe(true);
      expect(world.tuning.globalDamageMult).toBe(1.75);
      expect(world.tuning.spatialCellSize).toBe(23);
    } finally {
      expect(configs.replace(original).ok).toBe(true);
    }
  });
});

describe("Snapshots", () => {
  it("reports the ship's real FlightState throttle (0 without one)", () => {
    const sim = new ArenaSimulation(configs, "arena.ring-nebula", "gamemode.duel-1v1");
    const flyer = sim.spawnPlayerAt("ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 0, z: 0 });
    const drifter = sim.spawnPlayerAt("ship.interceptor", INTERCEPTOR_FITTING, 1, { x: 40, z: 0 });

    expect(sim.snapshot().ships.map((s) => s.throttle)).toEqual([0, 0]);

    sim.applyOrder(flyer, { kind: "flight", throttle: 0.6, turn: 0.2, boost: false, fire: true });
    sim.tick(DT);
    const ships = sim.snapshot().ships;
    expect(ships.find((s) => s.id === flyer)!.throttle).toBeCloseTo(0.6, 6);
    expect(ships.find((s) => s.id === drifter)!.throttle).toBe(0);

    // Level-triggered: the value persists across ticks with no further orders,
    // and only another flight order replaces it.
    for (let t = 0; t < 10; t++) sim.tick(DT);
    expect(sim.snapshot().ships.find((s) => s.id === flyer)!.throttle).toBeCloseTo(0.6, 6);
    sim.applyOrder(flyer, { kind: "flight", throttle: 0, turn: 0, boost: false, fire: true });
    sim.tick(DT);
    expect(sim.snapshot().ships.find((s) => s.id === flyer)!.throttle).toBe(0);
  });

  it("reports lock progress normalized 0..1 and the locked flag (FLIGHT.md §2)", () => {
    const sim = new ArenaSimulation(configs, "arena.ring-nebula", "gamemode.duel-1v1");
    // Facing each other down the +x axis: both sit in the other's sensor cone.
    const a = sim.spawnPlayerAt("ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 0, z: 0 }, 0);
    const b = sim.spawnPlayerAt("ship.interceptor", INTERCEPTOR_FITTING, 1, { x: 20, z: 0 }, Math.PI);
    const lockTime = sim.world.shipCores.get(a)!.sensors.lockTimeSec;
    const shipOf = (id: number) => sim.snapshot().ships.find((s) => s.id === id)!;

    expect(shipOf(a).lockProgress).toBe(0);
    expect(shipOf(a).locked).toBe(false);

    sim.tick(DT);
    expect(shipOf(a).lockProgress).toBeCloseTo(DT / lockTime, 6);
    expect(shipOf(a).locked).toBe(false);

    for (let t = 0; t * DT < lockTime; t++) sim.tick(DT);
    for (const id of [a, b]) {
      expect(shipOf(id).lockProgress).toBe(1); // normalized, never above 1
      expect(shipOf(id).locked).toBe(true);
      expect(shipOf(id).targetId).toBe(id === a ? b : a);
    }
  });

  it("carries y and pitch for ships, and y for asteroids and projectiles", () => {
    const sim = new ArenaSimulation(configs, "arena.deep-field", "gamemode.duel-1v1");
    const flyer = sim.spawnPlayerAt("ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 0, y: 12, z: 0 }, 0, undefined, 0.3);

    let snap = sim.snapshot();
    const ship = snap.ships.find((s) => s.id === flyer)!;
    expect(ship.pos.y).toBe(12);
    expect(ship.pitch).toBeCloseTo(0.3, 9);

    // The deep field authors a y-banded belt, so the arena's own content proves
    // asteroid y survives the placement → transform → snapshot path.
    expect(snap.asteroids.some((a) => a.pos.y !== 0)).toBe(true);

    // Climb under power and the replicated altitude follows.
    sim.applyOrder(flyer, { kind: "flight", throttle: 1, turn: 0, pitchStick: 1, boost: false, fire: true });
    for (let t = 0; t < 30; t++) sim.tick(DT);
    snap = sim.snapshot();
    const climbed = snap.ships.find((s) => s.id === flyer)!;
    expect(climbed.pos.y).toBeGreaterThan(12);
    expect(climbed.pitch).toBeGreaterThan(0.3);

    const projectile = spawnProjectile(sim.world, {
      kind: "missile",
      damage: 1,
      damageType: "kinetic",
      speed: 10,
      lifetime: 5,
      ownerId: flyer,
      ownerTeam: 0,
      pos: { x: 1, y: -7, z: 2 },
      heading: 0,
    });
    expect(sim.snapshot().projectiles.find((p) => p.id === projectile)!.pos.y).toBe(-7);
  });
});

describe("Determinism", () => {
  it("two sims fed identical orders produce identical snapshots after 1000 ticks", () => {
    const build = () => {
      const sim = new ArenaSimulation(configs, "arena.ring-nebula", "gamemode.duel-1v1", 42);
      const a = sim.spawnPlayerAt("ship.interceptor", INTERCEPTOR_FITTING, 0, { x: -20, z: 0 }, 0);
      const b = sim.spawnPlayerAt("ship.interceptor", INTERCEPTOR_FITTING, 1, { x: 20, z: 0 }, Math.PI);
      return { sim, a, b };
    };
    const run = (r: ReturnType<typeof build>) => {
      const { sim, a, b } = r;
      for (let t = 0; t < 1000; t++) {
        if (t === 0) {
          sim.applyOrder(a, { kind: "moduleToggle", hardpointIndex: 0 });
          sim.applyOrder(b, { kind: "moduleToggle", hardpointIndex: 0 });
        }
        if (t === 3) {
          // Pitched input on both ships: the vertical axis has to be as
          // reproducible as the planar one (BUBBLE.md §A).
          sim.applyOrder(a, { kind: "flight", throttle: 0.5, turn: 0.25, pitchStick: 0.6, boost: false, fire: true });
          sim.applyOrder(b, { kind: "flight", throttle: 0.5, turn: -0.25, pitchStick: -1, boost: false, fire: true });
        }
        if (t === 120) sim.applyOrder(a, { kind: "flight", throttle: 0.9, turn: 0, pitchStick: -0.35, boost: false, fire: true });
        // Flight is level-triggered: two orders drive 900+ ticks of motion, and
        // the integration must stay bit-identical across runs.
        if (t === 200) sim.applyOrder(a, { kind: "flight", throttle: 0.7, turn: -0.4, boost: true, fire: true });
        if (t === 400) sim.applyOrder(b, { kind: "flight", throttle: 1, turn: 0.15, boost: false, fire: true });
        sim.tick(DT);
        sim.getEvents();
      }
      return sim.snapshot();
    };
    const s1 = run(build());
    const s2 = run(build());
    expect(JSON.stringify(s1)).toEqual(JSON.stringify(s2));
    // The run has to have USED the bubble, or this proves determinism of a
    // planar sim with a spare field.
    expect(s1.ships.some((s) => Math.abs(s.pos.y) > 1 && s.pitch !== 0)).toBe(true);
  });
});

describe("Scripted 60s engagement (regression anchor)", () => {
  it("interceptor vs static target: energy never negative, target dies in sane time", () => {
    const sim = new ArenaSimulation(configs, "arena.ring-nebula", "gamemode.duel-1v1");
    // Open space, 22 apart. The arena's centrepiece sits at the origin, and
    // parking the pair on top of it made this anchor a test of where the
    // collision pushout happened to leave them rather than of the engagement.
    const shooter = sim.spawnPlayerAt("ship.interceptor", INTERCEPTOR_FITTING, 0, { x: -11, z: 90 });
    const target = sim.spawnPlayerAt("ship.interceptor", INTERCEPTOR_FITTING, 1, { x: 11, z: 90 });
    // Bring shooter's laser + missile online directly and lock the target.
    const mods = sim.world.modules.get(shooter)!.modules;
    mods[0]!.state = "active";
    mods[1]!.state = "active";
    sim.world.targets.get(shooter)!.targetId = target;
    sim.applyOrder(shooter, { kind: "flight", throttle: 0, turn: 0, boost: false, fire: true });

    let diedTick = -1;
    for (let t = 0; t < 1800; t++) {
      sim.tick(DT);
      sim.getEvents();
      const s = sim.world.shipCores.get(shooter);
      if (s) {
        expect(s.capacitor.cur).toBeGreaterThanOrEqual(0);
        for (const m of sim.world.modules.get(shooter)!.modules) expect(m.heat).toBeGreaterThanOrEqual(0);
      }
      if (diedTick < 0 && !sim.world.shipCores.has(target)) diedTick = t;
    }
    expect(diedTick).toBeGreaterThan(15); // > 0.5s
    expect(diedTick).toBeLessThan(1800); // dead within the minute
  });
});

describe("Respawn, team scoreboard and the hard time cap (owner 2026-07-31)", () => {
  // gamemode.practice-bots authors the full ruleset: fragLimit 10, a 600 s hard
  // cap, respawn {enabled, delay 3}, eliminationEndsMatch false.
  const GAMEMODE = "gamemode.practice-bots";

  function duelSim(seed = 7) {
    const sim = new ArenaSimulation(configs, "arena.ring-nebula", GAMEMODE, seed);
    const player = sim.spawnPlayer("ship.interceptor", INTERCEPTOR_FITTING, 0);
    const enemy = sim.spawnPlayer("ship.interceptor", INTERCEPTOR_FITTING, 1);
    return { sim, player, enemy };
  }

  /** Tick once and drain — the host invariant every real driver follows. */
  function tickDrained(sim: ArenaSimulation, dt = DT): void {
    sim.tick(dt);
    sim.getEvents();
  }

  it("respawns a destroyed ship under the SAME entity id, full hull, on one of its team's pads", () => {
    const { sim, player, enemy } = duelSim();
    const hullMax = sim.world.shipCores.get(enemy)!.hullMax;
    applyDamageToShip(sim.world, enemy, player, 100000, "kinetic");
    tickDrained(sim);
    expect(sim.hasShip(enemy)).toBe(false);

    // Sit out the 3 s delay (respawn timers only advance while live).
    for (let i = 0; i < 92 && !sim.hasShip(enemy); i++) tickDrained(sim);

    expect(sim.hasShip(enemy)).toBe(true); // the same id — no rebinding anywhere
    const core = sim.world.shipCores.get(enemy)!;
    expect(core.hull).toBe(hullMax);
    const tf = sim.world.transforms.get(enemy)!;
    const pads = sim.world.arena.spawnPoints.filter((sp) => sp.team === 1);
    const onPad = pads.some(
      (sp) => Math.hypot(tf.pos.x - sp.position.x, tf.pos.y - (sp.position.y ?? 0), tf.pos.z - sp.position.z) < 1e-9,
    );
    expect(onPad).toBe(true);
    // The frame is freshly seeded for the pad attitude.
    expect(Math.hypot(tf.up.x, tf.up.y, tf.up.z)).toBeCloseTo(1, 9);
    // The match did NOT end on the momentary team wipe (eliminationEndsMatch false).
    expect(sim.isEnded).toBe(false);
  });

  it("credits the killer's team on the snapshot scoreboard", () => {
    const { sim, player, enemy } = duelSim();
    expect(sim.snapshot().teamScores).toEqual([
      { team: 0, kills: 0, captures: 0 },
      { team: 1, kills: 0, captures: 0 },
    ]);
    applyDamageToShip(sim.world, enemy, player, 100000, "kinetic");
    tickDrained(sim);
    expect(sim.snapshot().teamScores).toEqual([
      { team: 0, kills: 1, captures: 0 },
      { team: 1, kills: 0, captures: 0 },
    ]);
  });

  it("an environment death (boundary/rock/overheat — killerId null) credits the OPPOSING team", () => {
    const { sim, player } = duelSim();
    // The player cooks itself / hits the rim: no killer entity on the event.
    applyDamageToShip(sim.world, player, null, 100000, "kinetic");
    tickDrained(sim);
    expect(sim.snapshot().teamScores).toEqual([
      { team: 0, kills: 0, captures: 0 },
      { team: 1, kills: 1, captures: 0 }, // the enemy team scores — a death always counts
    ]);
  });

  it("a self/team kill also credits the opposing team, never the victim's own", () => {
    const { sim, player } = duelSim();
    applyDamageToShip(sim.world, player, player, 100000, "kinetic");
    tickDrained(sim);
    expect(sim.snapshot().teamScores).toEqual([
      { team: 0, kills: 0, captures: 0 },
      { team: 1, kills: 1, captures: 0 },
    ]);
  });

  it("a ship REMOVED while dead never respawns (a leaver is not a ghost)", () => {
    const { sim, player, enemy } = duelSim();
    applyDamageToShip(sim.world, enemy, player, 100000, "kinetic");
    tickDrained(sim);
    sim.removeShip(enemy);
    for (let i = 0; i < 120; i++) tickDrained(sim);
    expect(sim.hasShip(enemy)).toBe(false);
  });

  it("ends an even match at the hard time cap as a DRAW", () => {
    const { sim } = duelSim();
    // Coarse dt on purpose: the cap is a wall-clock rule, not a per-tick one.
    for (let i = 0; i < 601 && !sim.isEnded; i++) tickDrained(sim, 1);
    expect(sim.isEnded).toBe(true);
    expect(sim.snapshot().winnerTeam).toBeNull();
  });

  it("the leading team wins at the cap", () => {
    const { sim, player, enemy } = duelSim();
    applyDamageToShip(sim.world, enemy, player, 100000, "kinetic");
    tickDrained(sim);
    for (let i = 0; i < 601 && !sim.isEnded; i++) tickDrained(sim, 1);
    expect(sim.isEnded).toBe(true);
    expect(sim.snapshot().winnerTeam).toBe(0);
  });
});
