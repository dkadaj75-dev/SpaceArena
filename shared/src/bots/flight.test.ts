import { describe, expect, it } from "vitest";

import { flightStep, type SteerState } from "../sim/steering.js";
import { seedUp } from "../sim/frame.js";
import { DEFAULT_PITCH_RATE_MULT } from "../sim/tuningDefaults.js";
import {
  bearing3,
  noseBlocker,
  pitchForElevation,
  pointOnRing,
  pointOnSphere,
  interceptPoint,
  steerForPoint,
  turnForHeading,
  type Steer3Params,
} from "./flight.js";

const RATE = 3; // rad/s, matching the shipped interceptor hull
const PITCH_RATE = RATE * DEFAULT_PITCH_RATE_MULT; // what the sim gives that hull
const HORIZON = 0.25; // s, matching the shipped aggressive decision interval
/** The legacy clamp, authored explicitly by the cases that assert clamped steering. */
const MAX_PITCH = 1.4;

/** Fully calibrated steering params (the steady state a flying bot is in). */
function steerParams(over: Partial<Steer3Params> = {}): Steer3Params {
  return { turnRate: RATE, pitchRate: PITCH_RATE, horizonSec: HORIZON, maxPitchRad: MAX_PITCH, ...over };
}

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
    const s: SteerState = { pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, heading: 0, pitch: 0, up: { x: 0, y: 1, z: 0 } };
    const dt = 1 / 30;
    const ticks = 12;
    const horizon = ticks * dt; // a whole number of sim ticks, so no residue
    const desired = 0.6;
    const turn = turnForHeading(s.heading, desired, RATE, horizon);
    for (let i = 0; i < ticks; i++) {
      flightStep(
        s,
        { throttle: 0, turn, pitchStick: 0, boostMult: 1 },
        { nominalSpeed: 0, accel: 0, turnRate: RATE, pitchRateMult: DEFAULT_PITCH_RATE_MULT, maxPitchRad: MAX_PITCH },
        dt,
      );
    }
    expect(s.heading).toBeCloseTo(desired, 6);
  });
});

describe("pitchForElevation", () => {
  it("uses the same proportional-horizon rule as the yaw axis", () => {
    const span = PITCH_RATE * HORIZON; // 0.6 rad
    expect(pitchForElevation(0, span, PITCH_RATE, HORIZON)).toBeCloseTo(1, 10);
    expect(pitchForElevation(0, span / 2, PITCH_RATE, HORIZON)).toBeCloseTo(0.5, 10);
    expect(pitchForElevation(0.2, 0.2 - span / 4, PITCH_RATE, HORIZON)).toBeCloseTo(-0.25, 10);
  });

  it("centres inside the tolerance and saturates outside the horizon", () => {
    expect(pitchForElevation(0, 0.01, PITCH_RATE, HORIZON, 0.02)).toBe(0);
    expect(pitchForElevation(0, -0.01, PITCH_RATE, HORIZON, 0.02)).toBe(0);
    expect(pitchForElevation(-MAX_PITCH, MAX_PITCH, PITCH_RATE, HORIZON)).toBe(1);
    expect(pitchForElevation(MAX_PITCH, -MAX_PITCH, PITCH_RATE, HORIZON)).toBe(-1);
  });

  it("never wraps: pitch is clamped state, so the direct difference IS the short way", () => {
    // The bug this rules out: `angleDelta` would call a -0.1 rad correction a
    // +6.18 rad one "the short way" and push the nose the wrong direction.
    expect(pitchForElevation(0, -0.1, PITCH_RATE, HORIZON)).toBeLessThan(0);
    expect(pitchForElevation(1.0, 1.1, PITCH_RATE, HORIZON)).toBeGreaterThan(0);
    expect(pitchForElevation(1.1, 1.0, PITCH_RATE, HORIZON)).toBeLessThan(0);
  });

  it("falls back to full deflection while the pitch rate is still unknown", () => {
    expect(pitchForElevation(0, 0.05, 0, HORIZON)).toBe(1);
    expect(pitchForElevation(0, -0.05, 0, HORIZON)).toBe(-1);
    expect(pitchForElevation(0, 0.05, -1, HORIZON)).toBe(1);
  });
});

