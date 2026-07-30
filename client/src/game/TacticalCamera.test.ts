import { NullEngine, Scene } from "@babylonjs/core";
import {
  EventBus,
  type CameraConfig,
  type ConfigEvents,
  type ConfigService,
} from "@space-arena/shared";
import { afterEach, describe, expect, it } from "vitest";
import { TacticalCamera } from "./TacticalCamera.js";

const CAMERA: CameraConfig = {
  id: "camera.default",
  type: "camera",
  version: 1,
  name: "Test Camera",
  alpha: { default: -Math.PI / 2 },
  beta: { min: 0.6, max: 1.15, default: 0.9 },
  radius: { min: 25, max: 100, default: 55 },
  followLag: 0.15,
  chase: { radius: 12, height: 1.4, beta: 1.34, yawLag: 0.12 },
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
});
