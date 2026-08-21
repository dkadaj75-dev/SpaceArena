import type { ModuleState, ModuleSnapshot, ModuleConfig } from "@space-arena/shared";
import type { DeploySettings } from "./juiceSettings.js";

/**
 * ROADMAP §10 5.7 — hardpoint deploy/retract animation, as pure math.
 *
 * The *timing* is sim-authoritative and already data-driven
 * (`module.activation.deployTime` / `retractTime`, counted down in
 * `stateTimer` by ModuleSystem). This module answers the two rendering
 * questions on top of that: how far through the sweep are we
 * ({@link deployProgress}), and what pose does that progress mean
 * ({@link hardpointPose}) — extend, scale, spin.
 *
 * Kept Babylon-free so the whole state→pose mapping is unit-testable;
 * {@link import("../ShipSocketRig.js").ShipSocketRig} just writes the result
 * onto the socket node.
 */

/** Sweep position: 0 = fully stowed inside the hull, 1 = fully deployed. */
export function deployProgress(
  state: ModuleState,
  stateTimer: number,
  deployTime: number,
  retractTime: number,
): number {
  switch (state) {
    case "active":
      return 1;
    case "deploying":
      // stateTimer counts DOWN from deployTime, so remaining/total inverts to progress.
      return deployTime > 0 ? clamp01(1 - stateTimer / deployTime) : 1;
    case "retracting":
      return retractTime > 0 ? clamp01(stateTimer / retractTime) : 0;
    case "retracted":
    default:
      return 0;
  }
}

/** Convenience: progress for one module snapshot against its config. */
export function deployProgressFor(
  module: Pick<ModuleSnapshot, "state" | "stateTimer">,
  config: Pick<ModuleConfig, "activation"> | undefined,
): number {
  return deployProgress(
    module.state,
    module.stateTimer,
    config?.activation.deployTime ?? 0,
    config?.activation.retractTime ?? 0,
  );
}

/** Local-space pose of a hardpoint mesh for a given sweep position. */
export interface HardpointPose {
  /** Uniform scale applied to the socket node (0 hides the module entirely). */
  scale: number;
  /** Offset along the socket's local +Y — the turret rising out of the hull. */
  extend: number;
  /** Residual spin (radians) around the socket's local Y, unwound as it settles. */
  spinRad: number;
}

const DEG_TO_RAD = Math.PI / 180;

/**
 * Pose for a sweep position.
 *
 * `scale` uses a back-ease so a deploying turret punches slightly past full
 * size before settling (`overshoot`; 0 gives a plain ease-out cubic). Both
 * endpoints are exact — `pose(0).scale === 0` and `pose(1).scale === 1` — so a
 * stowed module is fully hidden and a live one is never left mid-tween.
 */
export function hardpointPose(progress: number, settings: DeploySettings): HardpointPose {
  const p = clamp01(progress);
  // Endpoints are snapped, not eased: floating-point dust at p=0 would leave a
  // "hidden" module at a sliver of scale instead of gone.
  const scale = p <= 0 ? 0 : p >= 1 ? 1 : Math.max(0, easeOutBack(p, settings.overshoot));
  return {
    scale,
    extend: settings.extendDistance * p,
    spinRad: settings.spinDegrees * DEG_TO_RAD * (1 - p),
  };
}

/**
 * Ease-out with configurable overshoot. `overshoot = 0` is a plain ease-out
 * cubic; larger values push the curve above 1 mid-flight before returning to
 * exactly 1 at p = 1 (the classic "back" ease).
 */
export function easeOutBack(p: number, overshoot: number): number {
  const c1 = Math.max(0, overshoot);
  const t = p - 1;
  return 1 + (c1 + 1) * t * t * t + c1 * t * t;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
