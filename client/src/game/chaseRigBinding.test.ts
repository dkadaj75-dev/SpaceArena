import { ArcRotateCamera, Matrix, NullEngine, Scene, Vector3 } from "@babylonjs/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chaseOffsetFor, chaseUpFor } from "./chaseCamera.js";

/**
 * **Does Babylon actually build the rig we solved for?** (BUBBLE.md §A)
 *
 * `chaseCamera.ts` is pure math and `screenSteering.test.ts` proves the invariant
 * holds *in that math*. Neither says anything about the BINDING:
 * `ArcRotateCamera` does not accept a pose, it derives its position from
 * `alpha`/`beta` and then rotates the result by `RotationAlign(Y, upVector)`.
 * `TacticalCamera.applyChasePose` inverts that alignment to solve for the orbit
 * angles, and if that inversion is wrong — or if the engine does not transform
 * the way we assume — the real camera sits somewhere other than where the maths
 * says, its screen basis stops being pitch-independent, and left/right starts
 * depending on attitude while every pure-math test still passes.
 *
 * So this drives a REAL `ArcRotateCamera` on a `NullEngine` through the same
 * solve and checks the two things that matter: the camera lands exactly on the
 * intended offset, and its view matrix's screen-right is the pitch-independent
 * vector the invariant depends on.
 */

const BASE_BETA = 1.34;
const RADIUS = 14;
const HEADING = 0.7;
const PITCHES_DEG = [0, 30, -30, 45, -45, 80, -80, 90, -90, 100, -100, 135, -135, 179, -179, 180];

let engine: NullEngine;
let scene: Scene;
let camera: ArcRotateCamera;

beforeAll(() => {
  engine = new NullEngine();
  scene = new Scene(engine);
  camera = new ArcRotateCamera("test", 0, 1, RADIUS, Vector3.Zero(), scene);
});

afterAll(() => {
  scene.dispose();
  engine.dispose();
});

const scratchUp = new Vector3();
const scratchOffset = new Vector3();
const yToUp = new Matrix();
const upToY = new Matrix();
const local = new Vector3();

/** `TacticalCamera.applyChasePose`, verbatim, against the real camera. */
function applyChasePose(heading: number, pitch: number): void {
  chaseUpFor(heading, pitch, scratchUp);
  chaseOffsetFor(heading, pitch, BASE_BETA, RADIUS, scratchOffset);
  camera.upVector = scratchUp;
  Matrix.RotationAlignToRef(Vector3.UpReadOnly, camera.upVector, yToUp);
  yToUp.transposeToRef(upToY);
  Vector3.TransformCoordinatesToRef(scratchOffset, upToY, local);
  camera.radius = RADIUS;
  camera.beta = Math.acos(Math.min(1, Math.max(-1, local.y / RADIUS)));
  camera.alpha = Math.atan2(local.z, local.x);
}

describe("the chase rig as BABYLON actually builds it", () => {
  it("puts the camera exactly on the intended offset at every pitch", () => {
    const failures: string[] = [];
    for (const deg of PITCHES_DEG) {
      const pitch = (deg * Math.PI) / 180;
      applyChasePose(HEADING, pitch);
      camera.getViewMatrix(true); // forces the position recompute
      const want = chaseOffsetFor(HEADING, pitch, BASE_BETA, RADIUS, { x: 0, y: 0, z: 0 });
      const got = camera.position;
      const err = Math.hypot(got.x - want.x, got.y - want.y, got.z - want.z);
      if (err > 1e-6) failures.push(`${deg}deg err=${err.toFixed(4)}`);
    }
    expect(failures).toEqual([]);
  });

  it("keeps screen-right PITCH-INDEPENDENT, which is what the steering invariant rests on", () => {
    // Read screen-right straight out of the view matrix Babylon hands the GPU:
    // for a left-handed view matrix the first COLUMN is the world-space x axis.
    const rights: { deg: number; x: number; y: number; z: number }[] = [];
    for (const deg of PITCHES_DEG) {
      const pitch = (deg * Math.PI) / 180;
      applyChasePose(HEADING, pitch);
      const m = camera.getViewMatrix(true).m;
      rights.push({ deg, x: m[0]!, y: m[4]!, z: m[8]! });
    }
    const want = { x: Math.sin(HEADING), y: 0, z: -Math.cos(HEADING) };
    const failures: string[] = [];
    for (const r of rights) {
      const err = Math.hypot(r.x - want.x, r.y - want.y, r.z - want.z);
      if (err > 1e-5) failures.push(`${r.deg}deg -> (${r.x.toFixed(3)},${r.y.toFixed(3)},${r.z.toFixed(3)})`);
    }
    expect(failures).toEqual([]);
  });

  it("rolls the view: screen-UP tracks the ship's own up, orthogonalized", () => {
    // The other half of the rolled rig. `LookAtLH` sets `yaxis = cross(zaxis,
    // xaxis)`, i.e. the supplied up Gram-Schmidt'd against the view axis — and
    // the view axis is NOT the nose, it is tilted off it by the base beta. So the
    // drawn up is the ship's up with that tilt removed, not the raw `chaseUpFor`.
    for (const deg of [0, 90, 180, -90, 135]) {
      const pitch = (deg * Math.PI) / 180;
      applyChasePose(HEADING, pitch);
      const m = camera.getViewMatrix(true).m;
      const up = { x: m[1]!, y: m[5]!, z: m[9]! };
      const fwd = { x: m[2]!, y: m[6]!, z: m[10]! };
      const shipUp = chaseUpFor(HEADING, pitch, { x: 0, y: 0, z: 0 });
      const along = shipUp.x * fwd.x + shipUp.y * fwd.y + shipUp.z * fwd.z;
      const ortho = { x: shipUp.x - along * fwd.x, y: shipUp.y - along * fwd.y, z: shipUp.z - along * fwd.z };
      const len = Math.hypot(ortho.x, ortho.y, ortho.z);
      expect(up.x).toBeCloseTo(ortho.x / len, 5);
      expect(up.y).toBeCloseTo(ortho.y / len, 5);
      expect(up.z).toBeCloseTo(ortho.z / len, 5);
    }
  });

  it("actually INVERTS the horizon over the top, rather than pinning it to world up", () => {
    // The one-line statement of "the camera rolls": upright the view's up has a
    // positive world-Y component, inverted it is negative. A world-up rig could
    // never produce the second.
    const upAt = (deg: number): number => {
      applyChasePose(HEADING, (deg * Math.PI) / 180);
      return camera.getViewMatrix(true).m[5]!;
    };
    expect(upAt(0)).toBeGreaterThan(0.9);
    expect(upAt(180)).toBeLessThan(-0.9);
    expect(upAt(135)).toBeLessThan(0);
  });
});
