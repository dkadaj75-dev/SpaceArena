import { describe, expect, it } from "vitest";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core";
import { upFromAttitude } from "@space-arena/shared";
import {
  approachRoll,
  bankRollFor,
  headingRatePerSec,
  meshPitchFor,
  meshYawFor,
  pitchForDirection,
  yawForDirection,
} from "./shipOrientation.js";

/**
 * BUBBLE.md §C — mesh orientation. The assertions run the angles through
 * Babylon's OWN rotation composition (`RotationYawPitchRoll`, the same one
 * `node.rotation` uses) and check where the model's nose and right wing actually
 * end up, so a sign convention cannot agree with itself and still be wrong.
 */
function poseNose(heading: number, pitch: number, roll = 0): Vector3 {
  const m = Matrix.RotationYawPitchRoll(meshYawFor(heading), meshPitchFor(pitch), roll);
  return Vector3.TransformCoordinates(new Vector3(0, 0, 1), m);
}

function poseRightWing(heading: number, pitch: number, roll: number): Vector3 {
  const m = Matrix.RotationYawPitchRoll(meshYawFor(heading), meshPitchFor(pitch), roll);
  return Vector3.TransformCoordinates(new Vector3(1, 0, 0), m);
}

/** The sim's own 3D facing (BUBBLE.md §A) — what the hull must be aimed along. */
function simFacing(heading: number, pitch: number): Vector3 {
  return new Vector3(
    Math.cos(pitch) * Math.cos(heading),
    Math.sin(pitch),
    Math.cos(pitch) * Math.sin(heading),
  );
}

/**
 * Babylon stores `Vector3` components as float32, so a matrix round-trip lands
 * within ~1e-7 of the double-precision answer, never closer. Six decimals is
 * therefore the tightest honest tolerance for anything that went through one.
 */
const POSE_DIGITS = 6;

/** Shortest signed distance between two angles — π and −π are the same direction. */
function angleGap(a: number, b: number): number {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d <= -Math.PI) d += Math.PI * 2;
  return d;
}

describe("mesh yaw + pitch", () => {
  it("aims the model's +Z nose along the sim's 3D facing vector", () => {
    for (const heading of [0, 0.8, Math.PI / 2, 2.7, Math.PI, -1.1]) {
      for (const pitch of [-1.4, -0.6, 0, 0.6, 1.4]) {
        const nose = poseNose(heading, pitch);
        const want = simFacing(heading, pitch);
        expect(nose.x).toBeCloseTo(want.x, POSE_DIGITS);
        expect(nose.y).toBeCloseTo(want.y, POSE_DIGITS);
        expect(nose.z).toBeCloseTo(want.z, POSE_DIGITS);
      }
    }
  });

  it("raises the nose for a POSITIVE sim pitch", () => {
    // The negation that makes this true is the whole content of meshPitchFor:
    // Babylon's +x rotation dives, the sim's +pitch climbs.
    expect(poseNose(0, 0.5).y).toBeGreaterThan(0);
    expect(poseNose(0, -0.5).y).toBeLessThan(0);
    expect(meshPitchFor(0.5)).toBe(-0.5);
  });

  it("keeps the FLIGHT.md yaw mapping intact", () => {
    expect(meshYawFor(0)).toBeCloseTo(Math.PI / 2, 9);
    const nose = poseNose(Math.PI / 2, 0);
    expect(nose.x).toBeCloseTo(0, POSE_DIGITS);
    expect(nose.z).toBeCloseTo(1, POSE_DIGITS);
  });

  it("leaves the nose where it is when a bank rolls the hull", () => {
    // Roll is decoration: it must not steer. Same nose, rolled or not.
    for (const roll of [-0.5, 0.5]) {
      const rolled = poseNose(1.2, 0.4, roll);
      const level = poseNose(1.2, 0.4, 0);
      expect(rolled.x).toBeCloseTo(level.x, POSE_DIGITS);
      expect(rolled.y).toBeCloseTo(level.y, POSE_DIGITS);
      expect(rolled.z).toBeCloseTo(level.z, POSE_DIGITS);
    }
  });
});

