import { describe, expect, it } from "vitest";
import type { ActionConfig, ModuleConfig, SimEvent, ThemeConfig } from "@space-arena/shared";
import {
  actionIdsForEvent,
  audioSettingsOf,
  cueSoundFor,
  moduleHookFor,
  resolveSoundId,
  soundRequestFromAction,
} from "./soundIds.js";

const PLAYER = 1;
const ENEMY = 2;

function action(partial: Partial<ActionConfig>): ActionConfig {
  return {
    id: "action.test",
    type: "action",
    version: 1,
    name: "Test",
    kind: "play_sound",
    ...partial,
  } as ActionConfig;
}

describe("resolveSoundId", () => {
  it("accepts both the bare id and the [SOUND: x] placeholder form", () => {
    expect(resolveSoundId("laser_fire")).toBe("laser_fire");
    expect(resolveSoundId("[SOUND: laser_fire]")).toBe("laser_fire");
    expect(resolveSoundId("[SOUND:laser_fire]")).toBe("laser_fire");
    expect(resolveSoundId("  [SOUND:  explosion_ship ]  ")).toBe("explosion_ship");
  });

  it("returns null for anything that isn't a usable id", () => {
    expect(resolveSoundId(undefined)).toBeNull();
    expect(resolveSoundId(null)).toBeNull();
    expect(resolveSoundId(42)).toBeNull();
    expect(resolveSoundId("")).toBeNull();
    expect(resolveSoundId("   ")).toBeNull();
    expect(resolveSoundId("[SOUND: ]")).toBeNull();
  });
});

describe("soundRequestFromAction", () => {
  it("reads id + volume from a play_sound action", () => {
    const request = soundRequestFromAction(
      action({ params: { sound: "[SOUND: kinetic_fire]", volume: 0.75 } }),
    );
    expect(request).toEqual({ id: "kinetic_fire", volume: 0.75 });
  });

  it("defaults the volume and clamps out-of-range values", () => {
    expect(soundRequestFromAction(action({ params: { sound: "laser_fire" } }))?.volume).toBe(1);
    expect(soundRequestFromAction(action({ params: { sound: "laser_fire", volume: 4 } }))?.volume).toBe(1);
    expect(soundRequestFromAction(action({ params: { sound: "laser_fire", volume: -1 } }))?.volume).toBe(0);
  });

  it("ignores non-play_sound actions and missing sounds", () => {
    expect(soundRequestFromAction(undefined)).toBeNull();
    expect(
      soundRequestFromAction(action({ kind: "show_notification", params: { notification: "x" } })),
    ).toBeNull();
    expect(soundRequestFromAction(action({ params: { volume: 1 } }))).toBeNull();
  });
});

describe("moduleHookFor", () => {
  it("maps module-driven events to their action hook", () => {
    expect(moduleHookFor({ type: "projectileFired", ownerId: 1, moduleId: "m", kind: "beam", targetId: null })).toBe("onFire");
    expect(moduleHookFor({ type: "overheated", entityId: 1, hardpointIndex: 0, moduleId: "m" })).toBe("onOverheat");
    expect(
      moduleHookFor({ type: "moduleStateChanged", entityId: 1, hardpointIndex: 0, moduleId: "m", from: "retracted", to: "deploying" }),
    ).toBe("onActivate");
    expect(
      moduleHookFor({ type: "moduleStateChanged", entityId: 1, hardpointIndex: 0, moduleId: "m", from: "active", to: "retracting" }),
    ).toBe("onDeactivate");
  });

  it("returns null for everything else", () => {
    expect(moduleHookFor({ type: "damage", targetId: 1, sourceId: 2, amount: 5, damageType: "energy", isAsteroid: false })).toBeNull();
  });
});

