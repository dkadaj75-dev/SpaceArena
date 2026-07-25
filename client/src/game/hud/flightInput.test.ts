import { describe, expect, it } from "vitest";
import { TURN_SIGN_FOR_SCREEN_RIGHT } from "../chaseCamera.js";
import {
  flightKeyOf,
  keyAxesFrom,
  rampThrottle,
  throttleFromPointer,
  thumbTopPx,
  turnFromStick,
} from "./flightInput.js";

/**
 * The pure input mappings behind the flight HUD (FLIGHT.md §4). The turn SIGN is
 * cross-checked against the rig's geometry in `chaseCamera.test.ts`; here we pin
 * the shaping (deadzone / expo / clamping) around it.
 */
describe("turnFromStick", () => {
  it("maps a stick pushed right to the screen-right turn sign, and left to its negation", () => {
    expect(Math.sign(turnFromStick(1, 0, 1))).toBe(TURN_SIGN_FOR_SCREEN_RIGHT);
    expect(Math.sign(turnFromStick(-1, 0, 1))).toBe(-TURN_SIGN_FOR_SCREEN_RIGHT);
    expect(turnFromStick(1, 0, 1)).toBe(TURN_SIGN_FOR_SCREEN_RIGHT);
  });

  it("is exactly centred: a stick at rest is a straight line", () => {
    expect(turnFromStick(0, 0.12, 1.35)).toBe(0);
  });

  it("treats deflection inside the deadzone as centre and re-normalizes the rest", () => {
    expect(turnFromStick(0.1, 0.12, 1)).toBe(0);
    expect(turnFromStick(0.12, 0.12, 1)).toBe(0);
    // Halfway through the LIVE travel (0.12 → 1) is half a turn, not 0.56.
    expect(Math.abs(turnFromStick(0.56, 0.12, 1))).toBeCloseTo(0.5, 9);
    // The rim always means the hardest turn, whatever the deadzone.
    expect(Math.abs(turnFromStick(1, 0.12, 1))).toBeCloseTo(1, 9);
  });

  it("shapes magnitude with expo but never flips the sign", () => {
    const linear = Math.abs(turnFromStick(0.5, 0, 1));
    const shaped = Math.abs(turnFromStick(0.5, 0, 2));
    expect(shaped).toBeLessThan(linear);
    expect(Math.sign(turnFromStick(0.5, 0, 2))).toBe(Math.sign(turnFromStick(0.5, 0, 1)));
    expect(Math.abs(turnFromStick(1, 0, 3))).toBeCloseTo(1, 9);
  });

  it("clamps deflection beyond the base ring instead of exceeding full turn", () => {
    expect(Math.abs(turnFromStick(4, 0, 1))).toBe(1);
    expect(Math.abs(turnFromStick(-4, 0, 1))).toBe(1);
  });
});

describe("throttleFromPointer", () => {
  const TOP = 100;
  const HEIGHT = 200;

  it("puts 0 % at the bottom of the track and 100 % at the top", () => {
    expect(throttleFromPointer(TOP + HEIGHT, TOP, HEIGHT)).toBe(0);
    expect(throttleFromPointer(TOP, TOP, HEIGHT)).toBe(1);
    expect(throttleFromPointer(TOP + HEIGHT / 2, TOP, HEIGHT)).toBeCloseTo(0.5, 9);
  });

  it("clamps a drag past either end rather than losing the grab", () => {
    expect(throttleFromPointer(TOP - 500, TOP, HEIGHT)).toBe(1);
    expect(throttleFromPointer(TOP + 500, TOP, HEIGHT)).toBe(0);
  });

  it("is inert on a zero-height track (pre-layout)", () => {
    expect(throttleFromPointer(50, 0, 0)).toBe(0);
  });
});

describe("thumbTopPx", () => {
  it("puts the thumb at the bottom of its travel for 0 and the top for 1", () => {
    expect(thumbTopPx(0, 200, 26)).toBe(174);
    expect(thumbTopPx(1, 200, 26)).toBe(0);
    expect(thumbTopPx(0.5, 200, 26)).toBe(87);
  });

  it("never leaves the track when the thumb is taller than the track", () => {
    expect(thumbTopPx(0, 20, 40)).toBe(0);
  });
});

describe("keyAxesFrom / flightKeyOf", () => {
  it("binds A/D and ←/→ to turn, W/S and ↑/↓ to throttle, Shift to boost", () => {
    expect(keyAxesFrom(new Set(["d"]))).toEqual({ turnScreenX: 1, throttleRamp: 0, boost: false });
    expect(keyAxesFrom(new Set(["arrowleft"]))).toEqual({ turnScreenX: -1, throttleRamp: 0, boost: false });
    expect(keyAxesFrom(new Set(["w"]))).toEqual({ turnScreenX: 0, throttleRamp: 1, boost: false });
    expect(keyAxesFrom(new Set(["arrowdown"]))).toEqual({ turnScreenX: 0, throttleRamp: -1, boost: false });
    expect(keyAxesFrom(new Set(["shift"])).boost).toBe(true);
  });

  it("cancels opposite keys instead of letting the last press win", () => {
    expect(keyAxesFrom(new Set(["a", "d"])).turnScreenX).toBe(0);
    expect(keyAxesFrom(new Set(["w", "s"])).throttleRamp).toBe(0);
  });

  it("normalizes keys case-insensitively and ignores unbound ones", () => {
    expect(flightKeyOf("D")).toBe("d");
    expect(flightKeyOf("ArrowLeft")).toBe("arrowleft");
    expect(flightKeyOf("Shift")).toBe("shift");
    expect(flightKeyOf("q")).toBeNull();
    expect(flightKeyOf("Enter")).toBeNull();
  });
});

describe("rampThrottle", () => {
  it("ramps at the configured rate per second while a key is held", () => {
    expect(rampThrottle(0, 1, 0.9, 1000)).toBeCloseTo(0.9, 9);
    expect(rampThrottle(0.5, -1, 0.9, 500)).toBeCloseTo(0.05, 9);
  });

  it("HOLDS the value when no key is held — the throttle is a lever, not a spring", () => {
    expect(rampThrottle(0.42, 0, 0.9, 1000)).toBe(0.42);
  });

  it("clamps at both ends", () => {
    expect(rampThrottle(0.9, 1, 0.9, 1000)).toBe(1);
    expect(rampThrottle(0.1, -1, 0.9, 1000)).toBe(0);
  });
});
