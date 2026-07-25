import { describe, expect, it } from "vitest";
import type { CameraConfig, SimEvent } from "@space-arena/shared";
import {
  addShake,
  advanceShake,
  DEFAULT_SHAKE_SETTINGS,
  newShakeState,
  remainingAmplitude,
  shakeRequestFor,
  shakeSettingsOf,
} from "./cameraShake.js";

const PLAYER = 1;
const ENEMY = 2;
const settings = DEFAULT_SHAKE_SETTINGS;

function damage(targetId: number, amount: number, isAsteroid = false): SimEvent {
  return { type: "damage", targetId, sourceId: ENEMY, amount, damageType: "kinetic", isAsteroid };
}

describe("shakeSettingsOf", () => {
  it("defaults everything when camera.json has no shake block", () => {
    expect(shakeSettingsOf(undefined)).toEqual(DEFAULT_SHAKE_SETTINGS);
  });

  it("takes the config's values when present", () => {
    const camera = {
      shake: { enabled: false, hitAmplitude: 1, killAmplitude: 2, durationMs: 100, frequencyHz: 5, maxAmplitude: 3 },
    } as unknown as CameraConfig;
    const s = shakeSettingsOf(camera);
    expect(s.enabled).toBe(false);
    expect(s.hitAmplitude).toBe(1);
    expect(s.durationMs).toBe(100);
    // Unspecified sub-knobs still fall back.
    expect(s.damageReference).toBe(DEFAULT_SHAKE_SETTINGS.damageReference);
  });
});

describe("shakeRequestFor", () => {
  it("only shakes for the player's OWN hits", () => {
    expect(shakeRequestFor(damage(PLAYER, 14), PLAYER, settings)).toBeCloseTo(settings.hitAmplitude);
    expect(shakeRequestFor(damage(ENEMY, 14), PLAYER, settings)).toBeNull();
    expect(shakeRequestFor(damage(PLAYER, 14, true), PLAYER, settings)).toBeNull();
  });

  it("scales the hit shake by damage, with a floor so a graze still registers", () => {
    const light = shakeRequestFor(damage(PLAYER, 1), PLAYER, settings)!;
    const heavy = shakeRequestFor(damage(PLAYER, 100), PLAYER, settings)!;
    expect(light).toBeCloseTo(settings.hitAmplitude * settings.minDamageScale);
    expect(heavy).toBeCloseTo(settings.hitAmplitude); // clamped at full strength
    expect(light).toBeLessThan(heavy);
  });

  it("shakes for the player's kills and for the player's own death", () => {
    const kill: SimEvent = { type: "entityDestroyed", entityId: ENEMY, killerId: PLAYER, isAsteroid: false };
    const death: SimEvent = { type: "entityDestroyed", entityId: PLAYER, killerId: ENEMY, isAsteroid: false };
    const other: SimEvent = { type: "entityDestroyed", entityId: 3, killerId: 4, isAsteroid: false };
    const rock: SimEvent = { type: "entityDestroyed", entityId: 9, killerId: PLAYER, isAsteroid: true };
    expect(shakeRequestFor(kill, PLAYER, settings)).toBeCloseTo(settings.killAmplitude);
    expect(shakeRequestFor(death, PLAYER, settings)).toBeCloseTo(settings.killAmplitude);
    expect(shakeRequestFor(other, PLAYER, settings)).toBeNull();
    expect(shakeRequestFor(rock, PLAYER, settings)).toBeNull();
  });

  it("is silent when shake is disabled", () => {
    expect(shakeRequestFor(damage(PLAYER, 14), PLAYER, { ...settings, enabled: false })).toBeNull();
  });
});

describe("shake envelope", () => {
  it("decays monotonically to exactly zero and then stays there", () => {
    const state = newShakeState();
    const out = { x: 0, z: 0 };
    addShake(state, 0.5, settings, 0);

    let previousEnvelope = remainingAmplitude(state);
    expect(previousEnvelope).toBeCloseTo(0.5);
    for (let elapsed = 0; elapsed < settings.durationMs; elapsed += 16) {
      advanceShake(state, 16, settings, out);
      const envelope = remainingAmplitude(state);
      expect(envelope).toBeLessThanOrEqual(previousEnvelope + 1e-9);
      expect(Math.hypot(out.x, out.z)).toBeLessThanOrEqual(0.5 * Math.SQRT2 + 1e-9);
      previousEnvelope = envelope;
    }
    // Past the duration the state resets and the offset is EXACTLY zero — no
    // epsilon drift left on the camera target.
    advanceShake(state, settings.durationMs, settings, out);
    expect(out.x).toBe(0);
    expect(out.z).toBe(0);
    expect(state.durationMs).toBe(0);
    expect(remainingAmplitude(state)).toBe(0);
  });

  it("writes zero when nothing is shaking", () => {
    const out = { x: 5, z: 5 };
    advanceShake(newShakeState(), 16, settings, out);
    expect(out).toEqual({ x: 0, z: 0 });
  });

  it("takes the stronger amplitude instead of summing (no earthquake in a firefight)", () => {
    const state = newShakeState();
    addShake(state, 0.4, settings, 0);
    addShake(state, 0.2, settings, 0);
    expect(state.amplitude).toBeCloseTo(0.4); // weaker overlap can't reduce it
    addShake(state, 0.7, settings, 0);
    expect(state.amplitude).toBeCloseTo(0.7);
  });

  it("clamps stacked shakes to maxAmplitude", () => {
    const state = newShakeState();
    addShake(state, 99, settings, 0);
    expect(state.amplitude).toBe(settings.maxAmplitude);
  });

  it("restarts the envelope on a new impact", () => {
    const state = newShakeState();
    const out = { x: 0, z: 0 };
    addShake(state, 0.5, settings, 0);
    advanceShake(state, settings.durationMs * 0.75, settings, out);
    expect(state.elapsedMs).toBeCloseTo(settings.durationMs * 0.75);
    addShake(state, 0.5, settings, 0);
    expect(state.elapsedMs).toBe(0);
  });
});
