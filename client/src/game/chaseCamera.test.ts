import { describe, expect, it } from "vitest";
import { upFromAttitude, wrapAngle, type CameraConfig } from "@space-arena/shared";
import {
  angleDeltaTo,
  approachDirection,
  approachHeading,
  approachPitch,
  chaseAlphaFor,
  chaseOffsetForFrame,
  chaseSettingsOf,
  DEFAULT_CHASE_SETTINGS,
  TURN_SIGN_FOR_SCREEN_RIGHT,
} from "./chaseCamera.js";
import { turnFromStick } from "./hud/flightInput.js";

/** The roll-less frame for an attitude — what an unrolled ship replicates. */
function chaseUpFor(heading: number, pitch: number, out: Vec3): Vec3 {
  return upFromAttitude(heading, pitch, out);
}

/** Frame-based chase offset fed the DERIVED frame — the roll-less rig pose. */
function chaseOffsetFor(heading: number, pitch: number, baseBeta: number, radius: number, out: Vec3): Vec3 {
  return chaseOffsetForFrame(
    noseDir3D(heading, pitch),
    upFromAttitude(heading, pitch, { x: 0, y: 0, z: 0 }),
    baseBeta,
    radius,
    out,
  );
}

type Vec3 = { x: number; y: number; z: number };

/**
 * `ArcRotateCamera`'s own position formula, re-implemented so the assertions
 * below check the derivation in `chaseCamera.ts` against Babylon's geometry
 * rather than against itself.
 */
function orbitPosition(alpha: number, beta: number, radius: number, target: Vec3): Vec3 {
  return {
    x: target.x + radius * Math.cos(alpha) * Math.sin(beta),
    y: target.y + radius * Math.cos(beta),
    z: target.z + radius * Math.sin(alpha) * Math.sin(beta),
  };
}

/** The sim's heading convention: 0 faces +X, growing counter-clockwise in (x, z). */
function noseDir(heading: number): Vec3 {
  return { x: Math.cos(heading), y: 0, z: Math.sin(heading) };
}

/** The bubble's 3D facing: `(cos p·cos h, sin p, cos p·sin h)` (BUBBLE.md §A). */
function noseDir3D(heading: number, pitch: number): Vec3 {
  return {
    x: Math.cos(pitch) * Math.cos(heading),
    y: Math.sin(pitch),
    z: Math.cos(pitch) * Math.sin(heading),
  };
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v.x, v.y, v.z);
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

/**
 * Babylon's `Matrix.LookAtLH` builds screen-right as `cross(up, forward)` with
 * `up` the camera's world up vector — (0, 1, 0) for the tactical rig. Written
 * out for the specific case so the test does not depend on a cross-product
 * helper being right.
 */
function screenRight(forward: Vec3): Vec3 {
  return normalize({ x: forward.z, y: 0, z: -forward.x });
}

const ORIGIN: Vec3 = { x: 0, y: 0, z: 0 };

describe("chase camera geometry (FLIGHT.md §3)", () => {
  it("parks the camera directly behind the ship for any heading", () => {
    for (const heading of [0, 0.7, Math.PI / 2, 2.4, Math.PI, -1.9, 5.6]) {
      const pos = orbitPosition(chaseAlphaFor(heading), 1.34, 14, ORIGIN);
      // The offset from ship to camera must point straight down the ship's tail:
      // its ground-plane component is exactly -nose, so the dot is -1.
      const toCameraGround = normalize({ x: pos.x, y: 0, z: pos.z });
      expect(dot(toCameraGround, noseDir(heading))).toBeCloseTo(-1, 9);
    }
  });

  it("lifts the camera above the ship for a beta under π/2 and levels out at π/2", () => {
    expect(orbitPosition(chaseAlphaFor(0), 1.34, 14, ORIGIN).y).toBeGreaterThan(0);
    expect(orbitPosition(chaseAlphaFor(0), Math.PI / 2, 14, ORIGIN).y).toBeCloseTo(0, 9);
  });

  it("keeps the camera exactly `radius` from the follow point", () => {
    const pos = orbitPosition(chaseAlphaFor(1.1), 1.34, 14, ORIGIN);
    expect(Math.hypot(pos.x, pos.y, pos.z)).toBeCloseTo(14, 9);
  });
});

