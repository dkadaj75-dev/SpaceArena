import { beforeAll, describe, expect, it } from "vitest";
import type { ConfigService } from "../core/ConfigService.js";
import type { ArenaConfig, PropConfig } from "../schemas/index.js";
import { encodeFloat32Array, encodeUint32Array } from "../collision/base64.js";
import { seedUp } from "./frame.js";
import { hasLineOfSight } from "./los.js";
import { spawnProjectile, spawnShipFromConfig } from "./spawn.js";
import { resolveStaticStep } from "./staticStep.js";
import { collisionSystem } from "./systems/CollisionSystem.js";
import { navigationSystem } from "./systems/NavigationSystem.js";
import { raycastNose } from "./systems/CombatSystem.js";
import { projectileSystem } from "./systems/ProjectileSystem.js";
import { INTERCEPTOR_FITTING, loadTestConfigs, makeWorld, rebuildSpatial } from "./testutil.js";
import { World } from "./World.js";

const DT = 1 / 30;
const wall: PropConfig = {
  id: "prop.test-wall", type: "prop", version: 1, category: "structure", impactDamage: 12,
  render: { recipe: "model.static" },
  collision: {
    positions: encodeFloat32Array(new Float32Array([0, -20, -20, 0, 20, -20, 0, 20, 20, 0, -20, 20])),
    indices: encodeUint32Array(new Uint32Array([0, 1, 2, 0, 2, 3])),
    bounds: { min: { x: 0, y: -20, z: -20 }, max: { x: 0, y: 20, z: 20 } },
  },
};

let configs: ConfigService;
beforeAll(async () => {
  configs = await loadTestConfigs();
  const result = configs.replace(wall);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
});

function staticArena(base: ArenaConfig, x = 5): ArenaConfig {
  return {
    ...base,
    bounds: { shape: "box", width: 40, height: 40, floorY: -10, ceilingY: 10 },
    propPlacements: [{ propId: wall.id, position: { x, y: 0, z: 0 } }],
  };
}

function makeStaticWorld(x = 5): World {
  const base = makeWorld(configs, { gamemodeOverride: { boundaryRule: { type: "bounce", restitution: 0.5 } } });
  return new World(configs, base.tuning, staticArena(base.arena, x), base.gamemode);
}

describe("CollisionSystem static props", () => {
  it("pushes out, cancels inward velocity, applies threshold damage, and honors cooldown", () => {
    const world = makeStaticWorld();
    const ship = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 5.5, y: 0, z: 0 }, 0);
    const core = world.shipCores.get(ship)!;
    const before = core.hull;
    world.velocities.get(ship)!.x = -10;
    collisionSystem(world, DT);
    expect(world.transforms.get(ship)!.pos.x).toBeCloseTo(5 + world.colliders.get(ship)!.radius);
    expect(world.velocities.get(ship)!.x).toBeCloseTo(0);
    expect(core.hull).toBe(before - 12);

    world.transforms.get(ship)!.pos.x = 5.5;
    world.velocities.get(ship)!.x = -10;
    collisionSystem(world, DT);
    expect(core.hull).toBe(before - 12);
  });

  it("does not damage at or below the closing-speed threshold but still resolves", () => {
    const world = makeStaticWorld();
    const ship = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 5.5, y: 0, z: 0 }, 0);
    const before = world.shipCores.get(ship)!.hull;
    world.velocities.get(ship)!.x = -world.tuning.impactSpeedThreshold!;
    collisionSystem(world, DT);
    expect(world.shipCores.get(ship)!.hull).toBe(before);
    expect(world.transforms.get(ship)!.pos.x).toBeGreaterThan(5.5);
  });

  it("held flight into a prop never penetrates and damages once per cooldown window", () => {
    const world = makeStaticWorld();
    const ship = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 5.5, y: 0, z: 0 }, Math.PI);
    const radius = world.colliders.get(ship)!.radius;
    // Keep the test's real flight path above the impact threshold regardless
    // of the fixture ship's authored cruise speed.
    world.shipCores.get(ship)!.engine.nominalSpeed = 12;
    world.shipCores.get(ship)!.engine.accel = 240;
    world.queueOrder(ship, { kind: "flight", throttle: 1, turn: 0, boost: false, fire: false });
    let damageEvents = 0;
    for (let tick = 0; tick < 90; tick++) {
      rebuildSpatial(world);
      navigationSystem(world, DT);
      const eventStart = world.events.length;
      collisionSystem(world, DT);
      expect(world.transforms.get(ship)!.pos.x).toBeGreaterThan(5 + radius - 0.1);
      damageEvents += world.events.slice(eventStart).filter((event) => event.type === "damage").length;
    }
    expect(damageEvents).toBe(3);
  });

  it("sweeps a fast ship against a thin prop wall before it can tunnel", () => {
    const world = makeStaticWorld();
    const ship = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 7, y: 0, z: 0 }, 0);
    const radius = world.colliders.get(ship)!.radius;
    world.velocities.get(ship)!.x = 80;
    collisionSystem(world, DT);
    expect(world.transforms.get(ship)!.pos.x).toBeGreaterThanOrEqual(5 + radius - 1e-9);
  });
});

