import {
  QUALITY_TIERS,
  qualityTierRank,
  type QualityConfig,
  type QualityTier,
} from "@space-arena/shared";

/**
 * ROADMAP §10 5.6 — pure tier-selection logic for the render quality system.
 *
 * Everything in this module is a plain function over plain data so it can be
 * unit-tested without a browser, an engine or a scene: the device probe, the
 * initial tier pick, and the first-seconds FPS demote/promote decision. The
 * stateful side (applying a tier to the engine/scene) lives in
 * {@link import("./QualityManager.js").QualityManager}.
 */

/** localStorage key holding the player's explicit tier override (settings UI lands in 5.8). */
export const QUALITY_STORAGE_KEY = "sa.quality";

/** What we can learn about the device before rendering a single frame. */
export interface DeviceProbe {
  /** `navigator.hardwareConcurrency`, or 0 when unavailable. */
  cores: number;
  /** `navigator.deviceMemory` in GB, or 0 when unavailable. */
  memoryGb: number;
  /** UA hint that this is a phone/tablet. */
  mobile: boolean;
}

/** The subset of `navigator` the probe reads — keeps the function testable. */
export interface ProbeSource {
  hardwareConcurrency?: number;
  deviceMemory?: number;
  userAgent?: string;
  userAgentData?: { mobile?: boolean };
  maxTouchPoints?: number;
}

/**
 * Read device capabilities. Missing values become 0, which means "no
 * requirement satisfied" — a device that reports nothing lands on the cheapest
 * tier, which is the safe default.
 *
 * `navigator.userAgentData.mobile` is preferred (Chromium); the UA-string regex
 * and the touch-point count are fallbacks for Safari/Firefox.
 */
export function probeDevice(source: ProbeSource | undefined): DeviceProbe {
  const cores = numberOr(source?.hardwareConcurrency, 0);
  const memoryGb = numberOr(source?.deviceMemory, 0);
  const uaMobile = source?.userAgentData?.mobile;
  const ua = source?.userAgent ?? "";
  const mobile =
    typeof uaMobile === "boolean"
      ? uaMobile
      : /Android|iPhone|iPad|iPod|Mobile|Silk|Kindle|Opera Mini|IEMobile/i.test(ua) ||
        (ua !== "" && /Macintosh/.test(ua) && numberOr(source?.maxTouchPoints, 0) > 1); // iPadOS desktop UA
  return { cores, memoryGb, mobile };
}

function numberOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Tier configs sorted cheapest → best. Unknown/duplicate tiers keep their config order. */
export function sortTiers(tiers: readonly QualityConfig[]): QualityConfig[] {
  return [...tiers].sort((a, b) => qualityTierRank(a.tier) - qualityTierRank(b.tier));
}

/** The tier config for a given tier name, if the pack ships one. */
export function tierConfig(
  tiers: readonly QualityConfig[],
  tier: QualityTier,
): QualityConfig | undefined {
  return tiers.find((t) => t.tier === tier);
}

/** Does this device meet a tier's declared `probe` floor? */
export function probePasses(config: QualityConfig, probe: DeviceProbe): boolean {
  if (probe.mobile && !config.probe.allowMobile) return false;
  if (config.probe.minCores > 0 && probe.cores < config.probe.minCores) return false;
  if (config.probe.minMemoryGb > 0 && probe.memoryGb < config.probe.minMemoryGb) return false;
  return true;
}

/**
 * Best tier whose `probe` floor the device clears, walking best → cheapest.
 * Falls back to the cheapest available tier when nothing passes (and to `low`
 * when the pack ships no quality configs at all).
 */
export function selectInitialTier(
  tiers: readonly QualityConfig[],
  probe: DeviceProbe,
): QualityTier {
  const sorted = sortTiers(tiers);
  for (let i = sorted.length - 1; i >= 0; i--) {
    const cfg = sorted[i]!;
    if (probePasses(cfg, probe)) return cfg.tier;
  }
  return sorted[0]?.tier ?? "low";
}

