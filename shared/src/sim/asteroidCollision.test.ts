import { beforeAll, describe, expect, it } from "vitest";

import type { ConfigService } from "../core/ConfigService.js";
import { hasLineOfSight } from "./los.js";
import { spawnAsteroid, spawnProjectile, spawnShipFromConfig } from "./spawn.js";
import { collisionSystem } from "./systems/CollisionSystem.js";
import { projectileSystem } from "./systems/ProjectileSystem.js";
import { INTERCEPTOR_FITTING, loadTestConfigs, makeWorld, rebuildSpatial } from "./testutil.js";
import { asteroidContact, asteroidSegmentEntry, asteroidSurfaceRadiusToward } from "./asteroidCollision.js";
import { rockOrientationAt } from "../collision/rockPose.js";
import { resolveRockMesh, rockMeshWorldRadius } from "../collision/rockCollider.js";
import type { AsteroidConfig } from "../schemas/asteroid.js";
import type { World } from "./World.js";

const DT = 1 / 30;
/**
 * The shipped contact binary: a fat lobe at each end and a pinched waist, and
 * the most concave thing in the pack — its nearest surface sits at 0.22 of its
 * bounding radius, so most of that sphere is empty space.
 */
const TWIN = "asteroid.rock-d";
/** The shipped fractured shard: lumpy enough that its thin axis is half its fat one. */
const SHARD = "asteroid.rock-a";

let configs: ConfigService;
beforeAll(async () => {
  configs = await loadTestConfigs();
});

function surfaceAlong(world: World, id: number, dx: number, dy: number, dz: number): number {
  const tag = world.asteroids.get(id)!;
  const transform = world.transforms.get(id)!;
  const bound = world.colliders.get(id)!.radius;
  return asteroidSurfaceRadiusToward(world, tag, transform, bound, dx, dy, dz);
}

/**
 * How far the body reaches PERPENDICULAR to `axis` — the radius of the smallest
 * cylinder around that axis containing the rock. A line parallel to the axis and
 * further out than this provably misses the body, however lumpy it is, which is
 * what makes "passes through the gap the bounding sphere claims" a fair test
 * rather than a lucky one.
 */
function cylinderRadiusAbout(world: World, id: number, axis: readonly [number, number, number]): number {
  let widest = 0;
  for (let i = 0; i < 4000; i++) {
    const y = 1 - (2 * i + 1) / 4000;
    const ring = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = i * 2.39996;
    const dir: [number, number, number] = [Math.cos(theta) * ring, y, Math.sin(theta) * ring];
    const along = dir[0] * axis[0] + dir[1] * axis[1] + dir[2] * axis[2];
    const perpendicular = Math.sqrt(Math.max(0, 1 - along * along));
    widest = Math.max(widest, surfaceAlong(world, id, dir[0], dir[1], dir[2]) * perpendicular);
  }
  return widest;
}

