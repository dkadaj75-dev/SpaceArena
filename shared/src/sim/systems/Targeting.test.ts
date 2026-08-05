import { beforeAll, describe, expect, it } from "vitest";

import type { ConfigService } from "../../core/ConfigService.js";
import type { ShipConfig } from "../../schemas/index.js";
import type { EntityId } from "../components.js";
import type { SimEvent } from "../events.js";
import { spawnShipFromConfig } from "../spawn.js";
import { INTERCEPTOR_FITTING, loadTestConfigs, makeWorld, rebuildSpatial } from "../testutil.js";
import type { World } from "../World.js";
import { combatSystem, latchFireState } from "./CombatSystem.js";
import { targetingSystem } from "./TargetingSystem.js";

/**
 * Sensors + time-based lock-on (FLIGHT.md §2). Everything here is driven off the
 * shipped `core.sensors` block and `tuning.lockDecayMult` — no test hardcodes a
 * cone width, a lock time or a drain rate, so a content re-tune moves these
 * tests with it instead of breaking them.
 */

const DT = 1 / 30;
const LASER = 0;

let configs: ConfigService;
beforeAll(async () => {
  configs = await loadTestConfigs();
});

/**
 * Shooter at the origin facing (heading, pitch) plus one enemy at `enemyPos`.
 * `enemyPos.y` defaults to the old ground plane, so the planar cases below read
 * exactly as they did before the bubble.
 */
function scene(
  enemyPos: { x: number; y?: number; z: number },
  self: { heading?: number; pitch?: number } = {},
): { world: World; me: EntityId; foe: EntityId } {
  const world = makeWorld(configs);
  const me = spawnShipFromConfig(
    world,
    configs,
    "ship.interceptor",
    INTERCEPTOR_FITTING,
    0,
    { x: 0, z: 0 },
    self.heading ?? 0,
    undefined,
    self.pitch ?? 0,
  );
  world.flightStates.set(me, {
    throttle: 0,
    turn: 0,
    pitchStick: 0,
    boost: false,
    fire: true,
    firePrev: false,
  });
  const foe = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 1, enemyPos, Math.PI);
  rebuildSpatial(world);
  return { world, me, foe };
}

const sensorsOf = (world: World, id: EntityId) => world.shipCores.get(id)!.sensors;

/**
 * Ticks needed to fill a lock, accumulated exactly as the system accumulates it
 * (`progress += dt`), so the expectation cannot drift from the sim by a float ulp.
 */
function ticksToLock(lockTimeSec: number): number {
  let acc = 0;
  let ticks = 0;
  while (acc < lockTimeSec) {
    acc += DT;
    ticks++;
  }
  return ticks;
}

/** Ticks needed to drain a full lock at `tuning.lockDecayMult`, same accumulation. */
function ticksToDrain(world: World, lockTimeSec: number): number {
  const step = DT * (world.tuning.lockDecayMult ?? 1.5);
  let acc = lockTimeSec;
  let ticks = 0;
  while (acc > 0) {
    acc -= step;
    ticks++;
  }
  return ticks;
}

/** Run `n` targeting ticks, returning every event they emitted. */
function run(world: World, n: number): SimEvent[] {
  const before = world.events.length;
  for (let i = 0; i < n; i++) targetingSystem(world, DT);
  return world.events.slice(before);
}

// ---------------------------------------------------------------------------
// Cone + range geometry
// ---------------------------------------------------------------------------

