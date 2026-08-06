import { NullEngine, Scene, Vector3 } from "@babylonjs/core";
import {
  EventBus,
  type CameraConfig,
  type ConfigEvents,
  type ConfigService,
} from "@space-arena/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  HANGAR_STAGE_ALPHA,
  HANGAR_STAGE_BETA,
  HANGAR_STAGE_RADIUS,
  TacticalCamera,
} from "./TacticalCamera.js";

const CAMERA: CameraConfig = {
  id: "camera.default",
  type: "camera",
  version: 1,
  name: "Test Camera",
  alpha: { default: -Math.PI / 2 },
  beta: { min: 0.6, max: 1.15, default: 0.9 },
  radius: { min: 25, max: 100, default: 55 },
  followLag: 0.15,
  chase: { radius: 12, height: 1.4, beta: 1.34, yawLag: 0.12, landscapeRadiusScale: 0.7 },
};

const disposers: (() => void)[] = [];

afterEach(() => {
  while (disposers.length > 0) disposers.pop()!();
});

function rig(): TacticalCamera {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const configs = {
    get: <T,>(_type: string, id: string): T | undefined =>
      id === CAMERA.id ? (CAMERA as unknown as T) : undefined,
  } as ConfigService;
  const bus = new EventBus<ConfigEvents>();
  const camera = new TacticalCamera(scene, document.createElement("canvas"), configs, bus);
  disposers.push(() => {
    camera.dispose();
    scene.dispose();
    engine.dispose();
  });
  return camera;
}

describe("TacticalCamera staged (hangar) orbit reset", () => {
  const STAGE = new Vector3(0, 5, 300);

  it("snaps back to the canonical framing whatever the player left it on", () => {
    const rigCamera = rig();
    rigCamera.setHangarMode(true);
    rigCamera.stageAt(STAGE, 14, 2.4, 0.7); // the player orbited somewhere else

    rigCamera.resetStageOrbit(STAGE);

    expect(rigCamera.camera.alpha).toBeCloseTo(HANGAR_STAGE_ALPHA, 9);
    expect(rigCamera.camera.beta).toBeCloseTo(HANGAR_STAGE_BETA, 9);
    expect(rigCamera.camera.radius).toBeCloseTo(HANGAR_STAGE_RADIUS, 9);
    expect(rigCamera.camera.target.equals(STAGE)).toBe(true);
  });

  it("LEVELS the rig a match left rolled — the reported 'odd angle' on re-entry", () => {
    // Chase mode poses the camera by rolling it: the ship's own up axis goes
    // into `upVector`, and Babylon rotates the whole orbit by it. Re-assigning
    // alpha/beta alone would therefore reproduce the match's tilt in the hangar.
    const rigCamera = rig();
    rigCamera.setChaseFrame(1.2, 0.6, { x: 0.3, y: -0.4, z: 0.86 });
    rigCamera.setChaseMode(true);
    expect(rigCamera.camera.upVector.y).toBeLessThan(0.99);

    rigCamera.setChaseMode(false);
    rigCamera.setHangarMode(true);
    rigCamera.resetStageOrbit(STAGE);

    expect(rigCamera.camera.upVector.x).toBeCloseTo(0, 9);
    expect(rigCamera.camera.upVector.y).toBeCloseTo(1, 9);
    expect(rigCamera.camera.upVector.z).toBeCloseTo(0, 9);
    // Levelled AND framed: the hull sits directly in front of the rig again.
    rigCamera.camera.getViewMatrix(true);
    expect(rigCamera.camera.position.y - STAGE.y).toBeGreaterThan(0);
    expect(rigCamera.camera.position.subtract(STAGE).length()).toBeCloseTo(HANGAR_STAGE_RADIUS, 5);
  });

  it("drops leftover orbit inertia, so a flick from the last visit cannot drift the fresh view", () => {
    const rigCamera = rig();
    rigCamera.setHangarMode(true);
    rigCamera.camera.inertialAlphaOffset = 0.4;
    rigCamera.camera.inertialBetaOffset = -0.2;
    rigCamera.camera.inertialRadiusOffset = 3;

    rigCamera.resetStageOrbit(STAGE);

    expect(rigCamera.camera.inertialAlphaOffset).toBe(0);
    expect(rigCamera.camera.inertialBetaOffset).toBe(0);
    expect(rigCamera.camera.inertialRadiusOffset).toBe(0);
  });

  it("restores the default FOV when the hangar takes the rig back from a match", () => {
    const rigCamera = rig();
    const fov = rigCamera.camera.fov;
    rigCamera.setChaseMode(true);
    rigCamera.camera.fov = 1.1; // whatever the chase block asked for
    rigCamera.setHangarMode(true);
    expect(rigCamera.camera.fov).toBeCloseTo(fov, 9);
  });
});

