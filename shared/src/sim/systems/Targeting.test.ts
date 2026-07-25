import { beforeAll, describe, expect, it } from "vitest";

import type { ConfigService } from "../../core/ConfigService.js";
import type { ShipConfig } from "../../schemas/index.js";
import type { EntityId } from "../components.js";
import type { SimEvent } from "../events.js";
import { spawnShipFromConfig } from "../spawn.js";
import { INTERCEPTOR_FITTING, loadTestConfigs, makeWorld, rebuildSpatial } from "../testutil.js";
import type { World } from "../World.js";
import { combatSystem } from "./CombatSystem.js";
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

/** Shooter at the origin facing +x (heading 0) plus one enemy at `enemyPos`. */
function scene(enemyPos: { x: number; z: number }): { world: World; me: EntityId; foe: EntityId } {
  const world = makeWorld(configs);
  const me = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 0, z: 0 }, 0);
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

describe("candidate changes", () => {
  it("resets progress (and any lock) when a nearer enemy takes over the cone", () => {
    const world = makeWorld(configs);
    const me = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 0, z: 0 }, 0);
    const far = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 1, { x: 40, z: 0 }, Math.PI);
    const near = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 1, { x: 60, z: 0 }, Math.PI);
    const ref = world.targets.get(me)!;
    const lockTime = sensorsOf(world, me).lockTimeSec;

    run(world, ticksToLock(lockTime));
    expect(ref.targetId).toBe(far); // nearest of the two
    expect(ref.locked).toBe(true);

    // The other enemy closes inside it — nearest wins, and the new candidate
    // starts from zero (no lock inherited from the previous one).
    world.transforms.get(near)!.pos.x = 10;
    const events = run(world, 1);
    expect(ref.targetId).toBe(near);
    expect(ref.locked).toBe(false);
    expect(ref.lockProgress).toBeCloseTo(DT, 9);
    expect(events).toContainEqual({ type: "lockLost", entityId: me });
    expect(events).toContainEqual({ type: "targetSet", entityId: me, targetId: near });
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
});

// ---------------------------------------------------------------------------
// Interim manual target orders (retire with move orders)
// ---------------------------------------------------------------------------

describe("manual target orders (interim behaviour)", () => {
  it("pins WHICH enemy is the candidate but still requires the full lock", () => {
    const world = makeWorld(configs);
    const me = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 0, z: 0 }, 0);
    const near = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 1, { x: 10, z: 0 }, Math.PI);
    const far = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 1, { x: 30, z: 0 }, Math.PI);
    const ref = world.targets.get(me)!;

    world.queueOrder(me, { kind: "target", targetId: far });
    run(world, 1);
    expect(ref.targetId).toBe(far); // the pin beats the nearest-first policy
    expect(ref.manual).toBe(true);
    expect(ref.locked).toBe(false); // …but grants no free lock

    run(world, ticksToLock(sensorsOf(world, me).lockTimeSec) - 1);
    expect(ref.locked).toBe(true);
    expect(ref.targetId).toBe(far);
    void near;
  });

  it("clears the pin once progress drains out, handing the ship back to auto", () => {
    const world = makeWorld(configs);
    const me = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 0, z: 0 }, 0);
    const ahead = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 1, { x: 20, z: 0 }, Math.PI);
    const abeam = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 1, { x: 0, z: 25 }, Math.PI);
    const ref = world.targets.get(me)!;
    const lockTime = sensorsOf(world, me).lockTimeSec;

    world.queueOrder(me, { kind: "target", targetId: abeam }); // pinned outside the cone
    run(world, 1);
    // Nothing accrued (out of cone) and nothing to drain ⇒ the pin clears at once.
    expect(ref.manual).toBe(false);
    expect(ref.targetId).toBeNull();

    // Next tick auto targeting takes the enemy that IS in the cone.
    run(world, 1);
    expect(ref.targetId).toBe(ahead);
    run(world, ticksToLock(lockTime));
    expect(ref.locked).toBe(true);
  });

  it("a pinned target that leaves the cone drains, then releases the pin", () => {
    const world = makeWorld(configs);
    const me = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 0, z: 0 }, 0);
    const foe = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 1, { x: 20, z: 0 }, Math.PI);
    const ref = world.targets.get(me)!;
    const lockTime = sensorsOf(world, me).lockTimeSec;

    world.queueOrder(me, { kind: "target", targetId: foe });
    run(world, ticksToLock(lockTime));
    expect(ref.locked).toBe(true);
    expect(ref.manual).toBe(true);

    world.transforms.get(foe)!.pos = { x: 0, z: 25 }; // slides out of the cone
    run(world, ticksToDrain(world, lockTime) - 1);
    expect(ref.manual).toBe(true);
    expect(ref.locked).toBe(true);
    run(world, 1);
    expect(ref.manual).toBe(false);
    expect(ref.targetId).toBeNull();
    expect(ref.locked).toBe(false);
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
    }
    return before - world.shipCores.get(foe)!.hull;
  }

  it("holds fire until the lock completes, then shoots", () => {
    const { world, me, foe } = scene({ x: 20, z: 0 });
    const laser = world.modules.get(me)!.modules[LASER]!;
    laser.state = "active";
    const lockTicks = ticksToLock(sensorsOf(world, me).lockTimeSec);

    // Every tick up to (but excluding) the one that fills the lock: no damage.
    expect(fireFor(world, foe, lockTicks - 1)).toBe(0);
    expect(world.targets.get(me)!.locked).toBe(false);
    expect(fireFor(world, foe, 1)).toBeGreaterThan(0);
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
    for (let i = 0; i < ticksToLock(sensorsOf(world, me).lockTimeSec) - 1; i++) {
      targetingSystem(world, DT);
      combatSystem(world, DT);
    }
    expect(world.projectileIds().length).toBe(0);
    targetingSystem(world, DT);
    combatSystem(world, DT);
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
    // Fitted on the interceptor's utility hardpoint (index 3).
    const res = configs.replace({
      id: "module.test-longrangesensors",
      type: "module",
      version: 1,
      family: "utility",
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
      [null, null, null, "module.test-longrangesensors"],
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