describe("lock zone geometry (heading-relative cone × lockRange)", () => {
  it("picks up an enemy dead ahead and ignores one abeam", () => {
    const ahead = scene({ x: 20, z: 0 });
    run(ahead.world, 1);
    expect(ahead.world.targets.get(ahead.me)!.targetId).toBe(ahead.foe);

    const abeam = scene({ x: 0, z: 20 }); // 90° off the nose
    run(abeam.world, 1);
    expect(abeam.world.targets.get(abeam.me)!.targetId).toBeNull();
  });

  it("uses coneDeg as the FULL width: just inside coneDeg/2 locks, just outside does not", () => {
    const { world, me } = scene({ x: 20, z: 0 });
    const half = (sensorsOf(world, me).coneDeg * Math.PI) / 360;
    const d = 20;

    const inside = scene({ x: d * Math.cos(half * 0.95), z: d * Math.sin(half * 0.95) });
    run(inside.world, 1);
    expect(inside.world.targets.get(inside.me)!.targetId).toBe(inside.foe);

    const outside = scene({ x: d * Math.cos(half * 1.05), z: d * Math.sin(half * 1.05) });
    run(outside.world, 1);
    expect(outside.world.targets.get(outside.me)!.targetId).toBeNull();
  });

  it("is symmetric about the nose (port and starboard behave identically)", () => {
    const { world, me } = scene({ x: 20, z: 0 });
    const half = (sensorsOf(world, me).coneDeg * Math.PI) / 360;
    const port = scene({ x: 20 * Math.cos(half * 0.9), z: -20 * Math.sin(half * 0.9) });
    run(port.world, 1);
    expect(port.world.targets.get(port.me)!.targetId).toBe(port.foe);
  });

  it("honours lockRange: an enemy dead ahead but beyond it is not a candidate", () => {
    const probe = scene({ x: 1, z: 0 });
    const range = sensorsOf(probe.world, probe.me).lockRange;

    const near = scene({ x: range * 0.98, z: 0 });
    run(near.world, 1);
    expect(near.world.targets.get(near.me)!.targetId).toBe(near.foe);

    const far = scene({ x: range * 1.02, z: 0 });
    run(far.world, 1);
    expect(far.world.targets.get(far.me)!.targetId).toBeNull();
  });

  it("follows the ship's heading, not world axes", () => {
    const { world, me, foe } = scene({ x: 0, z: 20 });
    run(world, 1);
    expect(world.targets.get(me)!.targetId).toBeNull();
    // Pitch the nose onto the enemy: the same world position is now in the cone.
    world.transforms.get(me)!.heading = Math.PI / 2;
    run(world, 1);
    expect(world.targets.get(me)!.targetId).toBe(foe);
  });

  it("never locks a friendly ship inside the cone", () => {
    const world = makeWorld(configs);
    const me = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 0, z: 0 }, 0);
    spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 15, z: 0 }, Math.PI);
    run(world, 1);
    expect(world.targets.get(me)!.targetId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Lock timing
// ---------------------------------------------------------------------------

describe("lock timing across ticks", () => {
  it("acquiring a lock never fires a weapon while the flight trigger is false", () => {
    const { world, me, foe } = scene({ x: 20, z: 0 });
    world.flightStates.get(me)!.fire = false;
    const before = world.shipCores.get(foe)!.hull;
    for (let i = 0; i < ticksToLock(sensorsOf(world, me).lockTimeSec) + 2; i++) {
      targetingSystem(world, DT);
      combatSystem(world, DT);
      latchFireState(world);
    }
    expect(world.targets.get(me)!.locked).toBe(true);
    expect(world.shipCores.get(foe)!.hull).toBe(before);
    expect(world.events.some((event) => event.type === "projectileFired")).toBe(false);
  });

  it("accrues dt per tick, caps at lockTimeSec and flips `locked` on the filling tick", () => {
    const { world, me, foe } = scene({ x: 20, z: 0 });
    const lockTime = sensorsOf(world, me).lockTimeSec;
    const ticks = ticksToLock(lockTime);
    const ref = world.targets.get(me)!;

    run(world, 1);
    expect(ref.lockProgress).toBeCloseTo(DT, 9);
    expect(ref.locked).toBe(false);

    run(world, ticks - 2); // one tick short of full
    expect(ref.locked).toBe(false);
    expect(ref.lockProgress).toBeLessThan(lockTime);

    const events = run(world, 1);
    expect(ref.locked).toBe(true);
    expect(ref.lockProgress).toBeCloseTo(lockTime, 9);
    expect(events).toContainEqual({ type: "lockAcquired", entityId: me, targetId: foe });

    // Held: progress never exceeds the cap and the event does not repeat.
    const held = run(world, 30);
    expect(ref.lockProgress).toBe(lockTime);
    expect(held.some((e) => e.type === "lockAcquired")).toBe(false);
  });

  it("locks faster on a hull with a shorter lockTimeSec (per-ship, from config)", () => {
    const fast = scene({ x: 20, z: 0 });
    const slowWorld = makeWorld(configs);
    const slow = spawnShipFromConfig(slowWorld, configs, "ship.brawler", ["module.kinetic-mk1"], 0, { x: 0, z: 0 }, 0);
    spawnShipFromConfig(slowWorld, configs, "ship.brawler", ["module.kinetic-mk1"], 1, { x: 20, z: 0 }, Math.PI);

    expect(sensorsOf(slowWorld, slow).lockTimeSec).toBeGreaterThan(sensorsOf(fast.world, fast.me).lockTimeSec);
    const fastTicks = ticksToLock(sensorsOf(fast.world, fast.me).lockTimeSec);
    run(fast.world, fastTicks);
    run(slowWorld, fastTicks);
    expect(fast.world.targets.get(fast.me)!.locked).toBe(true);
    expect(slowWorld.targets.get(slow)!.locked).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Drain (the lock-break grace) + candidate changes
// ---------------------------------------------------------------------------

describe("drain hysteresis when the target leaves the zone", () => {
  it("keeps the lock while progress remains, then drops target + lock at 0", () => {
    const { world, me, foe } = scene({ x: 20, z: 0 });
    const lockTime = sensorsOf(world, me).lockTimeSec;
    const ref = world.targets.get(me)!;
    run(world, ticksToLock(lockTime));
    expect(ref.locked).toBe(true);

    // Break the cone by turning away — the enemy never moves.
    world.transforms.get(me)!.heading = Math.PI / 2;
    const drainTicks = ticksToDrain(world, lockTime);

    const early = run(world, drainTicks - 1);
    expect(ref.locked).toBe(true); // grace window: still shooting
    expect(ref.targetId).toBe(foe);
    expect(ref.lockProgress).toBeGreaterThan(0);
    expect(early.some((e) => e.type === "lockLost")).toBe(false);

    const last = run(world, 1);
    expect(ref.locked).toBe(false);
    expect(ref.lockProgress).toBe(0);
    expect(ref.targetId).toBeNull();
    expect(last).toContainEqual({ type: "lockLost", entityId: me });
    expect(last).toContainEqual({ type: "targetSet", entityId: me, targetId: null });
  });

  it("drains at tuning.lockDecayMult, so the grace is shorter than the lock", () => {
    const { world, me } = scene({ x: 20, z: 0 });
    const lockTime = sensorsOf(world, me).lockTimeSec;
    run(world, ticksToLock(lockTime));
    world.transforms.get(me)!.heading = Math.PI / 2;
    const drainTicks = ticksToDrain(world, lockTime);
    expect(drainTicks).toBeLessThan(ticksToLock(lockTime));
    expect(world.tuning.lockDecayMult).toBeGreaterThan(1);
  });

  it("re-entering the cone mid-drain resumes from the remaining progress", () => {
    const { world, me } = scene({ x: 20, z: 0 });
    const lockTime = sensorsOf(world, me).lockTimeSec;
    const ref = world.targets.get(me)!;
    const half = Math.floor(ticksToLock(lockTime) / 2);
    run(world, half);
    const partial = ref.lockProgress;

    world.transforms.get(me)!.heading = Math.PI / 2;
    run(world, 2);
    const drained = ref.lockProgress;
    expect(drained).toBeLessThan(partial);
    expect(drained).toBeGreaterThan(0);

    world.transforms.get(me)!.heading = 0;
    run(world, 1);
    expect(ref.lockProgress).toBeCloseTo(drained + DT, 9);
  });
});

describe("sticky candidate (FLIGHT.md §2)", () => {
  it("keeps the incumbent while it stays lockable, even when a nearer enemy arrives", () => {
    const world = makeWorld(configs);
    const me = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 0, z: 0 }, 0);
    const held = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 1, { x: 40, z: 0 }, Math.PI);
    const other = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 1, { x: 60, z: 0 }, Math.PI);
    const ref = world.targets.get(me)!;
    const lockTime = sensorsOf(world, me).lockTimeSec;

    run(world, ticksToLock(lockTime));
    expect(ref.targetId).toBe(held); // nearest of the two when selection last ran
    expect(ref.locked).toBe(true);

    // The other enemy closes well inside it. Under a re-rank-every-tick rule the
    // sensors would jump ship and throw the finished lock away; the sticky rule
    // holds whoever is already lockable.
    world.transforms.get(other)!.pos.x = 10;
    const events = run(world, 30);
    expect(ref.targetId).toBe(held);
    expect(ref.locked).toBe(true);
    expect(ref.lockProgress).toBeCloseTo(lockTime, 9);
    expect(events.some((e) => e.type === "lockLost")).toBe(false);
    expect(events.some((e) => e.type === "targetSet")).toBe(false);
  });

  it("stays sticky mid-warm-up, so a churning ranking can never starve a lock", () => {
    const world = makeWorld(configs);
    const me = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 0, z: 0 }, 0);
    const held = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 1, { x: 40, z: 0 }, Math.PI);
    const other = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 1, { x: 50, z: 0 }, Math.PI);
    const ref = world.targets.get(me)!;
    const lockTime = sensorsOf(world, me).lockTimeSec;

    run(world, 2);
    expect(ref.targetId).toBe(held);

    // Trade places every tick for the whole warm-up: the lock still completes.
    const total = ticksToLock(lockTime);
    for (let i = 0; i < total - 2; i++) {
      world.transforms.get(other)!.pos.x = i % 2 === 0 ? 5 : 55;
      run(world, 1);
    }
    expect(ref.targetId).toBe(held);
    expect(ref.locked).toBe(true);
  });

  it("re-selects the moment the incumbent leaves the zone, resetting progress", () => {
    const world = makeWorld(configs);
    const me = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 0, z: 0 }, 0);
    const held = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 1, { x: 20, z: 0 }, Math.PI);
    const other = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 1, { x: 30, z: 8 }, Math.PI);
    const ref = world.targets.get(me)!;

    run(world, ticksToLock(sensorsOf(world, me).lockTimeSec));
    expect(ref.targetId).toBe(held);
    expect(ref.locked).toBe(true);

    // The incumbent slides abeam, out of the cone. There IS another candidate in
    // the zone, so this is a switch, not a drain: no grace, progress from zero.
    world.transforms.get(held)!.pos = { x: 0, y: 0, z: 40 };
    const events = run(world, 1);
    expect(ref.targetId).toBe(other);
    expect(ref.locked).toBe(false);
    expect(ref.lockProgress).toBeCloseTo(DT, 9);
    expect(events).toContainEqual({ type: "lockLost", entityId: me });
    expect(events).toContainEqual({ type: "targetSet", entityId: me, targetId: other });
  });

  it("drops a destroyed target immediately — no drain grace for a wreck", () => {
    const world = makeWorld(configs);
    const me = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 0, z: 0 }, 0);
    const foe = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 1, { x: 20, z: 0 }, Math.PI);
    const ref = world.targets.get(me)!;
    run(world, ticksToLock(sensorsOf(world, me).lockTimeSec));
    expect(ref.locked).toBe(true);

    world.destroyEntity(foe);
    const events = run(world, 1);
    expect(ref.targetId).toBeNull();
    expect(ref.locked).toBe(false);
    expect(ref.lockProgress).toBe(0);
    expect(events).toContainEqual({ type: "lockLost", entityId: me });
  });

  it("hands the ship to the next enemy once a dead incumbent has been dropped", () => {
    const world = makeWorld(configs);
    const me = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 0, z: 0 }, 0);
    const first = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 1, { x: 20, z: 0 }, Math.PI);
    const second = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 1, { x: 34, z: 0 }, Math.PI);
    const ref = world.targets.get(me)!;

    run(world, 2);
    expect(ref.targetId).toBe(first);

    world.destroyEntity(first);
    run(world, 1);
    expect(ref.targetId).toBe(second);
    run(world, ticksToLock(sensorsOf(world, me).lockTimeSec));
    expect(ref.locked).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The gate CombatSystem reads
