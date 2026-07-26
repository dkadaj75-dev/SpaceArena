import { beforeAll, describe, expect, it } from "vitest";
import type { ConfigService } from "../../core/ConfigService.js";
import { applyDamageToAsteroid, applyDamageToShip } from "../damage.js";
import { hasLineOfSight } from "../los.js";
import { spawnAsteroid, spawnProjectile, spawnShipFromConfig } from "../spawn.js";
import { INTERCEPTOR_FITTING, loadTestConfigs, makeWorld, rebuildSpatial, warmLock } from "../testutil.js";
import type { World } from "../World.js";
import { combatSystem } from "./CombatSystem.js";
import { projectileSystem } from "./ProjectileSystem.js";

const DT = 1 / 30;
const LASER = 0;
const MISSILE = 1;
const SHIELD = 2;

let configs: ConfigService;
beforeAll(async () => {
  configs = await loadTestConfigs();
});

/**
 * Shooter (team 0) with an active weapon targeting an enemy (team 1). The shooter
 * faces +x (heading 0) and every `targetPos` used here sits on that axis inside
 * `sensors.lockRange`, so {@link warmLock} can drive the real lock to full before
 * the assertions — weapons cannot fire unlocked (FLIGHT.md §2).
 */
function duel(
  targetPos: { x: number; z: number },
  weapon = LASER,
): { world: World; shooter: number; target: number } {
  const world = makeWorld(configs);
  const shooter = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 0, z: 0 }, 0);
  const target = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 1, targetPos, 0);
  const mod = world.modules.get(shooter)!.modules[weapon]!;
  mod.state = "active";
  mod.cycleTimer = 0;
  // Seed the sticky candidate directly: targeting is automatic (FLIGHT.md §2),
  // and TargetingSystem holds whoever is already set while it stays lockable.
  world.targets.get(shooter)!.targetId = target;
  warmLock(world, shooter);
  rebuildSpatial(world);
  return { world, shooter, target };
}

describe("CombatSystem beam", () => {
  it("fires and damages a target in range with LoS + energy", () => {
    const { world, target } = duel({ x: 20, z: 0 });
    const before = world.shipCores.get(target)!.hull;
    combatSystem(world, DT);
    expect(world.shipCores.get(target)!.hull).toBeLessThan(before);
    expect(world.events.some((e) => e.type === "damage")).toBe(true);
  });

  it("does not fire out of range", () => {
    const { world, target } = duel({ x: 50, z: 0 }); // laser range 38
    const before = world.shipCores.get(target)!.hull;
    combatSystem(world, DT);
    expect(world.shipCores.get(target)!.hull).toBe(before);
  });

  it("does not fire without line of sight", () => {
    const { world, target } = duel({ x: 20, z: 0 });
    spawnAsteroid(world, configs, "asteroid.large-hazard", { x: 10, z: 0 });
    rebuildSpatial(world);
    const before = world.shipCores.get(target)!.hull;
    combatSystem(world, DT);
    expect(world.shipCores.get(target)!.hull).toBe(before);
  });

  it("does not fire with an empty capacitor", () => {
    const { world, shooter, target } = duel({ x: 20, z: 0 });
    world.shipCores.get(shooter)!.capacitor.cur = 0;
    const before = world.shipCores.get(target)!.hull;
    combatSystem(world, DT);
    expect(world.shipCores.get(target)!.hull).toBe(before);
  });
});

