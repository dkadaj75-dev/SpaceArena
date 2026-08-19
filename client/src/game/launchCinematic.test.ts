import type { ShipSnapshot } from "@space-arena/shared";
import { describe, expect, it } from "vitest";
import {
  LAUNCH_SHOT,
  LaunchCinematic,
  launchShotPose,
  newLaunchShotPose,
} from "./launchCinematic.js";
import type { TacticalCamera } from "./TacticalCamera.js";

interface Vec3 { x: number; y: number; z: number }

/** A pad on the shipped CTF line: heading +π/2, so the bay opens toward +Z. */
const PAD: Vec3 = { x: -52, y: 8, z: -310 };
const HEADING = Math.PI / 2;

function ship(overrides: Partial<ShipSnapshot> = {}): ShipSnapshot {
  return {
    id: 7,
    team: 0,
    pos: { ...PAD },
    heading: HEADING,
    pitch: 0,
    up: { x: 0, y: 1, z: 0 },
    hull: 100,
    hullMax: 100,
    targetId: null,
    launchHold: 3,
    launchLocked: true,
    throttle: 0,
    lockProgress: 0,
    locked: false,
    modules: [],
    ...overrides,
  };
}

/** Records what the rig was asked to do, without standing up Babylon. */
function fakeCamera(): TacticalCamera & { shots: Array<{ eye: Vec3; target: Vec3 } | null> } {
  const shots: Array<{ eye: Vec3; target: Vec3 } | null> = [];
  return {
    shots,
    setCinematicShot(eye: Vec3 | null, target?: Vec3) {
      shots.push(eye ? { eye: { ...eye }, target: { ...target! } } : null);
    },
  } as unknown as TacticalCamera & { shots: Array<{ eye: Vec3; target: Vec3 } | null> };
}

