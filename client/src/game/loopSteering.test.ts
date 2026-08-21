import { describe, expect, it } from "vitest";
import { advancePitch, flightStep, seedUp, wrapAngle, type FlightParams, type SteerState } from "@space-arena/shared";
import { mapRelativeSteer } from "./hud/flightInput.js";
import { FlightOrderSender, type FlightOrderPolicy } from "./hud/flightOrders.js";

/**
 * **Layer test for the "bumped back at vertical" report (2026-07-27).**
 *
 * The owner flew a loop on device and found that on reaching vertical the ship
 * kicked back the other way. This drives the REAL client steering chain —
 * screen-space drag → `mapRelativeSteer` → `FlightOrderSender` → `flightStep` —
 * with the stick held hard up across both poles, and asserts that nothing in
 * order generation or integration ever reverses.
 *
 * It exists to localise that class of bug, not to prove the feel is right: if
 * these assertions hold, the reversal the player sees cannot be coming from the
 * input frame, the order sender or the sim, which leaves presentation (the chase
 * camera's frame) as the only remaining layer.
 */

const DT = 1 / 60;

const POLICY: FlightOrderPolicy = {
  throttleEpsilon: 0.02,
  turnEpsilon: 0.05,
  pitchEpsilon: 0.05,
  heartbeatMs: 250,
  minIntervalMs: 50,
  maxOrdersPerSec: 20,
  budgetShare: 0.5,
};

const PARAMS: FlightParams = {
  nominalSpeed: 34,
  accel: 22,
  turnRate: 3,
  pitchRateMult: 0.8,
  maxPitchRad: null, // shipped tuning: free pitch, the regime the owner flew
};

/** Drag straight up from the origin, past the deadzone — "hold the stick up". */
const DRAG_UP = { dx: 0, dy: -120 };
const DRAG_DOWN = { dx: 0, dy: 120 };

function runHeldDrag(drag: { dx: number; dy: number }, seconds: number) {
  const axes = mapRelativeSteer(drag.dx, drag.dy, 8, 120, 1, false);
  const sent: number[] = [];
  const sender = new FlightOrderSender((order) => {
    if (order.kind === "flight") sent.push(order.pitchStick ?? 0);
  }, POLICY);

  const ship: SteerState = { pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, heading: 0.7, pitch: 0, up: seedUp(0.7, 0) };
  const pitches: number[] = [];
  let nowMs = 0;
  // The level-triggered state the sim is actually integrating.
  let held = { throttle: 1, turn: axes.turn, pitchStick: axes.pitchStick, boostMult: 1 };

  for (let i = 0; i < seconds / DT; i++) {
    nowMs += DT * 1000;
    sender.update(
      { throttle: 1, turn: axes.turn, pitchStick: axes.pitchStick, boost: false, fire: false, triggers: 0 },
      nowMs,
    );
    held = { throttle: 1, turn: sender.lastSent.turn, pitchStick: sender.lastSent.pitchStick, boostMult: 1 };
    flightStep(ship, held, PARAMS, DT);
    pitches.push(ship.pitch);
  }
  return { axes, sent, pitches, ship };
}

describe("holding the stick up flies a LOOP — no reversal at vertical", () => {
  it("emits one constant, correctly-signed pitchStick across both poles", () => {
    const { axes, sent, pitches } = runHeldDrag(DRAG_UP, 6);

    // Screen y grows downward, so a drag UP is negative dy and must command a
    // POSITIVE pitchStick (nose up). This is the sign the whole chain depends on.
    expect(axes.pitchStick).toBeGreaterThan(0);
    expect(Math.abs(axes.turn)).toBe(0); // exactly centred, sign of zero irrelevant

    // Every order carries the same value. Not "mostly positive" — identical, so a
    // sign flip anywhere in order generation is impossible by construction.
    expect(sent.length).toBeGreaterThan(0);
    for (const s of sent) expect(s).toBe(axes.pitchStick);

    // The ship crossed both poles: vertical (π/2) and inverted-level (±π).
    expect(pitches.some((p) => p > Math.PI / 2)).toBe(true);
    expect(pitches.some((p) => Math.abs(p) > Math.PI - 0.3)).toBe(true);
    expect(pitches.some((p) => p < -Math.PI / 2)).toBe(true);
  });

  it("advances the nose monotonically once wrap is accounted for", () => {
    // The direct statement of "not bumped back": every tick rotates the nose the
    // SAME way. A kick at vertical would show up as a negative step here.
    const { pitches } = runHeldDrag(DRAG_UP, 6);
    let total = 0;
    for (let i = 1; i < pitches.length; i++) {
      const step = wrapAngle(pitches[i]! - pitches[i - 1]!);
      expect(step).toBeGreaterThan(0);
      total += step;
    }
    // A full 6 s at turnRate 3 × pitchRateMult 0.8 is ~14.4 rad — over two loops.
    expect(total).toBeGreaterThan(2 * Math.PI * 2);
  });

  it("does the same downward, so neither pole is special", () => {
    const { axes, sent, pitches } = runHeldDrag(DRAG_DOWN, 6);
    expect(axes.pitchStick).toBeLessThan(0);
    for (const s of sent) expect(s).toBe(axes.pitchStick);
    for (let i = 1; i < pitches.length; i++) {
      expect(wrapAngle(pitches[i]! - pitches[i - 1]!)).toBeLessThan(0);
    }
  });

  it("crosses vertical with the velocity turning over, not reversing its sense", () => {
    // What the player actually sees at the pole: the ship's HORIZONTAL travel
    // reverses (cos pitch changes sign), which is a correct part of going over
    // the top — the nose keeps rotating the same way throughout. Pinning it here
    // so the sim's behaviour is not mistaken for the reported bug again.
    const { pitches } = runHeldDrag(DRAG_UP, 6);
    const crossing = pitches.findIndex((p) => p > Math.PI / 2);
    expect(crossing).toBeGreaterThan(0);
    expect(Math.cos(pitches[crossing - 1]!)).toBeGreaterThan(0);
    expect(Math.cos(pitches[crossing]!)).toBeLessThan(0);
    // ...and the vertical component is still climbing on both sides of it.
    expect(Math.sin(pitches[crossing - 1]!)).toBeGreaterThan(0.9);
    expect(Math.sin(pitches[crossing]!)).toBeGreaterThan(0.9);
  });

  it("integrates the same whether or not the wrap is crossed mid-tick", () => {
    // `advancePitch` is the one place the wrap happens; a step that lands exactly
    // on the boundary must not double back.
    expect(advancePitch(Math.PI - 0.01, 0.02, null)).toBeCloseTo(-Math.PI + 0.01, 12);
    expect(advancePitch(-Math.PI + 0.01, -0.02, null)).toBeCloseTo(Math.PI - 0.01, 12);
  });
});