// ---------------------------------------------------------------------------

describe("CombatSystem lock gate", () => {
  /** Tick targeting+combat, reporting how much hull `foe` lost. */
  function fireFor(world: World, foe: EntityId, ticks: number): number {
    const before = world.shipCores.get(foe)!.hull;
    for (let i = 0; i < ticks; i++) {
      targetingSystem(world, DT);
      combatSystem(world, DT);
      latchFireState(world);
    }
    return before - world.shipCores.get(foe)!.hull;
  }

  it("an off-nose target inside the cone is safe until the lock completes, then the aim takes over", () => {
    // Off the nose ray (z=8 at x=20 ≈ 22° — inside the 30° half-cone, well past
    // the 1.8-unit ray reach): straight fire misses, so damage starts exactly
    // when the lock fills and the aimed path engages.
    const { world, me, foe } = scene({ x: 20, z: 8 });
    const laser = world.modules.get(me)!.modules[LASER]!;
    laser.state = "active";
    const lockTicks = ticksToLock(sensorsOf(world, me).lockTimeSec);

    // Every tick up to (but excluding) the one that fills the lock: no damage.
    // (Straight fire is happening the whole time — it just cannot connect off
    // the nose line, which is what makes this a clean read of the lock gate.)
    expect(fireFor(world, foe, lockTicks - 1)).toBe(0);
    expect(world.targets.get(me)!.locked).toBe(false);
    // Once locked, the next cleared cycle lands on the target.
    expect(fireFor(world, foe, 15)).toBeGreaterThan(0);
  });

  it("a target dead on the nose line is hit by straight fire before any lock completes", () => {
    const { world, me, foe } = scene({ x: 20, z: 0 });
    const lockTicks = ticksToLock(sensorsOf(world, me).lockTimeSec);
    const dealt = fireFor(world, foe, Math.min(2, lockTicks - 1));
    expect(world.targets.get(me)!.locked).toBe(false);
    expect(dealt).toBeGreaterThan(0);
  });

  it("keeps firing through the drain grace and stops when the lock breaks", () => {
    const { world, me, foe } = scene({ x: 20, z: 0 });
    const laser = world.modules.get(me)!.modules[LASER]!;
    laser.state = "active";
    const lockTime = sensorsOf(world, me).lockTimeSec;
    fireFor(world, foe, ticksToLock(lockTime));

    // Turn away: the cone is broken but the grace window is still shooting.
    world.transforms.get(me)!.heading = Math.PI / 2;
    const drainTicks = ticksToDrain(world, lockTime);
    expect(fireFor(world, foe, drainTicks - 1)).toBeGreaterThan(0);

    // Past the drain the target is dropped and nothing fires again.
    fireFor(world, foe, 1);
    expect(world.targets.get(me)!.locked).toBe(false);
    expect(fireFor(world, foe, 60)).toBe(0);
  });

  it("gates missiles the same way as beams (all weapon kinds need lock)", () => {
    const { world, me } = scene({ x: 20, z: 0 });
    const missile = world.modules.get(me)!.modules[1]!; // hardpoint 1 = missile-mk1
    missile.state = "active";
    world.flightStates.get(me)!.fire = false;
    for (let i = 0; i < ticksToLock(sensorsOf(world, me).lockTimeSec) - 1; i++) {
      targetingSystem(world, DT);
      combatSystem(world, DT);
      latchFireState(world);
    }
    expect(world.projectileIds().length).toBe(0);
    world.flightStates.get(me)!.fire = true;
    targetingSystem(world, DT);
    combatSystem(world, DT);
    latchFireState(world);
    expect(world.projectileIds().length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Resolved (not raw config) sensors
// ---------------------------------------------------------------------------

describe("sensors come from the resolver", () => {
  it("a module statOp that extends lockRange extends the zone the sim uses", () => {
    const world = makeWorld(configs);
    const range = configs.get<ShipConfig>("ship", "ship.interceptor")!.core.sensors.lockRange;
    // Fitted in the light hull's SENSORS bay (slot 6) — where a sensor suite
    // lives since the internal bay landed (2026-07-31).
    const res = configs.replace({
      id: "module.test-longrangesensors",
      type: "module",
      version: 1,
      family: "sensors",
      level: 1,
      activation: { deployTime: 0, retractTime: 0 },
      energy: { drawIdle: 0, drawActive: 0 },
      heat: { perSecondActive: 0, overheatThreshold: 1, overheatCooldown: 0, overheatSelfDamage: 0 },
      passives: [{ target: "sensors.lockRange", op: "add", value: 20 }],
      ui: { icon: "s", label: "Long Range Sensors" },
      price: 0,
      requiresLevel: 1,
    });
    expect(res.ok).toBe(true);

    const me = spawnShipFromConfig(
      world,
      configs,
      "ship.interceptor",
      [null, null, null, null, null, null, "module.test-longrangesensors"],
      0,
      { x: 0, z: 0 },
      0,
    );
    const foe = spawnShipFromConfig(
      world,
      configs,
      "ship.interceptor",
      INTERCEPTOR_FITTING,
      1,
      { x: range + 10, z: 0 },
      Math.PI,
    );
    expect(sensorsOf(world, me).lockRange).toBeCloseTo(range + 20, 6);

    // Beyond the ship's base lockRange, inside the fitted one.
    run(world, 1);
    expect(world.targets.get(me)!.targetId).toBe(foe);
  });
});

// ---------------------------------------------------------------------------
// 3D cone + range (BUBBLE.md §A)
// ---------------------------------------------------------------------------

describe("lock zone in the bubble (3D cone, 3D range)", () => {
  /** Half the ship's own cone, in radians — nothing here hardcodes a cone width. */
  function halfCone(world: World, id: EntityId): number {
    return (sensorsOf(world, id).coneDeg * Math.PI) / 360;
  }

  it("locks an enemy above the nose while it is inside the cone, and not once it climbs out", () => {
    const probe = scene({ x: 30, z: 0 });
    const half = halfCone(probe.world, probe.me);
    const range = sensorsOf(probe.world, probe.me).lockRange;
    const dist = Math.min(30, range - 5);

    // Elevation well inside the half-cone: still a target for a level ship.
    const inside = scene({ x: dist * Math.cos(half * 0.5), y: dist * Math.sin(half * 0.5), z: 0 });
    run(inside.world, 1);
    expect(inside.world.targets.get(inside.me)!.targetId).toBe(inside.foe);

    // Same distance, elevated past the cone edge: the planar angleDelta this
    // replaces saw a bearing of exactly 0 here and would have locked it.
    const outside = scene({ x: dist * Math.cos(half * 1.4), y: dist * Math.sin(half * 1.4), z: 0 });
    run(outside.world, 1);
    expect(outside.world.targets.get(outside.me)!.targetId).toBeNull();
  });

  it("locks an enemy below the nose symmetrically", () => {
    const half = halfCone(scene({ x: 1, z: 0 }).world, 1);
    const dist = 30;
    const below = scene({ x: dist * Math.cos(half * 0.5), y: -dist * Math.sin(half * 0.5), z: 0 });
    run(below.world, 1);
    expect(below.world.targets.get(below.me)!.targetId).toBe(below.foe);

    const tooLow = scene({ x: dist * Math.cos(half * 1.4), y: -dist * Math.sin(half * 1.4), z: 0 });
    run(tooLow.world, 1);
    expect(tooLow.world.targets.get(tooLow.me)!.targetId).toBeNull();
  });

  it("follows the ship's own pitch: a climbing nose sees what a level one cannot", () => {
    const dist = 30;
    const steep = 1.0; // radians up — outside any shipped half-cone from level
    const target = { x: dist * Math.cos(steep), y: dist * Math.sin(steep), z: 0 };

    const level = scene(target);
    run(level.world, 1);
    expect(level.world.targets.get(level.me)!.targetId).toBeNull();

    // Nose pitched onto the same enemy: dead ahead in 3D.
    const climbing = scene(target, { pitch: steep });
    run(climbing.world, 1);
    expect(climbing.world.targets.get(climbing.me)!.targetId).toBe(climbing.foe);
  });

  it("measures range in 3D — altitude counts as distance", () => {
    const probe = scene({ x: 1, z: 0 });
    const range = sensorsOf(probe.world, probe.me).lockRange;

    // Directly ahead but high enough that the 3D distance exceeds lockRange,
    // while the planar distance alone would be comfortably inside it. Pitched
    // onto the target so the cone is never the reason it fails.
    const y = range * 1.2;
    const x = 5;
    const far = scene({ x, y, z: 0 }, { pitch: Math.atan2(y, x) });
    expect(Math.hypot(x, y)).toBeGreaterThan(range);
    run(far.world, 1);
    expect(far.world.targets.get(far.me)!.targetId).toBeNull();

    const near = scene({ x, y: range * 0.5, z: 0 }, { pitch: Math.atan2(range * 0.5, x) });
    run(near.world, 1);
    expect(near.world.targets.get(near.me)!.targetId).toBe(near.foe);
  });

  it("holds at wrap-around headings with the nose at the pitch extremes", () => {
    // heading π is the wrap seam, where a planar angleDelta had to be careful;
    // the 3D dot product has no seam at all. Nose steeply down, enemy on the
    // same line: locked. Enemy on the mirror line: not.
    const dist = 25;
    const pitch = -1.2;
    const heading = Math.PI;
    const ahead = {
      x: dist * Math.cos(pitch) * Math.cos(heading),
      y: dist * Math.sin(pitch),
      z: dist * Math.cos(pitch) * Math.sin(heading),
    };
    const locked = scene(ahead, { heading, pitch });
    run(locked.world, 1);
    expect(locked.world.targets.get(locked.me)!.targetId).toBe(locked.foe);

    const behind = scene({ x: -ahead.x, y: -ahead.y, z: -ahead.z }, { heading, pitch });
    run(behind.world, 1);
    expect(behind.world.targets.get(behind.me)!.targetId).toBeNull();
  });
});