/**
 * The bubble's vertical half (BUBBLE.md §A, free-pitch loops). Checked against
 * `ArcRotateCamera`'s position formula rather than against the rig's own
 * reasoning: the camera must sit exactly down the ship's 3D tail at every pitch,
 * and its up vector must stay square to the nose so the horizon rolls with the
 * ship instead of flipping.
 */
describe("the rolled chase rig (BUBBLE.md §A)", () => {
  const BASE = 1.34;

  it("keeps the up vector square to the nose at every pitch, wrap included", () => {
    for (const heading of [0, 0.7, 2.4, -1.9]) {
      for (const pitch of [-Math.PI, -2.6, -1.2, 0, 0.5, Math.PI / 2, 2.6, Math.PI]) {
        const up = chaseUpFor(heading, pitch, { x: 0, y: 0, z: 0 });
        expect(Math.hypot(up.x, up.y, up.z)).toBeCloseTo(1, 9);
        // Perpendicular to the nose — that is what makes it a valid camera up.
        expect(dot(up, noseDir3D(heading, pitch))).toBeCloseTo(0, 9);
      }
    }
  });

  it("rolls CONTINUOUSLY through a loop, including across the ±π wrap", () => {
    // The bug the owner hit: a world-up rig has to flip the image 180° in one
    // frame at the pole. A rolling up vector cannot — consecutive samples stay
    // close however many times the ship goes round.
    const prev = { x: 0, y: 0, z: 0 };
    const cur = { x: 0, y: 0, z: 0 };
    let maxStep = 0;
    chaseUpFor(0.7, -Math.PI, prev);
    for (let p = -Math.PI; p <= Math.PI; p += 0.01) {
      chaseUpFor(0.7, wrapAngle(p), cur);
      maxStep = Math.max(maxStep, Math.hypot(cur.x - prev.x, cur.y - prev.y, cur.z - prev.z));
      prev.x = cur.x;
      prev.y = cur.y;
      prev.z = cur.z;
    }
    expect(maxStep).toBeLessThan(0.02);
    // And it closes the circle: the wrap point is the same vector from both sides.
    const atPi = chaseUpFor(0.7, Math.PI, { x: 0, y: 0, z: 0 });
    const atMinusPi = chaseUpFor(0.7, -Math.PI, { x: 0, y: 0, z: 0 });
    expect(Math.hypot(atPi.x - atMinusPi.x, atPi.y - atMinusPi.y, atPi.z - atMinusPi.z)).toBeCloseTo(0, 9);
  });

  it("goes fully inverted over the top, which is the loop", () => {
    // Upright at level, upside-down half a loop later. Nothing else can make
    // "hold the stick up" keep looking like a climb all the way round.
    expect(chaseUpFor(0.7, 0, { x: 0, y: 0, z: 0 }).y).toBeCloseTo(1, 9);
    expect(chaseUpFor(0.7, Math.PI, { x: 0, y: 0, z: 0 }).y).toBeCloseTo(-1, 9);
    expect(chaseUpFor(0.7, Math.PI / 2, { x: 0, y: 0, z: 0 }).y).toBeCloseTo(0, 9);
  });

  it("sits behind the ship's 3D tail at every pitch, upright or inverted", () => {
    for (const heading of [0, 0.7, 2.4]) {
      for (const pitch of [-2.6, -1.2, 0, 1.2, 2.6, 3.0]) {
        const off = chaseOffsetFor(heading, pitch, Math.PI / 2, 14, { x: 0, y: 0, z: 0 });
        // A base tilt of exactly π/2 is "straight down the tail", so the offset
        // must be the negated nose. (The shipped tilt lifts it; see below.)
        expect(dot(normalize(off), noseDir3D(heading, pitch))).toBeCloseTo(-1, 9);
      }
    }
  });

  it("lifts the camera above the ship's own up for a base tilt under π/2", () => {
    for (const pitch of [0, 1.2, 2.6, -2.0]) {
      const off = chaseOffsetFor(0.7, pitch, BASE, 14, { x: 0, y: 0, z: 0 });
      const up = chaseUpFor(0.7, pitch, { x: 0, y: 0, z: 0 });
      // "Over the shoulder" is a constant lift along the SHIP's up, at any pitch —
      // that constancy is what makes the rig feel identical all the way round.
      expect(dot(normalize(off), up)).toBeCloseTo(Math.cos(BASE), 9);
      expect(Math.hypot(off.x, off.y, off.z)).toBeCloseTo(14, 9);
    }
  });

  it("keeps the camera position CONTINUOUS through a loop", () => {
    const prev = { x: 0, y: 0, z: 0 };
    const cur = { x: 0, y: 0, z: 0 };
    let maxStep = 0;
    chaseOffsetFor(0.7, -Math.PI, BASE, 14, prev);
    for (let p = -Math.PI; p <= Math.PI; p += 0.01) {
      chaseOffsetFor(0.7, wrapAngle(p), BASE, 14, cur);
      maxStep = Math.max(maxStep, Math.hypot(cur.x - prev.x, cur.y - prev.y, cur.z - prev.z));
      prev.x = cur.x;
      prev.y = cur.y;
      prev.z = cur.z;
    }
    // 0.01 rad of pitch moves a 14-unit arm about 0.14 units; nothing jumps.
    expect(maxStep).toBeLessThan(0.2);
  });

  it("reduces to the plain orbit formula, so the rig is still an ArcRotate pose", () => {
    // `chaseOffsetFor` IS `orbitPosition(alpha = h + π, beta = base + pitch)`.
    // Worth pinning: it means the camera's POSITION was always continuous under
    // the naive rule, and only the roll was ever broken.
    for (const pitch of [-2.0, 0, 0.9, 2.7]) {
      const off = chaseOffsetFor(0.7, pitch, BASE, 14, { x: 0, y: 0, z: 0 });
      const pos = orbitPosition(chaseAlphaFor(0.7), BASE + pitch, 14, ORIGIN);
      expect(off.x).toBeCloseTo(pos.x, 9);
      expect(off.y).toBeCloseTo(pos.y, 9);
      expect(off.z).toBeCloseTo(pos.z, 9);
    }
  });
});

