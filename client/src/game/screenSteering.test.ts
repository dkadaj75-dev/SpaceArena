// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { flightStep, wrapAngle, type FlightParams, type SteerState } from "@space-arena/shared";
import { RelativeSteerInput } from "./hud/RelativeSteerInput.js";
import { resolveFlightHudLayout } from "./hud/flightHudLayout.js";
import { chaseOffsetFor, chaseUpFor } from "./chaseCamera.js";

/**
 * **The screen invariant** (BUBBLE.md §A).
 *
 * > At every sustained pitch, a held LEFT turn input must move the nose LEFT on
 * > screen in the rolled camera frame.
 *
 * This is the property the owner has been reporting violations of, and it is
 * stated here as a property rather than as a mechanism on purpose: the sim yaws
 * about world Y, the camera rolls with the ship, and whether those two compose
 * into "left is left" is not obvious from either one alone.
 *
 * The chain driven below is the real one — a real {@link RelativeSteerInput}
 * taking real pointer events, its real `setShipPitch`, the real
 * `mapRelativeSteer` mapping inside it, the real `flightStep` integrator, and the
 * real {@link chaseUpFor}/{@link chaseOffsetFor} rig math — so a break anywhere
 * between the pointer and the screen shows up here.
 *
 * ## The frame
 *
 * Babylon's `LookAtLH` builds its basis as `zaxis = normalize(target - eye)` and
 * `xaxis = normalize(cross(up, zaxis))`, and `xaxis` IS screen-right. With the
 * rolled rig that works out to `(sin h, 0, -cos h)` — independent of pitch.
 *
 * Under BODY-FRAME yaw the nose's response to a turn input is `dN/dψ = W`, the
 * ship's own right-hand axis, which is exactly that screen-right vector with unit
 * length at every attitude. So the response is a constant `-1` — same direction,
 * same authority, upright or inverted or straight up. There is no sign flip and
 * no dead zone to work around; an earlier world-Y-yaw model needed both and could
 * satisfy neither (see the BUBBLE.md amendment for why).
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

/** Screen-right of the rolled chase rig for a ship at this attitude. */
function screenRight(heading: number, pitch: number): Vec3 {
  const up = chaseUpFor(heading, pitch, { x: 0, y: 0, z: 0 });
  const offset = chaseOffsetFor(heading, pitch, BASE_BETA, RADIUS, { x: 0, y: 0, z: 0 });
  // The camera sits at ship+offset and looks at the ship, so forward is -offset.
  const forward = normalize({ x: -offset.x, y: -offset.y, z: -offset.z });
  return normalize(cross(up, forward));
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
 * displacement measured against a frame the camera abandoned six ticks ago. The
 * difference is invisible in level flight and total near the poles, where a small
 * yaw swings the heading — and therefore the camera azimuth — a long way.
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
  };

  canvas.dispatchEvent(pointer("pointerdown", { id: 1, x: 400, y: 300, button: 2 }));
  document.dispatchEvent(
    pointer("pointermove", { id: 1, x: 400 + dragX, y: 300, movementX: dragX, movementY: 0 }),
  );

  // A few ticks of held input — the axes are level-triggered, so this is exactly
  // what the sim would be integrating between decisions.
  let total = 0;
  for (let i = 0; i < 6; i++) {
    const right = screenRight(ship.heading, ship.pitch);
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

  it("rolls the view by yaw x tan(p) — the deliberate trade, measured", () => {
    // Stated honestly, because it is NOT a free win. Turning while pitched rolls
    // the horizon, and body-frame yaw rolls it MORE than world-Y yaw did:
    // `yaw x tan p` against `yaw x sin p`. That is the price of a lateral response
    // that is constant and never reverses.
    //
    // It is the right trade because the two are different KINDS of defect. A
    // rolling horizon while you turn in a climb is what turning in a climb looks
    // like — it is continuous, it is symmetric, and it does not lie about which
    // way you are going. A lateral response that fades to zero and then reverses
    // sign, which is what world-Y yaw did, makes the control itself untrustworthy,
    // and that is what the owner kept reporting.
    const yawStep = PARAMS.turnRate * DT;
    for (const deg of [30, -30, 45, -45, 70, -70]) {
      const p = (deg * Math.PI) / 180;
      expect(viewRollPerTick(0.7, p)).toBeCloseTo(yawStep * Math.tan(p), 2);
    }
    // Level flight rolls not at all, on either model.
    expect(viewRollPerTick(0.7, 0)).toBeCloseTo(0, 12);
  });

  it("is IDENTICAL to the old world-yaw model in level flight", () => {
    // The safety property of the whole change: at pitch 0 the ship's up IS world
    // Y, so body-frame yaw and `heading += delta` are the same operation. Any
    // regression fixture recorded on level flight must therefore be untouched.
    const ship: SteerState = { pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, heading: 0.4, pitch: 0 };
    let worldYawHeading = 0.4;
    for (let i = 0; i < 120; i++) {
      flightStep(ship, { throttle: 1, turn: 0.6, pitchStick: 0, boostMult: 1 }, PARAMS, DT);
      worldYawHeading += 0.6 * PARAMS.turnRate * DT;
    }
    expect(ship.pitch).toBe(0);
    expect(Math.abs(wrapAngle(ship.heading - worldYawHeading))).toBeLessThan(1e-12);
  });
});