describe("launchShotPose", () => {
  /**
   * The composition the shot exists for: inside the bay, behind and above the
   * pad, aimed past the ship at the opening. Every axis is checked against the
   * pad frame rather than against literals, so a heading change cannot pass by
   * accident.
   */
  it("puts the eye in the rear corner above the pad and aims out the opening", () => {
    const out = launchShotPose(PAD, HEADING, PAD, 0, newLaunchShotPose());
    // Heading +π/2 ⇒ forward is +Z and screen-right (Y × F) is +X.
    expect(out.eye.z).toBeCloseTo(PAD.z - LAUNCH_SHOT.back, 5);
    expect(out.eye.x).toBeCloseTo(PAD.x + LAUNCH_SHOT.side, 5);
    expect(out.eye.y).toBeCloseTo(PAD.y + LAUNCH_SHOT.up, 5);
    // Aim is past the ship, toward the mouth — never behind it.
    expect(out.target.z).toBeCloseTo(PAD.z + LAUNCH_SHOT.lookAhead, 5);
    expect(out.target.x).toBeCloseTo(PAD.x, 5);
  });

  /**
   * The regression this file exists for: a shot tuned to the model's BOUNDING
   * BOX rather than its interior put the camera inside the hangar ceiling.
   *
   * The bounds below are measured — rays cast from a shipped pad against
   * `prop.ctf-hangar-bay`'s collision mesh — and each keeps a unit of margin
   * off the measured surface, so a future bay that is tighter than the shipped
   * one fails here rather than in someone's match.
   */
  it("stays inside the bay's MEASURED interior, at every point of the push-in", () => {
    /** Ray-probed clearances from the pad, in world units. */
    const INTERIOR = { ceiling: 4.07, deck: 2.75, side: 8.1, rear: 3.5 };
    const MARGIN = 1;
    const out = newLaunchShotPose();
    for (const sec of [0, 0.5, 1, 2, LAUNCH_SHOT.pushInSec, 10]) {
      launchShotPose(PAD, HEADING, PAD, sec, out);
      expect(Math.abs(out.eye.x - PAD.x)).toBeLessThan(INTERIOR.side - MARGIN);
      expect(out.eye.y - PAD.y).toBeLessThan(INTERIOR.ceiling - MARGIN);
      expect(out.eye.y - PAD.y).toBeGreaterThan(-(INTERIOR.deck - MARGIN));
      expect(PAD.z - out.eye.z).toBeLessThan(INTERIOR.rear - MARGIN);
      // Behind the ship, not in front of it — the shot looks down the bay.
      expect(PAD.z - out.eye.z).toBeGreaterThan(0);
    }
  });

  /**
   * The eye is close enough that the ship and the bay mouth are ~55° apart, so
   * the framing only works on the widened cinematic FOV. Pinned here because the
   * two numbers are set in different files and neither reads as load-bearing on
   * its own.
   */
  it("keeps the ship and the bay mouth inside the cinematic half-FOV", () => {
    /** `TacticalCamera`: default 0.8 × CINEMATIC_FOV_SCALE, vertical-fixed. */
    const halfFov = 1.2 / 2;
    const angleTo = (from: Vec3, aim: Vec3, at: Vec3): number => {
      const v = [aim.x - from.x, aim.y - from.y, aim.z - from.z];
      const w = [at.x - from.x, at.y - from.y, at.z - from.z];
      const dot = v[0]! * w[0]! + v[1]! * w[1]! + v[2]! * w[2]!;
      return Math.acos(dot / (Math.hypot(...v) * Math.hypot(...w)));
    };
    /** The mouth is 14 down the bay axis from the pad. */
    const mouth = { x: PAD.x, y: PAD.y, z: PAD.z + 14 };
    const out = newLaunchShotPose();
    for (const sec of [0, 1.5, LAUNCH_SHOT.pushInSec]) {
      launchShotPose(PAD, HEADING, PAD, sec, out);
      expect(angleTo(out.eye, out.target, PAD)).toBeLessThan(halfFov);
      expect(angleTo(out.eye, out.target, mouth)).toBeLessThan(halfFov);
    }
  });

  it("dollies in monotonically and then holds", () => {
    const out = newLaunchShotPose();
    const distanceAt = (sec: number): number => {
      launchShotPose(PAD, HEADING, PAD, sec, out);
      return Math.hypot(out.eye.x - PAD.x, out.eye.y - PAD.y, out.eye.z - PAD.z);
    };
    const samples = [0, 0.5, 1, 2, 3, LAUNCH_SHOT.pushInSec].map(distanceAt);
    for (let i = 1; i < samples.length; i++) expect(samples[i]!).toBeLessThan(samples[i - 1]!);
    // Past the push-in it is a locked-off shot, not a slow crash into the pad.
    expect(distanceAt(LAUNCH_SHOT.pushInSec + 5)).toBeCloseTo(samples.at(-1)!, 6);
  });

  it("follows the ship out of the bay while the eye stays put", () => {
    const out = newLaunchShotPose();
    launchShotPose(PAD, HEADING, PAD, 2, out);
    const parked = { ...out.eye };
    // 20 units down the bay axis — roughly where the run ends.
    launchShotPose(PAD, HEADING, { x: PAD.x, y: PAD.y, z: PAD.z + 20 }, 2, out);
    expect(out.eye).toEqual(parked);
    expect(out.target.z).toBeCloseTo(PAD.z + 20 + LAUNCH_SHOT.lookAhead, 5);
  });

  it("rotates the whole rig with the pad heading", () => {
    // The opposite line: heading −π/2 opens toward −Z, so the eye goes BEHIND
    // in +Z and the corner swaps sides.
    const out = launchShotPose(PAD, -Math.PI / 2, PAD, 0, newLaunchShotPose());
    expect(out.eye.z).toBeCloseTo(PAD.z + LAUNCH_SHOT.back, 5);
    expect(out.eye.x).toBeCloseTo(PAD.x - LAUNCH_SHOT.side, 5);
    expect(out.target.z).toBeCloseTo(PAD.z - LAUNCH_SHOT.lookAhead, 5);
  });

  it("ignores an authored pad pitch — the bay is a horizontal tube", () => {
    const level = launchShotPose(PAD, HEADING, PAD, 0, newLaunchShotPose());
    // The pose takes a heading only; a pitched pad cannot tilt the shot because
    // there is no pitch input to tilt it with.
    expect(level.eye.y - PAD.y).toBeCloseTo(LAUNCH_SHOT.up, 5);
  });
});

