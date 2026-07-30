// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { flightStep, seedUp, wrapAngle, type FlightParams, type SteerState } from "@space-arena/shared";
import { RelativeSteerInput } from "./hud/RelativeSteerInput.js";
import { resolveFlightHudLayout } from "./hud/flightHudLayout.js";
import { chaseOffsetForFrame } from "./chaseCamera.js";

/**
 * **The screen invariant** (BUBBLE.md §A, as amended by the 2026-07-30
 * flight-frame handoff).
 *
 * > At every sustained pitch, a held LEFT turn input must move the nose LEFT on
 * > screen in the rolled camera frame.
 *
 * This is the property the owner has been reporting violations of, and it is
 * stated here as a property rather than as a mechanism on purpose: the sim yaws
 * about the ship's own persisted up, the camera rolls with the ship's frame,
 * and whether those two compose into "left is left" is not obvious from either
 * one alone.
 *
 * The chain driven below is the real one — a real {@link RelativeSteerInput}
 * taking real pointer events, its real `setShipPitch`, the real
 * `mapRelativeSteer` mapping inside it, the real `flightStep` integrator over
 * the real persisted frame, and the real {@link chaseOffsetForFrame} rig math
 * fed the SHIP'S OWN up — so a break anywhere between the pointer and the
 * screen shows up here.
 *
 * ## The frame
 *
 * Babylon's `LookAtLH` builds its basis as `zaxis = normalize(target - eye)` and
 * `xaxis = normalize(cross(up, zaxis))`, and `xaxis` IS screen-right. The rig's
 * up is the ship's replicated up, so screen-right is `cross(U, forward)` — the
 * ship's own left-handed lateral axis, at every attitude.
 *
 * Under BODY-FRAME yaw the nose's response to a turn input is `dN/dψ = W = N×U`,
 * which is exactly that screen-right vector (negated) with unit length at every
 * attitude. So the response is a constant `-1` — same direction, same authority,
 * upright or inverted or straight up. There is no sign flip and no dead zone;
 * and since the flight-frame handoff there is no pole singularity either — the
 * persisted frame never has to be reconstructed from the two Euler coordinates.
 */

const DT = 1 / 60;
const BASE_BETA = 1.34;
const RADIUS = 14;

const PARAMS: FlightParams = {
  nominalSpeed: 34,
  accel: 22,
  turnRate: 3,
  pitchRateMult: 0.8,
  maxPitchRad: null,
};

/** The pitches the owner's report and the invariant have to cover. */
const TEST_PITCHES_DEG = [0, 45, -45, 80, -80, 90, -90, 100, -100, 135, -135, 180];

type Vec3 = { x: number; y: number; z: number };

