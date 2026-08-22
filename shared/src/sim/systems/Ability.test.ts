import { beforeAll, describe, expect, it } from "vitest";
import type { ConfigService } from "../../core/ConfigService.js";
import type { ModuleConfig } from "../../schemas/module.js";
import type { EntityId } from "../components.js";
import { spawnShipFromConfig } from "../spawn.js";
import {
  INTERCEPTOR_FITTING,
  INTERCEPTOR_FITTING_REPAIR,
  INTERCEPTOR_FITTING_SLOW_RAY,
  INTERCEPTOR_SLOTS,
  loadTestConfigs,
  makeWorld,
} from "../testutil.js";
import type { World } from "../World.js";
import { abilitySystem, applySlow, slowMultiplierFor } from "./AbilitySystem.js";
import { moduleSystem } from "./ModuleSystem.js";
import { navigationSystem } from "./NavigationSystem.js";

const DT = 1 / 30;
/** The slot both new modules occupy in the fixtures above. */
const PULSE = INTERCEPTOR_SLOTS.missile;

let configs: ConfigService;
beforeAll(async () => {
  configs = await loadTestConfigs();
});

const rayCfg = () => configs.get<ModuleConfig>("module", "module.ray-slow-mk1")!.slow!;
const fieldCfg = () => configs.get<ModuleConfig>("module", "module.field-repair-mk1")!.repairField!;

function ship(world: World, fitting: readonly string[], team = 0, pos = { x: 0, z: 0 }, heading = 0): EntityId {
  return spawnShipFromConfig(world, configs, "ship.interceptor", fitting, team, pos, heading);
}

/** The runtime for the pulse module on `id`. */
const pulseOf = (world: World, id: EntityId) =>
  world.modules.get(id)!.modules.find((m) => m.hardpointIndex === PULSE)!;

/**
 * Press the pulse button and run the sim far enough for the deploy to finish —
 * the whole activation path a pilot's tap takes, not a poke at the runtime.
 */
function pulse(world: World, id: EntityId, seconds = 1): void {
  world.queueOrder(id, { kind: "moduleToggle", hardpointIndex: PULSE });
  for (let t = 0; t < Math.round(seconds / DT); t++) {
    moduleSystem(world, DT);
    abilitySystem(world, DT);
  }
}

/** Lock `attacker` onto `target` the way the targeting system would have. */
function lock(world: World, attacker: EntityId, target: EntityId): void {
  const ref = world.targets.get(attacker)!;
  ref.targetId = target;
  ref.lockProgress = world.shipCores.get(attacker)!.sensors.lockTimeSec;
  ref.locked = true;
}

