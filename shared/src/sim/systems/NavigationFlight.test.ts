import { beforeAll, describe, expect, it } from "vitest";
import type { ConfigService } from "../../core/ConfigService.js";
import { angleDelta, len } from "../math.js";
import { spawnAsteroid, spawnShipFromConfig } from "../spawn.js";
import { INTERCEPTOR_FITTING, loadTestConfigs, makeWorld, rebuildSpatial } from "../testutil.js";
import type { World } from "../World.js";
import { navigationSystem } from "./NavigationSystem.js";

const DT = 1 / 30;

let configs: ConfigService;
beforeAll(async () => {
  configs = await loadTestConfigs();
});

function spawnPilot(world: World, pos = { x: 0, z: 0 }, heading = 0): number {
  return spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, pos, heading);
}

function speedOf(world: World, id: number): number {
  const v = world.velocities.get(id)!;
  return len(v.x, v.z);
}

describe("NavigationSystem — flight orders (FLIGHT.md §1)", () => {
  it("stores a flight order as a persistent FlightState and keeps integrating it", () => {
    const world = makeWorld(configs);
    const id = spawnPilot(world);
    world.queueOrder(id, { kind: "flight", throttle: 1, turn: 0, boost: false });

    // ONE order, many ticks: level-triggered state is never auto-cleared.
    for (let i = 0; i < 60; i++) navigationSystem(world, DT);

    expect(world.flightStates.get(id)).toEqual({ throttle: 1, turn: 0, boost: false });
    const tf = world.transforms.get(id)!;
    expect(tf.pos.x).toBeGreaterThan(10); // flew forward along heading 0 (+X)
    expect(tf.pos.z).toBeCloseTo(0, 6);
  });

  it("clamps throttle to 0..1 and turn to -1..1 on the way in", () => {
    const world = makeWorld(configs);
    const id = spawnPilot(world);
    world.queueOrder(id, { kind: "flight", throttle: 7, turn: -9, boost: true });
    navigationSystem(world, DT);
    expect(world.flightStates.get(id)).toEqual({ throttle: 1, turn: -1, boost: true });

    world.queueOrder(id, { kind: "flight", throttle: -3, turn: 4, boost: false });
    navigationSystem(world, DT);
    expect(world.flightStates.get(id)).toEqual({ throttle: 0, turn: 1, boost: false });
  });

  it("drops a flight order with a non-finite axis instead of poisoning FlightState", () => {
    const world = makeWorld(configs);
    const id = spawnPilot(world);
    world.queueOrder(id, { kind: "flight", throttle: 0.5, turn: 0, boost: false });
    navigationSystem(world, DT);

    world.queueOrder(id, { kind: "flight", throttle: Number.NaN, turn: 0, boost: false });
    world.queueOrder(id, { kind: "flight", throttle: 1, turn: Number.POSITIVE_INFINITY, boost: false });
    navigationSystem(world, DT);

    // Malformed orders were dropped; the previous state keeps driving the ship.
    expect(world.flightStates.get(id)).toEqual({ throttle: 0.5, turn: 0, boost: false });
    const tf = world.transforms.get(id)!;
    expect(Number.isFinite(tf.pos.x) && Number.isFinite(tf.heading)).toBe(true);
  });

  it("ignores a flight order for a non-ship entity", () => {
    const world = makeWorld(configs);
    const ast = spawnAsteroid(world, configs, "asteroid.small-rock", { x: 5, z: 5 });
    world.queueOrder(ast, { kind: "flight", throttle: 1, turn: 0, boost: false });
    navigationSystem(world, DT);
    expect(world.flightStates.has(ast)).toBe(false);
  });

  it("turns at turn * engine.turnRate and scales linearly with the stick", () => {
    const world = makeWorld(configs);
    const full = spawnPilot(world);
    const half = spawnPilot(world);
    const turnRate = world.shipCores.get(full)!.engine.turnRate;
    world.queueOrder(full, { kind: "flight", throttle: 0, turn: 1, boost: false });
    world.queueOrder(half, { kind: "flight", throttle: 0, turn: 0.5, boost: false });

    const ticks = 20;
    for (let i = 0; i < ticks; i++) navigationSystem(world, DT);

    expect(world.transforms.get(full)!.heading).toBeCloseTo(turnRate * DT * ticks, 6);
    expect(world.transforms.get(half)!.heading).toBeCloseTo(turnRate * DT * ticks * 0.5, 6);
    // Negative turn is the exact mirror.
    const mirror = spawnPilot(world);
    world.queueOrder(mirror, { kind: "flight", throttle: 0, turn: -1, boost: false });
    for (let i = 0; i < ticks; i++) navigationSystem(world, DT);
    expect(world.transforms.get(mirror)!.heading).toBeCloseTo(-turnRate * DT * ticks, 6);
  });

  it("approaches throttle * nominalSpeed at engine.accel and decelerates the same way", () => {
    const world = makeWorld(configs);
    const id = spawnPilot(world);
    const engine = world.shipCores.get(id)!.engine;
    world.queueOrder(id, { kind: "flight", throttle: 0.5, turn: 0, boost: false });

    navigationSystem(world, DT);
    expect(speedOf(world, id)).toBeCloseTo(engine.accel * DT, 6); // one accel step, not a jump

    for (let i = 0; i < 200; i++) navigationSystem(world, DT);
    expect(speedOf(world, id)).toBeCloseTo(engine.nominalSpeed * 0.5, 6); // holds, never overshoots

    world.queueOrder(id, { kind: "flight", throttle: 0, turn: 0, boost: false });
    navigationSystem(world, DT);
    expect(speedOf(world, id)).toBeCloseTo(engine.nominalSpeed * 0.5 - engine.accel * DT, 6);
    for (let i = 0; i < 200; i++) navigationSystem(world, DT);
    expect(speedOf(world, id)).toBeCloseTo(0, 6);
  });

  it("keeps velocity heading-aligned while turning", () => {
    const world = makeWorld(configs);
    const id = spawnPilot(world);
    world.queueOrder(id, { kind: "flight", throttle: 1, turn: 0.7, boost: false });
    for (let i = 0; i < 40; i++) {
      navigationSystem(world, DT);
      const tf = world.transforms.get(id)!;
      const v = world.velocities.get(id)!;
      expect(Math.abs(angleDelta(tf.heading, Math.atan2(v.z, v.x)))).toBeLessThan(1e-9);
    }
  });

  it("applies boost speed only with an active boost module that has headroom", () => {
    const world = makeWorld(configs);
    const id = spawnPilot(world);
    const core = world.shipCores.get(id)!;
    const boost = world.modules.get(id)!.modules[3]!;
    world.queueOrder(id, { kind: "flight", throttle: 1, turn: 0, boost: true });

    // Boost requested but the module is retracted ⇒ plain nominal speed.
    for (let i = 0; i < 200; i++) navigationSystem(world, DT);
    expect(speedOf(world, id)).toBeCloseTo(core.engine.nominalSpeed, 6);
    expect(boost.workedThisTick).toBe(false);

    boost.state = "active";
    for (let i = 0; i < 200; i++) navigationSystem(world, DT);
    expect(speedOf(world, id)).toBeGreaterThan(core.engine.nominalSpeed + 1);
    expect(boost.workedThisTick).toBe(true);

    // Overheated module: no speed bonus, no energy/heat charge this tick.
    boost.heat = 1000;
    boost.workedThisTick = false;
    navigationSystem(world, DT);
    expect(boost.workedThisTick).toBe(false);
    expect(speedOf(world, id)).toBeLessThan(core.engine.nominalSpeed * 1.8);
  });

  it("flies straight through the avoidance zone of an asteroid (no flight avoidance)", () => {
    const world = makeWorld(configs);
    // Rock dead ahead: the move-order path would steer tangentially around it.
    spawnAsteroid(world, configs, "asteroid.small-rock", { x: 25, z: 0 });
    const id = spawnPilot(world);
    world.queueOrder(id, { kind: "flight", throttle: 1, turn: 0, boost: false });

    for (let i = 0; i < 40; i++) {
      rebuildSpatial(world);
      navigationSystem(world, DT);
      expect(world.transforms.get(id)!.heading).toBe(0); // never steered off the stick
      expect(world.transforms.get(id)!.pos.z).toBe(0);
    }
  });

  it("replaces the standing FlightState rather than accumulating drivers", () => {
    const world = makeWorld(configs);
    const id = spawnPilot(world);

    world.queueOrder(id, { kind: "flight", throttle: 1, turn: 0, boost: false });
    navigationSystem(world, DT);
    expect(world.flightStates.get(id)).toEqual({ throttle: 1, turn: 0, boost: false });

    world.queueOrder(id, { kind: "flight", throttle: 0.4, turn: -1, boost: true });
    navigationSystem(world, DT);
    expect(world.flightStates.get(id)).toEqual({ throttle: 0.4, turn: -1, boost: true });
  });

  it("coasts a ship that has never been given a flight order (drag, no drive)", () => {
    const world = makeWorld(configs);
    const id = spawnPilot(world);
    world.velocities.set(id, { x: 10, z: 0 });

    for (let i = 0; i < 30; i++) navigationSystem(world, DT);

    expect(world.flightStates.has(id)).toBe(false);
    // dragCoefficient bleeds it: still drifting +X, but slower than it started.
    expect(world.transforms.get(id)!.pos.x).toBeGreaterThan(0);
    expect(speedOf(world, id)).toBeLessThan(10);
  });

  it("drops the FlightState when the ship is destroyed", () => {
    const world = makeWorld(configs);
    const id = spawnPilot(world);
    world.queueOrder(id, { kind: "flight", throttle: 1, turn: 0, boost: false });
    navigationSystem(world, DT);
    world.destroyEntity(id);
    expect(world.flightStates.has(id)).toBe(false);
  });
});
