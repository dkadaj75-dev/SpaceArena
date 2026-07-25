import { describe, expect, it } from "vitest";
import type { ShipSnapshot } from "./ArenaSimulation.js";
import { evalCurve, evalSignal, SIGNAL_REGISTRY, signalId } from "./signals.js";

function ship(overrides: Partial<ShipSnapshot> = {}): ShipSnapshot {
  return {
    id: 1,
    team: 0,
    pos: { x: 0, z: 0 },
    heading: 0,
    hull: 100,
    hullMax: 100,
    energy: { cur: 50, max: 100 },
    heat: { cur: 0, capacity: 100 },
    targetId: null,
    throttle: 0,
    modules: [],
    ...overrides,
  };
}

describe("evalCurve (piecewise-linear, domain-clamped)", () => {
  it("interpolates an ascending curve", () => {
    const c = [
      [0, 0],
      [1, 80],
    ] as const;
    expect(evalCurve(c, 0)).toBe(0);
    expect(evalCurve(c, 0.5)).toBeCloseTo(40, 6);
    expect(evalCurve(c, 1)).toBe(80);
  });

  it("interpolates a descending-domain curve (hull fraction)", () => {
    const c = [
      [1, 0],
      [0.5, 0],
      [0.2, 60],
    ] as const;
    expect(evalCurve(c, 1)).toBe(0);
    expect(evalCurve(c, 0.5)).toBe(0);
    expect(evalCurve(c, 0.2)).toBe(60);
    expect(evalCurve(c, 0.35)).toBeCloseTo(30, 6); // midway on the [0.5,0]→[0.2,60] leg
  });

  it("clamps input to the curve domain", () => {
    const c = [
      [0.2, 60],
      [1, 0],
    ] as const;
    expect(evalCurve(c, -5)).toBe(60); // below min → clamped to 0.2
    expect(evalCurve(c, 5)).toBe(0); // above max → clamped to 1
  });

  it("handles empty and single-point curves", () => {
    expect(evalCurve([], 0.5)).toBe(0);
    expect(evalCurve([[0.3, 7]], 99)).toBe(7);
  });
});

describe("signal registry", () => {
  it("covers exactly the signalId enum (extensible: id ⇔ registry entry)", () => {
    expect(Object.keys(SIGNAL_REGISTRY).sort()).toEqual([...signalId.options].sort());
  });

  it("hullFraction / heatFraction are exact ratios, clamped 0..1", () => {
    expect(evalSignal("hullFraction", ship({ hull: 40, hullMax: 80 }))).toBeCloseTo(0.5, 6);
    expect(evalSignal("heatFraction", ship({ heat: { cur: 30, capacity: 60 } }))).toBeCloseTo(0.5, 6);
    expect(evalSignal("hullFraction", ship({ hull: 999, hullMax: 100 }))).toBe(1);
  });

  it("shieldActive reflects any module with an absorb reservoir", () => {
    const withShield = ship({
      modules: [{ moduleId: "m", hardpointIndex: 0, state: "active", heat: 0, stateTimer: 0, cycleTimer: 0, shieldPool: 5 }],
    });
    expect(evalSignal("shieldActive", withShield)).toBe(1);
    expect(evalSignal("shieldActive", ship())).toBe(0);
  });

  it("firing reflects an active module mid weapon cycle", () => {
    const firing = ship({
      modules: [{ moduleId: "m", hardpointIndex: 0, state: "active", heat: 0, stateTimer: 0, cycleTimer: 0.2, shieldPool: 0 }],
    });
    expect(evalSignal("firing", firing)).toBe(1);
  });

  it("throttle reads the snapshot's real commanded throttle", () => {
    const prev = ship({ pos: { x: 0, z: 0 } });
    // A flight-driven ship reports what the pilot asked for, regardless of how
    // far it moved this snapshot (mid accel-ramp, or shoved by a collision).
    expect(evalSignal("throttle", ship({ throttle: 0.4, pos: { x: 5, z: 0 } }), prev)).toBeCloseTo(0.4, 6);
    expect(evalSignal("throttle", ship({ throttle: 1 }), prev)).toBe(1);
    expect(evalSignal("throttle", ship({ throttle: 1 }))).toBe(1); // no prev needed
    expect(evalSignal("throttle", ship({ throttle: 5 }), prev)).toBe(1); // clamped
  });

  it("motion signals derive from planar displacement between snapshots", () => {
    // throttle === 0 ⇒ no FlightState (move-order driven): displacement fallback.
    const prev = ship({ pos: { x: 0, z: 0 } });
    const moving = ship({ pos: { x: 1.2, z: 0 } });
    expect(evalSignal("throttle", moving, prev)).toBeCloseTo(1, 6); // step == reference
    expect(evalSignal("throttle", ship(), prev)).toBe(0); // no movement
    expect(evalSignal("throttle", moving)).toBe(0); // no prev ⇒ 0
    const boosting = ship({ pos: { x: 2.5, z: 0 } });
    expect(evalSignal("boostActive", boosting, prev)).toBe(1);
    expect(evalSignal("boostActive", moving, prev)).toBe(0);
  });
});
