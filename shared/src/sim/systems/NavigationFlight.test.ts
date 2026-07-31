import { beforeAll, describe, expect, it } from "vitest";
import type { ConfigService } from "../../core/ConfigService.js";
import { angleDelta, len, len3 } from "../math.js";
import { spawnAsteroid, spawnShipFromConfig } from "../spawn.js";
import { INTERCEPTOR_FITTING, INTERCEPTOR_FITTING_BOOST, loadTestConfigs, makeWorld, rebuildSpatial } from "../testutil.js";
import type { World } from "../World.js";
import { navigationSystem } from "./NavigationSystem.js";

const DT = 1 / 30;

let configs: ConfigService;
beforeAll(async () => {
  configs = await loadTestConfigs();
});

function spawnPilot(world: World, pos = { x: 0, z: 0 }, heading = 0, pitch = 0): number {
  return spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, pos, heading, undefined, pitch);
}

function speedOf(world: World, id: number): number {
  const v = world.velocities.get(id)!;
  return len3(v.x, v.y, v.z);
}

describe("NavigationSystem — flight orders (FLIGHT.md §1)", () => {
  it("stores a flight order as a persistent FlightState and keeps integrating it", () => {
    const world = makeWorld(configs);
    const id = spawnPilot(world);
    world.queueOrder(id, { kind: "flight", throttle: 1, turn: 0, boost: false, fire: true });

    // ONE order, many ticks: level-triggered state is never auto-cleared.
    for (let i = 0; i < 60; i++) navigationSystem(world, DT);

    expect(world.flightStates.get(id)).toEqual({ throttle: 1, turn: 0, pitchStick: 0, boost: false, fire: true, firePrev: false });
    const tf = world.transforms.get(id)!;
    expect(tf.pos.x).toBeGreaterThan(10); // flew forward along heading 0 (+X)
    expect(tf.pos.z).toBeCloseTo(0, 6);
  });

  it("clamps throttle to 0..1 and turn/pitch to -1..1 on the way in", () => {
    const world = makeWorld(configs);
    const id = spawnPilot(world);
    world.queueOrder(id, { kind: "flight", throttle: 7, turn: -9, pitchStick: 6, boost: true, fire: true });
    navigationSystem(world, DT);
    expect(world.flightStates.get(id)).toEqual({ throttle: 1, turn: -1, pitchStick: 1, boost: true, fire: true, firePrev: false });

    world.queueOrder(id, { kind: "flight", throttle: -3, turn: 4, pitchStick: -8, boost: false, fire: true });
    navigationSystem(world, DT);
    expect(world.flightStates.get(id)).toEqual({ throttle: 0, turn: 1, pitchStick: -1, boost: false, fire: true, firePrev: false });

    // An order with no pitch axis at all (the pre-T2 wire shape) reads as a
    // centred stick, which for held pitch means "leave the nose alone".
    world.queueOrder(id, { kind: "flight", throttle: 0.5, turn: 0, boost: false, fire: true });
    navigationSystem(world, DT);
    expect(world.flightStates.get(id)).toEqual({ throttle: 0.5, turn: 0, pitchStick: 0, boost: false, fire: true, firePrev: false });
  });

  it("takes the last axes but ORs fire across every order drained in one tick", () => {
    const world = makeWorld(configs);
    const id = spawnPilot(world);
    world.queueOrder(id, { kind: "flight", throttle: 0.2, turn: -0.5, boost: false, fire: true });
    world.queueOrder(id, { kind: "flight", throttle: 0.8, turn: 0.75, boost: true, fire: false });

    navigationSystem(world, DT);

    expect(world.flightStates.get(id)).toMatchObject({
      throttle: 0.8,
      turn: 0.75,
      boost: true,
      fire: true,
      firePrev: false,
    });

    // The release becomes the standing level on the following tick.
    world.queueOrder(id, { kind: "flight", throttle: 0.8, turn: 0.75, boost: true, fire: false });
    navigationSystem(world, DT);
    expect(world.flightStates.get(id)!.fire).toBe(false);
  });

  it("drops a flight order with a non-finite axis instead of poisoning FlightState", () => {
    const world = makeWorld(configs);
    const id = spawnPilot(world);
    world.queueOrder(id, { kind: "flight", throttle: 0.5, turn: 0, boost: false, fire: true });
    navigationSystem(world, DT);

    world.queueOrder(id, { kind: "flight", throttle: Number.NaN, turn: 0, boost: false, fire: true });
    world.queueOrder(id, { kind: "flight", throttle: 1, turn: Number.POSITIVE_INFINITY, boost: false, fire: true });
    world.queueOrder(id, { kind: "flight", throttle: 1, turn: 0, pitchStick: Number.NaN, boost: false, fire: true });
    navigationSystem(world, DT);

    // Malformed orders were dropped; the previous state keeps driving the ship.
    expect(world.flightStates.get(id)).toEqual({ throttle: 0.5, turn: 0, pitchStick: 0, boost: false, fire: true, firePrev: false });
    const tf = world.transforms.get(id)!;
    expect(Number.isFinite(tf.pos.x) && Number.isFinite(tf.heading)).toBe(true);
  });

  it("ignores a flight order for a non-ship entity", () => {
    const world = makeWorld(configs);
    const ast = spawnAsteroid(world, configs, "asteroid.small-rock", { x: 5, z: 5 });
    world.queueOrder(ast, { kind: "flight", throttle: 1, turn: 0, boost: false, fire: true });
    navigationSystem(world, DT);
    expect(world.flightStates.has(ast)).toBe(false);
  });

  it("turns at turn * engine.turnRate and scales linearly with the stick", () => {
    const world = makeWorld(configs);
    const full = spawnPilot(world);
    const half = spawnPilot(world);
    const turnRate = world.shipCores.get(full)!.engine.turnRate;
    world.queueOrder(full, { kind: "flight", throttle: 0, turn: 1, boost: false, fire: true });
    world.queueOrder(half, { kind: "flight", throttle: 0, turn: 0.5, boost: false, fire: true });

    const ticks = 20;
    for (let i = 0; i < ticks; i++) navigationSystem(world, DT);

    expect(world.transforms.get(full)!.heading).toBeCloseTo(turnRate * DT * ticks, 6);
    expect(world.transforms.get(half)!.heading).toBeCloseTo(turnRate * DT * ticks * 0.5, 6);
    // Negative turn is the exact mirror.
    const mirror = spawnPilot(world);
    world.queueOrder(mirror, { kind: "flight", throttle: 0, turn: -1, boost: false, fire: true });
    for (let i = 0; i < ticks; i++) navigationSystem(world, DT);
    expect(world.transforms.get(mirror)!.heading).toBeCloseTo(-turnRate * DT * ticks, 6);
  });

  it("approaches throttle * nominalSpeed at engine.accel and decelerates the same way", () => {
    const world = makeWorld(configs);
    const id = spawnPilot(world);
    const engine = world.shipCores.get(id)!.engine;
    world.queueOrder(id, { kind: "flight", throttle: 0.5, turn: 0, boost: false, fire: true });

    navigationSystem(world, DT);
    expect(speedOf(world, id)).toBeCloseTo(engine.accel * DT, 6); // one accel step, not a jump

    for (let i = 0; i < 200; i++) navigationSystem(world, DT);
    expect(speedOf(world, id)).toBeCloseTo(engine.nominalSpeed * 0.5, 6); // holds, never overshoots

    world.queueOrder(id, { kind: "flight", throttle: 0, turn: 0, boost: false, fire: true });
    navigationSystem(world, DT);
    expect(speedOf(world, id)).toBeCloseTo(engine.nominalSpeed * 0.5 - engine.accel * DT, 6);
    for (let i = 0; i < 200; i++) navigationSystem(world, DT);
    expect(speedOf(world, id)).toBeCloseTo(0, 6);
  });

  it("keeps velocity heading-aligned while turning", () => {
    const world = makeWorld(configs);
    const id = spawnPilot(world);
    world.queueOrder(id, { kind: "flight", throttle: 1, turn: 0.7, boost: false, fire: true });
    for (let i = 0; i < 40; i++) {
      navigationSystem(world, DT);
      const tf = world.transforms.get(id)!;
      const v = world.velocities.get(id)!;
      expect(Math.abs(angleDelta(tf.heading, Math.atan2(v.z, v.x)))).toBeLessThan(1e-9);
    }
  });

  it("applies boost speed only with an active boost module that has headroom", () => {
    const world = makeWorld(configs);
    // Boost rides the ENGINE internal (slot 2) since 2026-07-31; park it
    // retracted first so the "no boost available" leg still has something to
    // assert against.
    const id = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING_BOOST, 0, { x: 0, z: 0 }, 0);
    const core = world.shipCores.get(id)!;
    const boost = world.modules.get(id)!.modules[2]!;
    boost.state = "retracted";
    world.queueOrder(id, { kind: "flight", throttle: 1, turn: 0, boost: true, fire: true });

    // Boost requested but the drive is offline ⇒ plain nominal speed.
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
    world.queueOrder(id, { kind: "flight", throttle: 1, turn: 0, boost: false, fire: true });

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

    world.queueOrder(id, { kind: "flight", throttle: 1, turn: 0, boost: false, fire: true });
    navigationSystem(world, DT);
    expect(world.flightStates.get(id)).toEqual({ throttle: 1, turn: 0, pitchStick: 0, boost: false, fire: true, firePrev: false });

    world.queueOrder(id, { kind: "flight", throttle: 0.4, turn: -1, boost: true, fire: true });
    navigationSystem(world, DT);
    expect(world.flightStates.get(id)).toEqual({ throttle: 0.4, turn: -1, pitchStick: 0, boost: true, fire: true, firePrev: false });
  });

  it("coasts a ship that has never been given a flight order (drag, no drive)", () => {
    const world = makeWorld(configs);
    const id = spawnPilot(world);
    world.velocities.set(id, { x: 10, y: 0, z: 0 });

    for (let i = 0; i < 30; i++) navigationSystem(world, DT);

    expect(world.flightStates.has(id)).toBe(false);
    // dragCoefficient bleeds it: still drifting +X, but slower than it started.
    expect(world.transforms.get(id)!.pos.x).toBeGreaterThan(0);
    expect(speedOf(world, id)).toBeLessThan(10);
  });

  it("drops the FlightState when the ship is destroyed", () => {
    const world = makeWorld(configs);
    const id = spawnPilot(world);
    world.queueOrder(id, { kind: "flight", throttle: 1, turn: 0, boost: false, fire: true });
    navigationSystem(world, DT);
    world.destroyEntity(id);
    expect(world.flightStates.has(id)).toBe(false);
  });
});