describe("actionIdsForEvent", () => {
  const laser = {
    id: "module.laser-mk1",
    onFire: ["action.play-sound-laser"],
    onOverheat: ["action.notify-overheat", "action.play-sound-overheat"],
  } as unknown as ModuleConfig;
  const lookup = (id: string): ModuleConfig | undefined => (id === "module.laser-mk1" ? laser : undefined);

  it("prefers the action ids the sim stamped on the event (offline path)", () => {
    const event: SimEvent = {
      type: "projectileFired",
      ownerId: PLAYER,
      moduleId: "module.laser-mk1",
      kind: "beam",
      targetId: ENEMY,
      actions: ["action.custom"],
    };
    expect(actionIdsForEvent(event, lookup)).toEqual(["action.custom"]);
  });

  it("re-derives them from the module config when absent (online path)", () => {
    const event: SimEvent = {
      type: "projectileFired",
      ownerId: PLAYER,
      moduleId: "module.laser-mk1",
      kind: "beam",
      targetId: ENEMY,
    };
    expect(actionIdsForEvent(event, lookup)).toEqual(["action.play-sound-laser"]);
  });

  it("is empty for unknown modules and non-module events", () => {
    const unknownModule: SimEvent = { type: "overheated", entityId: PLAYER, hardpointIndex: 0, moduleId: "module.nope" };
    expect(actionIdsForEvent(unknownModule, lookup)).toEqual([]);
    const damage: SimEvent = { type: "damage", targetId: PLAYER, sourceId: ENEMY, amount: 5, damageType: "energy", isAsteroid: false };
    expect(actionIdsForEvent(damage, lookup)).toEqual([]);
  });
});

describe("audioSettingsOf", () => {
  it("defaults every field when the theme has no audio block", () => {
    const settings = audioSettingsOf(undefined);
    expect(settings.enabled).toBe(true);
    expect(settings.defaultMasterVolume).toBe(0.8);
    expect(settings.defaultSfxVolume).toBe(0.8);
    expect(settings.cues.playerDamaged).toBeNull();
  });

  it("resolves placeholder cue ids to bare ids", () => {
    const theme = {
      audio: {
        enabled: true,
        maxVoices: 4,
        retriggerGapMs: 10,
        cues: { playerDamaged: "[SOUND: hit_thud]", playerKill: "kill_confirm" },
      },
    } as unknown as ThemeConfig;
    const settings = audioSettingsOf(theme);
    expect(settings.cues.playerDamaged).toBe("hit_thud");
    expect(settings.cues.playerKill).toBe("kill_confirm");
    expect(settings.cues.overheat).toBeNull();
    expect(settings.maxVoices).toBe(4);
    expect(settings.retriggerGapMs).toBe(10);
  });
});

describe("cueSoundFor", () => {
  const cues = {
    playerDamaged: "hit_thud",
    shieldAbsorb: "shield_hit",
    playerKill: "kill_confirm",
    playerDeath: "explosion_heavy",
    overheat: "overheat_warning",
    boundaryWarning: "boundary_warn",
  };

  it("fires player-feedback cues only for the local player", () => {
    expect(cueSoundFor({ type: "damage", targetId: PLAYER, sourceId: ENEMY, amount: 4, damageType: "energy", isAsteroid: false }, PLAYER, cues)).toBe("hit_thud");
    expect(cueSoundFor({ type: "damage", targetId: ENEMY, sourceId: PLAYER, amount: 4, damageType: "energy", isAsteroid: false }, PLAYER, cues)).toBeNull();
    expect(cueSoundFor({ type: "shieldAbsorb", targetId: PLAYER, hardpointIndex: 0, amount: 3 }, PLAYER, cues)).toBe("shield_hit");
    expect(cueSoundFor({ type: "overheated", entityId: ENEMY, hardpointIndex: 0, moduleId: "m" }, PLAYER, cues)).toBeNull();
  });

  it("separates a kill from the player's own death", () => {
    expect(cueSoundFor({ type: "entityDestroyed", entityId: ENEMY, killerId: PLAYER, isAsteroid: false }, PLAYER, cues)).toBe("kill_confirm");
    expect(cueSoundFor({ type: "entityDestroyed", entityId: PLAYER, killerId: ENEMY, isAsteroid: false }, PLAYER, cues)).toBe("explosion_heavy");
    // Asteroids never produce a player cue — their explosion effect owns the sound.
    expect(cueSoundFor({ type: "entityDestroyed", entityId: 7, killerId: PLAYER, isAsteroid: true }, PLAYER, cues)).toBeNull();
  });

  it("ignores harmless boundary bounces", () => {
    expect(cueSoundFor({ type: "boundaryHit", entityId: PLAYER, rule: "bounce" }, PLAYER, cues)).toBeNull();
    expect(cueSoundFor({ type: "boundaryHit", entityId: PLAYER, rule: "warning" }, PLAYER, cues)).toBe("boundary_warn");
  });

  it("stays silent for cues the theme leaves unset", () => {
    const silent = { ...cues, playerDamaged: null };
    expect(cueSoundFor({ type: "damage", targetId: PLAYER, sourceId: ENEMY, amount: 4, damageType: "energy", isAsteroid: false }, PLAYER, silent)).toBeNull();
  });
});
