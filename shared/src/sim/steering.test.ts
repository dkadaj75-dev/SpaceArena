import { beforeAll, describe, expect, it } from "vitest";
import type { ConfigService } from "../core/ConfigService.js";
import type { ModuleConfig } from "../schemas/index.js";
import type { TuningConfig } from "../schemas/index.js";
import { spawnShipFromConfig } from "./spawn.js";
import { flightStep, type FlightParams, type SteerState } from "./steering.js";
import { navigationSystem } from "./systems/NavigationSystem.js";
import { INTERCEPTOR_FITTING, loadTestConfigs, makeWorld } from "./testutil.js";
import { pitchTuningOf } from "./tuningDefaults.js";
import type { World } from "./World.js";

const DT = 1 / 30;

let configs: ConfigService;
beforeAll(async () => {
  configs = await loadTestConfigs();
});

/**
 * Pilot input changes, as (tick, throttle, turn, pitchStick) — replayed into both
 * integrators. The pitch column drives the nose through both clamps and back
 * through level, so the schedule exercises the 3D path rather than a flat one
 * with a spare axis (BUBBLE.md §A).
 */
const INPUT_SCHEDULE: ReadonlyArray<readonly [number, number, number, number]> = [
  [0, 1, 0, 0],
  [12, 1, 1, 0.6],
  [37, 0.35, -0.6, 1],
  [80, 0, 0.2, -0.4],
  [140, 0.8, -1, -1],
  [200, 0.5, 0, 0.25],
];

/** FlightParams the client predictor would build for this ship (resolved stats + tuning). */
function paramsFor(world: World, id: number): FlightParams {
  const engine = world.shipCores.get(id)!.engine;
  return {
    nominalSpeed: engine.nominalSpeed,
    accel: engine.accel,
    turnRate: engine.turnRate,
    ...pitchTuningOf(world.tuning),
  };
}

/** Same start state as the sim ship, as the client seeds it from a snapshot. */
function mirrorOf(world: World, id: number): SteerState {
  const tf = world.transforms.get(id)!;
  const vel = world.velocities.get(id)!;
  return { pos: { ...tf.pos }, vel: { ...vel }, heading: tf.heading, pitch: tf.pitch };
}

describe("flightStep ⇄ NavigationSystem parity (FLIGHT.md §1, BUBBLE.md §A)", () => {
  it("produces an identical trajectory for varied stick/throttle/pitch input over many ticks", () => {
    const world = makeWorld(configs);
    const id = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, { x: -7, y: 4, z: 3 }, 0.9);
    const tf = world.transforms.get(id)!;
    const vel = world.velocities.get(id)!;

    // Client-side mirror: same start state, resolved stats, no boost module.
    const pred = mirrorOf(world, id);
    const params = paramsFor(world, id);

    let throttle = 0;
    let turn = 0;
    let pitchStick = 0;
    for (let tick = 0; tick < 260; tick++) {
      const change = INPUT_SCHEDULE.find(([at]) => at === tick);
      if (change) {
        throttle = change[1];
        turn = change[2];
        pitchStick = change[3];
        world.queueOrder(id, { kind: "flight", throttle, turn, pitchStick, boost: false });
      }

      navigationSystem(world, DT);
      flightStep(pred, { throttle, turn, pitchStick, boostMult: 1 }, params, DT);

      // Bit-for-bit: the two run the same operations in the same order, which is
      // what lets client prediction ride on top of the server's motion.
      expect(pred.pos.x).toBe(tf.pos.x);
      expect(pred.pos.y).toBe(tf.pos.y);
      expect(pred.pos.z).toBe(tf.pos.z);
      expect(pred.vel.x).toBe(vel.x);
      expect(pred.vel.y).toBe(vel.y);
      expect(pred.vel.z).toBe(vel.z);
      expect(pred.heading).toBe(tf.heading);
      expect(pred.pitch).toBe(tf.pitch);
    }

    // Sanity: the trajectory actually went somewhere, turned around AND changed
    // altitude — a mirror that agreed only on a flat path would prove nothing.
    expect(Math.hypot(tf.pos.x + 7, tf.pos.z - 3)).toBeGreaterThan(20);
    expect(Math.abs(tf.pos.y - 4)).toBeGreaterThan(5);
  });

  it("mirrors the sim's input clamping (out-of-range stick/throttle/pitch)", () => {
    const world = makeWorld(configs);
    const id = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 0, z: 0 }, 0);
    const tf = world.transforms.get(id)!;
    const pred = mirrorOf(world, id);
    const params = paramsFor(world, id);

    world.queueOrder(id, { kind: "flight", throttle: 4, turn: -3, pitchStick: 5, boost: false });
    for (let tick = 0; tick < 120; tick++) {
      navigationSystem(world, DT);
      flightStep(pred, { throttle: 4, turn: -3, pitchStick: 5, boostMult: 1 }, params, DT);
      expect(pred.pos.x).toBe(tf.pos.x);
      expect(pred.pos.y).toBe(tf.pos.y);
      expect(pred.pos.z).toBe(tf.pos.z);
      expect(pred.heading).toBe(tf.heading);
      expect(pred.pitch).toBe(tf.pitch);
    }
    // Long enough to pin both integrators against the pitch clamp identically.
    expect(tf.pitch).toBe(params.maxPitchRad);
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
    const pred = mirrorOf(world, id);
    const params = paramsFor(world, id);

    world.queueOrder(id, { kind: "flight", throttle: 1, turn: 0.25, pitchStick: -0.5, boost: true });
    for (let tick = 0; tick < 120; tick++) {
      navigationSystem(world, DT);
      flightStep(pred, { throttle: 1, turn: 0.25, pitchStick: -0.5, boostMult }, params, DT);
      expect(pred.pos.x).toBe(tf.pos.x);
      expect(pred.pos.y).toBe(tf.pos.y);
      expect(pred.pos.z).toBe(tf.pos.z);
      expect(pred.heading).toBe(tf.heading);
      expect(pred.pitch).toBe(tf.pitch);
    }
    // Boost scales the 3D speed, not the planar shadow of it: the ship is diving.
    expect(Math.hypot(vel.x, vel.y, vel.z)).toBeCloseTo(engine.nominalSpeed * boostMult, 6);
    expect(vel.y).toBeLessThan(0);
  });

  it("uses the tuning pack's pitch knobs, defaulted identically on both sides", () => {
    const world = makeWorld(configs);
    const tuning = configs.getAll<TuningConfig>("tuning")[0]!;
    // The shipped pack authors both knobs; the defaults exist for packs that do not.
    expect(pitchTuningOf(tuning)).toEqual({
      pitchRateMult: tuning.pitchRateMult,
      maxPitchRad: tuning.maxPitchRad,
    });
    expect(pitchTuningOf({ ...tuning, pitchRateMult: undefined, maxPitchRad: undefined })).toEqual({
      pitchRateMult: 0.8,
      maxPitchRad: 1.4,
    });
    expect(world.tuning.maxPitchRad).toBeGreaterThan(0);
  });
});
