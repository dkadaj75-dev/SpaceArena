import type {
  CameraConfig,
  ConfigEvents,
  ConfigService,
  EntityId,
  EventBus,
  SimEvent,
} from "@space-arena/shared";
import {
  addShake,
  advanceShake,
  newShakeState,
  shakeRequestFor,
  shakeSettingsOf,
  type ShakeSettings,
  type ShakeState,
} from "./cameraShake.js";

const CAMERA_CONFIG_ID = "camera.default";

/** The camera surface this consumer drives — an additive planar offset, nothing else. */
export interface ShakeTarget {
  setShakeOffset(x: number, z: number): void;
}

/**
 * ROADMAP §10 5.7 — the sim-event → camera-shake consumer (same
 * drain-events-then-update shape as the HUD's Haptics/DamageFeedback).
 *
 * Owns only the envelope state; the policy and the math are pure
 * ({@link import("./cameraShake.js")}) and the camera only ever receives an
 * additive offset, so user pan and the follow rig are never fought.
 * Amplitudes/duration are tuned live from `camera.json` (`shake` block).
 */
export class ScreenShake {
  private settings: ShakeSettings;
  private readonly state: ShakeState = newShakeState();
  private readonly offset = { x: 0, z: 0 };
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly configs: ConfigService,
    private readonly playerId: EntityId,
    private readonly target: ShakeTarget,
    bus?: EventBus<ConfigEvents>,
  ) {
    this.settings = shakeSettingsOf(this.configs.get<CameraConfig>("camera", CAMERA_CONFIG_ID));
    if (bus) {
      this.unsubscribe = bus.on("config:changed", (evt) => {
        if (evt.id === CAMERA_CONFIG_ID) this.refresh();
      });
    }
  }

  /** Re-read `camera.shake` (config hot-reload / Camera editor). */
  refresh(): void {
    this.settings = shakeSettingsOf(this.configs.get<CameraConfig>("camera", CAMERA_CONFIG_ID));
  }

  consumeEvents(events: readonly SimEvent[]): void {
    if (!this.settings.enabled) return;
    for (let i = 0; i < events.length; i++) {
      const amplitude = shakeRequestFor(events[i]!, this.playerId, this.settings);
      if (amplitude !== null) addShake(this.state, amplitude, this.settings);
    }
  }

  /** Advance the envelope and push this frame's offset at the camera. */
  update(dtMs: number): void {
    const wasActive = this.state.durationMs > 0;
    if (!wasActive) return; // idle: the camera keeps the zero offset written on the last frame
    advanceShake(this.state, dtMs, this.settings, this.offset);
    this.target.setShakeOffset(this.offset.x, this.offset.z);
  }

  /** Current planar offset (dev probe / tests). */
  get currentOffset(): { x: number; z: number } {
    return this.offset;
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.target.setShakeOffset(0, 0);
  }
}