describe("NavigationSystem — pitch and 3D integration (BUBBLE.md §A)", () => {
  it("integrates pitch at pitchStick * turnRate * tuning.pitchRateMult", () => {
    const world = makeWorld(configs);
    const full = spawnPilot(world);
    const half = spawnPilot(world);
    const turnRate = world.shipCores.get(full)!.engine.turnRate;
    const mult = world.tuning.pitchRateMult!;
    world.queueOrder(full, { kind: "flight", throttle: 0, turn: 0, pitchStick: 1, boost: false, fire: true });
    world.queueOrder(half, { kind: "flight", throttle: 0, turn: 0, pitchStick: -0.5, boost: false, fire: true });

    const ticks = 15;
    for (let i = 0; i < ticks; i++) navigationSystem(world, DT);

    expect(world.transforms.get(full)!.pitch).toBeCloseTo(turnRate * mult * DT * ticks, 6);
    expect(world.transforms.get(half)!.pitch).toBeCloseTo(-turnRate * mult * DT * ticks * 0.5, 6);
  });

  it("holds pitch when the stick returns to centre (held state, no auto-level)", () => {
    const world = makeWorld(configs);
    const id = spawnPilot(world);
    world.queueOrder(id, { kind: "flight", throttle: 0, turn: 0, pitchStick: 1, boost: false, fire: true });
    for (let i = 0; i < 10; i++) navigationSystem(world, DT);
    const climbing = world.transforms.get(id)!.pitch;
    expect(climbing).toBeGreaterThan(0);

    world.queueOrder(id, { kind: "flight", throttle: 0, turn: 0, pitchStick: 0, boost: false, fire: true });
    for (let i = 0; i < 60; i++) navigationSystem(world, DT);
    expect(world.transforms.get(id)!.pitch).toBe(climbing);
  });

  it("clamps pitch to ±tuning.maxPitchRad in both directions when a pack authors it", () => {
    // Authored explicitly: shipped tuning omits `maxPitchRad` (pitch is free and
    // the ship loops), and the clamp survives only as a legacy content knob.
    const world = makeWorld(configs, { tuningOverride: { maxPitchRad: 1.4 } });
    const up = spawnPilot(world);
    const down = spawnPilot(world);
    const maxPitch = world.tuning.maxPitchRad!;
    world.queueOrder(up, { kind: "flight", throttle: 0, turn: 0, pitchStick: 1, boost: false, fire: true });
    world.queueOrder(down, { kind: "flight", throttle: 0, turn: 0, pitchStick: -1, boost: false, fire: true });

    for (let i = 0; i < 600; i++) navigationSystem(world, DT);

    expect(world.transforms.get(up)!.pitch).toBe(maxPitch);
    expect(world.transforms.get(down)!.pitch).toBe(-maxPitch);
    // The clamp is what keeps world-up unambiguous: the nose never passes vertical.
    expect(maxPitch).toBeLessThan(Math.PI / 2);
  });

  it("loops instead, with no clamp authored — the shipped behaviour", () => {
    const world = makeWorld(configs);
    expect(world.tuning.maxPitchRad).toBeUndefined();
    const heading = 0.7;
    const id = spawnPilot(world, { x: 0, z: 0 }, heading, 0);
    world.queueOrder(id, { kind: "flight", throttle: 1, turn: 0, pitchStick: 1, boost: false, fire: true });

    const seen: number[] = [];
    for (let i = 0; i < 600; i++) {
      navigationSystem(world, DT);
      seen.push(world.transforms.get(id)!.pitch);
    }

    // The nose visits every quadrant of the circle — up, inverted, down, level —
    // which is what "hold the stick up and fly a full loop" means.
    expect(seen.some((p) => p > 0.1 && p < Math.PI / 2 - 0.1)).toBe(true);
    expect(seen.some((p) => p > Math.PI / 2 + 0.1)).toBe(true);
    expect(seen.some((p) => p < -Math.PI / 2 - 0.1)).toBe(true);
    expect(seen.some((p) => p < -0.1 && p > -Math.PI / 2 + 0.1)).toBe(true);
    // Always a legal wrapped angle, never a runaway accumulator.
    for (const p of seen) {
      expect(p).toBeGreaterThan(-Math.PI);
      expect(p).toBeLessThanOrEqual(Math.PI);
    }
    // Yaw is untouched by the loop: turning is always about world Y.
    expect(world.transforms.get(id)!.heading).toBeCloseTo(heading, 12);
    // Past vertical the horizontal component of the nose flips sign against the
    // heading — that flip IS the ship going over the top.
    const inverted = seen.findIndex((p) => Math.abs(p) > Math.PI / 2);
    expect(Math.cos(seen[inverted]!)).toBeLessThan(0);
  });

  it("flies along the 3D facing vector (cos p cos h, sin p, cos p sin h)", () => {
    const world = makeWorld(configs);
    const heading = 0.6;
    const pitch = 0.4;
    const id = spawnPilot(world, { x: 0, z: 0 }, heading, pitch);
    world.queueOrder(id, { kind: "flight", throttle: 1, turn: 0, pitchStick: 0, boost: false, fire: true });

    for (let i = 0; i < 200; i++) navigationSystem(world, DT);

    const vel = world.velocities.get(id)!;
    const speed = speedOf(world, id);
    expect(speed).toBeCloseTo(world.shipCores.get(id)!.engine.nominalSpeed, 6);
    expect(vel.x).toBeCloseTo(Math.cos(pitch) * Math.cos(heading) * speed, 6);
    expect(vel.y).toBeCloseTo(Math.sin(pitch) * speed, 6);
    expect(vel.z).toBeCloseTo(Math.cos(pitch) * Math.sin(heading) * speed, 6);
    // Climbing costs planar speed rather than adding free vertical speed.
    const tf = world.transforms.get(id)!;
    expect(tf.pos.y).toBeGreaterThan(5);
    expect(len(tf.pos.x, tf.pos.z)).toBeLessThan(len3(tf.pos.x, tf.pos.y, tf.pos.z));
  });

  it("clamps a spawn pitch before the first flight order when a clamp is authored", () => {
    const world = makeWorld(configs, { tuningOverride: { maxPitchRad: 1.4 } });
    const up = spawnPilot(world, { x: 0, z: 0 }, 0, 4);
    const down = spawnPilot(world, { x: 0, z: 0 }, 0, -4);
    const maxPitch = world.tuning.maxPitchRad!;
    expect(world.transforms.get(up)!.pitch).toBe(maxPitch);
    expect(world.transforms.get(down)!.pitch).toBe(-maxPitch);
  });

  it("merely WRAPS a spawn pitch when pitch is free", () => {
    // No clamp means no illegal spawn attitude — only unspelled ones, so an
    // out-of-range authored pitch becomes the equivalent wrapped angle rather
    // than being pinned somewhere the author did not ask for.
    const world = makeWorld(configs);
    const up = spawnPilot(world, { x: 0, z: 0 }, 0, 4);
    const down = spawnPilot(world, { x: 0, z: 0 }, 0, -4);
    expect(world.transforms.get(up)!.pitch).toBeCloseTo(4 - 2 * Math.PI, 12);
    expect(world.transforms.get(down)!.pitch).toBeCloseTo(2 * Math.PI - 4, 12);
  });

  it("keeps the total speed curve identical whatever the pitch is", () => {
    const world = makeWorld(configs);
    const level = spawnPilot(world);
    const steep = spawnPilot(world, { x: 0, z: 0 }, 0, 1.0);
    world.queueOrder(level, { kind: "flight", throttle: 0.7, turn: 0, pitchStick: 0, boost: false, fire: true });
    world.queueOrder(steep, { kind: "flight", throttle: 0.7, turn: 0, pitchStick: 0, boost: false, fire: true });

    for (let i = 0; i < 40; i++) {
      navigationSystem(world, DT);
      // Speed/accel are exactly as in the planar model — pitch only redirects it.
      expect(speedOf(world, steep)).toBeCloseTo(speedOf(world, level), 12);
    }
  });

  it("coasts in 3D (drag bleeds a vertical drift too)", () => {
    const world = makeWorld(configs);
    const id = spawnPilot(world);
    world.velocities.set(id, { x: 0, y: 10, z: 0 });

    for (let i = 0; i < 30; i++) navigationSystem(world, DT);

    expect(world.transforms.get(id)!.pos.y).toBeGreaterThan(0);
    expect(speedOf(world, id)).toBeLessThan(10);
  });
});
