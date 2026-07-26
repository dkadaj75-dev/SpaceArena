import type { AbstractEngine } from "@babylonjs/core";
import {
  createLogger,
  type ConfigEvents,
  type ConfigService,
  type EventBus,
  type QualityConfig,
  type QualityTier,
} from "@space-arena/shared";
import {
  newAutoTierState,
  probeDevice,
  QUALITY_STORAGE_KEY,
  resolveStartTier,
  sampleAutoTier,
  sortTiers,
  tierConfig,
  type AutoTierState,
  type DeviceProbe,
} from "./qualityTier.js";

const log = createLogger("Quality");

/** Minimal engine surface the manager drives — keeps it constructible in tests. */
export interface QualityEngine {
  setHardwareScalingLevel(level: number): void;
}

/**
 * ROADMAP §10 5.6 — owns the active render-quality tier and pushes it at the
 * engine and every renderer that consumes it.
 *
 * Selection order, cheapest source of truth first:
 *  1. the player's `sa.quality` localStorage override (the 5.8 settings UI will
 *     write it; the dev editor's Quality tab writes it today),
 *  2. otherwise the device probe (cores / memory / mobile hint),
 *  3. optionally adjusted **once per match** by measured FPS in the first
 *     seconds (see {@link sampleAutoTier}) — never when the player set an
 *     explicit override.
 *
 * Consumers subscribe with {@link onChange} and re-read {@link current}; the
 * manager itself only knows about the engine's hardware scaling level.
 */
export class QualityManager {
  private readonly listeners = new Set<(config: QualityConfig) => void>();
  private readonly probe: DeviceProbe;
  private readonly storage: Pick<Storage, "getItem" | "setItem"> | null;
  private auto: AutoTierState = newAutoTierState();
  private tier: QualityTier;
  private fromOverride: boolean;
  private unsubscribe: (() => void) | null = null;
  /** Device pixel ratio ceiling comes from the tier; this is the raw device value. */
  private devicePixelRatio: number;

  constructor(
    private readonly configs: ConfigService,
    private readonly engine: QualityEngine,
    options: {
      bus?: EventBus<ConfigEvents>;
      storage?: Pick<Storage, "getItem" | "setItem"> | null;
      navigator?: Navigator | undefined;
      devicePixelRatio?: number;
    } = {},
  ) {
    this.storage = options.storage === undefined ? safeStorage() : options.storage;
    this.devicePixelRatio = options.devicePixelRatio ?? 1;
    this.probe = probeDevice(options.navigator as never);

    const start = resolveStartTier(this.tiers, this.probe, this.storage?.getItem(QUALITY_STORAGE_KEY));
    this.tier = start.tier;
    this.fromOverride = start.fromOverride;
    log.info("quality tier selected", {
      tier: this.tier,
      fromOverride: this.fromOverride,
      probe: this.probe,
    });
    this.applyEngine();

    // Editing a quality config in the dev editor (or a content hot-reload)
    // re-applies the live tier immediately — the iron rule applies to perf too.
    if (options.bus) {
      this.unsubscribe = options.bus.on("config:changed", (evt) => {
        if (evt.type !== "quality") return;
        this.applyEngine();
        this.emit();
      });
    }
  }

  /** Every quality tier the content pack ships, cheapest first. */
  get tiers(): QualityConfig[] {
    return sortTiers(this.configs.getAll<QualityConfig>("quality"));
  }

  /**
   * The active tier's config. Falls back to a built-in conservative tier when
   * the pack ships none, so the renderer never has to null-check.
   */
  get current(): QualityConfig {
    return tierConfig(this.tiers, this.tier) ?? FALLBACK_TIER;
  }

  get currentTier(): QualityTier {
    return this.tier;
  }

  /** True when the tier came from the player's stored override, not the probe. */
  get isOverridden(): boolean {
    return this.fromOverride;
  }

  get deviceProbe(): DeviceProbe {
    return this.probe;
  }