describe("box bounds and static-step parity", () => {
  it("charges a corner boundary contact once and emits one damage event per tick", () => {
    const base = makeWorld(configs, { gamemodeOverride: { boundaryRule: { type: "damageAndBounce", damagePerSec: 30, restitution: 0.5 } } });
    const world = new World(configs, base.tuning, staticArena(base.arena, 0), base.gamemode);
    const ship = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 20, y: 10, z: 20 }, 0);
    const core = world.shipCores.get(ship)!;
    const before = core.hull;
    const eventStart = world.events.length;
    collisionSystem(world, DT);
    expect(core.hull).toBeCloseTo(before - 30 * DT);
    expect(world.events.slice(eventStart).filter((event) => event.type === "damage")).toHaveLength(1);
  });

  it("resolves all violated faces and reflects wall plus ceiling velocity in one tick", () => {
    const world = makeStaticWorld(0);
    const ship = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 0, y: 0, z: 0 }, 0);
    const radius = world.colliders.get(ship)!.radius;
    const tf = world.transforms.get(ship)!;
    tf.pos.x = 20;
    tf.pos.y = 10;
    tf.pos.z = 20;
    const vel = world.velocities.get(ship)!;
    vel.x = 8; vel.y = 6; vel.z = 10;
    collisionSystem(world, DT);
    expect(tf.pos.x).toBeCloseTo(20 - radius);
    expect(tf.pos.y).toBeCloseTo(10 - radius);
    expect(tf.pos.z).toBeCloseTo(20 - radius);
    expect(vel.x).toBeCloseTo(-4);
    expect(vel.y).toBeCloseTo(-3);
    expect(vel.z).toBeCloseTo(-5);
  });

  it("matches resolveStaticStep position, velocity, and attitude exactly", () => {
    const world = makeStaticWorld(18);
    const ship = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 18.5, y: 9.5, z: 0 }, 0);
    const tf = world.transforms.get(ship)!;
    tf.heading = 0.3; tf.pitch = 0.6; Object.assign(tf.up, seedUp(tf.heading, tf.pitch));
    const vel = world.velocities.get(ship)!;
    vel.x = -9; vel.y = 7; vel.z = 1;
    const predicted = {
      position: { ...tf.pos }, velocity: { ...vel }, heading: tf.heading, pitch: tf.pitch, up: { ...tf.up },
    };
    resolveStaticStep({ staticWorld: world.staticWorld, bounds: world.arena.bounds, rule: world.gamemode.boundaryRule }, predicted, world.colliders.get(ship)!.radius, DT);
    collisionSystem(world, DT);
    expect(tf.pos).toEqual(predicted.position);
    expect(vel).toEqual(predicted.velocity);
    expect({ heading: tf.heading, pitch: tf.pitch, up: tf.up }).toEqual({ heading: predicted.heading, pitch: predicted.pitch, up: predicted.up });
  });
});

describe("static prop occlusion", () => {
  it("destroys a projectile without damaging an entity", () => {
    const world = makeStaticWorld();
    const owner = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, { x: -5, y: 0, z: 0 }, 0);
    const pid = spawnProjectile(world, { kind: "kinetic", damage: 10, damageType: "kinetic", speed: 300, lifetime: 1, ownerId: owner, ownerTeam: 0, pos: { x: 0, y: 0, z: 0 }, heading: 0 });
    rebuildSpatial(world);
    projectileSystem(world, DT);
    expect(world.projectiles.has(pid)).toBe(false);
  });

  it("culls projectiles beyond a box ceiling plus margin", () => {
    const world = makeStaticWorld();
    const owner = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, { x: -5, y: 0, z: 0 }, 0);
    const margin = world.tuning.projectileBoundsMargin ?? 20;
    const pid = spawnProjectile(world, { kind: "kinetic", damage: 10, damageType: "kinetic", speed: 1, lifetime: 1, ownerId: owner, ownerTeam: 0, pos: { x: -10, y: 10 + margin + 1, z: 0 }, heading: Math.PI });
    rebuildSpatial(world);
    projectileSystem(world, DT);
    expect(world.projectiles.has(pid)).toBe(false);
  });

  it("blocks beam nose rays and line of sight", () => {
    const world = makeStaticWorld();
    const shooter = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 0, y: 0, z: 0 }, 0);
    rebuildSpatial(world);
    expect(raycastNose(world, shooter, 0, world.transforms.get(shooter)!, 10)?.isStatic).toBe(true);
    expect(hasLineOfSight(world, { x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 })).toBe(false);
  });
});
