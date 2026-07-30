import { describe, expect, it } from "vitest";
import { upFromAttitude } from "@space-arena/shared";
import {
  projectRadarPoint,
  radarLocalPoint,
  type RadarLocalPoint,
  type RadarProjectedPoint,
} from "./radarProjection.js";

const local: RadarLocalPoint = { right: 0, up: 0, forward: 0 };

/** The roll-less up for an attitude — what the sim replicates for an unrolled ship. */
function derivedUp(heading: number, pitch: number): { x: number; y: number; z: number } {
  return upFromAttitude(heading, pitch, { x: 0, y: 0, z: 0 });
}
const projected: RadarProjectedPoint = { x: 0, baseY: 0, tipY: 0, outOfRange: false };
const geometry = {
  centreX: 64,
  centreY: 70,
  radiusX: 52,
  radiusY: 26,
  rangeUnits: 100,
  elevationRad: Math.PI / 6,
  altitudeScale: 0.65,
  altitudeStemMaxPx: 20,
};

describe("3D radar projection", () => {
  it("maps the player to centre and forward/right contacts to the tilted plane", () => {
    radarLocalPoint(0, 0, 0, 0, 0, derivedUp(0, 0), local);
    projectRadarPoint(local, geometry, projected);
    expect(projected).toMatchObject({ x: 64, baseY: 70, tipY: 70, outOfRange: false });

    // Heading 0 faces +X; screen-right is -Z.
    radarLocalPoint(50, 0, 0, 0, 0, derivedUp(0, 0), local);
    projectRadarPoint(local, geometry, projected);
    expect(projected.x).toBeCloseTo(64);
    expect(projected.baseY).toBeLessThan(70);
    radarLocalPoint(0, 0, -50, 0, 0, derivedUp(0, 0), local);
    projectRadarPoint(local, geometry, projected);
    expect(projected.x).toBeGreaterThan(64);
  });

  it("uses ship-relative up through vertical and inverted attitudes", () => {
    // Nose vertical: world +X is ship-down, while world +Y is forward.
    radarLocalPoint(10, 0, 0, 0, Math.PI / 2, derivedUp(0, Math.PI / 2), local);
    expect(local.up).toBeCloseTo(-10, 8);
    expect(local.forward).toBeCloseTo(0, 8);
    radarLocalPoint(0, 10, 0, 0, Math.PI / 2, derivedUp(0, Math.PI / 2), local);
    expect(local.forward).toBeCloseTo(10, 8);

    // Fully inverted: world +Y is ship-down, not "above" on the radar.
    radarLocalPoint(0, 10, 0, 0, Math.PI, derivedUp(0, Math.PI), local);
    expect(local.up).toBeCloseTo(-10, 8);
  });

  it("draws altitude as a clamped lollipop stem and pins distant contacts", () => {
    radarLocalPoint(0, 1000, 0, 0, 0, derivedUp(0, 0), local);
    projectRadarPoint(local, geometry, projected);
    expect(projected.tipY - projected.baseY).toBe(-20);

    radarLocalPoint(1000, 0, -1000, 0, 0, derivedUp(0, 0), local);
    projectRadarPoint(local, geometry, projected);
    expect(projected.outOfRange).toBe(true);
    const ellipse =
      ((projected.x - geometry.centreX) / geometry.radiusX) ** 2 +
      ((projected.baseY - geometry.centreY) / geometry.radiusY) ** 2;
    expect(ellipse).toBeCloseTo(1, 8);
  });

  it("projects in the ship's ACTUAL frame when the hull is rolled (flight-frame handoff)", () => {
    // Nose +X, hull rolled 90 deg so the ship's up points at world +Z. A contact
    // at world +Y is then off the ship's RIGHT wingtip plane, not "above" it -
    // the display right is U x N = (0, 1, 0).
    const rolledUp = { x: 0, y: 0, z: 1 };
    radarLocalPoint(0, 10, 0, 0, 0, rolledUp, local);
    expect(local.right).toBeCloseTo(10, 8);
    expect(local.up).toBeCloseTo(0, 8);
    expect(local.forward).toBeCloseTo(0, 8);
  });

  it("stays finite across heading wrap", () => {
    for (const heading of [-Math.PI, Math.PI, Math.PI * 3, -Math.PI * 3]) {
      radarLocalPoint(12, -4, 30, heading, 2.4, derivedUp(heading, 2.4), local);
      projectRadarPoint(local, geometry, projected);
      expect(Number.isFinite(projected.x)).toBe(true);
      expect(Number.isFinite(projected.tipY)).toBe(true);
    }
  });
});