/** Parse a persisted `sa.quality` value; anything unrecognised is ignored. */
export function parseStoredTier(raw: string | null | undefined): QualityTier | null {
  if (!raw) return null;
  const value = raw.trim().toLowerCase();
  return (QUALITY_TIERS as readonly string[]).includes(value) ? (value as QualityTier) : null;
}

/**
 * The tier a session should start on: the player's stored override always wins
 * (they chose it), otherwise the device probe decides.
 */
export function resolveStartTier(
  tiers: readonly QualityConfig[],
  probe: DeviceProbe,
  stored: string | null | undefined,
): { tier: QualityTier; fromOverride: boolean } {
  const override = parseStoredTier(stored);
  if (override && tierConfig(tiers, override)) return { tier: override, fromOverride: true };
  return { tier: selectInitialTier(tiers, probe), fromOverride: false };
}

/** One step up/down the tier ladder, clamped at both ends. */
export function stepTier(
  tiers: readonly QualityConfig[],
  from: QualityTier,
  direction: 1 | -1,
): QualityTier {
  const sorted = sortTiers(tiers);
  const index = sorted.findIndex((t) => t.tier === from);
  if (index < 0) return from;
  const next = sorted[index + direction];
  return next ? next.tier : from;
}

/** Rolling FPS-sample state for one match. Reset per match — one change max. */
export interface AutoTierState {
  /** Milliseconds of match time elapsed. */
  elapsedMs: number;
  /** Frames accumulated inside the sampling window. */
  sampleFrames: number;
  /** Sum of per-frame FPS readings inside the window. */
  sampleFpsSum: number;
  /** Set once the single allowed adjustment has been spent. */
  adjusted: boolean;
}

export function newAutoTierState(): AutoTierState {
  return { elapsedMs: 0, sampleFrames: 0, sampleFpsSum: 0, adjusted: false };
}

export interface AutoTierResult {
  /** Tier to switch to, or null to stay put. */
  tier: QualityTier | null;
  /** Average FPS over the window, or null while the window is still open. */
  averageFps: number | null;
}

const NO_CHANGE: AutoTierResult = { tier: null, averageFps: null };

/**
 * Feed one rendered frame into the auto-tier sampler and decide whether the
 * tier should move.
 *
 * Mutates `state` (it is per-match scratch, allocated once) and returns a
 * decision. Contract:
 * - nothing happens before `autoTier.sampleAfterMs` of match time — warm-up;
 * - FPS is then averaged across `autoTier.sampleWindowMs`;
 * - avg < `demoteBelowFps` steps down one tier, avg > `promoteAboveFps` steps
 *   up one; the gap between them is the hysteresis band, and a threshold of 0
 *   disables that direction;
 * - at most **one** adjustment per match, whatever the result.
 *
 * Non-finite / zero FPS readings (the very first frames, or a hidden tab that
 * never composites) are ignored rather than counted as a stall.
 */
export function sampleAutoTier(
  state: AutoTierState,
  config: QualityConfig,
  tiers: readonly QualityConfig[],
  fps: number,
  dtMs: number,
): AutoTierResult {
  if (state.adjusted) return NO_CHANGE;
  state.elapsedMs += dtMs;
  if (state.elapsedMs < config.autoTier.sampleAfterMs) return NO_CHANGE;
  if (Number.isFinite(fps) && fps > 0) {
    state.sampleFrames += 1;
    state.sampleFpsSum += fps;
  }
  if (state.elapsedMs < config.autoTier.sampleAfterMs + config.autoTier.sampleWindowMs) {
    return NO_CHANGE;
  }

  state.adjusted = true;
  if (state.sampleFrames === 0) return NO_CHANGE; // never saw a usable reading
  const averageFps = state.sampleFpsSum / state.sampleFrames;

  const { demoteBelowFps, promoteAboveFps } = config.autoTier;
  if (demoteBelowFps > 0 && averageFps < demoteBelowFps) {
    const next = stepTier(tiers, config.tier, -1);
    return { tier: next === config.tier ? null : next, averageFps };
  }
  if (promoteAboveFps > 0 && averageFps > promoteAboveFps) {
    const next = stepTier(tiers, config.tier, 1);
    return { tier: next === config.tier ? null : next, averageFps };
  }
  return { tier: null, averageFps };
}
