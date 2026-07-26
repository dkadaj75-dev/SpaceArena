import { describe, expect, it } from "vitest";

import { flightStep, type SteerState } from "../sim/steering.js";
import { bearing, noseBlocker, pointOnRing, turnForHeading, turnForPoint } from "./flight.js";

const RATE = 3; // rad/s, matching the shipped interceptor hull
const HORIZON = 0.25; // s, matching the shipped aggressive decision interval

describe("turnForHeading", () => {
  it("centres the stick inside the aim tolerance", () => {
    expect(turnForHeading(0, 0.01, RATE, HORIZON, 0.02)).toBe(0);
    expect(turnForHeading(0, -0.01, RATE, HORIZON, 0.02)).toBe(0);
    expect(turnForHeading(0, 0.03, RATE, HORIZON, 0.02)).not.toBe(0);
  });

  it("scales proportionally to the rotation the horizon can buy", () => {
    const span = RATE * HORIZON; // 0.75 rad
    expect(turnForHeading(0, span, RATE, HORIZON)).toBeCloseTo(1, 10);
    expect(turnForHeading(0, span / 2, RATE, HORIZON)).toBeCloseTo(0.5, 10);
    expect(turnForHeading(0, -span / 4, RATE, HORIZON)).toBeCloseTo(-0.25, 10);
  });

  it("saturates at full deflection and never exceeds the axis range", () => {
    expect(turnForHeading(0, Math.PI - 0.001, RATE, HORIZON)).toBe(1);
    expect(turnForHeading(0, -Math.PI + 0.001, RATE, HORIZON)).toBe(-1);
  });

  it("takes the short way around the wrap", () => {
    // From 3.0 rad to -3.0 rad is +0.28 the short way, not -6.0 the long way.
    expect(turnForHeading(3.0, -3.0, RATE, HORIZON)).toBeGreaterThan(0);
    expect(turnForHeading(-3.0, 3.0, RATE, HORIZON)).toBeLessThan(0);
  });

  it("falls back to full deflection while the turn rate is still unknown", () => {
    expect(turnForHeading(0, 0.05, 0, HORIZON)).toBe(1);
    expect(turnForHeading(0, -0.05, 0, HORIZON)).toBe(-1);
    expect(turnForHeading(0, 0.05, -1, HORIZON)).toBe(1); // negative is "unknown" too
  });

  it("lands the nose on the desired heading after one horizon of the sim's own integration", () => {
    // The contract that makes the whole bot flight model work: hold the returned
    // axis for `horizon` through the real integrator and the error is gone.
    // Bots still fly planar (pitchStick 0) until stage T4.
    const s: SteerState = { pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, heading: 0, pitch: 0 };
    const dt = 1 / 30;
    const ticks = 12;
    const horizon = ticks * dt; // a whole number of sim ticks, so no residue
    const desired = 0.6;
    const turn = turnForHeading(s.heading, desired, RATE, horizon);
    for (let i = 0; i < ticks; i++) {
      flightStep(
        s,
        { throttle: 0, turn, pitchStick: 0, boostMult: 1 },
        { nominalSpeed: 0, accel: 0, turnRate: RATE, pitchRateMult: 0.8, maxPitchRad: 1.4 },
        dt,
      );
    }
    expect(s.heading).toBeCloseTo(desired, 6);
  });
});

describe("turnForPoint", () => {
  it("steers toward a world point on the correct side", () => {
    const pos = { x: 0, z: 0 };
    expect(turnForPoint(pos, 0, { x: 10, z: 10 }, RATE, HORIZON)).toBeGreaterThan(0);
    expect(turnForPoint(pos, 0, { x: 10, z: -10 }, RATE, HORIZON)).toBeLessThan(0);
    expect(turnForPoint(pos, 0, { x: 10, z: 0 }, RATE, HORIZON)).toBe(0);
  });

  it("holds the current heading when the aim point is the ship itself", () => {
    expect(turnForPoint({ x: 4, z: -2 }, 1.1, { x: 4, z: -2 }, RATE, HORIZON)).toBe(0);
  });

  it("agrees with turnForHeading on the bearing", () => {
    const pos = { x: -3, z: 7 };
    const aim = { x: 12, z: -4 };
    expect(turnForPoint(pos, 0.4, aim, RATE, HORIZON)).toBe(
      turnForHeading(0.4, bearing(pos, aim), RATE, HORIZON),
    );
  });
});

describe("pointOnRing", () => {
  it("places a point at the requested bearing and radius", () => {
    const p = pointOnRing({ x: 1, z: 2 }, 0, 5);
    expect(p.x).toBeCloseTo(6, 10);
    expect(p.z).toBeCloseTo(2, 10);
    expect(bearing({ x: 1, z: 2 }, p)).toBeCloseTo(0, 10);
  });
});

describe("noseBlocker", () => {
  const origin = { x: 0, z: 0 };

  it("finds a rock in the nose corridor and reports which way to turn off it", () => {
    // Rock slightly to starboard (negative z) of a heading-0 nose.
    const hit = noseBlocker(origin, 0, [{ pos: { x: 10, z: -3 }, radius: 4 }], 16, 2);
    expect(hit).not.toBeNull();
    expect(hit!.along).toBeCloseTo(10, 10);
    expect(hit!.offset).toBeCloseTo(3, 10);
    expect(hit!.side).toBe(1); // turn positive (to port) to clear it

    const mirrored = noseBlocker(origin, 0, [{ pos: { x: 10, z: 3 }, radius: 4 }], 16, 2);
    expect(mirrored!.side).toBe(-1);
  });

  it("ignores rocks behind the nose, beyond the lookahead, or outside the corridor", () => {
    expect(noseBlocker(origin, 0, [{ pos: { x: -10, z: 0 }, radius: 6 }], 16, 2)).toBeNull();
    expect(noseBlocker(origin, 0, [{ pos: { x: 40, z: 0 }, radius: 6 }], 16, 2)).toBeNull();
    expect(noseBlocker(origin, 0, [{ pos: { x: 10, z: 20 }, radius: 4 }], 16, 2)).toBeNull();
    expect(noseBlocker(origin, 0, [{ pos: { x: 10, z: 0 }, radius: 4 }], 0, 2)).toBeNull(); // disabled
  });

  it("respects the ship's heading, not the world axes", () => {
    const rock = [{ pos: { x: 0, z: 10 }, radius: 4 }];
    expect(noseBlocker(origin, 0, rock, 16, 2)).toBeNull();
    expect(noseBlocker(origin, Math.PI / 2, rock, 16, 2)).not.toBeNull();
  });

  it("keeps the nearest hit, first-wins on ties (deterministic)", () => {
    const hit = noseBlocker(
      origin,
      0,
      [
        { pos: { x: 12, z: 0 }, radius: 3 },
        { pos: { x: 6, z: 0 }, radius: 3 },
        { pos: { x: 6, z: 1 }, radius: 3 },
      ],
      16,
      2,
    );
    expect(hit!.along).toBeCloseTo(6, 10);
    expect(hit!.offset).toBeCloseTo(0, 10);
  });
});
