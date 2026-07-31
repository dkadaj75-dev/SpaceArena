import { beforeAll, describe, expect, it } from "vitest";
import type { ConfigService } from "../../core/ConfigService.js";
import type { ModuleConfig } from "../../schemas/module.js";
import type { ShipConfig } from "../../schemas/ship.js";
import { applyDamageToAsteroid, applyDamageToShip } from "../damage.js";
import { hasLineOfSight } from "../los.js";
import { spawnAsteroid, spawnProjectile, spawnShipFromConfig } from "../spawn.js";
import { INTERCEPTOR_FITTING, loadTestConfigs, makeWorld, rebuildSpatial, warmLock } from "../testutil.js";
import type { World } from "../World.js";
import { combatSystem, latchFireState } from "./CombatSystem.js";
import { energySystem } from "./EnergySystem.js";
import { navigationSystem } from "./NavigationSystem.js";
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
 * the assertions — the aimed (locked) firing path is the one under test here;
 * the no-lock straight-fire path has its own describe below.
 */
function duel(
  targetPos: { x: number; z: number },
  weapon = LASER,
): { world: World; shooter: number; target: number } {
  const world = makeWorld(configs);
  const shooter = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 0, z: 0 }, 0);
  const target = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 1, targetPos, 0);
  // Weapons spawn ONLINE now — park everything but the weapon under test so the
  // assertions keep isolating one module, exactly as before.
  for (const other of world.modules.get(shooter)!.modules) other.state = "retracted";
  for (const other of world.modules.get(target)!.modules) other.state = "retracted";
  const mod = world.modules.get(shooter)!.modules[weapon]!;
  mod.state = "active";
  mod.cycleTimer = 0;
  world.flightStates.set(shooter, {
    throttle: 0,
    turn: 0,
    pitchStick: 0,
    boost: false,
    fire: true,
    firePrev: false,
  });
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
    const { world, target } = duel({ x: 110, z: 0 }); // laser range 95 (2.5x pass, 2026-07-31)
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