describe("CombatSystem — a dead target is not a target (review Finding 6)", () => {
  /**
   * CleanupSystem removes wrecks at the END of a tick, so between the shot that
   * kills a ship and that removal the entity is still present with hull ≤ 0 —
   * and `combatSystem` iterates ships in ascending id order, so every attacker
   * with a higher id runs after the kill inside the SAME call. Gating on the
   * target component's existence rather than its hull let all of them spend a
   * cycle timer and a tick of energy shooting the corpse.
   */
  function twoOnOne(): { world: World; first: number; second: number; target: number } {
    const world = makeWorld(configs);
    // Ids ascend with spawn order: the two shooters both run before cleanup.
    const first = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 0, z: 0 }, 0);
    const second = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 0, z: 6 }, 0);
    const target = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 1, { x: 20, z: 3 }, 0);
    for (const shooter of [first, second]) {
      const mod = world.modules.get(shooter)!.modules[LASER]!;
      mod.state = "active";
      mod.cycleTimer = 0;
      world.targets.get(shooter)!.targetId = target;
      warmLock(world, shooter);
    }
    rebuildSpatial(world);
    return { world, first, second, target };
  }

  it("the second attacker spends no cycle and no energy once the first one's shot kills the target", () => {
    const { world, first, second, target } = twoOnOne();
    // One laser tick is enough to finish it.
    world.shipCores.get(target)!.hull = 1;
    const energyBefore = world.shipCores.get(second)!.capacitor.cur;

    combatSystem(world, DT);

    // The lower-id attacker fired and killed.
    expect(world.shipCores.get(target)!.hull).toBeLessThanOrEqual(0);
    expect(world.modules.get(first)!.modules[LASER]!.cycleTimer).toBeGreaterThan(0);

    // The second one found a wreck: no cooldown started, no energy earmarked,
    // and exactly one shot exists for the whole tick.
    const secondMod = world.modules.get(second)!.modules[LASER]!;
    expect(secondMod.cycleTimer).toBe(0);
    expect(secondMod.workedThisTick).toBe(false);
    expect(world.shipCores.get(second)!.capacitor.cur).toBe(energyBefore);
    expect(world.events.filter((e) => e.type === "projectileFired").length).toBe(1);
  });

  it("both attackers still fire while the target is alive", () => {
    // Control: the gate is hull, not some accident of the fixture.
    const { world, first, second } = twoOnOne();
    combatSystem(world, DT);
    expect(world.modules.get(first)!.modules[LASER]!.cycleTimer).toBeGreaterThan(0);
    expect(world.modules.get(second)!.modules[LASER]!.cycleTimer).toBeGreaterThan(0);
    expect(world.events.filter((e) => e.type === "projectileFired").length).toBe(2);
  });
});

