import type { AbstractEngine } from "@babylonjs/core";
import {
  createLogger,
  qualityTierRank,
  type ConfigEvents,
  type ConfigService,
  type EventBus,
  type QualityConfig,
  type QualityTier,
} from "@space-arena/shared";
import {
  newAutoTierState,
  isSafari,
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
const LEARNED_TIER_PREFIX = "sa.quality.learned.";

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
  private promotedThisSession = false;

  constructor(
    private readonly configs: ConfigService,
    private readonly engine: QualityEngine,
    options: {
      bus?: EventBus<ConfigEvents>;
      storage?: Pick<Storage, "getItem" | "setItem"> | null;
      navigator?: Navigator | undefined;
      devicePixelRatio?: number;
      webglRenderer?: string | null;
    } = {},
  ) {
    this.storage = options.storage === undefined ? safeStorage() : options.storage;
    this.devicePixelRatio = options.devicePixelRatio ?? 1;
    const nav = options.navigator as (Navigator & {
      deviceMemory?: number;
      userAgentData?: { mobile?: boolean };
    }) | undefined;
    this.probe = probeDevice({
      hardwareConcurrency: nav?.hardwareConcurrency,
      deviceMemory: nav?.deviceMemory,
      userAgent: nav?.userAgent,
      userAgentData: nav?.userAgentData,
      maxTouchPoints: nav?.maxTouchPoints,
      webglRenderer: options.webglRenderer ?? readWebglRenderer(),
    });

    const start = resolveStartTier(
      this.tiers,
      this.probe,
      this.storage?.getItem(QUALITY_STORAGE_KEY),
      isSafari(options.navigator),
      this.learnedTier(),
    );
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
    if (!this.fromOverride && !this.promotedThisSession && this.auto.promotionReady) {
      const tiers = this.tiers;
      const index = tiers.findIndex((config) => config.tier === this.tier);
      const next = index >= 0 ? tiers[index + 1]?.tier : undefined;
      if (next) {
        this.promotedThisSession = true;
        this.setTier(next);
        this.persistLearnedTier(next);
      }
    }
    this.auto = newAutoTierState();
  }

  /**
   * Feed one rendered frame to the auto-tier sampler. No-op when the player has
   * an explicit override. Cheap: two adds and a compare until the window closes.
   */
  sampleFrame(fps: number, dtMs: number): void {
    if (this.fromOverride || this.auto.adjusted) return;
    const tiers = this.tiers;
    const result = sampleAutoTier(this.auto, this.current, tiers, fps, dtMs);
    if (result.tier) {
      const target = resolveAutoTierTarget(this.tier, result.tier, this.probe.renderer, tiers);
      log.info("auto-tier adjustment", {
        from: this.tier,
        to: target,
        averageFps: Math.round(result.averageFps ?? 0),
      });
      this.setTier(target);
      this.persistLearnedTier(target);
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
    // Every bound here is a guard against a 0×0 backing store, which is both an
    // invisible canvas and one `drawImage` cannot even sample. A config that
    // ships `maxDevicePixelRatio <= 0` used to drive `dpr` to 0, hence a scaling
    // level of Infinity, which `setSize`'s `width | 0` truncates to zero.
    const cap = Math.max(0.5, cfg.render.maxDevicePixelRatio || 0.5);
    const dpr = Math.min(Math.max(this.devicePixelRatio || 1, 0.5), cap);
    const multiplier = cfg.render.hardwareScalingMultiplier || 1;
    const level = (1 / dpr) * multiplier;
    return Number.isFinite(level) ? Math.min(Math.max(level, 0.25), 4) : 1;
  }

  private applyEngine(): void {
    this.engine.setHardwareScalingLevel(this.hardwareScalingLevel());
  }

  private emit(): void {
    const cfg = this.current;
    for (const listener of this.listeners) listener(cfg);
  }

  private learnedTier(): QualityTier | null {
    const renderer = this.probe.renderer;
    if (!renderer) return null;
    const raw = this.storage?.getItem(`${LEARNED_TIER_PREFIX}${deviceBucket(renderer)}`);
    return raw === "low" || raw === "med" || raw === "high" || raw === "ultra" ? raw : null;
  }

  private persistLearnedTier(tier: QualityTier): void {
    const renderer = this.probe.renderer;
    if (!renderer) return;
    try { this.storage?.setItem(`${LEARNED_TIER_PREFIX}${deviceBucket(renderer)}`, tier); } catch { /* storage unavailable */ }
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.listeners.clear();
  }
}

function deviceBucket(renderer: string): string {
  return renderer.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 96);
}

/**
 * The GPU's own name, for tier selection and for every diagnostic that has to
 * say which machine it is talking about. WebGL2 first: this used to request a
 * WebGL1 context, which reports a WebGL1 renderer string on a machine that
 * would happily have given WebGL2 — and it never released the context either,
 * so every call leaked one against the browser's per-page context limit, and
 * running out of contexts is itself a way to get a black canvas.
 */
export function readWebglRenderer(): string | null {
  try {
    const canvas = document.createElement("canvas");
    const gl = (canvas.getContext("webgl2") ||
      canvas.getContext("webgl") ||
      canvas.getContext("experimental-webgl")) as WebGLRenderingContext | null;
    if (!gl) return null;
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    const name = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : null;
    // Hand the context straight back rather than waiting for a GC that may
    // never come before the next probe.
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return name;
  } catch { return null; }
}

/** `Engine` satisfies {@link QualityEngine}; this alias documents the intent. */
export type BabylonQualityEngine = AbstractEngine & QualityEngine;

/**
 * The auto sampler deliberately adjusts once per match. On legacy Intel UHD
 * 6xx, Ultra's measured demotion to High used to spend that one adjustment on
 * another glow-enabled tier even though the glow pass alone costs ~17 ms in a
 * 5v5 lunar-rift match. Skip to the first shipped non-glow rung so the one-shot
 * decision actually removes the feature that breached the frame budget.
 * Explicit settings overrides never reach this path.
 */
export function resolveAutoTierTarget(
  from: QualityTier,
  proposed: QualityTier,
  renderer: string | null | undefined,
  tiers: readonly QualityConfig[],
): QualityTier {
  if (
    from === "ultra" &&
    proposed === "high" &&
    renderer !== null &&
    renderer !== undefined &&
    /intel(?:\(r\))?.*uhd graphics 6\d\d/i.test(renderer)
  ) {
    const nonGlow = sortTiers(tiers)
      .filter((tier) => qualityTierRank(tier.tier) < qualityTierRank(proposed))
      .reverse()
      .find((tier) => !tier.glow.enabled);
    if (nonGlow) return nonGlow.tier;
  }
  return proposed;
}

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
  autoTier: { sampleAfterMs: 1500, sampleWindowMs: 1000, demoteBelowFps: 26, promoteAboveFps: 56 },
  render: { hardwareScalingMultiplier: 1.15, maxDevicePixelRatio: 2, freezeStatics: true },
  glow: { enabled: true, intensity: 0.35 },
  particles: { enabled: true, budgetMultiplier: 0.6, maxEmitterCapacity: 60 },
  asteroids: { lodMediumDistance: 150, lodLowDistance: 340, lodCullDistance: 900 },
  projectiles: { useInstances: true },
  scene: {
    skyboxEnabled: true,
    boundaryShieldShader: true,
    starfieldPoints: 250,
    // Off, like every shipped tier: spawn gizmos are an authoring aid, and the
    // dev editor forces them back on for itself.
    spawnMarkers: false,
    dust: { count: 180, size: 0.35, alpha: 0.3, driftSpeed: 0.8, boxSize: 120 },
  },
};