describe("approachPitch", () => {
  it("DOES take the short way round, now that a looping ship wraps its pitch", () => {
    // The inverse of what this asserted while pitch was clamped. Free pitch
    // (BUBBLE.md §A) makes −3.0 and 3.0 genuine neighbours 0.28 rad apart, which
    // a ship crosses every revolution of a loop; going "the long way" between
    // them would spin the camera through a whole turn at the top of every loop.
    // The rig feeds this the CANONICAL elevation, bounded by ±π/2, so the two
    // never differ by more than π and the short way is always well defined.
    expect(approachPitch(-3, 3, 1, 1 / 60)).toBe(3);
    const stepped = approachPitch(-3, 3, 0.5, 1 / 60);
    expect(stepped).toBeLessThan(-3); // toward −π and out the other side
    expect(stepped).toBe(approachHeading(-3, 3, 0.5, 1 / 60)); // same rule as yaw now
  });

  it("snaps when lag is 1 and freezes when lag is 0", () => {
    expect(approachPitch(0, 1.2, 1, 1 / 60)).toBe(1.2);
    expect(approachPitch(0, 1.2, 0, 1 / 60)).toBe(0);
  });

  it("is frame-rate independent: two 60 Hz steps ≈ one 30 Hz step", () => {
    const oneBig = approachPitch(0, 1, 0.2, 2 / 60);
    const twoSmall = approachPitch(approachPitch(0, 1, 0.2, 1 / 60), 1, 0.2, 1 / 60);
    expect(twoSmall).toBeCloseTo(oneBig, 9);
  });

  it("converges without overshooting", () => {
    let p = 0;
    for (let i = 0; i < 600; i++) p = approachPitch(p, -1.4, 0.1, 1 / 60);
    expect(p).toBeCloseTo(-1.4, 6);
  });
});