describe("ProjectileSystem", () => {
  it("a kinetic projectile hits a static ship", () => {
    const world = makeWorld(configs);
    const target = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 1, { x: 20, z: 0 }, 0);
    const before = world.shipCores.get(target)!.hull;
    spawnProjectile(world, {
      kind: "kinetic",
      damage: 15,
      damageType: "kinetic",
      speed: 60,
      lifetime: 3,
      ownerId: 999,
      ownerTeam: 0,
      pos: { x: 0, z: 0 },
      heading: 0,
    });
    for (let i = 0; i < 30 && world.projectileIds().length > 0; i++) {
      rebuildSpatial(world);
      projectileSystem(world, DT);
    }
    expect(world.shipCores.get(target)!.hull).toBeLessThan(before);
  });

  it("a homing missile catches a moving target", () => {
    const { world, shooter, target } = duel({ x: 30, z: 0 }, MISSILE);
    const before = world.shipCores.get(target)!.hull;
    // Fire the missile.
    combatSystem(world, DT);
    // Target drifts sideways; missile homes.
    const tv = world.velocities.get(target)!;
    tv.x = 0;
    tv.z = 12;
    let hit = false;
    for (let i = 0; i < 200 && !hit; i++) {
      const tt = world.transforms.get(target)!;
      tt.pos.x += tv.x * DT;
      tt.pos.z += tv.z * DT;
      rebuildSpatial(world);
      projectileSystem(world, DT);
      if (world.shipCores.get(target)!.hull < before) hit = true;
    }
    void shooter;
    expect(hit).toBe(true);
  });

  /**
   * Review Finding 8. A missile whose target dies stops homing and flies
   * straight for the rest of its lifetime. On the radius-300 deep field that
   * carries it hundreds of units past the rim — outside the ±327.67 int16 centi
   * wire range, where `encodeCenti` silently clamps and the client renders a
   * missile pinned to an invisible wall while the authoritative one flies on.
   * The cull is in the SIM so offline and online agree and it stays deterministic.
   */
  describe("out-of-arena cull (Finding 8)", () => {
    const MARGIN = 20; // DEFAULT_BOUNDS_MARGIN; no tuning override in the pack
    const RIM = 300; // arena.deep-field bounds radius

    function flyOutward(lifetime: number): { world: World; ticks: number; last: { x: number; z: number } } {
      const world = makeWorld(configs, { arenaId: "arena.deep-field" });
      const id = spawnProjectile(world, {
        kind: "missile",
        damage: 20,
        damageType: "kinetic",
        speed: 90,
        turnRate: 3,
        lifetime,
        ownerId: 999,
        ownerTeam: 0,
        // Just inside the rim, nose out: the "lost its target near the edge" case.
        pos: { x: RIM - 5, z: 0 },
        heading: 0,
      });
      const last = { x: 0, z: 0 };
      let ticks = 0;
      for (; ticks < Math.ceil(lifetime / DT) + 5; ticks++) {
        rebuildSpatial(world);
        projectileSystem(world, DT);
        const tf = world.transforms.get(id);
        if (!tf) break;
        last.x = tf.pos.x;
        last.z = tf.pos.z;
      }
      return { world, ticks, last };
    }

    it("despawns a missile that flies past the arena bounds, long before its lifetime expires", () => {
      // 8 s at 90 u/s would reach ~1015 units — 3× the wire range.
      const { world, ticks, last } = flyOutward(8);
      expect(world.projectileIds()).toHaveLength(0);
      expect(ticks).toBeLessThan(Math.ceil(8 / DT)); // culled by bounds, not lifetime
      // Never seen outside the guard rail, so every replicated position is
      // representable (|x| < 327.67).
      expect(Math.hypot(last.x, last.z)).toBeLessThanOrEqual(RIM + MARGIN + 1);
    });

    it("leaves a projectile travelling inside the bounds alone", () => {
      const world = makeWorld(configs, { arenaId: "arena.deep-field" });
      spawnProjectile(world, {
        kind: "kinetic",
        damage: 10,
        damageType: "kinetic",
        speed: 60,
        lifetime: 3,
        ownerId: 999,
        ownerTeam: 0,
        pos: { x: 0, z: 0 },
        heading: 0,
      });
      for (let i = 0; i < 15; i++) {
        rebuildSpatial(world);
        projectileSystem(world, DT);
      }
      expect(world.projectileIds()).toHaveLength(1);
    });
  });
});

describe("Damage pipeline — shield mitigation", () => {
  it("an active shield reduces incoming covered damage before hull", () => {
    const world = makeWorld(configs);
    const id = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 0, z: 0 }, 0);
    const shield = world.modules.get(id)!.modules[SHIELD]!;
    shield.state = "active";
    shield.shieldPool = 12; // full reservoir
    const core = world.shipCores.get(id)!;
    const before = core.hull;

    applyDamageToShip(world, id, null, 20, "energy");
    const drop = before - core.hull;
    // damageReduction 0.5, pool caps absorb at 10 → ~10 through to hull (energy resist 0).
    expect(drop).toBeCloseTo(10, 1);
    expect(world.events.some((e) => e.type === "shieldAbsorb")).toBe(true);
  });

  it("without a shield the full (resisted) damage hits hull", () => {
    const world = makeWorld(configs);
    const id = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 0, z: 0 }, 0);
    const core = world.shipCores.get(id)!;
    const before = core.hull;
    applyDamageToShip(world, id, null, 20, "energy");
    expect(before - core.hull).toBeCloseTo(20, 5);
  });
});

describe("Asteroid destruction updates LoS", () => {
  it("a destroyed asteroid no longer blocks line of sight", () => {
    const world = makeWorld(configs);
    const ast = spawnAsteroid(world, configs, "asteroid.small-rock", { x: 0, z: 0 });
    rebuildSpatial(world);
    expect(hasLineOfSight(world, { x: -20, z: 0 }, { x: 20, z: 0 })).toBe(false);
    applyDamageToAsteroid(world, ast, null, 100, "kinetic"); // hp 40 → destroyed
    expect(world.asteroids.get(ast)!.state).toBe("destroyed");
    expect(hasLineOfSight(world, { x: -20, z: 0 }, { x: 20, z: 0 })).toBe(true);
  });
});
