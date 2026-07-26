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
  /** -1..1, sim convention (positive noses UP — BUBBLE.md §A). */
  pitchStick: number;
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
 * Joystick deflection → sim `pitchStick` (BUBBLE.md §C).
 *
 * `stickY` is the thumb offset as a fraction of the base radius in SCREEN axes,
 * so **+1 = pushed toward the bottom of the screen** (client coordinates grow
 * downward). "Push up = climb" therefore means the screen axis is negated —
 * {@link PITCH_SIGN_FOR_STICK_DOWN} — and `invert` flips that for players who
 * read the stick as a yoke instead of a nose. Unlike the turn sign this is a
 * PREFERENCE, not a derivation: nothing about the camera rig decides it, which
 * is exactly why it is the axis that gets a settings toggle.
 *
 * Deadzone and expo behave as in {@link turnFromStick} — the same values, since
 * both axes are one thumb on one ring.
 */
export function pitchFromStick(stickY: number, deadzone: number, expo = 1, invert = false): number {
  const y = clamp(stickY, -1, 1);
  const magnitude = Math.abs(y);
  const dz = clamp(deadzone, 0, 0.9);
  if (magnitude <= dz) return 0;
  const scaled = (magnitude - dz) / (1 - dz);
  const shaped = expo === 1 ? scaled : Math.pow(scaled, expo);
  const sign = Math.sign(y) * PITCH_SIGN_FOR_STICK_DOWN * (invert ? -1 : 1);
  return sign * clamp(shaped, 0, 1);
}

/**
 * Sign a stick pushed toward the BOTTOM of the screen carries as a sim
 * `pitchStick`, before the player's invert preference. Screen y grows downward
 * and "push up = climb" (a positive pitch), so pushing down noses down: −1.
 */
export const PITCH_SIGN_FOR_STICK_DOWN = -1;

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
  /**
   * Screen-space pitch axis: **+1 = a key pushing the nose toward the BOTTOM of
   * the screen** held, -1 = toward the top, 0 = neither or both. Same convention
   * as the stick's `stickY`, so both feed {@link pitchFromStick} unchanged and
   * the invert preference applies to keys and thumb alike.
   */
  pitchScreenY: number;
  /** -1 = throttle-down held, +1 = throttle-up, 0 = neither or both. */
  throttleRamp: number;
  boost: boolean;
}

/**
 * Desktop bindings (FLIGHT.md §4, rebound for the bubble in BUBBLE.md §C):
 * A/D and ←/→ steer, **W/S and ↑/↓ pitch** (up = climb), **R/F ramp the
 * throttle** while held, Shift boosts. Keys are matched on `KeyboardEvent.key`
 * lower-cased, so layout-independent arrows work and letters are case-agnostic.
 *
 * The throttle keys moved rather than doubling up: pitch is a continuous flight
 * axis that wants the primary hand position, and the throttle already has a
 * draggable lever plus (since the bubble) a mouse wheel over the strip.
 *
 * Opposite keys cancel rather than fighting over the last press — holding A and
 * D is a straight line, which is what a pilot mashing both expects.
 */
export function keyAxesFrom(held: ReadonlySet<string>): KeyAxes {
  const left = held.has("a") || held.has("arrowleft");
  const right = held.has("d") || held.has("arrowright");
  const noseUp = held.has("w") || held.has("arrowup");
  const noseDown = held.has("s") || held.has("arrowdown");
  return {
    turnScreenX: (right ? 1 : 0) - (left ? 1 : 0),
    // Nose-up is a push toward the TOP of the screen, i.e. the negative screen axis.
    pitchScreenY: (noseDown ? 1 : 0) - (noseUp ? 1 : 0),
    throttleRamp: (held.has("r") ? 1 : 0) - (held.has("f") ? 1 : 0),
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
  "r",
  "f",
  "arrowleft",
  "arrowright",
  "arrowup",
  "arrowdown",
  "shift",
]);

/**
 * Advance a key-held throttle by `dtMs`. Held R ramps up, F ramps down at
 * `ratePerSec` of full travel per second; releasing both HOLDS the value (the
 * throttle is a lever, not a spring — same contract as the touch thumb).
 */
export function rampThrottle(current: number, ramp: number, ratePerSec: number, dtMs: number): number {
  if (ramp === 0) return current;
  return clamp(current + Math.sign(ramp) * ratePerSec * (dtMs / 1000), 0, 1);
}

/**
 * Mouse wheel over the throttle strip → a new lever value (BUBBLE.md §C, the
 * pointer-side replacement for the W/S nudge the pitch axis took).
 *
 * Only the SIGN of `deltaY` is used, never its magnitude: browsers report wildly
 * different deltas for one physical notch (pixels, lines, pages, and a trackpad
 * flick streams dozens of tiny events), so a proportional mapping would make the
 * step depend on the input device. Scrolling up (negative `deltaY`, the same
 * direction as the lever's 100 % end) opens the throttle.
 */
export function throttleFromWheel(current: number, deltaY: number, stepPerNotch: number): number {
  if (deltaY === 0) return current;
  return clamp(current - Math.sign(deltaY) * stepPerNotch, 0, 1);
}