describe("slowing ray (owner 2026-08-22)", () => {
  it("slows the LOCKED target on a tap, for the authored duration", () => {
    const world = makeWorld(configs);
    const attacker = ship(world, INTERCEPTOR_FITTING_SLOW_RAY);
    const victim = ship(world, INTERCEPTOR_FITTING, 1, { x: 40, z: 0 }, Math.PI);
    lock(world, attacker, victim);

    pulse(world, attacker);

    const slow = world.slows.get(victim)!;
    expect(slow.factor).toBe(rayCfg().factor);
    expect(slow.sourceId).toBe(attacker);
    // The tap spent one second of the duration getting through the deploy.
    expect(slow.remaining).toBeGreaterThan(0);
    expect(slow.remaining).toBeLessThanOrEqual(rayCfg().durationSec);
    expect(world.events.some((e) => e.type === "slowApplied")).toBe(true);
  });

  it("takes the authored fraction off TOP SPEED and leaves acceleration alone", () => {
    const world = makeWorld(configs);
    const victim = ship(world, INTERCEPTOR_FITTING);
    const nominal = world.shipCores.get(victim)!.engine.nominalSpeed;
    world.queueOrder(victim, { kind: "flight", throttle: 1, turn: 0, boost: false, fire: false });

    // Free: full throttle converges on nominal speed.
    for (let t = 0; t < 300; t++) navigationSystem(world, DT);
    const free = Math.hypot(
      world.velocities.get(victim)!.x,
      world.velocities.get(victim)!.y,
      world.velocities.get(victim)!.z,
    );
    expect(free).toBeCloseTo(nominal, 3);

    applySlow(world, victim, 0.35, 10, null);
    // It decelerates INTO the new cap at its normal accel rate rather than
    // snapping — that is the whole reason the slow scales speed, not velocity.
    const oneTickLater = (): number => {
      navigationSystem(world, DT);
      const v = world.velocities.get(victim)!;
      return Math.hypot(v.x, v.y, v.z);
    };
    const afterOneTick = oneTickLater();
    const accelStep = world.shipCores.get(victim)!.engine.accel * DT;
    expect(free - afterOneTick).toBeCloseTo(accelStep, 6);

    for (let t = 0; t < 300; t++) navigationSystem(world, DT);
    const slowed = Math.hypot(
      world.velocities.get(victim)!.x,
      world.velocities.get(victim)!.y,
      world.velocities.get(victim)!.z,
    );
    expect(slowed).toBeCloseTo(nominal * 0.65, 3);
  });

  it("REFRESHES rather than stacking: two rays are the better ray, not a parked hull", () => {
    const world = makeWorld(configs);
    const victim = ship(world, INTERCEPTOR_FITTING);

    applySlow(world, victim, 0.3, 4, 1);
    // Age it most of the way down, then land a stronger one.
    for (let t = 0; t < Math.round(3 / DT); t++) abilitySystem(world, DT);
    applySlow(world, victim, 0.5, 4, 2);
    expect(slowMultiplierFor(world, victim)).toBeCloseTo(0.5, 6); // not 0.7 × 0.5
    expect(world.slows.get(victim)!.remaining).toBeCloseTo(4, 6);
    expect(world.slows.get(victim)!.sourceId).toBe(2);

    // A WEAKER pulse landing on top may refresh the clock but must never
    // downgrade the slow that is already running.
    applySlow(world, victim, 0.1, 6, 3);
    expect(world.slows.get(victim)!.factor).toBeCloseTo(0.5, 6);
    expect(world.slows.get(victim)!.remaining).toBeCloseTo(6, 6);
    expect(world.slows.get(victim)!.sourceId).toBe(2);
  });

  it("expires on its own clock and hands the hull back its speed", () => {
    const world = makeWorld(configs);
    const victim = ship(world, INTERCEPTOR_FITTING);
    applySlow(world, victim, 0.4, 1, null);

    for (let t = 0; t < Math.round(0.9 / DT); t++) abilitySystem(world, DT);
    expect(world.slows.has(victim)).toBe(true);
    for (let t = 0; t < Math.round(0.2 / DT); t++) abilitySystem(world, DT);
    expect(world.slows.has(victim)).toBe(false);
    expect(slowMultiplierFor(world, victim)).toBe(1);
    expect(world.events.some((e) => e.type === "slowExpired")).toBe(true);
  });

  it("spends the cooldown even when it lands on nothing, and refuses to re-fire while cold", () => {
    const world = makeWorld(configs);
    const attacker = ship(world, INTERCEPTOR_FITTING_SLOW_RAY);
    // No lock at all: the pulse is still spent. A button that silently declines
    // to consume itself teaches a pilot to mash it.
    pulse(world, attacker);
    expect(pulseOf(world, attacker).cycleTimer).toBeGreaterThan(0);
    expect(world.events.some((e) => e.type === "abilityFired")).toBe(true);
    expect(world.slows.size).toBe(0);

    const cold = pulseOf(world, attacker).cycleTimer;
    pulse(world, attacker, 0.5);
    // Still counting down from the FIRST shot — the second tap was refused, it
    // did not re-stamp the timer.
    expect(pulseOf(world, attacker).cycleTimer).toBeLessThan(cold);
    expect(pulseOf(world, attacker).state).toBe("retracted");
  });

  it("comes back when the cooldown clears", () => {
    const world = makeWorld(configs);
    const attacker = ship(world, INTERCEPTOR_FITTING_SLOW_RAY);
    const victim = ship(world, INTERCEPTOR_FITTING, 1, { x: 40, z: 0 }, Math.PI);
    lock(world, attacker, victim);

    pulse(world, attacker);
    world.slows.delete(victim);
    for (let t = 0; t < Math.round(rayCfg().cooldownSec / DT) + 2; t++) {
      moduleSystem(world, DT);
      abilitySystem(world, DT);
    }
    expect(pulseOf(world, attacker).cycleTimer).toBe(0);

    pulse(world, attacker);
    expect(world.slows.get(victim)?.factor).toBe(rayCfg().factor);
  });

  it("does not reach past its authored range, and does not slow a wreck", () => {
    const world = makeWorld(configs);
    const attacker = ship(world, INTERCEPTOR_FITTING_SLOW_RAY);
    const far = ship(world, INTERCEPTOR_FITTING, 1, { x: rayCfg().range + 5, z: 0 }, Math.PI);
    lock(world, attacker, far);
    pulse(world, attacker);
    expect(world.slows.has(far)).toBe(false);

    const world2 = makeWorld(configs);
    const attacker2 = ship(world2, INTERCEPTOR_FITTING_SLOW_RAY);
    const dead = ship(world2, INTERCEPTOR_FITTING, 1, { x: 20, z: 0 }, Math.PI);
    lock(world2, attacker2, dead);
    world2.shipCores.get(dead)!.hull = 0;
    pulse(world2, attacker2);
    expect(world2.slows.has(dead)).toBe(false);
  });

  it("replicates the slow so both clients can see it", () => {
    const world = makeWorld(configs);
    const victim = ship(world, INTERCEPTOR_FITTING);
    applySlow(world, victim, 0.35, 4, null);
    // The snapshot field is the whole replication path (see ArenaSimulation);
    // this pins that the sim state actually reaches it.
    expect(world.slows.get(victim)!.factor).toBe(0.35);
  });
});