describe("LaunchCinematic", () => {
  it("runs while the sim owns the hull and cuts back the frame control returns", () => {
    const camera = fakeCamera();
    const director = new LaunchCinematic(camera);

    director.update(ship(), PAD, 16);
    expect(director.active).toBe(true);
    expect(camera.shots.at(-1)).not.toBeNull();

    director.update(ship({ launchHold: 0, launchLocked: false }), PAD, 16);
    expect(director.active).toBe(false);
    expect(camera.shots.at(-1)).toBeNull();
  });

  it("holds the PAD pose after the ship has left it", () => {
    const camera = fakeCamera();
    const director = new LaunchCinematic(camera);
    director.update(ship(), PAD, 16);
    const eye = { ...camera.shots.at(-1)!.eye };

    // Mid-run: the hull has moved 12 units and its snapshot pose with it. The
    // shot must still be anchored to the bay, not dragged along by the ship.
    const flown = { x: PAD.x, y: PAD.y, z: PAD.z + 12 };
    director.update(ship({ pos: flown, throttle: 1 }), flown, 16);
    const after = camera.shots.at(-1)!;
    // Only the push-in has moved the eye, and only toward the pad.
    expect(Math.hypot(after.eye.x - eye.x, after.eye.y - eye.y, after.eye.z - eye.z)).toBeLessThan(0.1);
    expect(after.target.z).toBeCloseTo(flown.z + LAUNCH_SHOT.lookAhead, 5);
  });

  /**
   * The opening wave's countdown is the MATCH countdown, so those ships fly
   * their run with `launchHold` already at 0 — keying the shot off the hold
   * would skip the establishing shot for every match start.
   */
  it("runs for an opening-wave spawn, which has no visible hold at all", () => {
    const camera = fakeCamera();
    const director = new LaunchCinematic(camera);
    director.update(ship({ launchHold: 0, launchLocked: true }), PAD, 16);
    expect(director.active).toBe(true);
  });

  it("cues the thrust exactly once, when throttle leaves zero", () => {
    const played: string[] = [];
    const director = new LaunchCinematic(fakeCamera(), (id) => played.push(id));
    // Pinned half: silent.
    for (let i = 0; i < 3; i++) director.update(ship({ throttle: 0 }), PAD, 16);
    expect(played).toEqual([]);
    // The run.
    for (let i = 0; i < 5; i++) director.update(ship({ throttle: 1 }), PAD, 16);
    expect(played).toEqual(["launch_thrust"]);
  });

  it("re-arms for the next respawn", () => {
    const played: string[] = [];
    const camera = fakeCamera();
    const director = new LaunchCinematic(camera, (id) => played.push(id));
    director.update(ship({ throttle: 1 }), PAD, 16);
    director.update(null, PAD, 16);
    director.update(ship({ throttle: 1 }), PAD, 16);
    expect(played).toEqual(["launch_thrust", "launch_thrust"]);
    expect(director.active).toBe(true);
  });

  it("tears the shot down when the player dies mid-sequence", () => {
    const camera = fakeCamera();
    const director = new LaunchCinematic(camera);
    director.update(ship(), PAD, 16);
    director.update(undefined, PAD, 16);
    expect(camera.shots.at(-1)).toBeNull();
    // Idempotent: a dead player is many frames, not one.
    const count = camera.shots.length;
    director.update(undefined, PAD, 16);
    expect(camera.shots.length).toBe(count);
  });
});