describe("bearing3", () => {
  it("decomposes a 3D bearing into the sim's own yaw + pitch pair", () => {
    const b = bearing3({ x: 0, y: 0, z: 0 }, { x: 10, y: 10, z: 0 });
    expect(b.yaw).toBeCloseTo(0, 10);
    expect(b.pitch).toBeCloseTo(Math.PI / 4, 10);
    expect(b.planar).toBeCloseTo(10, 10);

    const down = bearing3({ x: 0, y: 20, z: 0 }, { x: 0, y: 0, z: 10 });
    expect(down.yaw).toBeCloseTo(Math.PI / 2, 10);
    expect(down.pitch).toBeCloseTo(Math.atan2(-20, 10), 10);
  });

  it("reads a missing y as the ground plane, never as 'unknown'", () => {
    expect(bearing3({ x: 0, z: 0 }, { x: 10, z: 0 }).pitch).toBe(0);
    expect(bearing3({ x: 0, y: 5, z: 0 }, { x: 10, z: 0 }).pitch).toBeLessThan(0);
  });

  it("reports zero planar separation for a straight-up bearing, where yaw is meaningless", () => {
    const up = bearing3({ x: 3, y: 0, z: 4 }, { x: 3, y: 50, z: 4 });
    expect(up.planar).toBe(0);
    expect(up.pitch).toBeCloseTo(Math.PI / 2, 10);
  });
});

