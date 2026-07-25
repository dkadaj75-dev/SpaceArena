import type { CameraConfig, EntityId, SimEvent } from "@space-arena/shared";

/**
 * ROADMAP §10 5.7 — camera micro-shake, as pure math + a pure event policy.
 *
 * The shake is an **additive world-space offset** on the orbit target. It never
 * touches the follow point or the player's pan offset, and its envelope decays
 * to exactly zero, so the tactical rig's follow/pan architecture is untouched:
 * {@link import("../TacticalCamera.js").TacticalCamera} adds the offset as the
 * last step of its frame and the next frame recomputes the target from scratch.
 *
 * Subtlety is the whole point at tactical distance (orbit radius 30-90): the
 * default amplitudes are fractions of a world unit, small enough to feel like
 * impact and too small to fight the player's aim.
 */

/** The camera config's `shake` block, fully defaulted. */
export interface ShakeSettings {
  enabled: boolean;
  hitAmplitude: number;
  killAmplitude: number;
  durationMs: number;
  frequencyHz: number;
  maxAmplitude: number;
  /** Damage amount producing a full-strength hit shake. */
  damageReference: number;
  /** Floor on damage scaling so a graze still registers. */
  minDamageScale: number;
}

export const DEFAULT_SHAKE_SETTINGS: ShakeSettings = {
  enabled: true,
  hitAmplitude: 0.28,
  killAmplitude: 0.55,
  durationMs: 260,
  frequencyHz: 22,
  maxAmplitude: 0.9,
  damageReference: 14,
  minDamageScale: 0.35,
};

/** Resolve `camera.shake` against the built-in defaults. */
export function shakeSettingsOf(camera: CameraConfig | undefined): ShakeSettings {
  const s = camera?.shake;
  const d = DEFAULT_SHAKE_SETTINGS;
  return {
    enabled: s?.enabled ?? d.enabled,
    hitAmplitude: s?.hitAmplitude ?? d.hitAmplitude,
    killAmplitude: s?.killAmplitude ?? d.killAmplitude,
    durationMs: s?.durationMs ?? d.durationMs,
    frequencyHz: s?.frequencyHz ?? d.frequencyHz,
    maxAmplitude: s?.maxAmplitude ?? d.maxAmplitude,
    damageReference: s?.damageReference ?? d.damageReference,
    minDamageScale: s?.minDamageScale ?? d.minDamageScale,
  };
}

/**
 * Amplitude one sim event should shake the camera by, or null for "no shake".
 *
 * Own-ship events only (ROADMAP: "camera micro-shake on own-ship hits/kills") —
 * a firefight across the arena must never rattle the player's view:
 *  - damage landing on the player's ship, scaled by how big the hit was,
 *  - the player scoring a kill, or the player's own ship being destroyed.
 */
export function shakeRequestFor(
  event: SimEvent,
  playerId: EntityId,
  settings: ShakeSettings,
): number | null {
  if (!settings.enabled) return null;
  if (event.type === "damage") {
    if (event.targetId !== playerId || event.isAsteroid) return null;
    const scale =
      settings.damageReference > 0
        ? clamp(event.amount / settings.damageReference, settings.minDamageScale, 1)
        : 1;
    const amplitude = settings.hitAmplitude * scale;
    return amplitude > 0 ? amplitude : null;
  }
  if (event.type === "entityDestroyed" && !event.isAsteroid) {
    const own = event.entityId === playerId || event.killerId === playerId;
    return own && settings.killAmplitude > 0 ? settings.killAmplitude : null;
  }
  return null;
}

/** Live shake envelope. Reused in place — no per-event allocation. */
export interface ShakeState {
  amplitude: number;
  elapsedMs: number;
  durationMs: number;
  /** Randomized per trigger so repeated hits don't wobble along the same line. */
  phase: number;
}

export function newShakeState(): ShakeState {
  return { amplitude: 0, elapsedMs: 0, durationMs: 0, phase: 0 };
}

/**
 * Add a shake to the running envelope. Overlapping shakes do NOT sum (that is
 * how a firefight turns into an earthquake): the stronger amplitude wins,
 * clamped to `maxAmplitude`, and the envelope restarts so the new impact is
 * felt in full.
 */
export function addShake(
  state: ShakeState,
  amplitude: number,
  settings: ShakeSettings,
  phase = Math.random() * Math.PI * 2,
): void {
  const remaining = remainingAmplitude(state);
  const next = Math.min(Math.max(amplitude, remaining), settings.maxAmplitude);
  if (next <= 0) return;
  state.amplitude = next;
  state.elapsedMs = 0;
  state.durationMs = settings.durationMs;
  state.phase = phase;
}

/** Current envelope value — what an in-flight shake still has left to give. */
export function remainingAmplitude(state: ShakeState): number {
  if (state.durationMs <= 0 || state.elapsedMs >= state.durationMs) return 0;
  const t = state.elapsedMs / state.durationMs;
  const decay = 1 - t;
  return state.amplitude * decay * decay;
}

/**
 * Advance the envelope by `dtMs` and write the planar offset into `out`.
 *
 * The envelope is a quadratic decay (`(1-t)²`) over two out-of-phase sinusoids
 * at slightly different rates, which reads as a rattle rather than a circle.
 * Once `t` reaches 1 the state is cleared and the offset is **exactly zero** —
 * no epsilon drift left on the camera target.
 */
export function advanceShake(
  state: ShakeState,
  dtMs: number,
  settings: ShakeSettings,
  out: { x: number; z: number },
): void {
  if (state.durationMs <= 0) {
    out.x = 0;
    out.z = 0;
    return;
  }
  state.elapsedMs += dtMs;
  if (state.elapsedMs >= state.durationMs) {
    state.amplitude = 0;
    state.durationMs = 0;
    state.elapsedMs = 0;
    out.x = 0;
    out.z = 0;
    return;
  }
  const env = remainingAmplitude(state);
  const seconds = state.elapsedMs / 1000;
  const w = 2 * Math.PI * settings.frequencyHz;
  out.x = env * Math.sin(w * seconds + state.phase);
  // 1.37× keeps the two axes from tracing a circle (irrational-ish ratio).
  out.z = env * Math.cos(w * 1.37 * seconds + state.phase * 0.5);
}

function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}
