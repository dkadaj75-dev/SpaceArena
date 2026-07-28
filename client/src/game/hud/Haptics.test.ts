import { describe, expect, it, vi } from "vitest";
import type { ConfigService, SimEvent, ThemeConfig } from "@space-arena/shared";
import { Haptics, hapticPatternFor, hapticsSettingsOf } from "./Haptics.js";

const PLAYER = 1;
const ENEMY = 2;

const SETTINGS = {
  enabled: true,
  overheatPattern: [60, 50, 120],
  killPattern: [25, 40, 25],
  lockPattern: [18, 45, 18],
  fireBlockedPattern: [35, 35, 90],
};

const overheat = (entityId: number): SimEvent => ({
  type: "overheated",
  entityId,
  hardpointIndex: 0,
  moduleId: "module.laser-mk1",
});
const destroyed = (entityId: number, killerId: number | null, isAsteroid = false): SimEvent => ({
  type: "entityDestroyed",
  entityId,
  killerId,
  isAsteroid,
});

describe("hapticPatternFor", () => {
  it("buzzes on the player's own overheat shutdown", () => {
    expect(hapticPatternFor(overheat(PLAYER), PLAYER, SETTINGS)).toEqual([60, 50, 120]);
  });

  it("stays silent for someone else's overheat", () => {
    expect(hapticPatternFor(overheat(ENEMY), PLAYER, SETTINGS)).toBeNull();
  });

  it("buzzes when the player scores a kill", () => {
    expect(hapticPatternFor(destroyed(ENEMY, PLAYER), PLAYER, SETTINGS)).toEqual([25, 40, 25]);
  });

  it("stays silent for asteroid kills, other players' kills, and the player's own death", () => {
    expect(hapticPatternFor(destroyed(ENEMY, PLAYER, true), PLAYER, SETTINGS)).toBeNull();
    expect(hapticPatternFor(destroyed(ENEMY, ENEMY), PLAYER, SETTINGS)).toBeNull();
    expect(hapticPatternFor(destroyed(PLAYER, ENEMY), PLAYER, SETTINGS)).toBeNull();
  });

  // FLIGHT.md §4: the lock flip is the moment weapons come live, so it gets its
  // own buzz — but only for the local player, and only on acquire (a `lockLost`
  // buzz would rattle constantly in a dogfight).
  it("buzzes when the player's own sensors complete a lock", () => {
    expect(hapticPatternFor({ type: "lockAcquired", entityId: PLAYER, targetId: ENEMY }, PLAYER, SETTINGS)).toEqual([18, 45, 18]);
    expect(hapticPatternFor({ type: "lockAcquired", entityId: ENEMY, targetId: PLAYER }, PLAYER, SETTINGS)).toBeNull();
    expect(hapticPatternFor({ type: "lockLost", entityId: PLAYER }, PLAYER, SETTINGS)).toBeNull();
  });

  it("honours the master toggle and treats an empty pattern as 'off'", () => {
    expect(hapticPatternFor(overheat(PLAYER), PLAYER, { ...SETTINGS, enabled: false })).toBeNull();
    expect(hapticPatternFor(overheat(PLAYER), PLAYER, { ...SETTINGS, overheatPattern: [] })).toBeNull();
  });

  it("ignores unrelated events", () => {
    expect(hapticPatternFor({ type: "targetSet", entityId: PLAYER, targetId: ENEMY }, PLAYER, SETTINGS)).toBeNull();
  });
});

describe("hapticsSettingsOf", () => {
  it("defaults to silent when a theme declares no haptics block", () => {
    expect(hapticsSettingsOf(undefined)).toEqual({
      enabled: false,
      overheatPattern: [],
      killPattern: [],
      lockPattern: [],
      fireBlockedPattern: [],
    });
  });

  it("reads patterns and the toggle straight from the theme", () => {
    const theme = { haptics: { enabled: true, killPattern: [10], lockPattern: [18] } } as ThemeConfig;
    expect(hapticsSettingsOf(theme)).toEqual({
      enabled: true,
      overheatPattern: [],
      killPattern: [10],
      lockPattern: [18],
      fireBlockedPattern: [],
    });
  });
});

function configsWith(theme: ThemeConfig | undefined): ConfigService {
  return { get: () => theme } as unknown as ConfigService;
}

describe("Haptics", () => {
  const theme = { haptics: { enabled: true, overheatPattern: [60], killPattern: [25] } } as ThemeConfig;

  it("vibrates once per frame even when several qualifying events land together", () => {
    const vibrate = vi.fn();
    const haptics = new Haptics(configsWith(theme), PLAYER, vibrate);
    haptics.consumeEvents([overheat(PLAYER), destroyed(ENEMY, PLAYER)]);
    expect(vibrate).toHaveBeenCalledTimes(1);
    expect(vibrate).toHaveBeenCalledWith([60]);
  });

  it("is a no-op on browsers without navigator.vibrate", () => {
    const haptics = new Haptics(configsWith(theme), PLAYER, null);
    expect(() => haptics.consumeEvents([overheat(PLAYER)])).not.toThrow();
  });

  it("picks up a hot-reloaded theme on refresh()", () => {
    const vibrate = vi.fn();
    let live: ThemeConfig = { haptics: { enabled: false, overheatPattern: [60] } } as ThemeConfig;
    const configs = { get: () => live } as unknown as ConfigService;
    const haptics = new Haptics(configs, PLAYER, vibrate);
    haptics.consumeEvents([overheat(PLAYER)]);
    expect(vibrate).not.toHaveBeenCalled();

    live = { haptics: { enabled: true, overheatPattern: [90] } } as ThemeConfig;
    haptics.refresh();
    haptics.consumeEvents([overheat(PLAYER)]);
    expect(vibrate).toHaveBeenCalledWith([90]);
  });

  it("uses the existing vibration path for a blocked trigger pull", () => {
    const vibrate = vi.fn();
    const blockedTheme = {
      haptics: { enabled: true, fireBlockedPattern: [35, 35, 90] },
    } as ThemeConfig;
    const haptics = new Haptics(configsWith(blockedTheme), PLAYER, vibrate);
    haptics.fireBlocked();
    expect(vibrate).toHaveBeenCalledWith([35, 35, 90]);
  });
});