describe("steerForPoint", () => {
  const origin = { x: 0, y: 0, z: 0 };

  it("splits one 3D aim point across both stick axes", () => {
    // Target up and to port: positive turn, positive pitch.
    const s = steerForPoint(origin, 0, 0, { x: 10, y: 6, z: 10 }, steerParams());
    expect(s.turn).toBeGreaterThan(0);
    expect(s.pitchStick).toBeGreaterThan(0);
    // ...and each axis agrees with its own primitive on the decomposed bearing.
    const b = bearing3(origin, { x: 10, y: 6, z: 10 });
    expect(s.turn).toBe(turnForHeading(0, b.yaw, RATE, HORIZON));
    // From level flight at heading 0 the ship's frame IS the world frame, so the
    // body-frame split reproduces the spherical bearing exactly — to within the
    // last bit, since it reaches the same angle by `asin` rather than `atan2`.
    expect(s.pitchStick).toBeCloseTo(pitchForElevation(0, b.pitch, PITCH_RATE, HORIZON), 12);
  });

  it("noses DOWN onto a target below, and only in pitch when it is dead ahead", () => {
    const s = steerForPoint(origin, 0, 0, { x: 30, y: -12, z: 0 }, steerParams());
    expect(s.pitchStick).toBeLessThan(0);
    expect(s.turn).toBe(0);
  });

  it("holds both axes when the aim point is the ship itself", () => {
    const here = { x: 4, y: -2, z: -2 };
    expect(steerForPoint(here, 1.1, 0.3, here, steerParams())).toEqual({ turn: 0, pitchStick: 0 });
  });

  it("centres the yaw axis for a straight-up or straight-down aim point", () => {
    // `atan2(0, 0)` is 0, which reads as "+x": steering yaw off a purely vertical
    // bearing would swing the hull to an arbitrary heading for no gain.
    const up = steerForPoint(origin, 2.5, 0, { x: 0, y: 40, z: 0 }, steerParams());
    expect(up.turn).toBe(0);
    expect(up.pitchStick).toBe(1);

    const down = steerForPoint(origin, 2.5, 0, { x: 0, y: -40, z: 0 }, steerParams());
    expect(down.turn).toBe(0);
    expect(down.pitchStick).toBe(-1);
  });

  it("stops pushing once the nose is at the pitch clamp, however far above the target is", () => {
    // The clamp case that would otherwise pin a full-deflection axis forever: the
    // sim will not pitch past ±maxPitchRad, so asking for PI/2 is asking for an
    // error that can never null. The desired elevation is clamped instead.
    const pinned = steerForPoint(origin, 0, MAX_PITCH, { x: 0, y: 40, z: 0 }, steerParams());
    expect(pinned.pitchStick).toBe(0);
    const pinnedDown = steerForPoint(origin, 0, -MAX_PITCH, { x: 0, y: -40, z: 0 }, steerParams());
    expect(pinnedDown.pitchStick).toBe(0);
    // Just short of the clamp it still climbs, and never past full deflection.
    const nearly = steerForPoint(origin, 0, MAX_PITCH - 0.05, { x: 0, y: 40, z: 0 }, steerParams());
    expect(nearly.pitchStick).toBeGreaterThan(0);
    expect(nearly.pitchStick).toBeLessThanOrEqual(1);
  });

  it("takes the short way around the yaw wrap while pitching", () => {
    const aim = pointOnSphere(origin, -3.0, 0.3, 20);
    expect(steerForPoint(origin, 3.0, 0, aim, steerParams()).turn).toBeGreaterThan(0);
    const mirrored = pointOnSphere(origin, 3.0, 0.3, 20);
    expect(steerForPoint(origin, -3.0, 0, mirrored, steerParams()).turn).toBeLessThan(0);
  });

  it("centres each axis independently inside the tolerance", () => {
    // Lined up in yaw but not in pitch: the yaw axis goes quiet on its own, which
    // is what keeps a climbing bot from re-sending turn traffic it does not need.
    const s = steerForPoint(origin, 0, 0, { x: 30, y: 9, z: 0.1 }, steerParams({ toleranceRad: 0.02 }));
    expect(s.turn).toBe(0);
    expect(s.pitchStick).toBeGreaterThan(0);
  });

  it("falls back to full deflection on BOTH axes while uncalibrated", () => {
    const s = steerForPoint(origin, 0, 0, { x: 10, y: 6, z: 10 }, steerParams({ turnRate: 0, pitchRate: 0 }));
    expect(s.turn).toBe(1);
    expect(s.pitchStick).toBe(1);
  });

  it("converges the nose onto a 3D bearing when re-planned each tick", () => {
    // The closed-loop contract, and the one the driver actually relies on: it
    // re-decides every interval. Body-frame yaw and pitch are applied about axes
    // that MOVE with the hull, so unlike the old independent-coordinate model no
    // single constant pair of sticks held open-loop lands exactly on a bearing —
    // rotations about different axes do not commute. Re-planning is what closes
    // the gap, and it closes it to nothing.
    const dt = 1 / 30;
    const s: SteerState = { pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, heading: 0, pitch: 0, up: { x: 0, y: 1, z: 0 } };
    const aim = { x: 20, y: 9, z: 14 };
    for (let i = 0; i < 120; i++) {
      const steer = steerForPoint(s.pos, s.heading, s.pitch, aim, steerParams({ horizonSec: 12 / 30 }));
      flightStep(
        s,
        { throttle: 0, turn: steer.turn, pitchStick: steer.pitchStick, boostMult: 1 },
        { nominalSpeed: 0, accel: 0, turnRate: RATE, pitchRateMult: DEFAULT_PITCH_RATE_MULT, maxPitchRad: MAX_PITCH },
        dt,
      );
    }
    // The loop closes geometrically rather than in one step, so this is "on the
    // bearing to within a thousandth of a degree" rather than to the last bit.
    const b = bearing3(s.pos, aim);
    expect(s.heading).toBeCloseTo(b.yaw, 4);
    expect(s.pitch).toBeCloseTo(b.pitch, 4);
  });

  it("aims correctly from an INVERTED hull, with no special case", () => {
    // The payoff of planning in the ship's frame: `U` already points where the
    // hull's up points, so an upside-down bot needs no sign flip and no fold.
    const dt = 1 / 30;
    // An inverted spawn state: the persisted up is the DERIVED up for this attitude
    // (seedUp), which for pitch 2.6 points below the horizon — a genuinely inverted frame.
    const s: SteerState = { pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, heading: 0.4, pitch: 2.6, up: seedUp(0.4, 2.6) };
    const aim = { x: 25, y: -6, z: -18 };
    for (let i = 0; i < 200; i++) {
      const steer = steerForPoint(s.pos, s.heading, s.pitch, aim, steerParams({ maxPitchRad: null }));
      flightStep(
        s,
        { throttle: 0, turn: steer.turn, pitchStick: steer.pitchStick, boostMult: 1 },
        { nominalSpeed: 0, accel: 0, turnRate: RATE, pitchRateMult: DEFAULT_PITCH_RATE_MULT, maxPitchRad: null },
        dt,
      );
    }
    // Nose on the bearing, whichever spelling the attitude ended up in.
    const nx = Math.cos(s.pitch) * Math.cos(s.heading);
    const ny = Math.sin(s.pitch);
    const nz = Math.cos(s.pitch) * Math.sin(s.heading);
    const len = Math.hypot(aim.x, aim.y, aim.z);
    expect(nx * (aim.x / len) + ny * (aim.y / len) + nz * (aim.z / len)).toBeCloseTo(1, 6);
  });
});