describe("CombatSystem straight fire — no lock, non-homing weapons (2026-07-31)", () => {
  /** duel() with the lock stripped: trigger held, nothing locked. */
  function noLockDuel(targetPos: { x: number; z: number }, weapon = LASER) {
    const fixture = duel(targetPos, weapon);
    const ref = fixture.world.targets.get(fixture.shooter)!;
    ref.locked = false;
    ref.lockProgress = 0;
    ref.targetId = null;
    return fixture;
  }

  it("a hitscan laser damages the enemy sitting dead ahead on the nose line", () => {
    const { world, target } = noLockDuel({ x: 20, z: 0 });
    const before = world.shipCores.get(target)!.hull;
    combatSystem(world, DT);
    expect(world.shipCores.get(target)!.hull).toBeLessThan(before);
    const shot = world.events.find((e) => e.type === "projectileFired");
    expect(shot).toMatchObject({ kind: "beam", targetId: target });
  });

  it("a miss still spends the shot — cycle, heat, energy — and reports no victim", () => {
    const { world, shooter, target } = noLockDuel({ x: 20, z: 0 });
    world.transforms.get(shooter)!.heading = Math.PI / 2; // nose off the target
    rebuildSpatial(world);
    const before = world.shipCores.get(target)!.hull;

    combatSystem(world, DT);

    expect(world.shipCores.get(target)!.hull).toBe(before);
    const weapon = world.modules.get(shooter)!.modules[LASER]!;
    expect(weapon.workedThisTick).toBe(true);
    expect(weapon.cycleTimer).toBeGreaterThan(0);
    expect(weapon.heat).toBeGreaterThan(0); // authored heatPerShot
    expect(world.events.find((e) => e.type === "projectileFired")).toMatchObject({
      kind: "beam",
      targetId: null,
    });
  });

  it("an asteroid on the nose line soaks the beam instead of the ship behind it", () => {
    const { world, target } = noLockDuel({ x: 20, z: 0 });
    const rock = spawnAsteroid(world, configs, "asteroid.small-rock", { x: 10, z: 0 });
    rebuildSpatial(world);
    const shipBefore = world.shipCores.get(target)!.hull;
    const rockBefore = world.asteroids.get(rock)!.hp;

    combatSystem(world, DT);

    expect(world.shipCores.get(target)!.hull).toBe(shipBefore);
    expect(world.asteroids.get(rock)!.hp).toBeLessThan(rockBefore);
  });

  it("a kinetic weapon launches a dumb round down the nose that hits the ship ahead", () => {
    const KINETIC_FITTING = ["module.kinetic-mk1", null, null, null];
    const world = makeWorld(configs);
    const shooter = spawnShipFromConfig(world, configs, "ship.interceptor", KINETIC_FITTING, 0, { x: 0, z: 0 }, 0);
    const target = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 1, { x: 20, z: 0 }, 0);
    for (const m of world.modules.get(target)!.modules) m.state = "retracted";
    world.flightStates.set(shooter, {
      throttle: 0,
      turn: 0,
      pitchStick: 0,
      boost: false,
      fire: true,
      firePrev: false,
    });
    rebuildSpatial(world);

    const before = world.shipCores.get(target)!.hull;
    combatSystem(world, DT); // weapon spawned online; no lock at all
    expect(world.events.find((e) => e.type === "projectileFired")).toMatchObject({
      kind: "kinetic",
      targetId: null,
    });
    for (let i = 0; i < 30 && world.projectileIds().length > 0; i++) {
      rebuildSpatial(world);
      projectileSystem(world, DT);
    }
    expect(world.shipCores.get(target)!.hull).toBeLessThan(before);
  });

  it("the nose ray never reaches past fire.range", () => {
    const { world, target } = noLockDuel({ x: 110, z: 0 }); // laser range 95
    const before = world.shipCores.get(target)!.hull;
    combatSystem(world, DT);
    expect(world.shipCores.get(target)!.hull).toBe(before);
    // The shot itself still leaves (a visible miss), it just cannot connect.
    expect(world.events.find((e) => e.type === "projectileFired")).toMatchObject({ targetId: null });
  });
});

