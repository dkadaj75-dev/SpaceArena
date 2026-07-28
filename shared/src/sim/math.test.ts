import { describe, expect, it } from "vitest";
import {
  advancePitch,
  attitudeNear,
  canonicalAttitude,
  facingVec,
  mirrorAttitude,
  wrapAngle,
  type Attitude,
} from "./math.js";

/**
 * The attitude algebra free-pitch flight rests on (BUBBLE.md §A). Every helper
 * here exists because `(heading, pitch) -> facing` is two-to-one once pitch can
 * leave [-PI/2, PI/2], so "the same nose direction" and "the same pair of
 * numbers" stop being the same statement.
 */

const scratch: Attitude = { heading: 0, pitch: 0 };

function dirOf(heading: number, pitch: number): { x: number; y: number; z: number } {
  return facingVec(heading, pitch, { x: 0, y: 0, z: 0 });
}

function expectSameDirection(a: Attitude, heading: number, pitch: number): void {
  const want = dirOf(heading, pitch);
  const got = dirOf(a.heading, a.pitch);
  expect(got.x).toBeCloseTo(want.x, 12);
  expect(got.y).toBeCloseTo(want.y, 12);
  expect(got.z).toBeCloseTo(want.z, 12);
}

describe("mirrorAttitude", () => {
  it("names the same direction with the other pair, for any pitch", () => {
    for (const heading of [0, 0.4, -2.2, 3.0]) {
      for (const pitch of [0, 0.3, -1.2, 1.9, -2.7, Math.PI / 2, Math.PI]) {
        expectSameDirection(mirrorAttitude(heading, pitch, scratch), heading, pitch);
      }
    }
  });

  it("is an involution — there are exactly TWO names, not a chain of them", () => {
    const once = mirrorAttitude(0.4, 2.6, { heading: 0, pitch: 0 });
    const twice = mirrorAttitude(once.heading, once.pitch, scratch);
    expect(twice.heading).toBeCloseTo(wrapAngle(0.4), 12);
    expect(twice.pitch).toBeCloseTo(2.6, 12);
  });

  it("flips the horizontal component's sense, which is what inversion means", () => {
    const m = mirrorAttitude(0, 0.5, scratch);
    // Upright at heading 0 the nose travels toward +X; the mirror spells that as
    // heading PI with an INVERTED pitch, whose negative cosine undoes the flip.
    expect(m.heading).toBeCloseTo(Math.PI, 12);
    expect(Math.cos(m.pitch)).toBeLessThan(0);
  });
});

describe("canonicalAttitude", () => {
  it("folds pitch into [-PI/2, PI/2] without moving the nose", () => {
    for (const pitch of [-3.0, -2.0, -1.0, 0, 1.0, 2.0, 3.0]) {
      const c = canonicalAttitude(1.1, pitch, scratch);
      expect(Math.abs(c.pitch)).toBeLessThanOrEqual(Math.PI / 2 + 1e-12);
      expectSameDirection(c, 1.1, pitch);
    }
  });

  it("leaves an already-upright attitude alone", () => {
    const c = canonicalAttitude(0.7, 1.2, scratch);
    expect(c.heading).toBeCloseTo(0.7, 12);
    expect(c.pitch).toBeCloseTo(1.2, 12);
  });

  it("is CONTINUOUS in pitch through the pole, and discontinuous in heading", () => {
    // This asymmetry is the whole reason the chase camera can follow a loop with
    // a world-up rig: the elevation it tilts to rises to vertical and comes back
    // down, while the azimuth flips by PI at the top — a swing that costs almost
    // no camera movement precisely because it happens at the pole.
    const below = canonicalAttitude(0.5, Math.PI / 2 - 1e-4, { heading: 0, pitch: 0 });
    const above = canonicalAttitude(0.5, Math.PI / 2 + 1e-4, scratch);
    expect(Math.abs(above.pitch - below.pitch)).toBeLessThan(1e-3);
    expect(Math.abs(wrapAngle(above.heading - below.heading))).toBeCloseTo(Math.PI, 6);
  });
});

describe("attitudeNear", () => {
  it("answers the canonical spelling while the reference is upright", () => {
    for (const ref of [-1.4, -0.5, 0, 0.5, 1.4]) {
      for (const pitch of [-1.2, 0, 0.9]) {
        const a = attitudeNear(0.6, pitch, ref, scratch);
        expect(a.pitch).toBeCloseTo(pitch, 12);
        expect(a.heading).toBeCloseTo(0.6, 12);
      }
    }
  });

  it("answers the INVERTED spelling while the reference is inverted", () => {
    // A ship at pitch 2.6 asked to point at an elevation of -0.54 should read
    // that as "keep flying inverted, drop the nose a little", not as a PI heading
    // slam plus a 3-radian pitch change.
    const a = attitudeNear(0.4 + Math.PI, -0.5415, 2.6, scratch);
    expect(Math.cos(a.pitch)).toBeLessThan(0);
    expect(Math.abs(wrapAngle(a.pitch - 2.6))).toBeLessThan(Math.PI / 2);
  });

  it("always names the SAME direction whichever spelling it picks", () => {
    for (const ref of [-2.9, -1.0, 0, 1.0, 2.9, Math.PI]) {
      for (const pitch of [-1.3, -0.2, 0.8, 1.5]) {
        expectSameDirection(attitudeNear(-1.7, pitch, ref, scratch), -1.7, pitch);
      }
    }
  });

  it("never travels further than the alternative would", () => {
    for (const ref of [-3.0, -1.5, 0, 1.5, 3.0]) {
      const chosen = attitudeNear(0.2, 0.9, ref, { heading: 0, pitch: 0 });
      const other = mirrorAttitude(chosen.heading, chosen.pitch, scratch);
      expect(Math.abs(wrapAngle(chosen.pitch - ref))).toBeLessThanOrEqual(
        Math.abs(wrapAngle(other.pitch - ref)) + 1e-12,
      );
    }
  });
});

describe("advancePitch", () => {
  it("wraps into (-PI, PI] with no clamp, so the nose can go round forever", () => {
    let pitch = 0;
    for (let i = 0; i < 1000; i++) {
      pitch = advancePitch(pitch, 0.05, null);
      expect(pitch).toBeGreaterThan(-Math.PI);
      expect(pitch).toBeLessThanOrEqual(Math.PI);
    }
    // 1000 steps of 0.05 is 50 rad — just under eight full revolutions.
    expect(pitch).toBeCloseTo(wrapAngle(50), 9);
  });

  it("pins at the legacy clamp when one is supplied", () => {
    let pitch = 0;
    for (let i = 0; i < 1000; i++) pitch = advancePitch(pitch, 0.05, 1.4);
    expect(pitch).toBe(1.4);
    let down = 0;
    for (let i = 0; i < 1000; i++) down = advancePitch(down, -0.05, 1.4);
    expect(down).toBe(-1.4);
  });
});