describe("pointOnSphere", () => {
  it("places a point at the requested 3D bearing and radius", () => {
    const origin = { x: 1, y: 2, z: 3 };
    const p = pointOnSphere(origin, 0.7, 0.4, 25);
    const b = bearing3(origin, p);
    expect(b.yaw).toBeCloseTo(0.7, 10);
    expect(b.pitch).toBeCloseTo(0.4, 10);
    expect(Math.hypot(p.x - 1, p.y - 2, p.z - 3)).toBeCloseTo(25, 10);
  });

  it("clamps past vertical instead of flipping to the opposite yaw", () => {
    // Behaviours ADD an offset to a measured elevation (kite's verticalSlipRad),
    // so an over-steep pitch is reachable from content. Past PI/2 `cos p` goes
    // negative and the point would land behind the ship.
    const origin = { x: 0, y: 0, z: 0 };
    const over = pointOnSphere(origin, 0, Math.PI / 2 + 0.6, 10);
    expect(over.x).toBeCloseTo(0, 10);
    expect(over.y).toBeCloseTo(10, 10);
    expect(over).toEqual(pointOnSphere(origin, 0, Math.PI / 2, 10));
    const under = pointOnSphere(origin, 0, -Math.PI / 2 - 0.6, 10);
    expect(under.y).toBeCloseTo(-10, 10);
  });
});

describe("pointOnRing", () => {
  it("places a point at the requested bearing and radius, at the origin's own altitude", () => {
    // A LEVEL ring, not a ground-plane one: a bot fighting at y = 40 that aimed at
    // a y = 0 ring point would dive out of the fight on every sidestep.
    const p = pointOnRing({ x: 1, y: 40, z: 2 }, 0, 5);
    expect(p.x).toBeCloseTo(6, 10);
    expect(p.y).toBeCloseTo(40, 10);
    expect(p.z).toBeCloseTo(2, 10);
    expect(bearing3({ x: 1, y: 40, z: 2 }, p).yaw).toBeCloseTo(0, 10);
  });
});