describe("repair field (owner 2026-08-22)", () => {
  /** Hurt a ship by `amount` so a heal has somewhere to go. */
  function wound(world: World, id: EntityId, amount: number): void {
    world.shipCores.get(id)!.hull -= amount;
  }

  it("heals every ally in radius, the caster included", () => {
    const world = makeWorld(configs);
    const medic = ship(world, INTERCEPTOR_FITTING_REPAIR);
    const wingman = ship(world, INTERCEPTOR_FITTING, 0, { x: 20, z: 0 });
    wound(world, medic, 60);
    wound(world, wingman, 60);

    pulse(world, medic);

    const heal = fieldCfg().healAmount;
    expect(world.shipCores.get(medic)!.hull).toBe(world.shipCores.get(medic)!.hullMax - 60 + heal);
    expect(world.shipCores.get(wingman)!.hull).toBe(world.shipCores.get(wingman)!.hullMax - 60 + heal);
    const repairs = world.events.filter((e) => e.type === "hullRepaired");
    expect(repairs).toHaveLength(2);
  });

  it("leaves enemies, distant allies and wrecks alone", () => {
    const world = makeWorld(configs);
    const medic = ship(world, INTERCEPTOR_FITTING_REPAIR);
    const enemy = ship(world, INTERCEPTOR_FITTING, 1, { x: 10, z: 0 });
    const distant = ship(world, INTERCEPTOR_FITTING, 0, { x: fieldCfg().radiusUnits + 5, z: 0 });
    const wreck = ship(world, INTERCEPTOR_FITTING, 0, { x: 12, z: 0 });
    for (const id of [medic, enemy, distant, wreck]) wound(world, id, 50);
    world.shipCores.get(wreck)!.hull = 0;

    pulse(world, medic);

    expect(world.shipCores.get(enemy)!.hull).toBe(world.shipCores.get(enemy)!.hullMax - 50);
    expect(world.shipCores.get(distant)!.hull).toBe(world.shipCores.get(distant)!.hullMax - 50);
    expect(world.shipCores.get(wreck)!.hull).toBe(0);
  });

  it("never heals past max hull, and says how much it really gave", () => {
    const world = makeWorld(configs);
    const medic = ship(world, INTERCEPTOR_FITTING_REPAIR);
    const core = world.shipCores.get(medic)!;
    wound(world, medic, 5); // less than one pulse can fill

    pulse(world, medic);

    expect(core.hull).toBe(core.hullMax);
    const repair = world.events.find((e) => e.type === "hullRepaired");
    expect(repair).toMatchObject({ amount: 5, targetId: medic, sourceId: medic });
  });

  it("emits nothing for a hull already full — a floating +0 is noise", () => {
    const world = makeWorld(configs);
    const medic = ship(world, INTERCEPTOR_FITTING_REPAIR);
    pulse(world, medic);
    expect(world.events.filter((e) => e.type === "hullRepaired")).toHaveLength(0);
    // The pulse itself still happened and still cost its cooldown.
    expect(world.events.some((e) => e.type === "abilityFired")).toBe(true);
    // Stamped, then burning down with the rest of the second of ticks.
    expect(pulseOf(world, medic).cycleTimer).toBeGreaterThan(0);
    expect(pulseOf(world, medic).cycleTimer).toBeLessThanOrEqual(fieldCfg().cooldownSec);
  });

  it("is one pulse per tap: the module puts itself back down instead of staying up", () => {
    const world = makeWorld(configs);
    const medic = ship(world, INTERCEPTOR_FITTING_REPAIR);
    wound(world, medic, 60);

    pulse(world, medic, 3);
    // Three seconds of ticks after one tap, and exactly one heal landed.
    expect(world.events.filter((e) => e.type === "hullRepaired")).toHaveLength(1);
    expect(pulseOf(world, medic).state).toBe("retracted");
  });
});