/** Unit vector perpendicular to `axis`, built deterministically. */
function perpendicularTo(axis: readonly [number, number, number]): [number, number, number] {
  const reference: [number, number, number] = Math.abs(axis[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const px = axis[1] * reference[2] - axis[2] * reference[1];
  const py = axis[2] * reference[0] - axis[0] * reference[2];
  const pz = axis[0] * reference[1] - axis[1] * reference[0];
  const length = Math.hypot(px, py, pz);
  return [px / length, py / length, pz / length];
}

/** The direction in which a rock reaches furthest, and the one where it is thinnest. */
function extremeAxes(world: World, id: number): { fat: [number, number, number]; thin: [number, number, number] } {
  let fat: [number, number, number] = [1, 0, 0];
  let thin: [number, number, number] = [1, 0, 0];
  let best = -Infinity;
  let worst = Infinity;
  for (let i = 0; i < 400; i++) {
    const y = 1 - (2 * i + 1) / 400;
    const ring = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = i * 2.39996;
    const dir: [number, number, number] = [Math.cos(theta) * ring, y, Math.sin(theta) * ring];
    const r = surfaceAlong(world, id, dir[0], dir[1], dir[2]);
    if (r > best) { best = r; fat = dir; }
    if (r < worst) { worst = r; thin = dir; }
  }
  return { fat, thin };
}

describe("mesh-collided asteroids", () => {
  it("stops a shot on the lobe and lets one through beside it", () => {
    const world = makeWorld(configs);
    const rock = spawnAsteroid(world, configs, TWIN, { x: 0, y: 0, z: 0 });
    const bound = world.colliders.get(rock)!.radius;
    const { fat, thin } = extremeAxes(world, rock);
    const fatSurface = surfaceAlong(world, rock, ...fat);
    const thinSurface = surfaceAlong(world, rock, ...thin);
    // The rock has to actually be lumpy for this test to mean anything.
    expect(fatSurface).toBeGreaterThan(thinSurface * 1.5);

    // A shot down the fat axis lands. One offset sideways past the body's widest
    // point — but still well inside the bounding sphere — flies over empty space
    // the sphere claims as solid.
    const side = perpendicularTo(fat);
    const grazeOffset = cylinderRadiusAbout(world, rock, fat) + 1;
    expect(grazeOffset).toBeLessThan(bound);
    for (const [name, offset, expectHit] of [["lobe", 0, true], ["gap", grazeOffset, false]] as const) {
      const shooter = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 0, y: 0, z: -200 }, 0);
      const start = {
        x: fat[0] * -60 + side[0] * offset,
        y: fat[1] * -60 + side[1] * offset,
        z: fat[2] * -60 + side[2] * offset,
      };
      const shot = spawnProjectile(world, {
        kind: "kinetic", damage: 1, damageType: "kinetic", speed: 0, lifetime: 10,
        ownerId: shooter, ownerTeam: 0, pos: start, heading: 0,
      });
      world.velocities.set(shot, { x: fat[0] * 120, y: fat[1] * 120, z: fat[2] * 120 });
      expect(offset, `${name} start is inside the broadphase sphere`).toBeLessThan(bound);

      let survived = true;
      for (let tick = 0; tick < 30 && survived; tick++) {
        rebuildSpatial(world);
        projectileSystem(world, DT);
        survived = world.projectiles.has(shot);
      }
      expect(survived, `${name} shot expected ${expectHit ? "to hit" : "to pass"}`).toBe(!expectHit);
      world.destroyEntity(shooter);
      if (survived) world.destroyEntity(shot);
    }
  });

  it("rests a ship on the surface, not on the bounding sphere", () => {
    const world = makeWorld(configs);
    const rock = spawnAsteroid(world, configs, SHARD, { x: 0, y: 0, z: 0 });
    const bound = world.colliders.get(rock)!.radius;
    const { thin } = extremeAxes(world, rock);
    const ship = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 0, y: 0, z: 0 }, 0);
    const shipRadius = world.colliders.get(ship)!.radius;
    // Drop the hull right on the body centre and let push-out resolve it.
    const transform = world.transforms.get(ship)!;
    transform.pos.x = thin[0] * 0.4;
    transform.pos.y = thin[1] * 0.4;
    transform.pos.z = thin[2] * 0.4;
    for (let tick = 0; tick < 20; tick++) {
      rebuildSpatial(world);
      collisionSystem(world, DT);
    }
    const distance = Math.hypot(transform.pos.x, transform.pos.y, transform.pos.z);
    const surface = surfaceAlong(world, rock, transform.pos.x, transform.pos.y, transform.pos.z);
    // Out of the rock...
    expect(distance).toBeGreaterThanOrEqual(surface + shipRadius - 1e-6);
    // ...but nowhere near the old sphere, which would have shoved a fighter
    // half a rock's width into clear space.
    expect(distance).toBeLessThan(bound + shipRadius);
  });

  it("keeps sight lines on the same surface as shots", () => {
    const world = makeWorld(configs);
    const rock = spawnAsteroid(world, configs, TWIN, { x: 0, y: 0, z: 0 });
    const { fat } = extremeAxes(world, rock);
    const side = perpendicularTo(fat);
    const bound = world.colliders.get(rock)!.radius;
    rebuildSpatial(world);
    const offset = cylinderRadiusAbout(world, rock, fat) + 1;
    expect(offset).toBeLessThan(bound);
    const from = { x: fat[0] * -80 + side[0] * offset, y: fat[1] * -80 + side[1] * offset, z: fat[2] * -80 + side[2] * offset };
    const to = { x: fat[0] * 80 + side[0] * offset, y: fat[1] * 80 + side[1] * offset, z: fat[2] * 80 + side[2] * offset };
    expect(hasLineOfSight(world, from, to)).toBe(true);
    // Straight through the body is still blocked.
    expect(hasLineOfSight(world, { x: fat[0] * -80, y: fat[1] * -80, z: fat[2] * -80 }, { x: fat[0] * 80, y: fat[1] * 80, z: fat[2] * 80 })).toBe(false);
  });

  it("leaves the twin lobe's waist clear deep inside its bounding sphere", () => {
    // The headline of the change. The contact binary's bounding sphere is mostly
    // empty: at the pinch, the surface is a fraction of the way out. A hull
    // parked in that gap is in CLEAR SPACE and must report no contact — the old
    // sphere collider called all of it solid and killed pilots in open vacuum.
    const world = makeWorld(configs);
    const rock = spawnAsteroid(world, configs, TWIN, { x: 0, y: 0, z: 0 });
    const tag = world.asteroids.get(rock)!;
    const transform = world.transforms.get(rock)!;
    const bound = world.colliders.get(rock)!.radius;
    const ship = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 0, y: 0, z: -200 }, 0);
    const shipRadius = world.colliders.get(ship)!.radius;
    const { thin } = extremeAxes(world, rock);
    const surface = surfaceAlong(world, rock, ...thin);
    // The gap has to be a real one, not a rounding error.
    expect(bound).toBeGreaterThan(surface + 2 * shipRadius + 1);

    const clearAt = surface + shipRadius + 0.5;
    expect(
      asteroidContact(world, tag, transform, bound, thin[0] * clearAt, thin[1] * clearAt, thin[2] * clearAt, shipRadius),
      "hull just clear of the waist surface",
    ).toBe(false);
    // Still clear all the way out to the sphere the broadphase uses.
    const deepInsideSphere = (clearAt + bound) / 2;
    expect(
      asteroidContact(world, tag, transform, bound, thin[0] * deepInsideSphere, thin[1] * deepInsideSphere, thin[2] * deepInsideSphere, shipRadius),
      "hull deep inside the bounding sphere but outside the rock",
    ).toBe(false);
    // ...and the surface itself still stops it.
    const touching = surface + shipRadius - 0.5;
    expect(
      asteroidContact(world, tag, transform, bound, thin[0] * touching, thin[1] * touching, thin[2] * touching, shipRadius),
      "hull pressed into the waist surface",
    ).toBe(true);
  });

  it("enters a raycast at the triangle surface, not at the bounding sphere", () => {
    const world = makeWorld(configs);
    const rock = spawnAsteroid(world, configs, TWIN, { x: 0, y: 0, z: 0 });
    const tag = world.asteroids.get(rock)!;
    const transform = world.transforms.get(rock)!;
    const bound = world.colliders.get(rock)!.radius;
    const { fat } = extremeAxes(world, rock);
    const START = 100;
    const from = { x: fat[0] * -START, y: fat[1] * -START, z: fat[2] * -START };
    const to = { x: fat[0] * START, y: fat[1] * START, z: fat[2] * START };
    const t = asteroidSegmentEntry(world, tag, transform, bound, from, to, 0);
    expect(t).toBeGreaterThanOrEqual(0);
    // Where the ray actually entered, as a distance from the body centre. It
    // travels along +fat starting behind the rock, so it enters on the -fat face.
    const entryDistance = START - t * 2 * START;
    const surface = surfaceAlong(world, rock, -fat[0], -fat[1], -fat[2]);
    expect(entryDistance, "entry sits on the mesh surface").toBeCloseTo(surface, 3);
    // Which is strictly nearer the centre than the sphere would have reported.
    expect(entryDistance).toBeLessThan(bound);
  });

  it("pushes a hull tunnelled deep inside the body back out", () => {
    // `sphereDeepestContact` only sees triangles within the probe's own radius,
    // so a hull further in than that finds nothing. Without the radial recovery
    // it would sit inside the rock reporting clear space forever.
    const world = makeWorld(configs);
    const rock = spawnAsteroid(world, configs, SHARD, { x: 0, y: 0, z: 0 });
    const ship = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 0, y: 0, z: 0 }, 0);
    const shipRadius = world.colliders.get(ship)!.radius;
    const transform = world.transforms.get(ship)!;
    // Dead centre of the body — as deep as it gets.
    transform.pos.x = 0;
    transform.pos.y = 0;
    transform.pos.z = 0;
    for (let tick = 0; tick < 40; tick++) {
      rebuildSpatial(world);
      collisionSystem(world, DT);
    }
    const distance = Math.hypot(transform.pos.x, transform.pos.y, transform.pos.z);
    const surface = surfaceAlong(world, rock, transform.pos.x, transform.pos.y, transform.pos.z);
    expect(distance, "hull ends up outside the surface").toBeGreaterThanOrEqual(surface + shipRadius - 1e-6);
  });

  it("turns the collision surface with the rock's drawn tumble", () => {
    // Pose is the one thing a baked mesh can get wrong that a sphere could not:
    // the client draws the rock through `rockOrientationAt`, so the BVH has to be
    // queried through the same pose or the collider drifts off the art.
    const world = makeWorld(configs);
    const rock = spawnAsteroid(world, configs, TWIN, { x: 0, y: 0, z: 0 }, 1, 3, 0);
    const tag = world.asteroids.get(rock)!;
    const transform = world.transforms.get(rock)!;
    const bound = world.colliders.get(rock)!.radius;
    const probe: [number, number, number] = [1, 0, 0];

    world.matchElapsed = 0;
    const atRest = asteroidSurfaceRadiusToward(world, tag, transform, bound, ...probe);
    world.matchElapsed = 40;
    const tumbled = asteroidSurfaceRadiusToward(world, tag, transform, bound, ...probe);
    // 40 s of authored tumble swings a 4:1 body a long way past this direction.
    expect(Math.abs(tumbled - atRest)).toBeGreaterThan(0.5);

    // And it is the SAME body, merely turned: the mesh queried directly with the
    // direction counter-rotated by the pose reproduces the posed answer.
    const mesh = resolveRockMesh(configs.get<AsteroidConfig>("asteroid", TWIN)!)!;
    const pose = { x: 0, y: 0, z: 0, w: 1 };
    rockOrientationAt(tag.spin, tag.baseRotationY, 40, pose);
    expect(rockMeshWorldRadius(mesh, tag.visualRadius, pose, ...probe)).toBeCloseTo(tumbled, 6);
  });

  it("is reproducible tick for tick", () => {
    const run = (): number[] => {
      const world = makeWorld(configs);
      spawnAsteroid(world, configs, TWIN, { x: 0, y: 0, z: 0 });
      const ship = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 0, y: 1, z: -30 }, Math.PI / 2);
      world.queueOrder(ship, { kind: "flight", throttle: 1, turn: 0, boost: false, fire: false });
      const trace: number[] = [];
      for (let tick = 0; tick < 90; tick++) {
        world.matchElapsed = tick * DT;
        rebuildSpatial(world);
        collisionSystem(world, DT);
        const p = world.transforms.get(ship)!.pos;
        trace.push(p.x, p.y, p.z);
      }
      return trace;
    };
    expect(run()).toEqual(run());
  });

  it("keeps a rock with neither shape nor mesh on its legacy sphere", () => {
    const world = makeWorld(configs);
    // Every shipped rock authors a real surface, so build the legacy case
    // explicitly — stripping BOTH representations, since the mesh is what the
    // shipped configs carry.
    const source = configs.get<AsteroidConfig>("asteroid", TWIN)!;
    const legacy = {
      ...source,
      id: "asteroid.legacy-sphere",
      shape: undefined,
      collision: undefined,
      render: { ...source.render, model: undefined },
      radius: 10,
      colliderScale: 0.8,
    };
    configs.replace(legacy as never);
    const rock = spawnAsteroid(world, configs, "asteroid.legacy-sphere", { x: 0, y: 0, z: 0 });
    expect(world.colliders.get(rock)!.radius).toBeCloseTo(8, 6);
    expect(world.asteroids.get(rock)!.shape).toBeNull();
    expect(world.asteroids.get(rock)!.mesh).toBeNull();
    rebuildSpatial(world);
    // A pure sphere blocks in every direction alike.
    expect(hasLineOfSight(world, { x: -50, y: 0, z: 0 }, { x: 50, y: 0, z: 0 })).toBe(false);
    expect(hasLineOfSight(world, { x: 0, y: -50, z: 0 }, { x: 0, y: 50, z: 0 })).toBe(false);
    expect(hasLineOfSight(world, { x: -50, y: 20, z: 0 }, { x: 50, y: 20, z: 0 })).toBe(true);
  });
});
