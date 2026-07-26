import { createLogger, type QualityTier } from "@space-arena/shared";
import { QUALITY_STORAGE_KEY, parseStoredTier } from "./qualityTier.js";
import { DEFAULT_VOLUME, VOLUME_MASTER_KEY, VOLUME_SFX_KEY } from "../audio/AudioManager.js";

const log = createLogger("Settings");

/**
 * ROADMAP §10 5.8 — the player's *local* settings: everything the Settings
 * screen owns, and nothing else.
 *
 * Design rules, in the same spirit as the config pipeline:
 *  - **Content stays the baseline.** These values are LOCAL OVERRIDES layered on
 *    top of `theme.json` / `camera.json` / `quality/*.json` at the point of use.
 *    Nothing here edits content, and a cleared key restores the config value
 *    exactly — which is why "auto"/"default" is always represented as an ABSENT
 *    storage key rather than a sentinel string.
 *  - **Pure mapping, testable.** {@link readUserSettings} and
 *    {@link settingsToStorage} are plain functions over a Storage-like object,
 *    so the whole persistence contract is unit-tested without a browser.
 *  - **One writer.** The Settings screen only ever calls
 *    {@link UserSettingsStore.set}; consumers (audio, quality, camera, haptics)
 *    are driven from a single apply pass in `main.ts` subscribed to the store.
 */

/** Storage surface used here — `removeItem` matters: absent means "use the config value". */
export type SettingsStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Renderer backend preference (`?renderer=` also overrides this for one boot). */
export type RendererPref = "webgl" | "webgpu";

/** localStorage key holding the renderer preference (predates 5.8 — kept as-is). */
export const RENDERER_KEY = "spacearena.renderer";
/** `"off"` disables haptics locally even when the theme enables them. */
export const HAPTICS_KEY = "sa.haptics";
/** Multiplier on `camera.pan.sensitivity`. */
export const CAMERA_PAN_SENS_KEY = "sa.camera.panSens";
/** `"off"` disables camera micro-shake locally even when `camera.shake.enabled` is true. */
export const CAMERA_SHAKE_KEY = "sa.camera.shake";
/**
 * `"on"` inverts the flight stick's pitch axis (BUBBLE.md §C). The odd one out
 * among the flags here: every other key stores `"off"` because content is the
 * baseline, but there is no content baseline for "which way does a thumb read" —
 * push-up-to-climb is the default and this key is the opt-IN away from it.
 */
export const INVERT_PITCH_KEY = "sa.controls.invertPitch";

export { QUALITY_STORAGE_KEY, VOLUME_MASTER_KEY, VOLUME_SFX_KEY };

/** The value written to a boolean key when the player turns a feature OFF. */
export const OFF_VALUE = "off";
/** The value written to an opt-IN key when the player turns a feature ON. */
export const ON_VALUE = "on";

/** Bounds on the pan-sensitivity multiplier — a slider, not a footgun. */
export const PAN_SENS_MIN = 0.25;
export const PAN_SENS_MAX = 2.5;

export interface UserSettings {
  /** `null` = Auto (device probe + first-seconds FPS decide). */
  quality: QualityTier | null;
  masterVolume: number;
  sfxVolume: number;
  /** False only when the player disabled them locally; the theme still has a master switch. */
  haptics: boolean;
  /** Multiplier applied on top of `camera.pan.sensitivity`. */
  cameraPanSens: number;
  /** False only when the player disabled it locally; `camera.shake.enabled` still gates it. */
  cameraShake: boolean;
  /** True flips the flight stick's pitch axis (BUBBLE.md §C); default is push-up-to-climb. */
  invertPitch: boolean;
  renderer: RendererPref;
}

/** Values used when no key is stored and no theme default is supplied. */
export const DEFAULT_USER_SETTINGS: UserSettings = {
  quality: null,
  masterVolume: DEFAULT_VOLUME,
  sfxVolume: DEFAULT_VOLUME,
  haptics: true,
  cameraPanSens: 1,
  cameraShake: true,
  invertPitch: false,
  renderer: "webgl",
};

/** Theme-derived fallbacks for the keys that have a content default. */
export interface UserSettingsDefaults {
  masterVolume?: number;
  sfxVolume?: number;
}

