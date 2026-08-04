import { describe, expect, it } from "vitest";
import {
  CAMERA_DISTANCE_KEY,
  CAMERA_DISTANCE_MAX,
  CAMERA_DISTANCE_MIN,
  CAMERA_PAN_SENS_KEY,
  CAMERA_SHAKE_KEY,
  clampCameraDistance,
  clampPanSens,
  clampSteerSens,
  defaultRendererPreference,
  DEFAULT_USER_SETTINGS,
  HAPTICS_KEY,
  INVERT_PITCH_KEY,
  MOUSE_STEER_SENS_KEY,
  PAN_SENS_MAX,
  PAN_SENS_MIN,
  STEER_SENS_MAX,
  STEER_SENS_MIN,
  QUALITY_STORAGE_KEY,
  readUserSettings,
  RENDERER_KEY,
  settingsToStorage,
  TOUCH_STEER_SENS_KEY,
  UserSettingsStore,
  VOLUME_MASTER_KEY,
  VOLUME_SFX_KEY,
  writeUserSettings,
  type SettingsStorage,
} from "./userSettings.js";

/** In-memory Storage stub — the whole module is written against this surface. */
function fakeStorage(seed: Record<string, string> = {}): SettingsStorage & { map: Map<string, string> } {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

describe("readUserSettings", () => {
  it("returns the built-in defaults when nothing is stored", () => {
    expect(readUserSettings(fakeStorage())).toEqual(DEFAULT_USER_SETTINGS);
  });

  it("falls back to theme-supplied volume defaults", () => {
    const settings = readUserSettings(fakeStorage(), { masterVolume: 0.3, sfxVolume: 0.4 });
    expect(settings.masterVolume).toBe(0.3);
    expect(settings.sfxVolume).toBe(0.4);
  });

  it("stored volumes win over the theme defaults and are clamped to 0..1", () => {
    const storage = fakeStorage({ [VOLUME_MASTER_KEY]: "0.25", [VOLUME_SFX_KEY]: "5" });
    const settings = readUserSettings(storage, { masterVolume: 0.9, sfxVolume: 0.9 });
    expect(settings.masterVolume).toBe(0.25);
    expect(settings.sfxVolume).toBe(1);
  });

  it("reads a quality override and ignores an unknown tier", () => {
    expect(readUserSettings(fakeStorage({ [QUALITY_STORAGE_KEY]: "high" })).quality).toBe("high");
    expect(readUserSettings(fakeStorage({ [QUALITY_STORAGE_KEY]: "ultra" })).quality).toBe("ultra");
  });

  it("treats only the literal \"off\" as disabled for flag keys", () => {
    expect(readUserSettings(fakeStorage({ [HAPTICS_KEY]: "off" })).haptics).toBe(false);
    expect(readUserSettings(fakeStorage({ [HAPTICS_KEY]: "OFF" })).haptics).toBe(false);
    expect(readUserSettings(fakeStorage({ [HAPTICS_KEY]: "on" })).haptics).toBe(true);
    expect(readUserSettings(fakeStorage({ [CAMERA_SHAKE_KEY]: "off" })).cameraShake).toBe(false);
  });

  it("treats pitch invert as an opt-IN: only the literal \"on\" flips the axis", () => {
    // The odd one out among the flags: there is no content baseline for which way
    // a thumb reads, so push-up-to-climb is the default and this is the opt-in.
    expect(readUserSettings(fakeStorage()).invertPitch).toBe(false);
    expect(readUserSettings(fakeStorage({ [INVERT_PITCH_KEY]: "on" })).invertPitch).toBe(true);
    expect(readUserSettings(fakeStorage({ [INVERT_PITCH_KEY]: "ON" })).invertPitch).toBe(true);
    expect(readUserSettings(fakeStorage({ [INVERT_PITCH_KEY]: "off" })).invertPitch).toBe(false);
    expect(readUserSettings(fakeStorage({ [INVERT_PITCH_KEY]: "yes" })).invertPitch).toBe(false);
  });

  it("clamps a hand-edited pan sensitivity and ignores garbage", () => {
    expect(readUserSettings(fakeStorage({ [CAMERA_PAN_SENS_KEY]: "9" })).cameraPanSens).toBe(PAN_SENS_MAX);
    expect(readUserSettings(fakeStorage({ [CAMERA_PAN_SENS_KEY]: "0" })).cameraPanSens).toBe(PAN_SENS_MIN);
    expect(readUserSettings(fakeStorage({ [CAMERA_PAN_SENS_KEY]: "abc" })).cameraPanSens).toBe(1);
  });

  it("clamps a hand-edited camera distance and ignores garbage", () => {
    expect(readUserSettings(fakeStorage({ [CAMERA_DISTANCE_KEY]: "9" })).cameraDistanceScale).toBe(
      CAMERA_DISTANCE_MAX,
    );
    expect(readUserSettings(fakeStorage({ [CAMERA_DISTANCE_KEY]: "0" })).cameraDistanceScale).toBe(
      CAMERA_DISTANCE_MIN,
    );
    expect(readUserSettings(fakeStorage({ [CAMERA_DISTANCE_KEY]: "abc" })).cameraDistanceScale).toBe(1);
  });

  it("reads and clamps the independent steering multipliers", () => {
    const settings = readUserSettings(fakeStorage({
      [MOUSE_STEER_SENS_KEY]: "9",
      [TOUCH_STEER_SENS_KEY]: "0.2",
    }));
    expect(settings.mouseSteerSens).toBe(STEER_SENS_MAX);
    expect(settings.touchSteerSens).toBe(STEER_SENS_MIN);
  });

  it("reads the renderer preference, defaulting by platform only when no key exists", () => {
    expect(readUserSettings(fakeStorage({ [RENDERER_KEY]: "webgpu" })).renderer).toBe("webgpu");
    expect(readUserSettings(fakeStorage({ [RENDERER_KEY]: "vulkan" })).renderer).toBe("webgl");
    const safari = { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Version/17.0 Safari/605.1.15" };
    expect(defaultRendererPreference(safari)).toBe("webgpu");
    expect(readUserSettings(fakeStorage(), {}, safari).renderer).toBe("webgpu");
    expect(readUserSettings(fakeStorage({ [RENDERER_KEY]: "webgl" }), {}, safari).renderer).toBe("webgl");
  });

  it("survives storage being unavailable entirely", () => {
    expect(readUserSettings(null)).toEqual(DEFAULT_USER_SETTINGS);
  });
});

describe("settingsToStorage", () => {
  it("maps each setting to its documented key", () => {
    expect(settingsToStorage({ quality: "low" })).toEqual([[QUALITY_STORAGE_KEY, "low"]]);
    expect(settingsToStorage({ quality: "ultra" })).toEqual([[QUALITY_STORAGE_KEY, "ultra"]]);
    expect(settingsToStorage({ masterVolume: 0.5 })).toEqual([[VOLUME_MASTER_KEY, "0.5"]]);
    expect(settingsToStorage({ sfxVolume: 0.5 })).toEqual([[VOLUME_SFX_KEY, "0.5"]]);
    expect(settingsToStorage({ renderer: "webgpu" })).toEqual([[RENDERER_KEY, "webgpu"]]);
    expect(settingsToStorage({ cameraDistanceScale: 1.25 })).toEqual([[CAMERA_DISTANCE_KEY, "1.25"]]);
    expect(settingsToStorage({ mouseSteerSens: 1.5 })).toEqual([[MOUSE_STEER_SENS_KEY, "1.5"]]);
    expect(settingsToStorage({ touchSteerSens: 0.75 })).toEqual([[TOUCH_STEER_SENS_KEY, "0.75"]]);
  });

  it("removes the key for every 'use the config baseline' choice", () => {
    // Auto quality, haptics on, shake on and 1x pan all mean "no override".
    expect(settingsToStorage({ quality: null })).toEqual([[QUALITY_STORAGE_KEY, null]]);
    expect(settingsToStorage({ haptics: true })).toEqual([[HAPTICS_KEY, null]]);
    expect(settingsToStorage({ cameraShake: true })).toEqual([[CAMERA_SHAKE_KEY, null]]);
    expect(settingsToStorage({ cameraPanSens: 1 })).toEqual([[CAMERA_PAN_SENS_KEY, null]]);
    expect(settingsToStorage({ cameraDistanceScale: 1 })).toEqual([[CAMERA_DISTANCE_KEY, null]]);
    // ...and so does a non-inverted pitch axis, which is the default.
    expect(settingsToStorage({ invertPitch: false })).toEqual([[INVERT_PITCH_KEY, null]]);
    expect(settingsToStorage({ mouseSteerSens: 1 })).toEqual([[MOUSE_STEER_SENS_KEY, null]]);
    expect(settingsToStorage({ touchSteerSens: 1 })).toEqual([[TOUCH_STEER_SENS_KEY, null]]);
  });

  it("writes 'off' for disabled flags and 'on' for the opt-in one", () => {
    expect(settingsToStorage({ haptics: false })).toEqual([[HAPTICS_KEY, "off"]]);
    expect(settingsToStorage({ cameraShake: false })).toEqual([[CAMERA_SHAKE_KEY, "off"]]);
    expect(settingsToStorage({ invertPitch: true })).toEqual([[INVERT_PITCH_KEY, "on"]]);
  });

  it("clamps and rounds pan sensitivity before storing it", () => {
    expect(settingsToStorage({ cameraPanSens: 1.4567 })).toEqual([[CAMERA_PAN_SENS_KEY, "1.46"]]);
    expect(settingsToStorage({ cameraPanSens: 99 })).toEqual([[CAMERA_PAN_SENS_KEY, String(PAN_SENS_MAX)]]);
  });

  it("clamps and rounds camera distance before storing it", () => {
    expect(settingsToStorage({ cameraDistanceScale: 1.234 })).toEqual([[CAMERA_DISTANCE_KEY, "1.23"]]);
    expect(settingsToStorage({ cameraDistanceScale: 99 })).toEqual([
      [CAMERA_DISTANCE_KEY, String(CAMERA_DISTANCE_MAX)],
    ]);
  });

  it("ignores keys the patch does not mention", () => {
    expect(settingsToStorage({})).toEqual([]);
  });
});

describe("writeUserSettings", () => {
  it("round-trips through storage", () => {
    const storage = fakeStorage();
    writeUserSettings(storage, {
      quality: "med",
      haptics: false,
      cameraPanSens: 1.5,
      cameraDistanceScale: 1.3,
      mouseSteerSens: 1.8,
      touchSteerSens: 0.6,
      sfxVolume: 0.2,
    });
    expect(readUserSettings(storage)).toMatchObject({
      quality: "med",
      haptics: false,
      cameraPanSens: 1.5,
      cameraDistanceScale: 1.3,
      mouseSteerSens: 1.8,
      touchSteerSens: 0.6,
      sfxVolume: 0.2,
    });
  });

  it("clearing an override restores the config baseline", () => {
    const storage = fakeStorage({ [QUALITY_STORAGE_KEY]: "low", [HAPTICS_KEY]: "off" });
    writeUserSettings(storage, { quality: null, haptics: true });
    expect(storage.map.has(QUALITY_STORAGE_KEY)).toBe(false);
    expect(storage.map.has(HAPTICS_KEY)).toBe(false);
    expect(readUserSettings(storage)).toEqual(DEFAULT_USER_SETTINGS);
  });

  it("never throws when storage rejects writes", () => {
    const throwing: SettingsStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {
        throw new Error("quota");
      },
    };
    expect(() => writeUserSettings(throwing, { quality: "high", haptics: true })).not.toThrow();
  });
});

describe("UserSettingsStore", () => {
  it("notifies listeners only when a value actually changed", () => {
    const store = new UserSettingsStore(fakeStorage());
    const seen: number[] = [];
    store.onChange((v) => seen.push(v.masterVolume));

    store.set({ masterVolume: 0.5 });
    store.set({ masterVolume: 0.5 });
    expect(seen).toEqual([0.5]);
    expect(store.current.masterVolume).toBe(0.5);
  });

  it("unsubscribes cleanly", () => {
    const store = new UserSettingsStore(fakeStorage());
    let calls = 0;
    const off = store.onChange(() => calls++);
    store.set({ haptics: false });
    off();
    store.set({ haptics: true });
    expect(calls).toBe(1);
  });

  it("refresh() picks up a key written by another writer (dev Quality panel)", () => {
    const storage = fakeStorage();
    const store = new UserSettingsStore(storage);
    storage.setItem(QUALITY_STORAGE_KEY, "low");
    expect(store.current.quality).toBeNull();
    store.refresh();
    expect(store.current.quality).toBe("low");
  });
});

describe("clampPanSens", () => {
  it("keeps the multiplier inside the slider range", () => {
    expect(clampPanSens(1)).toBe(1);
    expect(clampPanSens(-3)).toBe(PAN_SENS_MIN);
    expect(clampPanSens(Number.NaN)).toBe(1);
  });
});

describe("clampCameraDistance", () => {
  it("keeps the chase-distance multiplier inside the slider range", () => {
    expect(clampCameraDistance(1.25)).toBe(1.25);
    expect(clampCameraDistance(0)).toBe(CAMERA_DISTANCE_MIN);
    expect(clampCameraDistance(99)).toBe(CAMERA_DISTANCE_MAX);
    expect(clampCameraDistance(Number.NaN)).toBe(1);
  });
});

describe("clampSteerSens", () => {
  it("keeps player multipliers inside the slider range", () => {
    expect(clampSteerSens(1.25)).toBe(1.25);
    expect(clampSteerSens(0)).toBe(STEER_SENS_MIN);
    expect(clampSteerSens(99)).toBe(STEER_SENS_MAX);
    expect(clampSteerSens(Number.NaN)).toBe(1);
  });
});