  /** Subscribe to tier changes. Returns an unsubscribe function. */
  onChange(listener: (config: QualityConfig) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Switch tier. `persist` writes the player's `sa.quality` override (and
   * disables auto-tier for the rest of the session — an explicit choice is not
   * something a frame-rate heuristic gets to undo).
   */
  setTier(tier: QualityTier, options: { persist?: boolean } = {}): void {
    if (options.persist) {
      this.fromOverride = true;
      try {
        this.storage?.setItem(QUALITY_STORAGE_KEY, tier);
      } catch {
        // Private-mode / quota — the tier still applies for this session.
      }
    }
    if (tier === this.tier) return;
    this.tier = tier;
    log.info("quality tier changed", { tier, persisted: options.persist === true });
    this.applyEngine();
    this.emit();
  }

  /**
   * Apply the player's tier choice from the 5.8 settings screen: a tier pins
   * the quality (and disables auto-tier), `null` means **Auto** — the stored
   * override is cleared and the device probe decides again, immediately.
   *
   * The settings store owns persistence, so nothing is written here; this only
   * moves the *live* tier so the choice is visible without a reload.
   */
  applyOverride(tier: QualityTier | null): void {
    if (tier) {
      this.fromOverride = true;
      if (tier !== this.tier) this.setTier(tier);
      return;
    }
    if (!this.fromOverride) return;
    this.fromOverride = false;
    this.auto = newAutoTierState();
    const probed = resolveStartTier(this.tiers, this.probe, null).tier;
    log.info("quality override cleared — back to auto", { tier: probed });
    this.setTier(probed);
  }

  /** Reset the once-per-match auto-tier sampler. Call when a match starts. */
  beginMatch(): void {
    this.auto = newAutoTierState();
  }

  /**
   * Feed one rendered frame to the auto-tier sampler. No-op when the player has
   * an explicit override. Cheap: two adds and a compare until the window closes.
   */
  sampleFrame(fps: number, dtMs: number): void {
    if (this.fromOverride || this.auto.adjusted) return;
    const result = sampleAutoTier(this.auto, this.current, this.tiers, fps, dtMs);
    if (result.tier) {
      log.info("auto-tier adjustment", {
        from: this.tier,
        to: result.tier,
        averageFps: Math.round(result.averageFps ?? 0),
      });
      this.setTier(result.tier);
    }
  }

  /** Re-apply the current tier's hardware scaling (e.g. after a DPR change). */
  refreshDevicePixelRatio(dpr: number): void {
    this.devicePixelRatio = dpr;
    this.applyEngine();
  }

  /**
   * Effective Babylon hardware scaling level: `1 / cappedDpr` scaled by the
   * tier's multiplier. Level > 1 renders fewer pixels than CSS size.
   */
  hardwareScalingLevel(): number {
    const cfg = this.current;
    const dpr = Math.min(Math.max(this.devicePixelRatio, 0.5), cfg.render.maxDevicePixelRatio);
    return (1 / dpr) * cfg.render.hardwareScalingMultiplier;
  }

  private applyEngine(): void {
    this.engine.setHardwareScalingLevel(this.hardwareScalingLevel());
  }

  private emit(): void {
    const cfg = this.current;
    for (const listener of this.listeners) listener(cfg);
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.listeners.clear();
  }
}

/** `Engine` satisfies {@link QualityEngine}; this alias documents the intent. */
export type BabylonQualityEngine = AbstractEngine & QualityEngine;

function safeStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null; // storage disabled (some privacy modes throw on access)
  }
}

/**
 * Used only when a content pack ships no `quality` configs — mirrors
 * `content/quality/med.json` so the renderer always has consumable numbers.
 */
const FALLBACK_TIER: QualityConfig = {
  id: "quality.med",
  type: "quality",
  version: 1,
  name: "Medium (built-in fallback)",
  tier: "med",
  probe: { minCores: 0, minMemoryGb: 0, allowMobile: true },
  autoTier: { sampleAfterMs: 5000, sampleWindowMs: 3000, demoteBelowFps: 26, promoteAboveFps: 56 },
  render: { hardwareScalingMultiplier: 1.15, maxDevicePixelRatio: 2, freezeStatics: true },
  glow: { enabled: true, intensity: 0.35 },
  particles: { enabled: true, budgetMultiplier: 0.6, maxEmitterCapacity: 60 },
  asteroids: { lodMediumDistance: 150, lodLowDistance: 340, lodCullDistance: 900, thinInstances: false },
  projectiles: { useInstances: true },
  scene: {
    skyboxEnabled: true,
    boundaryShieldShader: true,
    starfieldPoints: 250,
    boundsGrid: true,
    spawnMarkers: true,
  },
};
