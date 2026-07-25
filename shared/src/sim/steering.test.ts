import { beforeAll, describe, expect, it } from "vitest";
import type { ConfigService } from "../core/ConfigService.js";
import type { ModuleConfig } from "../schemas/index.js";
import { spawnShipFromConfig } from "./spawn.js";
import { flightStep, type FlightParams, type SteerState } from "./steering.js";
import { navigationSystem } from "./systems/NavigationSystem.js";
import { INTERCEPTOR_FITTING, loadTestConfigs, makeWorld } from "./testutil.js";

const DT = 1 / 30;

let configs: ConfigService;
beforeAll(async () => {
  configs = await loadTestConfigs();
});

/** Pilot input changes, as (tick, throttle, turn) — replayed into both integrators. */
const INPUT_SCHEDULE: ReadonlyArray<readonly [number, number, number]> = [
  [0, 1, 0],
  [12, 1, 1],
  [37, 0.35, -0.6],
  [80, 0, 0.2],
  [140, 0.8, -1],
  [200, 0.5, 0],
];

describe("flightStep ⇄ NavigationSystem parity (FLIGHT.md §1)", () => {
  it("produces an identical trajectory for varied stick/throttle input over many ticks", () => {
    const world = makeWorld(configs);
    const id = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, { x: -7, z: 3 }, 0.9);
    const tf = world.transforms.get(id)!;
    const vel = world.velocities.get(id)!;
    const engine = world.shipCores.get(id)!.engine;

    // Client-side mirror: same start state, resolved stats, no boost module.
    const pred: SteerState = { pos: { ...tf.pos }, vel: { ...vel }, heading: tf.heading };
    const params: FlightParams = {
      nominalSpeed: engine.nominalSpeed,
      accel: engine.accel,
      turnRate: engine.turnRate,
    };

    let throttle = 0;
    let turn = 0;
    for (let tick = 0; tick < 260; tick++) {
      const change = INPUT_SCHEDULE.find(([at]) => at === tick);
      if (change) {
        throttle = change[1];
        turn = change[2];
        world.queueOrder(id, { kind: "flight", throttle, turn, boost: false });
      }

      navigationSystem(world, DT);
      flightStep(pred, { throttle, turn, boostMult: 1 }, params, DT);

      // Bit-for-bit: the two run the same operations in the same order, which is
      // what lets client prediction ride on top of the server's motion.
      expect(pred.pos.x).toBe(tf.pos.x);
      expect(pred.pos.z).toBe(tf.pos.z);
      expect(pred.vel.x).toBe(vel.x);
      expect(pred.vel.z).toBe(vel.z);
      expect(pred.heading).toBe(tf.heading);
    }

    // Sanity: the trajectory actually went somewhere and turned around.
    expect(Math.hypot(tf.pos.x + 7, tf.pos.z - 3)).toBeGreaterThan(20);
  });

  it("mirrors the sim's input clamping (out-of-range stick/throttle)", () => {
    const world = makeWorld(configs);
    const id = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 0, z: 0 }, 0);
    const tf = world.transforms.get(id)!;
    const vel = world.velocities.get(id)!;
    const engine = world.shipCores.get(id)!.engine;
    const pred: SteerState = { pos: { ...tf.pos }, vel: { ...vel }, heading: tf.heading };
    const params: FlightParams = {
      nominalSpeed: engine.nominalSpeed,
      accel: engine.accel,
      turnRate: engine.turnRate,
    };

    world.queueOrder(id, { kind: "flight", throttle: 4, turn: -3, boost: false });
    for (let tick = 0; tick < 30; tick++) {
      navigationSystem(world, DT);
      flightStep(pred, { throttle: 4, turn: -3, boostMult: 1 }, params, DT);
      expect(pred.pos.x).toBe(tf.pos.x);
      expect(pred.pos.z).toBe(tf.pos.z);
      expect(pred.heading).toBe(tf.heading);
    }
  });

  it("scales desired speed by boostMult exactly like the sim's boost path", () => {
    const world = makeWorld(configs);
    const id = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 0, z: 0 }, 0);
    const boost = world.modules.get(id)!.modules[3]!;
    boost.state = "active"; // deployed afterburner with full energy + no heat
    const boostMult = configs.get<ModuleConfig>("module", "module.boost-mk1")!.boost!.speedMult;

    const tf = world.transforms.get(id)!;
    const vel = world.velocities.get(id)!;
    const engine = world.shipCores.get(id)!.engine;
    const pred: SteerState = { pos: { ...tf.pos }, vel: { ...vel }, heading: tf.heading };
    const params: FlightParams = {
      nominalSpeed: engine.nominalSpeed,
      accel: engine.accel,
      turnRate: engine.turnRate,
    };

    world.queueOrder(id, { kind: "flight", throttle: 1, turn: 0.25, boost: true });
    for (let tick = 0; tick < 120; tick++) {
      navigationSystem(world, DT);
      flightStep(pred, { throttle: 1, turn: 0.25, boostMult }, params, DT);
      expect(pred.pos.x).toBe(tf.pos.x);
      expect(pred.pos.z).toBe(tf.pos.z);
      expect(pred.heading).toBe(tf.heading);
    }
    expect(Math.hypot(vel.x, vel.z)).toBeCloseTo(engine.nominalSpeed * boostMult, 6);
  });
});