/**
 * The one mapping that silently inverts the whole game if it is wrong. Derived
 * here from the rig's geometry (independently of `chaseCamera.ts`'s reasoning)
 * and matched against the constant the joystick actually uses.
 */
describe("stick-right ⇒ turn sign (FLIGHT.md §4)", () => {
  /** Sign of the nose's screen-space drift when heading increases, under the chase rig. */
  function noseDriftPerHeading(heading: number, beta: number): number {
    const pos = orbitPosition(chaseAlphaFor(heading), beta, 14, ORIGIN);
    const forward = normalize(sub(ORIGIN, pos));
    const right = screenRight(forward);
    const eps = 1e-4;
    const swing = sub(noseDir(heading + eps), noseDir(heading));
    return Math.sign(dot(swing, right));
  }

  it("moves the nose toward screen LEFT as sim heading increases, at every tilt", () => {
    for (const beta of [0.6, 1.0, 1.34, Math.PI / 2 - 0.01]) {
      for (const heading of [0, 1.3, Math.PI, -2.2]) {
        expect(noseDriftPerHeading(heading, beta)).toBe(-1);
      }
    }
  });

  it("therefore maps a stick pushed right to a NEGATIVE turn", () => {
    expect(TURN_SIGN_FOR_SCREEN_RIGHT).toBe(-1);
    // The mapping and the geometry must agree: turn × drift-per-heading > 0
    // means "the nose goes the way the thumb went".
    const turn = turnFromStick(1, 0, 1);
    expect(Math.sign(turn) * noseDriftPerHeading(0, 1.34)).toBe(1);
    expect(Math.sign(turnFromStick(-1, 0, 1)) * noseDriftPerHeading(0, 1.34)).toBe(-1);
  });
});

describe("approachHeading / angleDeltaTo", () => {
  it("takes the short way round a ±π wrap", () => {
    // 3.0 → -3.0 is +0.283 rad the short way, not -6.0.
    expect(angleDeltaTo(3.0, -3.0)).toBeCloseTo(2 * Math.PI - 6.0, 9);
    const next = approachHeading(3.0, -3.0, 0.5, 1 / 60);
    expect(next).toBeGreaterThan(3.0);
  });

  it("snaps when lag is 1 and freezes when lag is 0", () => {
    expect(approachHeading(0, 2, 1, 1 / 60)).toBe(2);
    expect(approachHeading(0, 2, 0, 1 / 60)).toBe(0);
  });

  it("is frame-rate independent: two 60 Hz steps ≈ one 30 Hz step", () => {
    const oneBig = approachHeading(0, 1, 0.2, 2 / 60);
    const twoSmall = approachHeading(approachHeading(0, 1, 0.2, 1 / 60), 1, 0.2, 1 / 60);
    expect(twoSmall).toBeCloseTo(oneBig, 9);
  });

  it("converges on the target without overshooting", () => {
    let h = 0;
    for (let i = 0; i < 600; i++) h = approachHeading(h, 1.2, 0.12, 1 / 60);
    expect(h).toBeCloseTo(1.2, 6);
  });
});

