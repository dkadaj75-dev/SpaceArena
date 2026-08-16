import { describe, expect, it } from "vitest";
import type { ShipSnapshot } from "./ArenaSimulation.js";
import { evalCurve, evalSignal, SIGNAL_REGISTRY, signalId } from "./signals.js";

function ship(overrides: Partial<ShipSnapshot> = {}): ShipSnapshot {
  return {
    id: 1,
    team: 0,
    pos: { x: 0, y: 0, z: 0 },
    heading: 0,
    pitch: 0,
    up: { x: 0, y: 1, z: 0 },
    hull: 100,
    hullMax: 100,
    targetId: null,
    throttle: 0,
    lockProgress: 0,
    locked: false,
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
    // heatFraction is the HOTTEST rack now — there is no ship pool to read.
    const hot = ship({
      modules: [
        { moduleId: "a", hardpointIndex: 0, state: "active", heat: 30, heatCapacity: 60, energy: 0, energyCapacity: 0, stateTimer: 0, rounds: 0, cycleTimer: 0, channeling: false, shieldPool: 0 },
        { moduleId: "b", hardpointIndex: 1, state: "active", heat: 0, heatCapacity: 100, energy: 0, energyCapacity: 0, stateTimer: 0, rounds: 0, cycleTimer: 0, channeling: false, shieldPool: 0 },
      ],
    });
    expect(evalSignal("heatFraction", hot)).toBeCloseTo(0.5, 6);
    expect(evalSignal("hullFraction", ship({ hull: 999, hullMax: 100 }))).toBe(1);
  });

  it("shieldActive reflects a DEPLOYED module with an absorb reservoir", () => {
    const withShield = ship({
      modules: [{ moduleId: "m", hardpointIndex: 0, state: "active", heat: 0, heatCapacity: 100, energy: 0, energyCapacity: 0, stateTimer: 0, rounds: 0, cycleTimer: 0, channeling: false, shieldPool: 5 }],
    });
    expect(evalSignal("shieldActive", withShield)).toBe(1);
    expect(evalSignal("shieldActive", ship())).toBe(0);
  });

  /**
   * Owner 2026-08-16: a shield's reservoir IS its energy tank, and that tank
   * charges from spawn, so a pool alone reads "this hull carries a shield" —
   * not "this hull is running one". Only `active` mitigates damage, and only
   * `active` may look like it does: this is what stopped the bubble appearing
   * around every ship that merely had a shield equipped.
   */
  it("stays down for a shield that is fitted and charged but never switched on", () => {
    const module = { moduleId: "m", hardpointIndex: 0, heat: 0, heatCapacity: 100, energy: 20, energyCapacity: 20, stateTimer: 0, rounds: 0, cycleTimer: 0, channeling: false, shieldPool: 20 } as const;
    expect(evalSignal("shieldActive", ship({ modules: [{ ...module, state: "retracted" }] }))).toBe(0);
    expect(evalSignal("shieldActive", ship({ modules: [{ ...module, state: "deploying" }] }))).toBe(0);
    expect(evalSignal("shieldActive", ship({ modules: [{ ...module, state: "retracting" }] }))).toBe(0);
    expect(evalSignal("shieldActive", ship({ modules: [{ ...module, state: "active" }] }))).toBe(1);
  });

  it("firing reflects an active module mid weapon cycle", () => {
    const firing = ship({
      modules: [{ moduleId: "m", hardpointIndex: 0, state: "active", heat: 0, heatCapacity: 100, energy: 0, energyCapacity: 0, stateTimer: 0, rounds: 0, cycleTimer: 0.2, channeling: false, shieldPool: 0 }],
    });
    expect(evalSignal("firing", firing)).toBe(1);
  });

  it("throttle reads the snapshot's real commanded throttle", () => {
    const prev = ship({ pos: { x: 0, y: 0, z: 0 } });
    // A flight-driven ship reports what the pilot asked for, regardless of how
    // far it moved this snapshot (mid accel-ramp, or shoved by a collision).
    expect(evalSignal("throttle", ship({ throttle: 0.4, pos: { x: 5, y: 0, z: 0 } }), prev)).toBeCloseTo(0.4, 6);
    expect(evalSignal("throttle", ship({ throttle: 1 }), prev)).toBe(1);
    expect(evalSignal("throttle", ship({ throttle: 1 }))).toBe(1); // no prev needed
    expect(evalSignal("throttle", ship({ throttle: 5 }), prev)).toBe(1); // clamped
  });

  it("speedFraction and boostActive measure ACTUAL motion, not the command", () => {
    // These two deliberately stay on displacement (FLIGHT.md §7): the snapshot
    // carries no velocity, and a ship mid accel-ramp or one whose boost request
    // was denied for want of energy is not moving at what it asked for.
    const prev = ship({ pos: { x: 0, y: 0, z: 0 } });
    const moving = ship({ throttle: 1, pos: { x: 1.2, y: 0, z: 0 } });
    const boosting = ship({ throttle: 1, pos: { x: 2.5, y: 0, z: 0 } });
    expect(evalSignal("boostActive", boosting, prev)).toBe(1);
    expect(evalSignal("boostActive", moving, prev)).toBe(0);
    // Full throttle, not moving yet (or rammed to a stop) ⇒ no boost signal.
    expect(evalSignal("boostActive", ship({ throttle: 1 }), prev)).toBe(0);
    expect(evalSignal("speedFraction", boosting, prev)).toBeGreaterThan(evalSignal("speedFraction", moving, prev));
    expect(evalSignal("speedFraction", moving)).toBe(0); // no prev ⇒ 0

    // Measured in 3D (BUBBLE.md §A): a ship that spent the frame climbing is
    // moving exactly as fast as one that spent it running flat.
    const climbing = ship({ throttle: 1, pos: { x: 0, y: 1.2, z: 0 } });
    expect(evalSignal("speedFraction", climbing, prev)).toBeCloseTo(evalSignal("speedFraction", moving, prev), 12);
  });
});
