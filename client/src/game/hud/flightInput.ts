import { TURN_SIGN_FOR_SCREEN_RIGHT } from "../chaseCamera.js";

/**
 * FLIGHT.md §4 — the pure input math behind the flight HUD: joystick → `turn`,
 * drag → throttle, held keys → both. No DOM, no config service, so every mapping
 * (above all the turn SIGN) is unit-testable.
 */

/** One frame of pilot intent — exactly the payload of a `flight` order. */
export interface FlightInputState {
  /** 0..1 */
  throttle: number;
  /** -1..1, sim convention (positive INCREASES heading). */
  turn: number;
  boost: boolean;
}

export function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}

/**
 * Joystick deflection → sim `turn`.
 *
 * `stickX` is the thumb offset as a fraction of the base radius, screen axes:
 * **+1 = pushed to the right of the screen**. The returned value is a sim turn,
 * and the sign flip between the two is not a preference — it is derived in
 * `chaseCamera.ts`: under the chase rig an INCREASING sim heading sweeps the nose
 * toward screen LEFT, so screen-right must be a negative turn
 * ({@link TURN_SIGN_FOR_SCREEN_RIGHT}).
 *
 * `deadzone` is fractional stick travel treated as centre (thumb drift), and the
 * remaining travel is re-normalized to a full 0..1 so the outer edge always
 * means "hardest turn". `expo` shapes the magnitude only, never the sign.
 */
export function turnFromStick(stickX: number, deadzone: number, expo = 1): number {
  const x = clamp(stickX, -1, 1);
  const magnitude = Math.abs(x);
  const dz = clamp(deadzone, 0, 0.9);
  if (magnitude <= dz) return 0;
  const scaled = (magnitude - dz) / (1 - dz);
  const shaped = expo === 1 ? scaled : Math.pow(scaled, expo);
  return Math.sign(x) * TURN_SIGN_FOR_SCREEN_RIGHT * clamp(shaped, 0, 1);
}

/**
 * Pointer position on the throttle track → throttle 0..1.
 *
 * The track is a rectangle in client coordinates; 0 % is the BOTTOM edge and
 * 100 % the top, which is why the y axis is inverted here. Positions outside the
 * track clamp instead of releasing the drag — dragging past the top and coming
 * back must not lose the grab.
 */
export function throttleFromPointer(clientY: number, trackTop: number, trackHeight: number): number {
  if (trackHeight <= 0) return 0;
  return clamp(1 - (clientY - trackTop) / trackHeight, 0, 1);
}

/** Throttle 0..1 → the thumb's top offset (px) inside its track. */
export function thumbTopPx(throttle: number, trackHeight: number, thumbHeight: number): number {
  const travel = Math.max(0, trackHeight - thumbHeight);
  return (1 - clamp(throttle, 0, 1)) * travel;
}

/** Desktop keys currently held, already collapsed to axes. */
export interface KeyAxes {
  /** -1 = left key(s) held, +1 = right, 0 = neither or both. */
  turnScreenX: number;
  /** -1 = throttle-down held, +1 = throttle-up, 0 = neither or both. */
  throttleRamp: number;
  boost: boolean;
}

/**
 * Desktop bindings (FLIGHT.md §4): A/D and ←/→ steer, W/S and ↑/↓ ramp the
 * throttle while held, Shift boosts. Keys are matched on `KeyboardEvent.key`
 * lower-cased, so layout-independent arrows work and letters are case-agnostic.
 *
 * Opposite keys cancel rather than fighting over the last press — holding A and
 * D is a straight line, which is what a pilot mashing both expects.
 */
export function keyAxesFrom(held: ReadonlySet<string>): KeyAxes {
  const left = held.has("a") || held.has("arrowleft");
  const right = held.has("d") || held.has("arrowright");
  const up = held.has("w") || held.has("arrowup");
  const down = held.has("s") || held.has("arrowdown");
  return {
    turnScreenX: (right ? 1 : 0) - (left ? 1 : 0),
    throttleRamp: (up ? 1 : 0) - (down ? 1 : 0),
    boost: held.has("shift"),
  };
}

/** The normalized `KeyboardEvent.key` this module matches on, or null if unbound. */
export function flightKeyOf(key: string): string | null {
  const k = key.toLowerCase();
  return FLIGHT_KEYS.has(k) ? k : null;
}

const FLIGHT_KEYS: ReadonlySet<string> = new Set([
  "a",
  "d",
  "w",
  "s",
  "arrowleft",
  "arrowright",
  "arrowup",
  "arrowdown",
  "shift",
]);

/**
 * Advance a key-held throttle by `dtMs`. Held W/↑ ramps up, S/↓ ramps down at
 * `ratePerSec` of full travel per second; releasing both HOLDS the value (the
 * throttle is a lever, not a spring — same contract as the touch thumb).
 */
export function rampThrottle(current: number, ramp: number, ratePerSec: number, dtMs: number): number {
  if (ramp === 0) return current;
  return clamp(current + Math.sign(ramp) * ratePerSec * (dtMs / 1000), 0, 1);
}