describe("bankRollFor", () => {
  it("leans INTO the turn: a positive heading rate lifts the right wing", () => {
    // Heading grows counter-clockwise, which sweeps the nose toward screen LEFT
    // under the chase rig, and a lifted right wing IS a left bank.
    const roll = bankRollFor(1.5, 0.45, 1.5);
    expect(roll).toBeCloseTo(0.45, 9);
    expect(poseRightWing(0, 0, roll).y).toBeGreaterThan(0);
    expect(poseRightWing(0, 0, bankRollFor(-1.5, 0.45, 1.5)).y).toBeLessThan(0);
  });

  it("scales linearly up to the reference rate and saturates past it", () => {
    expect(bankRollFor(0, 0.45, 1.5)).toBe(0);
    expect(bankRollFor(0.75, 0.45, 1.5)).toBeCloseTo(0.225, 9);
    expect(bankRollFor(1.5, 0.45, 1.5)).toBeCloseTo(0.45, 9);
    expect(bankRollFor(50, 0.45, 1.5)).toBeCloseTo(0.45, 9);
    expect(bankRollFor(-50, 0.45, 1.5)).toBeCloseTo(-0.45, 9);
  });

  it("is switched off by a zero max (or a degenerate reference rate)", () => {
    expect(bankRollFor(3, 0, 1.5)).toBe(0);
    expect(bankRollFor(3, 0.45, 0)).toBe(0);
  });
});

describe("headingRatePerSec", () => {
  it("reports the signed rate over the snapshot interval", () => {
    expect(headingRatePerSec(0, 0.1, 0.1)).toBeCloseTo(1, 9);
    expect(headingRatePerSec(0.1, 0, 0.1)).toBeCloseTo(-1, 9);
  });

  it("takes the short way round a ±π wrap, so a wrap is not a violent turn", () => {
    // 3.1 → -3.1 is a small turn the same way heading was already going.
    const rate = headingRatePerSec(3.1, -3.1, 1 / 30);
    expect(rate).toBeGreaterThan(0);
    expect(Math.abs(rate)).toBeLessThan(3);
  });

  it("reports 0 for a non-advancing clock (the same snapshot twice, a paused sim)", () => {
    expect(headingRatePerSec(0, 1, 0)).toBe(0);
    expect(headingRatePerSec(0, 1, -1)).toBe(0);
  });
});

describe("approachRoll", () => {
  it("snaps at lag 1 and freezes at lag 0", () => {
    expect(approachRoll(0, 0.4, 1, 1 / 60)).toBe(0.4);
    expect(approachRoll(0, 0.4, 0, 1 / 60)).toBe(0);
  });

  it("is frame-rate independent", () => {
    const oneBig = approachRoll(0, 0.4, 0.2, 2 / 60);
    const twoSmall = approachRoll(approachRoll(0, 0.4, 0.2, 1 / 60), 0.4, 0.2, 1 / 60);
    expect(twoSmall).toBeCloseTo(oneBig, 9);
  });

  it("converges on the commanded bank without overshooting", () => {
    let roll = 0;
    for (let i = 0; i < 600; i++) roll = approachRoll(roll, -0.45, 0.12, 1 / 60);
    expect(roll).toBeCloseTo(-0.45, 6);
  });
});