/** View roll produced by one tick of full turn input, in radians. */
function viewRollPerTick(heading: number, pitch: number): number {
  const ship: SteerState = { pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, heading, pitch };
  const n0 = nose(heading, pitch);
  const u0 = chaseUpFor(heading, pitch, { x: 0, y: 0, z: 0 });
  flightStep(ship, { throttle: 0, turn: 1, pitchStick: 0, boostMult: 1 }, PARAMS, DT);
  const n1 = nose(ship.heading, ship.pitch);
  const u1 = chaseUpFor(ship.heading, ship.pitch, { x: 0, y: 0, z: 0 });
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
 * **Honest residual: the pole is still singular, and always will be.**
 *
 * `BUBBLE.md`'s orientation model has no roll degree of freedom — attitude IS
 * (heading, pitch) — so the ship's up is *derived* from where the nose points. For
 * a nose pointing straight up there is no such derivation: every perpendicular is
 * equally "up", and the derived frame swings hard for any small nose movement.
 * Turning while passing exactly through vertical therefore spins the view, and no
 * choice of yaw axis avoids it; it is the Euler singularity, not a steering bug.
 *
 * What body-frame yaw changed is WHICH symptom the singularity produces. It no
 * longer touches the lateral response at all — that stays exactly correct at every
 * attitude, pole included — and instead shows up entirely as roll, which grows as
 * `tan p` and is unbounded only at the pole itself. A ship crosses the pole in a
 * few hundredths of a second. Under world-Y yaw the same singularity leaked out
 * across the whole steep-pitch band as a lateral response that faded to nothing
 * and then reversed sign, which is the defect the owner kept reporting. These
 * cases pin the trade so it is not rediscovered as a regression.
 *
 * Buying the last of it back means giving the sim a real roll axis, which is a
 * different orientation model than the one this game chose.
 */
describe("residual: the roll-less state is singular at the pole", () => {
  it("stays bounded away from vertical and blows up only at the pole", () => {
    // `tan p` is finite everywhere the player actually flies and unbounded only
    // where the derived up stops existing.
    const yawStep = PARAMS.turnRate * DT;
    for (const deg of [0, 45, -45, 135, -135, 180]) {
      expect(Math.abs(viewRollPerTick(0.7, (deg * Math.PI) / 180))).toBeLessThanOrEqual(yawStep * 1.001);
    }
  });

  it("spins the frame AT the pole, which is the derived up being undefined there", () => {
    expect(Math.abs(viewRollPerTick(0.7, Math.PI / 2))).toBeGreaterThan(1);
  });

  it("does not cost the player any steering authority while it happens", () => {
    // The point of the trade: even at the exact pole the lateral response is the
    // same as level flight, so the ship still goes where it is pointed.
    expect(lateralScreenDelta(90, -120)).toBeCloseTo(lateralScreenDelta(0, -120), 6);
  });
});
