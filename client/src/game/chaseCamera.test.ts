import { describe, expect, it } from "vitest";
import type { CameraConfig } from "@space-arena/shared";
import {
  angleDeltaTo,
  approachHeading,
  chaseAlphaFor,
  chaseSettingsOf,
  DEFAULT_CHASE_SETTINGS,
  TURN_SIGN_FOR_SCREEN_RIGHT,
} from "./chaseCamera.js";
import { turnFromStick } from "./hud/flightInput.js";

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
      chase: { radius: 20, height: 2, beta: 1.2, yawLag: 0.3, fov: 0.9 },
    } as unknown as CameraConfig;
    expect(chaseSettingsOf(camera)).toEqual({ radius: 20, height: 2, beta: 1.2, yawLag: 0.3, fov: 0.9 });
  });

  it("falls back per-field, so a partial chase block still resolves fully", () => {
    const camera = { chase: { radius: 20, height: 2, beta: 1.2, yawLag: 0.3 } } as unknown as CameraConfig;
    expect(chaseSettingsOf(camera).fov).toBe(DEFAULT_CHASE_SETTINGS.fov);
  });
});