describe("CombatSystem trigger discipline", () => {
  function tick(world: World): void {
    combatSystem(world, DT);
    latchFireState(world);
  }

  it("an armed, locked weapon does not fire while fire is false", () => {
    const { world, shooter, target } = duel({ x: 20, z: 0 });
    world.flightStates.get(shooter)!.fire = false;
    const before = world.shipCores.get(target)!.hull;

    tick(world);

    expect(world.shipCores.get(target)!.hull).toBe(before);
    expect(world.modules.get(shooter)!.modules[LASER]!.workedThisTick).toBe(false);
    expect(world.events.some((event) => event.type === "projectileFired")).toBe(false);
  });

  it("held weapons repeat on their authored cycle while the trigger stays held", () => {
    const { world } = duel({ x: 20, z: 0 });
    for (let i = 0; i < 40; i++) tick(world);
    expect(world.events.filter((event) => event.type === "projectileFired").length).toBeGreaterThan(1);
  });

  it("semi weapons fire once per rising edge, not once per held tick", () => {
    const { world, shooter } = duel({ x: 20, z: 0 }, MISSILE);
    const weapon = world.modules.get(shooter)!.modules[MISSILE]!;

    tick(world);
    weapon.cycleTimer = 0;
    tick(world);
    expect(world.events.filter((event) => event.type === "projectileFired")).toHaveLength(1);

    world.flightStates.get(shooter)!.fire = false;
    tick(world);
    weapon.cycleTimer = 0;
    world.flightStates.get(shooter)!.fire = true;
    tick(world);
    expect(world.events.filter((event) => event.type === "projectileFired")).toHaveLength(2);
  });

  it("fires a semi weapon once when press and release arrive inside one sim tick", () => {
    const { world, shooter } = duel({ x: 20, z: 0 }, MISSILE);
    world.flightStates.get(shooter)!.fire = false;
    world.queueOrder(shooter, { kind: "flight", throttle: 0, turn: 0, boost: false, fire: true });
    world.queueOrder(shooter, { kind: "flight", throttle: 0, turn: 0, boost: false, fire: false });

    navigationSystem(world, DT);
    tick(world);
    expect(world.events.filter((event) => event.type === "projectileFired")).toHaveLength(1);

    // No new order: navigation restores the final release as the standing level.
    navigationSystem(world, DT);
    tick(world);
    expect(world.flightStates.get(shooter)!.fire).toBe(false);
    expect(world.events.filter((event) => event.type === "projectileFired")).toHaveLength(1);
  });

  it("drains cycleTimer while the trigger is released", () => {
    const { world, shooter } = duel({ x: 20, z: 0 });
    const weapon = world.modules.get(shooter)!.modules[LASER]!;
    weapon.cycleTimer = DT * 2;
    world.flightStates.get(shooter)!.fire = false;

    tick(world);

    expect(weapon.cycleTimer).toBeCloseTo(DT);
    expect(world.events.some((event) => event.type === "projectileFired")).toBe(false);
  });

  it("an unlocked trigger pull on a HOMING weapon spends nothing and emits nothing", () => {
    // Missiles are the one weapon class that still hard-requires a lock — they
    // need a target to home on. Straight-fire weapons are covered below.
    const { world, shooter } = duel({ x: 20, z: 0 }, MISSILE);
    world.targets.get(shooter)!.locked = false;
    const core = world.shipCores.get(shooter)!;
    const before = core.capacitor.cur;

    combatSystem(world, DT);

    expect(core.capacitor.cur).toBe(before);
    expect(world.modules.get(shooter)!.modules[MISSILE]!.workedThisTick).toBe(false);
    expect(world.events.some((event) => event.type === "projectileFired")).toBe(false);
  });

  it("a ship with no FlightState never fires", () => {
    const { world, shooter } = duel({ x: 20, z: 0 });
    world.flightStates.delete(shooter);

    tick(world);

    expect(world.modules.get(shooter)!.modules[LASER]!.workedThisTick).toBe(false);
    expect(world.events.some((event) => event.type === "projectileFired")).toBe(false);
  });

  it("presents one semi-auto edge uniformly to every weapon in a fitting", () => {
    const { world, shooter } = duel({ x: 20, z: 0 });
    const weapons = world.modules.get(shooter)!.modules.slice(0, 2);
    for (const weapon of weapons) {
      weapon.moduleId = "module.missile-mk1";
      weapon.state = "active";
      weapon.cycleTimer = 0;
    }

    tick(world);

    expect(world.events.filter((event) => event.type === "projectileFired")).toHaveLength(2);
    expect(world.flightStates.get(shooter)!.firePrev).toBe(true);
  });

  it("adds optional heatPerShot on the firing tick", () => {
    const { world, shooter } = duel({ x: 20, z: 0 });
    const config = world.configs.get<ModuleConfig>("module", "module.laser-mk1")!;
    const weapon = world.modules.get(shooter)!.modules[LASER]!;
    configs.replace({ ...config, fire: { ...config.fire!, heatPerShot: 3 } });
    try {
      combatSystem(world, DT);
      expect(weapon.heat).toBe(3);
      energySystem(world, DT);
      // Existing active heat (+0.2) and ship dissipation (-0.3) still apply
      // after the per-shot addition on this fitting.
      expect(weapon.heat).toBeCloseTo(2.9);
    } finally {
      configs.replace(config);
    }
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
    // Weapons spawn ONLINE — park everything, then arm only the lasers so the
    // shot ledger below counts one weapon per shooter.
    for (const m of world.modules.get(target)!.modules) m.state = "retracted";
    for (const shooter of [first, second]) {
      for (const m of world.modules.get(shooter)!.modules) m.state = "retracted";
      const mod = world.modules.get(shooter)!.modules[LASER]!;
      mod.state = "active";
      mod.cycleTimer = 0;
      world.targets.get(shooter)!.targetId = target;
      warmLock(world, shooter);
      world.flightStates.set(shooter, {
        throttle: 0,
        turn: 0,
        pitchStick: 0,
        boost: false,
        fire: true,
        firePrev: false,
      });
    }
    rebuildSpatial(world);
    return { world, first, second, target };
  }

  it("a wreck takes no further hits — the second attacker's held trigger degrades to a straight miss", () => {
    const { world, first, second, target } = twoOnOne();
    // One laser tick is enough to finish it.
    world.shipCores.get(target)!.hull = 1;

    combatSystem(world, DT);

    // The lower-id attacker fired and killed.
    expect(world.shipCores.get(target)!.hull).toBe(0);
    expect(world.modules.get(first)!.modules[LASER]!.cycleTimer).toBeGreaterThan(0);

    // The second one's lock target is a corpse, so its held trigger falls back
    // to the straight-fire path — and the nose raycast SKIPS dead hulls, so the
    // wreck is not hit again: no damage event names it after the kill.
    const events = world.events;
    const killIndex = events.findIndex((e) => e.type === "entityDestroyed");
    expect(killIndex).toBeGreaterThanOrEqual(0);
    const postKillHits = events
      .slice(killIndex + 1)
      .filter((e) => e.type === "damage" && e.targetId === target);
    expect(postKillHits).toHaveLength(0);
    // The straight shot still happened (heat/energy are the pilot's problem) —
    // as a beam with no victim.
    const shots = events.filter((e) => e.type === "projectileFired");
    expect(shots).toHaveLength(2);
    expect(shots[1]).toMatchObject({ ownerId: second, targetId: null });
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

/**
 * `fire.mode: "continuous"` — the channelled beam. Its contract, in one line:
 * `fire.damage` is DPS, applied as `damage * dt` on EVERY tick the trigger is
 * held and every existing gate passes, with no cycle timer and no per-tick
 * events. Everything below pins one clause of that.
 */
describe("CombatSystem continuous channel", () => {
  const BEAM = 0;
  const BEAM_FITTING = [
    "module.beamlaser-mk1",
    "module.missile-mk1",
    "module.shield-mk1",
    "module.boost-mk1",
  ];

  /** Same fixture as {@link duel}, fitted with the continuous beam on hardpoint 0. */
  function channelDuel(
    targetPos: { x: number; z: number } = { x: 20, z: 0 },
    cfgs: ConfigService = configs,
  ): { world: World; shooter: number; target: number; dps: number } {
    const world = makeWorld(cfgs);
    const shooter = spawnShipFromConfig(world, cfgs, "ship.interceptor", BEAM_FITTING, 0, { x: 0, z: 0 }, 0);
    const target = spawnShipFromConfig(world, cfgs, "ship.interceptor", INTERCEPTOR_FITTING, 1, targetPos, 0);
    // Weapons spawn ONLINE — retract everything, then arm only the beam so the
    // channel is measured in isolation (the semi missile would fire too).
    for (const other of world.modules.get(shooter)!.modules) other.state = "retracted";
    for (const other of world.modules.get(target)!.modules) other.state = "retracted";
    const mod = world.modules.get(shooter)!.modules[BEAM]!;
    mod.state = "active";
    world.flightStates.set(shooter, {
      throttle: 0,
      turn: 0,
      pitchStick: 0,
      boost: false,
      fire: true,
      firePrev: false,
    });
    world.targets.get(shooter)!.targetId = target;
    warmLock(world, shooter);
    rebuildSpatial(world);
    const dps = cfgs.get<ModuleConfig>("module", "module.beamlaser-mk1")!.fire!.damage;
    return { world, shooter, target, dps };
  }

  function channelTick(world: World): void {
    combatSystem(world, DT);
    latchFireState(world);
  }

  it("drains hull at exactly DPS x elapsed time while the trigger is held", () => {
    const { world, target, dps } = channelDuel();
    const before = world.shipCores.get(target)!.hull;

    const ticks = 60; // 2 seconds at 30 Hz
    for (let i = 0; i < ticks; i++) channelTick(world);

    const dealt = before - world.shipCores.get(target)!.hull;
    // globalDamageMult is 1.0 and the interceptor's energy resist is 0, so the
    // authored DPS lands verbatim. This is the whole feature in one assertion.
    expect(dealt).toBeCloseTo(dps * ticks * DT, 9);
  });

  it("is tick-rate independent: the same wall time deals the same damage at half the tick rate", () => {
    const a = channelDuel();
    const b = channelDuel();
    for (let i = 0; i < 60; i++) {
      combatSystem(a.world, DT);
      latchFireState(a.world);
    }
    for (let i = 0; i < 30; i++) {
      combatSystem(b.world, DT * 2);
      latchFireState(b.world);
    }
    const dealtA = 80 - a.world.shipCores.get(a.target)!.hull;
    const dealtB = 80 - b.world.shipCores.get(b.target)!.hull;
    expect(dealtA).toBeCloseTo(dealtB, 9);
  });

  it("never touches the cycle timer and never spawns ordnance", () => {
    const { world, shooter } = channelDuel();
    for (let i = 0; i < 30; i++) channelTick(world);
    expect(world.modules.get(shooter)!.modules[BEAM]!.cycleTimer).toBe(0);
    expect(world.projectileIds().length).toBe(0);
  });

  it("stops the very next tick when the trigger is released — no lingering damage", () => {
    const { world, shooter, target } = channelDuel();
    for (let i = 0; i < 10; i++) channelTick(world);
    expect(world.modules.get(shooter)!.modules[BEAM]!.channeling).toBe(true);

    world.flightStates.get(shooter)!.fire = false;
    const atRelease = world.shipCores.get(target)!.hull;
    channelTick(world);

    expect(world.shipCores.get(target)!.hull).toBe(atRelease);
    expect(world.modules.get(shooter)!.modules[BEAM]!.channeling).toBe(false);
    expect(world.modules.get(shooter)!.modules[BEAM]!.channel).toBe(null);
  });

  it("on lock loss falls back to the straight nose channel — off the nose line it stops", () => {
    const { world, shooter, target } = channelDuel();
    for (let i = 0; i < 10; i++) channelTick(world);

    // Lock breaks AND the target slides off the nose line: nothing on the ray,
    // so the channel stops that tick.
    world.targets.get(shooter)!.locked = false;
    world.transforms.get(target)!.pos.z += 30;
    rebuildSpatial(world);
    const atLockLoss = world.shipCores.get(target)!.hull;
    channelTick(world);

    expect(world.shipCores.get(target)!.hull).toBe(atLockLoss);
    expect(world.modules.get(shooter)!.modules[BEAM]!.channeling).toBe(false);
  });

  it("without a lock the channel chews whatever enemy the nose crosses (straight fire)", () => {
    const { world, shooter, target, dps } = channelDuel(); // target dead ahead at x=20
    world.targets.get(shooter)!.locked = false;
    world.targets.get(shooter)!.targetId = null;

    const before = world.shipCores.get(target)!.hull;
    const ticks = 30;
    for (let i = 0; i < ticks; i++) channelTick(world);

    expect(before - world.shipCores.get(target)!.hull).toBeCloseTo(dps * ticks * DT, 9);
    expect(world.modules.get(shooter)!.modules[BEAM]!.channeling).toBe(true);
  });

  it("a no-lock channel is blocked by an asteroid on the line and does not chew the rock", () => {
    const { world, shooter, target } = channelDuel();
    world.targets.get(shooter)!.locked = false;
    world.targets.get(shooter)!.targetId = null;
    const rock = spawnAsteroid(world, configs, "asteroid.small-rock", { x: 10, z: 0 });
    rebuildSpatial(world);

    const shipBefore = world.shipCores.get(target)!.hull;
    const rockBefore = world.asteroids.get(rock)!.hp;
    for (let i = 0; i < 10; i++) channelTick(world);

    expect(world.shipCores.get(target)!.hull).toBe(shipBefore);
    expect(world.asteroids.get(rock)!.hp).toBe(rockBefore);
    expect(world.modules.get(shooter)!.modules[BEAM]!.channeling).toBe(false);
  });

  it("stops when the module leaves the active state", () => {
    const { world, shooter, target } = channelDuel();
    for (let i = 0; i < 5; i++) channelTick(world);
    world.modules.get(shooter)!.modules[BEAM]!.state = "retracting";
    const atRetract = world.shipCores.get(target)!.hull;
    channelTick(world);
    expect(world.shipCores.get(target)!.hull).toBe(atRetract);
    expect(world.modules.get(shooter)!.modules[BEAM]!.channeling).toBe(false);
  });

  it("stops out of range and past a line-of-sight blocker", () => {
    const far = channelDuel({ x: 95, z: 0 }); // beam range is 85 (2.5x pass, 2026-07-31)
    const beforeFar = far.world.shipCores.get(far.target)!.hull;
    channelTick(far.world);
    expect(far.world.shipCores.get(far.target)!.hull).toBe(beforeFar);

    const blocked = channelDuel({ x: 20, z: 0 });
    spawnAsteroid(blocked.world, configs, "asteroid.large-hazard", { x: 10, z: 0 });
    rebuildSpatial(blocked.world);
    const beforeBlocked = blocked.world.shipCores.get(blocked.target)!.hull;
    channelTick(blocked.world);
    expect(blocked.world.shipCores.get(blocked.target)!.hull).toBe(beforeBlocked);
  });

  it("stops on an exhausted capacitor and RESUMES from regen with the trigger still held", () => {
    const { world, shooter, target } = channelDuel();
    const core = world.shipCores.get(shooter)!;
    core.capacitor.cur = 0;

    // Energy-starved: the gate blocks the channel, and EnergySystem's regen then
    // refills against the idle draw only.
    const beforeStarved = world.shipCores.get(target)!.hull;
    combatSystem(world, DT);
    energySystem(world, DT);
    latchFireState(world);
    expect(world.shipCores.get(target)!.hull).toBe(beforeStarved);
    expect(world.modules.get(shooter)!.modules[BEAM]!.channeling).toBe(false);

    // The trigger was never released — as soon as regen clears the gate the
    // channel resumes on its own.
    let resumed = false;
    for (let i = 0; i < 30 && !resumed; i++) {
      combatSystem(world, DT);
      energySystem(world, DT);
      latchFireState(world);
      resumed = world.modules.get(shooter)!.modules[BEAM]!.channeling;
    }
    expect(resumed).toBe(true);
    expect(world.shipCores.get(target)!.hull).toBeLessThan(beforeStarved);
  });

  it("pays drawActive and per-second heat EVERY tick it channels (the point of the cost model)", () => {
    const { world, shooter } = channelDuel();
    const beam = world.modules.get(shooter)!.modules[BEAM]!;
    const cfg = configs.get<ModuleConfig>("module", "module.beamlaser-mk1")!;
    const core = world.shipCores.get(shooter)!;
    core.capacitor.cur = core.capacitor.max;
    const energyBefore = core.capacitor.cur;

    for (let i = 0; i < 30; i++) {
      combatSystem(world, DT);
      expect(beam.workedThisTick).toBe(true); // worked-this-tick on EVERY tick
      energySystem(world, DT);
      latchFireState(world);
    }

    // One second of channel: `drawActive - regen` out of the capacitor (the
    // other fitted modules are retracted and cost nothing), and
    // `perSecondActive - dissipation` into the module's own heat.
    const spent = energyBefore - core.capacitor.cur;
    expect(spent).toBeGreaterThan(0);
    expect(spent).toBeCloseTo(cfg.energy.drawActive - core.capacitor.regen, 0);
    expect(beam.heat).toBeGreaterThan(0);
    expect(beam.heat).toBeCloseTo(cfg.heat.perSecondActive - core.heat.dissipation, 0);
  });

  it("emits ~4 damage events per second, not one per tick, and one fire event per channel", () => {
    const { world, shooter, target, dps } = channelDuel();
    for (let i = 0; i < 60; i++) channelTick(world); // 2 seconds
    world.flightStates.get(shooter)!.fire = false;
    channelTick(world); // release flushes the final partial window

    const fired = world.events.filter((e) => e.type === "projectileFired");
    expect(fired.length).toBe(1); // one per channel, NOT one per tick
    expect(fired[0]).toMatchObject({ kind: "beam", ownerId: shooter, targetId: target });

    const damage = world.events.filter((e) => e.type === "damage");
    // 2 s at the 0.25 s flush cadence, plus the release flush — nowhere near 60.
    expect(damage.length).toBeGreaterThanOrEqual(7);
    expect(damage.length).toBeLessThanOrEqual(10);

    // Throttling the EVENTS must not lose any DAMAGE: the reported total is the
    // hull the target actually lost.
    const reported = damage.reduce((sum, e) => sum + (e.type === "damage" ? e.amount : 0), 0);
    expect(reported).toBeCloseTo(80 - world.shipCores.get(target)!.hull, 9);
    expect(reported).toBeCloseTo(dps * 60 * DT, 9);
  });

  it("emits damage-then-destroyed when the channel lands the kill", () => {
    const { world, target } = channelDuel();
    world.shipCores.get(target)!.hull = 0.2; // dies inside one tick
    channelTick(world);

    const types = world.events.map((e) => e.type);
    expect(types).toContain("damage");
    expect(types).toContain("entityDestroyed");
    expect(types.indexOf("damage")).toBeLessThan(types.indexOf("entityDestroyed"));
    expect(world.shipCores.get(target)!.hull).toBe(0);
  });

  it("ignores fire.heatPerShot — a channel has no shot to charge it against", async () => {
    // Fresh registry: the override must not leak into the rest of this file.
    const cfgs = await loadTestConfigs();
    const base = cfgs.get<ModuleConfig>("module", "module.beamlaser-mk1")!;
    expect(cfgs.replace({ ...base, fire: { ...base.fire!, heatPerShot: 100 } }).ok).toBe(true);

    const { world, shooter } = channelDuel({ x: 20, z: 0 }, cfgs);
    combatSystem(world, DT); // heat accrual is EnergySystem's job, not the shot's
    expect(world.modules.get(shooter)!.modules[BEAM]!.heat).toBe(0);
  });

  it("leaves held and semi weapons on their own path (no channel state, cycle timers intact)", () => {
    const { world, shooter } = duel({ x: 20, z: 0 }); // stock interceptor: held laser + semi missile
    for (let i = 0; i < 30; i++) channelTick(world);
    for (const m of world.modules.get(shooter)!.modules) {
      expect(m.channeling).toBe(false);
      expect(m.channel).toBe(null);
    }
    expect(world.modules.get(shooter)!.modules[LASER]!.cycleTimer).toBeGreaterThan(0);
  });

  it("is not fitted by default anywhere — the shipped balance anchors cannot move", () => {
    for (const ship of configs.getAll<ShipConfig>("ship")) {
      expect(ship.defaultFitting).not.toContain("module.beamlaser-mk1");
    }
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