describe("TacticalCamera chase distance", () => {
  it("multiplies the authored radius and pins every chase radius surface to it", () => {
    const rigCamera = rig();
    rigCamera.setChaseMode(true);
    rigCamera.setChaseDistanceScale(1.25);

    expect(rigCamera.camera.radius).toBeCloseTo(15, 9);
    expect(rigCamera.camera.lowerRadiusLimit).toBeCloseTo(15, 9);
    expect(rigCamera.camera.upperRadiusLimit).toBeCloseTo(15, 9);

    rigCamera.camera.getViewMatrix(true);
    const offset = rigCamera.camera.position.subtract(rigCamera.camera.target);
    expect(offset.length()).toBeCloseTo(15, 6);
  });

  it("can be set before chase mode and resets invalid input to the content baseline", () => {
    const rigCamera = rig();
    rigCamera.setChaseDistanceScale(0.8);
    rigCamera.setChaseMode(true);
    expect(rigCamera.camera.radius).toBeCloseTo(9.6, 9);

    rigCamera.setChaseDistanceScale(Number.NaN);
    expect(rigCamera.camera.radius).toBeCloseTo(12, 9);
  });

  it("applies the authored landscape scale as the orientation baseline, under the player multiplier", () => {
    // Owner 2026-07-31: a wide screen already shows more arena, so landscape
    // defaults closer (0.7x authored). The player's distance setting multiplies
    // ON TOP of that baseline rather than replacing it.
    const rigCamera = rig();
    rigCamera.setChaseMode(true);
    expect(rigCamera.camera.radius).toBeCloseTo(12, 9);

    rigCamera.setLandscapeOrientation(true);
    expect(rigCamera.camera.radius).toBeCloseTo(8.4, 9);
    expect(rigCamera.camera.lowerRadiusLimit).toBeCloseTo(8.4, 9);

    rigCamera.setChaseDistanceScale(1.5);
    expect(rigCamera.camera.radius).toBeCloseTo(12.6, 9);

    rigCamera.setLandscapeOrientation(false);
    expect(rigCamera.camera.radius).toBeCloseTo(18, 9);
  });
});

describe("TacticalCamera staged screen offset", () => {
  it("slides the staged subject by a share of the frame, and clears back to centre", () => {
    const rigCamera = rig();
    rigCamera.setHangarMode(true);
    rigCamera.camera.radius = 10;
    rigCamera.camera.fov = 0.8;

    const engine = rigCamera.camera.getScene().getEngine();
    const aspect = engine.getRenderWidth() / engine.getRenderHeight();
    const visibleHeight = 2 * 10 * Math.tan(0.4);

    // Portrait lift: up is +y, and the shift is a pure fraction of the frame,
    // so it stays the same share of the screen at any radius or FOV.
    rigCamera.setStageScreenOffset(0, 0.15);
    expect(rigCamera.camera.targetScreenOffset.x).toBeCloseTo(0, 9);
    expect(rigCamera.camera.targetScreenOffset.y).toBeCloseTo(0.15 * visibleHeight, 9);

    // Landscape shift: left is -x, scaled by aspect so a fraction of WIDTH
    // means the same on a wide frame as a tall one.
    rigCamera.setStageScreenOffset(-0.2, 0);
    expect(rigCamera.camera.targetScreenOffset.x).toBeCloseTo(-0.2 * visibleHeight * aspect, 9);
    expect(rigCamera.camera.targetScreenOffset.y).toBeCloseTo(0, 9);

    // Matches frame on the ship itself — no leftover stage offset.
    rigCamera.clearStageScreenOffset();
    expect(rigCamera.camera.targetScreenOffset.x).toBe(0);
    expect(rigCamera.camera.targetScreenOffset.y).toBe(0);
  });
});
