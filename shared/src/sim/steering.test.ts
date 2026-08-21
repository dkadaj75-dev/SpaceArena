import { beforeAll, describe, expect, it } from "vitest";
import type { ConfigService } from "../core/ConfigService.js";
import type { ModuleConfig } from "../schemas/index.js";
import type { TuningConfig } from "../schemas/index.js";
import { spawnShipFromConfig } from "./spawn.js";
import { flightStep, type FlightParams, type SteerState } from "./steering.js";
import { navigationSystem } from "./systems/NavigationSystem.js";
import { INTERCEPTOR_FITTING,
  INTERCEPTOR_FITTING_BOOST, loadTestConfigs, makeWorld } from "./testutil.js";
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
  return { pos: { ...tf.pos }, vel: { ...vel }, heading: tf.heading, pitch: tf.pitch, up: { ...tf.up } };
}

describe("flightStep ⇄ NavigationSystem parity (FLIGHT.md §1, BUBBLE.md §A)", () => {
  it("is bit-identical for inputs that differ only in the fire flag", () => {
    const world = makeWorld(configs);
    const id = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 2, y: 3, z: 4 }, 0.5);
    const params = paramsFor(world, id);
    const released = { throttle: 0.8, turn: -0.3, pitchStick: 0.4, boostMult: 1, fire: false };
    const held = { ...released, fire: true };
    const a = mirrorOf(world, id);
    const b = mirrorOf(world, id);

    for (let tick = 0; tick < 120; tick++) {
      flightStep(a, released, params, DT);
      flightStep(b, held, params, DT);
    }

    expect(a).toEqual(b);
  });

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
        world.queueOrder(id, { kind: "flight", throttle, turn, pitchStick, boost: false, fire: true });
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
    // The planar figure is smaller than it was under the old pitch clamp for a
    // good reason: the schedule's sustained pitch input now carries the nose over
    // the top instead of pinning it at ~80°, so the ship spends part of the run
    // flying back over its own ground track.
    expect(Math.hypot(tf.pos.x + 7, tf.pos.z - 3)).toBeGreaterThan(12);
    expect(Math.abs(tf.pos.y - 4)).toBeGreaterThan(5);
  });

  it("stays bit-identical through TWO full loops, wrap included", () => {
    const world = makeWorld(configs);
    const id = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 0, y: 0, z: 0 }, 0.3);
    const tf = world.transforms.get(id)!;
    const vel = world.velocities.get(id)!;
    const pred = mirrorOf(world, id);
    const params = paramsFor(world, id);
    // The shipped pack authors no clamp, so this is the regime players fly in.
    expect(params.maxPitchRad).toBeNull();

    // Stick held hard up with the throttle open: the nose climbs, goes inverted
    // over the top, and comes back — the manoeuvre the owner asked for.
    const input = { throttle: 1, turn: 0, pitchStick: 1, boostMult: 1 };
    world.queueOrder(id, { kind: "flight", ...input, boost: false, fire: false });

    // Two full revolutions of the pitch axis at turnRate * pitchRateMult.
    const pitchRate = world.shipCores.get(id)!.engine.turnRate * pitchTuningOf(world.tuning).pitchRateMult;
    const ticks = Math.ceil((2 * (2 * Math.PI)) / (pitchRate * DT));
    let wraps = 0;
    let maxAbsPitch = 0;
    let prevPitch = tf.pitch;

    for (let tick = 0; tick < ticks; tick++) {
      navigationSystem(world, DT);
      flightStep(pred, input, params, DT);

      expect(pred.pos.x).toBe(tf.pos.x);
      expect(pred.pos.y).toBe(tf.pos.y);
      expect(pred.pos.z).toBe(tf.pos.z);
      expect(pred.vel.x).toBe(vel.x);
      expect(pred.vel.y).toBe(vel.y);
      expect(pred.vel.z).toBe(vel.z);
      expect(pred.heading).toBe(tf.heading);
      expect(pred.pitch).toBe(tf.pitch);

      // Pitch stays a legal wrapped angle for every one of these ticks — the
      // codec's domain, so nothing on the wire can clip mid-loop.
      expect(tf.pitch).toBeGreaterThan(-Math.PI);
      expect(tf.pitch).toBeLessThanOrEqual(Math.PI);
      if (tf.pitch < prevPitch) wraps++; // the only decrease is the +PI -> -PI wrap
      maxAbsPitch = Math.max(maxAbsPitch, Math.abs(tf.pitch));
      prevPitch = tf.pitch;
    }

    // Two loops means the wrap boundary was crossed exactly twice, and the nose
    // genuinely went past vertical rather than stalling near it.
    expect(wraps).toBe(2);
    expect(maxAbsPitch).toBeGreaterThan(Math.PI / 2);
    // Heading is untouched by a loop: turning is yaw about world Y, always.
    expect(tf.heading).toBeCloseTo(0.3, 12);
    // And the ship really did fly a closed-ish figure rather than escaping: two
    // loops at a constant speed return it near its own start.
    expect(Math.hypot(tf.pos.x, tf.pos.y, tf.pos.z)).toBeLessThan(
      world.shipCores.get(id)!.engine.nominalSpeed * ticks * DT * 0.5,
    );
  });

  it("mirrors the sim's input clamping (out-of-range stick/throttle/pitch)", () => {
    const world = makeWorld(configs);
    const id = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 0, z: 0 }, 0);
    const tf = world.transforms.get(id)!;
    const pred = mirrorOf(world, id);
    const params = paramsFor(world, id);

    world.queueOrder(id, { kind: "flight", throttle: 4, turn: -3, pitchStick: 5, boost: false, fire: true });
    let maxAbsPitch = 0;
    let zeroCrossings = 0;
    let prevSign = 0;
    for (let tick = 0; tick < 600; tick++) {
      navigationSystem(world, DT);
      flightStep(pred, { throttle: 4, turn: -3, pitchStick: 5, boostMult: 1 }, params, DT);
      expect(pred.pos.x).toBe(tf.pos.x);
      expect(pred.pos.y).toBe(tf.pos.y);
      expect(pred.pos.z).toBe(tf.pos.z);
      expect(pred.heading).toBe(tf.heading);
      expect(pred.pitch).toBe(tf.pitch);
      expect(pred.up.x).toBe(tf.up.x);
      expect(pred.up.y).toBe(tf.up.y);
      expect(pred.up.z).toBe(tf.up.z);
      maxAbsPitch = Math.max(maxAbsPitch, Math.abs(tf.pitch));
      const sign = Math.sign(tf.pitch);
      if (sign !== 0 && prevSign !== 0 && sign !== prevSign) zeroCrossings++;
      if (sign !== 0) prevSign = sign;
    }
    // Long enough that both integrators advanced the attitude identically.
    expect(pred.pitch).toBe(tf.pitch);
    expect(pred.heading).toBe(tf.heading);
    // Full pitch AND full yaw held together is CONING under the authoritative
    // frame (flight-frame handoff): constant body rates trace a fixed tilted
    // circle, the way a real hull flies them. The nose climbs well past level,
    // oscillates back down, and never forms the old near-vertical trap where
    // yaw and pitch fought each other while heading spun ~6.5 rev/s.
    expect(maxAbsPitch).toBeGreaterThan(0.5);
    expect(maxAbsPitch).toBeLessThan(Math.PI / 2);
    expect(zeroCrossings).toBeGreaterThan(2);
  });

  it("mirrors the LEGACY pitch clamp when a pack authors one", () => {
    // The clamp is authored here on purpose: shipped tuning omits `maxPitchRad`
    // and flies free (BUBBLE.md §A), so this is the content-pack regime, and the
    // point of the case is that the two integrators pin identically.
    const world = makeWorld(configs, { tuningOverride: { maxPitchRad: 1.4 } });
    const id = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 0, z: 0 }, 0);
    const tf = world.transforms.get(id)!;
    const pred = mirrorOf(world, id);
    const params = paramsFor(world, id);
    expect(params.maxPitchRad).toBe(1.4);

    world.queueOrder(id, { kind: "flight", throttle: 1, turn: 0, pitchStick: 1, boost: false, fire: false });
    for (let tick = 0; tick < 120; tick++) {
      navigationSystem(world, DT);
      flightStep(pred, { throttle: 1, turn: 0, pitchStick: 1, boostMult: 1 }, params, DT);
      expect(pred.pitch).toBe(tf.pitch);
      expect(pred.pos.y).toBe(tf.pos.y);
    }
    expect(tf.pitch).toBe(1.4);
  });

  it("scales desired speed by boostMult exactly like the sim's boost path", () => {
    const world = makeWorld(configs);
    // Boost lives on the ENGINE internal since 2026-07-31: fit the sporting
    // drive (slot 2, the engine bay) rather than a boost hardpoint.
    const id = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING_BOOST, 0, { x: 0, z: 0 }, 0);
    const boost = world.modules.get(id)!.modules[2]!;
    boost.state = "active"; // always-on drive with a full energy bottle
    const boostMult = configs.get<ModuleConfig>("module", "module.engine-sport")!.boost!.speedMult;

    const tf = world.transforms.get(id)!;
    const vel = world.velocities.get(id)!;
    const engine = world.shipCores.get(id)!.engine;
    const pred = mirrorOf(world, id);
    const params = paramsFor(world, id);

    world.queueOrder(id, { kind: "flight", throttle: 1, turn: 0.25, pitchStick: -0.5, boost: true, fire: true });
    for (let tick = 0; tick < 120; tick++) {
      navigationSystem(world, DT);
      flightStep(pred, { throttle: 1, turn: 0.25, pitchStick: -0.5, boostMult }, params, DT);
      expect(pred.pos.x).toBe(tf.pos.x);
      expect(pred.pos.y).toBe(tf.pos.y);
      expect(pred.pos.z).toBe(tf.pos.z);
      expect(pred.heading).toBe(tf.heading);
      expect(pred.pitch).toBe(tf.pitch);
    }
    // Boost scales the 3D speed, not the planar shadow of it — and the velocity
    // is the ATTITUDE's, whatever the nose has wound round to by now (this run is
    // long enough for the free pitch axis to carry it past vertical).
    expect(Math.hypot(vel.x, vel.y, vel.z)).toBeCloseTo(engine.nominalSpeed * boostMult, 6);
    expect(vel.y).toBeCloseTo(Math.sin(tf.pitch) * engine.nominalSpeed * boostMult, 6);
    expect(Math.abs(vel.y)).toBeGreaterThan(0);
  });

  it("uses the tuning pack's pitch knobs, defaulted identically on both sides", () => {
    const world = makeWorld(configs);
    const tuning = configs.getAll<TuningConfig>("tuning")[0]!;
    // The shipped pack authors `pitchRateMult` and deliberately does NOT author
    // `maxPitchRad`: absent IS the free-pitch behaviour, so nothing substitutes a
    // number for it and both mirrors resolve the same `null`.
    expect(tuning.maxPitchRad).toBeUndefined();
    expect(pitchTuningOf(tuning)).toEqual({
      pitchRateMult: tuning.pitchRateMult,
      maxPitchRad: null,
    });
    expect(pitchTuningOf({ ...tuning, pitchRateMult: undefined })).toEqual({
      pitchRateMult: 0.8,
      maxPitchRad: null,
    });
    // Authored, it is the legacy clamp — floored above zero and held short of
    // vertical however the pack spells it.
    expect(pitchTuningOf({ ...tuning, maxPitchRad: 1.4 }).maxPitchRad).toBe(1.4);
    expect(pitchTuningOf({ ...tuning, maxPitchRad: Math.PI }).maxPitchRad!).toBeLessThan(Math.PI / 2);
    expect(pitchTuningOf({ ...tuning, maxPitchRad: 0 }).maxPitchRad!).toBeGreaterThan(0);
    expect(world.tuning.maxPitchRad).toBeUndefined();
  });
});