function nose(heading: number, pitch: number): Vec3 {
  return {
    x: Math.cos(pitch) * Math.cos(heading),
    y: Math.sin(pitch),
    z: Math.cos(pitch) * Math.sin(heading),
  };
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

function normalize(v: Vec3): Vec3 {
  const l = Math.hypot(v.x, v.y, v.z);
  return { x: v.x / l, y: v.y / l, z: v.z / l };
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

/**
 * Screen-right of the rolled chase rig for a ship carrying this FRAME — the
 * actual rendered camera basis: forward looks down the authored offset built
 * from the ship's own nose and up, and right is `cross(up, forward)` exactly as
 * `LookAtLH` builds it.
 */
function screenRight(ship: SteerState): Vec3 {
  const offset = chaseOffsetForFrame(nose(ship.heading, ship.pitch), ship.up, BASE_BETA, RADIUS, {
    x: 0,
    y: 0,
    z: 0,
  });
  // The camera sits at ship+offset and looks at the ship, so forward is -offset.
  const forward = normalize({ x: -offset.x, y: -offset.y, z: -offset.z });
  return normalize(cross(ship.up, forward));
}

function pointer(
  type: string,
  init: { id: number; x: number; y: number; movementX?: number; movementY?: number; button?: number },
): Event {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(ev, {
    pointerId: init.id,
    pointerType: "mouse",
    button: init.button ?? 0,
    clientX: init.x,
    clientY: init.y,
    movementX: init.movementX ?? 0,
    movementY: init.movementY ?? 0,
  });
  return ev;
}

/**
 * Hold a left (or right) drag at a sustained pitch and report how far the nose
 * moved along screen-right, summed PER TICK against that tick's own screen frame.
 * Negative is LEFT.
 *
 * Per-tick, not start-to-finish, and the distinction is the whole measurement.
 * The chase rig follows the ship, so the screen frame moves with it; what a player
 * perceives as "the world slid left" is each frame's motion in that frame, not the
 * displacement measured against a frame the camera abandoned six ticks ago.
 */
function lateralScreenDelta(pitchDeg: number, dragX: number): number {
  const root = document.createElement("div");
  const canvas = document.createElement("canvas");
  document.body.append(canvas, root);
  const steer = new RelativeSteerInput(root, canvas, resolveFlightHudLayout(undefined, { width: 800, height: 600 }));

  const pitch = (pitchDeg * Math.PI) / 180;
  const ship: SteerState = {
    pos: { x: 0, y: 0, z: 0 },
    vel: { x: 0, y: 0, z: 0 },
    heading: 0.7,
    pitch,
    up: seedUp(0.7, pitch),
  };

  canvas.dispatchEvent(pointer("pointerdown", { id: 1, x: 400, y: 300, button: 2 }));
  document.dispatchEvent(
    pointer("pointermove", { id: 1, x: 400 + dragX, y: 300, movementX: dragX, movementY: 0 }),
  );

  // A few ticks of held input — the axes are level-triggered, so this is exactly
  // what the sim would be integrating between decisions.
  let total = 0;
  for (let i = 0; i < 6; i++) {
    const right = screenRight(ship);
    const before = nose(ship.heading, ship.pitch);
    flightStep(ship, { throttle: 0, turn: steer.turn, pitchStick: 0, boostMult: 1 }, PARAMS, DT);
    const after = nose(ship.heading, ship.pitch);
    total += dot({ x: after.x - before.x, y: after.y - before.y, z: after.z - before.z }, right);
  }

  steer.dispose();
  root.remove();
  canvas.remove();
  return total;
}
describe("screen invariant: a held LEFT turn moves the nose LEFT at every pitch", () => {
  it("holds at every sustained pitch, upright and inverted", () => {
    const failures: string[] = [];
    for (const deg of TEST_PITCHES_DEG) {
      const delta = lateralScreenDelta(deg, -120);
      if (!(delta < 0)) failures.push(`${deg}deg -> ${delta.toFixed(4)}`);
    }
    expect(failures).toEqual([]);
  });

  it("mirrors for a held RIGHT turn", () => {
    const failures: string[] = [];
    for (const deg of TEST_PITCHES_DEG) {
      const delta = lateralScreenDelta(deg, 120);
      if (!(delta > 0)) failures.push(`${deg}deg -> ${delta.toFixed(4)}`);
    }
    expect(failures).toEqual([]);
  });

  it("keeps CONSTANT authority at every pitch — no dead zone at vertical", () => {
    // The property body-frame yaw buys that world-Y yaw could not. The old model
    // responded by |cos p|, which collapsed to nothing at vertical and left the
    // stick dead exactly where a loop spends its time. Now every attitude answers
    // the same amount.
    const level = Math.abs(lateralScreenDelta(0, -120));
    for (const deg of TEST_PITCHES_DEG) {
      expect(Math.abs(lateralScreenDelta(deg, -120))).toBeCloseTo(level, 6);
    }
    expect(level).toBeGreaterThan(0);
  });

  it("is IDENTICAL to the old world-yaw model in level flight", () => {
    // The safety property of the whole change: at pitch 0 the ship's up IS world
    // Y, so body-frame yaw and `heading += delta` are the same operation. Any
    // regression fixture recorded on level flight must therefore be untouched.
    const ship: SteerState = {
      pos: { x: 0, y: 0, z: 0 },
      vel: { x: 0, y: 0, z: 0 },
      heading: 0.4,
      pitch: 0,
      up: seedUp(0.4, 0),
    };
    let worldYawHeading = 0.4;
    for (let i = 0; i < 120; i++) {
      flightStep(ship, { throttle: 1, turn: 0.6, pitchStick: 0, boostMult: 1 }, PARAMS, DT);
      worldYawHeading += 0.6 * PARAMS.turnRate * DT;
    }
    expect(ship.pitch).toBe(0);
    expect(ship.up).toEqual({ x: 0, y: 1, z: 0 });
    expect(Math.abs(wrapAngle(ship.heading - worldYawHeading))).toBeLessThan(1e-12);
  });
});

/** View roll produced by one tick of full turn input, in radians — measured on the PERSISTED frame. */
function viewRollPerTick(heading: number, pitch: number): number {
  const ship: SteerState = {
    pos: { x: 0, y: 0, z: 0 },
    vel: { x: 0, y: 0, z: 0 },
    heading,
    pitch,
    up: seedUp(heading, pitch),
  };
  const n0 = nose(heading, pitch);
  const u0 = { ...ship.up };
  flightStep(ship, { throttle: 0, turn: 1, pitchStick: 0, boostMult: 1 }, PARAMS, DT);
  const n1 = nose(ship.heading, ship.pitch);
  const u1 = ship.up;
  // Parallel-transport the old up onto the new nose, then measure what is left
  // over against the new frame: that residue is roll about the view axis.
  const axis = cross(n0, n1);
  const sin = Math.hypot(axis.x, axis.y, axis.z);
  let t = u0;
  if (sin > 1e-12) {
    const a = normalize(axis);
    const ang = Math.atan2(sin, dot(n0, n1));
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);
    const c = cross(a, u0);
    const d = dot(a, u0) * (1 - ca);
    t = { x: u0.x * ca + c.x * sa + a.x * d, y: u0.y * ca + c.y * sa + a.y * d, z: u0.z * ca + c.z * sa + a.z * d };
  }
  const w1 = cross(n1, u1);
  return Math.atan2(dot(t, w1), dot(t, u1));
}

/**
 * **The pole singularity is GONE** (flight-frame handoff, 2026-07-30).
 *
 * The previous revision of this suite pinned an "honest residual": with attitude
 * stored as (heading, pitch) alone, the ship's up was *derived* from the nose,
 * the derivation is undefined at the poles, and turning while pitched rolled the
 * horizon by `yaw × tan p` — unbounded at vertical, measured at >1 rad per tick
 * AT the pole. That trade no longer exists to defend: the up is persisted state,
 * body yaw rotates the nose ABOUT it, and so a turn input produces exactly ZERO
 * view roll at every attitude, the pole included. These cases pin the repair the
 * same way the old ones pinned the trade.
 */
describe("the persisted frame: pure yaw never rolls the view, at any pitch", () => {
  it("produces zero roll residue at every test pitch, the pole included", () => {
    for (const deg of TEST_PITCHES_DEG) {
      expect(Math.abs(viewRollPerTick(0.7, (deg * Math.PI) / 180))).toBeLessThan(1e-6);
    }
    expect(Math.abs(viewRollPerTick(0.7, Math.PI / 2))).toBeLessThan(1e-6);
  });

  it("keeps full steering authority while crossing the pole", () => {
    expect(lateralScreenDelta(90, -120)).toBeCloseTo(lateralScreenDelta(0, -120), 6);
  });
});
