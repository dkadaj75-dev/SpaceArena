import { describe, expect, it } from "vitest";
import type { ModuleConfig } from "@space-arena/shared";
import { deployProgress, deployProgressFor, easeOutBack, hardpointPose } from "./deployAnim.js";
import { DEFAULT_JUICE_SETTINGS } from "./juiceSettings.js";

const DEPLOY = 1.5;
const RETRACT = 1.0;
const settings = DEFAULT_JUICE_SETTINGS.deploy;

describe("deployProgress", () => {
  it("is fully stowed while retracted and fully out while active", () => {
    expect(deployProgress("retracted", 0, DEPLOY, RETRACT)).toBe(0);
    expect(deployProgress("active", 0, DEPLOY, RETRACT)).toBe(1);
  });

  it("keeps an overheated module extended (mounted, just offline)", () => {
    expect(deployProgress("overheated", 3, DEPLOY, RETRACT)).toBe(1);
  });

  it("runs 0 → 1 across a deploy as stateTimer counts down", () => {
    expect(deployProgress("deploying", DEPLOY, DEPLOY, RETRACT)).toBe(0);
    expect(deployProgress("deploying", DEPLOY / 2, DEPLOY, RETRACT)).toBeCloseTo(0.5);
    expect(deployProgress("deploying", 0, DEPLOY, RETRACT)).toBe(1);
  });

  it("runs 1 → 0 across a retract", () => {
    expect(deployProgress("retracting", RETRACT, DEPLOY, RETRACT)).toBe(1);
    expect(deployProgress("retracting", RETRACT / 4, DEPLOY, RETRACT)).toBeCloseTo(0.25);
    expect(deployProgress("retracting", 0, DEPLOY, RETRACT)).toBe(0);
  });

  it("treats zero-duration activations as instant", () => {
    expect(deployProgress("deploying", 0, 0, 0)).toBe(1);
    expect(deployProgress("retracting", 0, 0, 0)).toBe(0);
  });

  it("clamps a stateTimer that outruns its configured duration", () => {
    expect(deployProgress("deploying", DEPLOY * 3, DEPLOY, RETRACT)).toBe(0);
    expect(deployProgress("retracting", RETRACT * 3, DEPLOY, RETRACT)).toBe(1);
  });

  it("reads timing straight off the module config", () => {
    const cfg = { activation: { deployTime: 2, retractTime: 1 } } as ModuleConfig;
    expect(deployProgressFor({ state: "deploying", stateTimer: 1 }, cfg)).toBeCloseTo(0.5);
    // No config (unknown module id): nothing to tween against, so it snaps.
    expect(deployProgressFor({ state: "deploying", stateTimer: 1 }, undefined)).toBe(1);
  });
});

describe("hardpointPose", () => {
  it("hides a stowed module and fully shows a deployed one", () => {
    expect(hardpointPose(0, settings).scale).toBe(0);
    expect(hardpointPose(1, settings).scale).toBeCloseTo(1);
  });

  it("extends the turret along +Y in step with the sweep", () => {
    expect(hardpointPose(0, settings).extend).toBe(0);
    expect(hardpointPose(0.5, settings).extend).toBeCloseTo(settings.extendDistance / 2);
    expect(hardpointPose(1, settings).extend).toBeCloseTo(settings.extendDistance);
  });

  it("unwinds the settle-spin to zero as it finishes", () => {
    expect(hardpointPose(0, settings).spinRad).toBeCloseTo((settings.spinDegrees * Math.PI) / 180);
    expect(hardpointPose(1, settings).spinRad).toBe(0);
  });

  it("overshoots past full size mid-sweep when configured, and only then", () => {
    const punchy = { ...settings, overshoot: 1.2 };
    const peak = Math.max(...[0.6, 0.7, 0.8, 0.9].map((p) => hardpointPose(p, punchy).scale));
    expect(peak).toBeGreaterThan(1);
    const flat = { ...settings, overshoot: 0 };
    for (const p of [0.25, 0.5, 0.75, 1]) expect(hardpointPose(p, flat).scale).toBeLessThanOrEqual(1);
  });

  it("clamps out-of-range progress", () => {
    expect(hardpointPose(-5, settings).scale).toBe(0);
    expect(hardpointPose(5, settings).scale).toBeCloseTo(1);
  });
});

describe("easeOutBack", () => {
  it("is anchored at both ends for any overshoot", () => {
    for (const overshoot of [0, 0.5, 1.7]) {
      expect(easeOutBack(0, overshoot)).toBeCloseTo(0);
      expect(easeOutBack(1, overshoot)).toBeCloseTo(1);
    }
  });

  it("reduces to a plain ease-out cubic without overshoot", () => {
    expect(easeOutBack(0.5, 0)).toBeCloseTo(1 + Math.pow(-0.5, 3));
  });
});