describe("chaseSettingsOf", () => {
  it("falls back to the built-in chase feel when content ships no block", () => {
    expect(chaseSettingsOf(undefined)).toEqual(DEFAULT_CHASE_SETTINGS);
    expect(chaseSettingsOf({} as CameraConfig)).toEqual(DEFAULT_CHASE_SETTINGS);
  });

  it("takes every knob from the camera config's chase block", () => {
    const camera = {
      chase: {
        radius: 20,
        height: 2,
        beta: 1.2,
        yawLag: 0.3,
        pitchLag: 0.4,
        fov: 0.9,
      },
    } as unknown as CameraConfig;
    expect(chaseSettingsOf(camera)).toEqual({
      radius: 20,
      height: 2,
      beta: 1.2,
      yawLag: 0.3,
      pitchLag: 0.4,
      fov: 0.9,
    });
  });

  it("falls back per-field, so a partial chase block still resolves fully", () => {
    const camera = { chase: { radius: 20, height: 2, beta: 1.2, yawLag: 0.3 } } as unknown as CameraConfig;
    expect(chaseSettingsOf(camera).fov).toBe(DEFAULT_CHASE_SETTINGS.fov);
    expect(chaseSettingsOf(camera).pitchLag).toBe(0.3); // omitted ⇒ yawLag
  });

  it("reuses yawLag for an omitted pitchLag, so both axes stay matched", () => {
    const camera = { chase: { yawLag: 0.42 } } as unknown as CameraConfig;
    expect(chaseSettingsOf(camera).pitchLag).toBe(0.42);
    // An explicit value still wins — a pack CAN decouple the two feels.
    const decoupled = { chase: { yawLag: 0.42, pitchLag: 0.05 } } as unknown as CameraConfig;
    expect(chaseSettingsOf(decoupled).pitchLag).toBe(0.05);
  });

});

describe("approachDirection — the frame smoother", () => {
  it("snaps at lag 1, holds at lag 0, and normalizes the blend", () => {
    const cur = { x: 1, y: 0, z: 0 };
    approachDirection(cur, { x: 0, y: 1, z: 0 }, 1, 1 / 60);
    expect(cur).toEqual({ x: 0, y: 1, z: 0 });
    approachDirection(cur, { x: 1, y: 0, z: 0 }, 0, 1 / 60);
    expect(cur).toEqual({ x: 0, y: 1, z: 0 });
    approachDirection(cur, { x: 1, y: 0, z: 0 }, 0.5, 1 / 60);
    expect(Math.hypot(cur.x, cur.y, cur.z)).toBeCloseTo(1, 12);
    expect(cur.x).toBeGreaterThan(0);
    expect(cur.y).toBeLessThan(1);
  });

  it("is frame-rate independent like the scalar smoothers", () => {
    const a = { x: 1, y: 0, z: 0 };
    approachDirection(a, { x: 0, y: 1, z: 0 }, 0.2, 2 / 60);
    const b = { x: 1, y: 0, z: 0 };
    approachDirection(b, { x: 0, y: 1, z: 0 }, 0.2, 1 / 60);
    approachDirection(b, { x: 0, y: 1, z: 0 }, 0.2, 1 / 60);
    // Nlerp of a nlerp is not algebraically identical to one big nlerp — this
    // 90° target is the worst case, far past any real per-frame delta — but the
    // step curve matches to a few percent, which is invisible in motion.
    expect(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)).toBeLessThan(0.05);
  });

  it("snaps to the target through an antipodal (degenerate) blend", () => {
    const cur = { x: 1, y: 0, z: 0 };
    approachDirection(cur, { x: -1, y: 0, z: 0 }, 0.5, 10); // big dt -> t ~ 1, blend ~ 0-length
    expect(Math.hypot(cur.x, cur.y, cur.z)).toBeCloseTo(1, 12);
  });

  it("converges onto the target direction", () => {
    const cur = { x: 1, y: 0, z: 0 };
    for (let i = 0; i < 600; i++) approachDirection(cur, { x: 0, y: 0, z: 1 }, 0.12, 1 / 60);
    expect(cur.z).toBeCloseTo(1, 6);
  });
});