export function clampPanSens(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_USER_SETTINGS.cameraPanSens;
  return Math.min(PAN_SENS_MAX, Math.max(PAN_SENS_MIN, value));
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function readNumber(storage: SettingsStorage | null, key: string, fallback: number): number {
  const raw = storage?.getItem(key);
  if (raw === null || raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

/** A boolean key: only the literal `"off"` disables — anything else means "on". */
function readFlag(storage: SettingsStorage | null, key: string): boolean {
  return storage?.getItem(key)?.trim().toLowerCase() !== OFF_VALUE;
}

/** An opt-IN key: only the literal `"on"` enables — absent/anything else is off. */
function readOptIn(storage: SettingsStorage | null, key: string): boolean {
  return storage?.getItem(key)?.trim().toLowerCase() === ON_VALUE;
}

function parseRenderer(raw: string | null | undefined): RendererPref | null {
  const value = raw?.trim().toLowerCase();
  return value === "webgpu" ? "webgpu" : value === "webgl" ? "webgl" : null;
}

/**
 * Read every stored setting. Unknown/corrupt values fall back to the default
 * rather than throwing — a hand-edited localStorage must never brick the boot.
 */
export function readUserSettings(
  storage: SettingsStorage | null,
  defaults: UserSettingsDefaults = {},
): UserSettings {
  const masterDefault = clamp01(defaults.masterVolume ?? DEFAULT_USER_SETTINGS.masterVolume);
  const sfxDefault = clamp01(defaults.sfxVolume ?? DEFAULT_USER_SETTINGS.sfxVolume);
  return {
    quality: parseStoredTier(storage?.getItem(QUALITY_STORAGE_KEY)),
    masterVolume: clamp01(readNumber(storage, VOLUME_MASTER_KEY, masterDefault)),
    sfxVolume: clamp01(readNumber(storage, VOLUME_SFX_KEY, sfxDefault)),
    haptics: readFlag(storage, HAPTICS_KEY),
    cameraPanSens: clampPanSens(readNumber(storage, CAMERA_PAN_SENS_KEY, DEFAULT_USER_SETTINGS.cameraPanSens)),
    cameraShake: readFlag(storage, CAMERA_SHAKE_KEY),
    invertPitch: readOptIn(storage, INVERT_PITCH_KEY),
    renderer: parseRenderer(storage?.getItem(RENDERER_KEY)) ?? DEFAULT_USER_SETTINGS.renderer,
  };
}

/**
 * The storage writes one settings patch implies: `[key, value]`, where a `null`
 * value means **remove the key** (i.e. fall back to the config baseline).
 * Pure — this is the persistence contract the tests pin down.
 */
export function settingsToStorage(patch: Partial<UserSettings>): [string, string | null][] {
  const out: [string, string | null][] = [];
  if ("quality" in patch) out.push([QUALITY_STORAGE_KEY, patch.quality ?? null]);
  if (patch.masterVolume !== undefined) out.push([VOLUME_MASTER_KEY, String(clamp01(patch.masterVolume))]);
  if (patch.sfxVolume !== undefined) out.push([VOLUME_SFX_KEY, String(clamp01(patch.sfxVolume))]);
  if (patch.haptics !== undefined) out.push([HAPTICS_KEY, patch.haptics ? null : OFF_VALUE]);
  if (patch.cameraPanSens !== undefined) {
    const sens = clampPanSens(patch.cameraPanSens);
    // 1x is the config baseline — store nothing rather than a redundant "1".
    out.push([CAMERA_PAN_SENS_KEY, sens === 1 ? null : String(round2(sens))]);
  }
  if (patch.cameraShake !== undefined) out.push([CAMERA_SHAKE_KEY, patch.cameraShake ? null : OFF_VALUE]);
  // Opt-in: "not inverted" is the default, so it is stored as an ABSENT key.
  if (patch.invertPitch !== undefined) out.push([INVERT_PITCH_KEY, patch.invertPitch ? ON_VALUE : null]);
  if (patch.renderer !== undefined) out.push([RENDERER_KEY, patch.renderer]);
  return out;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Apply the writes {@link settingsToStorage} produced. Storage failures are non-fatal. */
export function writeUserSettings(storage: SettingsStorage | null, patch: Partial<UserSettings>): void {
  if (!storage) return;
  for (const [key, value] of settingsToStorage(patch)) {
    try {
      if (value === null) storage.removeItem(key);
      else storage.setItem(key, value);
    } catch {
      // Private mode / quota — the value still applies for this session.
    }
  }
}

/**
 * Stateful wrapper: current values + change notification. Consumers subscribe
 * once and re-apply the whole settings object, which keeps "what a setting
 * does" in exactly one place (`main.ts`'s apply pass) instead of scattered
 * across the UI.
 */
export class UserSettingsStore {
  private values: UserSettings;
  private readonly listeners = new Set<(values: UserSettings) => void>();

  constructor(
    private readonly storage: SettingsStorage | null = safeStorage(),
    private readonly defaults: UserSettingsDefaults = {},
  ) {
    this.values = readUserSettings(this.storage, this.defaults);
  }

  get current(): UserSettings {
    return this.values;
  }

  /** Merge a patch, persist it, and notify listeners (only when something changed). */
  set(patch: Partial<UserSettings>): void {
    writeUserSettings(this.storage, patch);
    const next = readUserSettings(this.storage, this.defaults);
    if (shallowEqual(next, this.values)) return;
    this.values = next;
    log.info("settings changed", patch);
    for (const listener of this.listeners) listener(next);
  }

  /** Re-read from storage (another tab / the dev Quality panel wrote a key). */
  refresh(): void {
    const next = readUserSettings(this.storage, this.defaults);
    if (shallowEqual(next, this.values)) return;
    this.values = next;
    for (const listener of this.listeners) listener(next);
  }

  onChange(listener: (values: UserSettings) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.listeners.clear();
  }
}

function shallowEqual(a: UserSettings, b: UserSettings): boolean {
  return (
    a.quality === b.quality &&
    a.masterVolume === b.masterVolume &&
    a.sfxVolume === b.sfxVolume &&
    a.haptics === b.haptics &&
    a.cameraPanSens === b.cameraPanSens &&
    a.cameraShake === b.cameraShake &&
    a.invertPitch === b.invertPitch &&
    a.renderer === b.renderer
  );
}

function safeStorage(): SettingsStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null; // storage disabled (some privacy modes throw on access)
  }
}