describe("direction-based orientation (projectiles, beams)", () => {
  it("aims the +Z nose along an arbitrary 3D direction", () => {
    const dirs = [
      { x: 1, y: 0, z: 0 },
      { x: 0, y: 0, z: 1 },
      { x: -3, y: 2, z: 5 },
      { x: 0.5, y: -4, z: -0.25 },
    ];
    for (const d of dirs) {
      const m = Matrix.RotationYawPitchRoll(yawForDirection(d.x, d.z), pitchForDirection(d.x, d.y, d.z), 0);
      const nose = Vector3.TransformCoordinates(new Vector3(0, 0, 1), m);
      const want = new Vector3(d.x, d.y, d.z).normalize();
      expect(nose.x).toBeCloseTo(want.x, POSE_DIGITS);
      expect(nose.y).toBeCloseTo(want.y, POSE_DIGITS);
      expect(nose.z).toBeCloseTo(want.z, POSE_DIGITS);
    }
  });

  it("points straight up and straight down without degenerating", () => {
    const up = Matrix.RotationYawPitchRoll(yawForDirection(0, 0), pitchForDirection(0, 1, 0), 0);
    expect(Vector3.TransformCoordinates(new Vector3(0, 0, 1), up).y).toBeCloseTo(1, POSE_DIGITS);
    const down = Matrix.RotationYawPitchRoll(yawForDirection(0, 0), pitchForDirection(0, -1, 0), 0);
    expect(Vector3.TransformCoordinates(new Vector3(0, 0, 1), down).y).toBeCloseTo(-1, POSE_DIGITS);
  });

  it("reports level for a zero-length direction instead of NaN", () => {
    expect(pitchForDirection(0, 0, 0)).toBe(0);
    expect(Number.isNaN(yawForDirection(0, 0))).toBe(false);
  });

  it("agrees with the ship mapping for a purely horizontal direction", () => {
    // A shot fired in level flight must line up with the hull that fired it.
    // Compared modulo 2π: `atan2` folds into (−π, π] and `meshYawFor` does not
    // wrap at all, so the two can differ by a full turn and mean the same pose.
    for (const heading of [0, 1.2, -2.5]) {
      const dx = Math.cos(heading);
      const dz = Math.sin(heading);
      expect(angleGap(yawForDirection(dx, dz), meshYawFor(heading))).toBeCloseTo(0, 9);
      expect(pitchForDirection(dx, 0, dz)).toBeCloseTo(0, 9);
    }
  });
});

/**
 * Flight-frame amendment (2026-07-30): ships are posed from the authoritative
 * forward/up frame via `Quaternion.FromLookDirectionRH`, with the cosmetic bank
 * tilting the up around the nose (EntityView.syncShips). For a roll-less frame
 * that quaternion must reproduce EXACTLY the pose the legacy Euler composition
 * above describes — same nose, same wings, at every attitude and bank. This is
 * the equivalence that makes the Euler helpers a valid convention reference.
 */
describe("frame-quaternion pose ≡ legacy Euler pose (roll-less frames)", () => {
  function framePose(heading: number, pitch: number, roll: number): Matrix {
    const n = simFacing(heading, pitch);
    const u = upFromAttitude(heading, pitch, { x: 0, y: 0, z: 0 });
    // Banked up = U·cos r + (N×U)·sin r — the same formula EntityView applies.
    const cr = Math.cos(roll);
    const sr = Math.sin(roll);
    const lx = n.y * u.z - n.z * u.y;
    const ly = n.z * u.x - n.x * u.z;
    const lz = n.x * u.y - n.y * u.x;
    const banked = new Vector3(u.x * cr + lx * sr, u.y * cr + ly * sr, u.z * cr + lz * sr);
    // RH despite the LH engine: see EntityView.syncShips — Babylon's LH
    // variant aims -Z at the direction under the row-vector convention.
    const q = Quaternion.FromLookDirectionRH(n, banked);
    const m = new Matrix();
    Matrix.FromQuaternionToRef(q, m);
    return m;
  }

  it("matches nose and right wing at every attitude and bank, inverted included", () => {
    for (const heading of [0, 0.7, -2.1, Math.PI]) {
      for (const pitch of [0, 0.6, -1.2, 1.5708, 2.6, -3.0]) {
        for (const roll of [0, 0.35, -0.5]) {
          const m = framePose(heading, pitch, roll);
          const nose = Vector3.TransformCoordinates(new Vector3(0, 0, 1), m);
          const wing = Vector3.TransformCoordinates(new Vector3(1, 0, 0), m);
          const eulerNose = poseNose(heading, pitch, roll);
          const eulerWing = poseRightWing(heading, pitch, roll);
          expect(nose.x).toBeCloseTo(eulerNose.x, POSE_DIGITS);
          expect(nose.y).toBeCloseTo(eulerNose.y, POSE_DIGITS);
          expect(nose.z).toBeCloseTo(eulerNose.z, POSE_DIGITS);
          expect(wing.x).toBeCloseTo(eulerWing.x, POSE_DIGITS);
          expect(wing.y).toBeCloseTo(eulerWing.y, POSE_DIGITS);
          expect(wing.z).toBeCloseTo(eulerWing.z, POSE_DIGITS);
        }
      }
    }
  });
});