describe("noseBlocker", () => {
  const origin = { x: 0, y: 0, z: 0 };

  it("finds a rock in the nose corridor and reports which way to turn off it", () => {
    // Rock slightly to starboard (negative z) of a heading-0 nose.
    const hit = noseBlocker(origin, 0, 0, [{ pos: { x: 10, z: -3 }, radius: 4 }], 16, 2);
    expect(hit).not.toBeNull();
    expect(hit!.along).toBeCloseTo(10, 10);
    expect(hit!.offset).toBeCloseTo(3, 10);
    expect(hit!.side).toBe(1); // turn positive (to port) to clear it

    const mirrored = noseBlocker(origin, 0, 0, [{ pos: { x: 10, z: 3 }, radius: 4 }], 16, 2);
    expect(mirrored!.side).toBe(-1);
  });

  it("ignores rocks behind the nose, beyond the lookahead, or outside the corridor", () => {
    expect(noseBlocker(origin, 0, 0, [{ pos: { x: -10, z: 0 }, radius: 6 }], 16, 2)).toBeNull();
    expect(noseBlocker(origin, 0, 0, [{ pos: { x: 40, z: 0 }, radius: 6 }], 16, 2)).toBeNull();
    expect(noseBlocker(origin, 0, 0, [{ pos: { x: 10, z: 20 }, radius: 4 }], 16, 2)).toBeNull();
    expect(noseBlocker(origin, 0, 0, [{ pos: { x: 10, z: 0 }, radius: 4 }], 0, 2)).toBeNull(); // disabled
  });

  it("treats a rock far below a level nose as scenery, not a threat", () => {
    // The corridor is a 3D cylinder about the facing vector: the planar test used
    // to swerve off rocks the ship was flying comfortably over.
    const below = [{ pos: { x: 10, y: -30, z: 0 }, radius: 4 }];
    expect(noseBlocker(origin, 0, 0, below, 16, 2)).toBeNull();
    // ...but the same rock IS in the way once the nose points down at it.
    expect(noseBlocker(origin, 0, -Math.atan2(30, 10), below, 40, 2)).not.toBeNull();
  });

  it("respects the ship's heading and pitch, not the world axes", () => {
    const rock = [{ pos: { x: 0, y: 0, z: 10 }, radius: 4 }];
    expect(noseBlocker(origin, 0, 0, rock, 16, 2)).toBeNull();
    expect(noseBlocker(origin, Math.PI / 2, 0, rock, 16, 2)).not.toBeNull();
    // Same bearing, but the nose is climbing away from it.
    expect(noseBlocker(origin, Math.PI / 2, 1.2, rock, 16, 2)).toBeNull();
  });

  it("measures the offset perpendicular to the 3D facing vector", () => {
    // Rock directly above the ship's path: `along` projects onto the nose, and the
    // offset is the true perpendicular miss distance, not a planar cross product.
    const hit = noseBlocker(origin, 0, 0, [{ pos: { x: 10, y: 5, z: 0 }, radius: 6 }], 16, 2);
    expect(hit!.along).toBeCloseTo(10, 10);
    expect(hit!.offset).toBeCloseTo(5, 10);
  });

  it("keeps the nearest hit, first-wins on ties (deterministic)", () => {
    const hit = noseBlocker(
      origin,
      0,
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

describe("interceptPoint", () => {
  it("leads a crossing target to the point both ships reach at once", () => {
    // Target 100 ahead on +z crossing at 10 u/s on +x; a 20 u/s pursuer meets it
    // where |lead| = 20t and the crossing has run 10t: t solves 100^2 + (10t)^2 = (20t)^2.
    const t = Math.sqrt(10_000 / 300);
    const lead = interceptPoint({ x: 0, y: 0, z: 0 }, 20, { x: 0, y: 0, z: 100 }, { x: 10, y: 0, z: 0 });
    expect(lead.x).toBeCloseTo(10 * t, 6);
    expect(lead.z).toBeCloseTo(100, 6);
  });

  it("answers the target's own position when there is no honest lead", () => {
    const here = { x: 0, y: 0, z: 100 };
    // Stationary pursuer, stationary target, and a lead further out than the horizon.
    expect(interceptPoint({ x: 0, y: 0, z: 0 }, 0, here, { x: 10, y: 0, z: 0 })).toEqual(here);
    expect(interceptPoint({ x: 0, y: 0, z: 0 }, 20, here, undefined).z).toBeCloseTo(100, 6);
    expect(interceptPoint({ x: 0, y: 0, z: 0 }, 20, here, { x: 10, y: 0, z: 0 }, 1)).toEqual(here);
  });

  it("aims behind a target that is running away faster than the pursuer can close", () => {
    // No positive root exists, so pure pursuit is the honest answer.
    expect(interceptPoint({ x: 0, y: 0, z: 0 }, 5, { x: 0, y: 0, z: 50 }, { x: 0, y: 0, z: 30 }))
      .toEqual({ x: 0, y: 0, z: 50 });
  });
});
