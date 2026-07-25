import type { JuiceConfig, ThemeConfig } from "@space-arena/shared";

/**
 * ROADMAP §10 5.7 — resolution of the theme's `juice` block into fully
 * defaulted settings, plus the pure math the ripple animation runs on.
 *
 * Pure and Babylon-free on purpose: the renderer classes
 * ({@link import("./HitFlash.js").HitFlashPool},
 * {@link import("./ShieldBubble.js").ShieldBubble},
 * {@link import("./ExplosionFx.js").ExplosionFx}) own meshes and particle
 * systems, this owns the numbers — so every feel knob is data and every
 * mapping is testable without a scene.
 */

export interface HitFlashSettings {
  enabled: boolean;
  durationMs: number;
  color: string;
  /** Shell radius as a multiple of the ship's collider radius. */
  scale: number;
  /** Peak alpha at the moment of the hit. */
  intensity: number;
  /** Pool size; flashes beyond it in one window are dropped, never allocated. */
  maxConcurrent: number;
}

export interface ShieldRippleSettings {
  enabled: boolean;
  color: string;
  periodMs: number;
  /** Bubble radius as a multiple of the ship's collider radius. */
  radiusScale: number;
  /** Fraction of `radiusScale` the bubble breathes in and out across a cycle. */
  scaleWobble: number;
  minAlpha: number;
  maxAlpha: number;
}

export interface DeploySettings {
  /** World units the module mesh rises along its socket's local +Y while deploying. */
  extendDistance: number;
  /** Back-ease overshoot amount (0 = plain ease-out). */
  overshoot: number;
  /** Degrees of settle-spin unwound across the sweep. */
  spinDegrees: number;
}

export interface ExplosionSettings {
  /** Effect id for a destroyed ship whose class has no specific variant. */
  defaultEffect: string | null;
  /** Effect id for a destroyed asteroid. */
  asteroidEffect: string | null;
  /** Ship `class` → effect id. */
  byShipClass: Readonly<Record<string, string>>;
  /** Particles per burst BEFORE the quality tier's particle budget scales it. */
  burstCount: number;
  /** Pooled particle systems per effect id (round-robin across overlapping bursts). */
  poolPerEffect: number;
}

export interface JuiceSettings {
  hitFlash: HitFlashSettings;
  shieldRipple: ShieldRippleSettings;
  deploy: DeploySettings;
  explosions: ExplosionSettings;
}

export const DEFAULT_JUICE_SETTINGS: JuiceSettings = {
  hitFlash: {
    enabled: true,
    durationMs: 160,
    color: "#ffd9a0",
    scale: 1.25,
    intensity: 0.5,
    maxConcurrent: 8,
  },
  shieldRipple: {
    enabled: true,
    color: "#57d8ff",
    periodMs: 1400,
    radiusScale: 1.5,
    scaleWobble: 0.06,
    minAlpha: 0.1,
    maxAlpha: 0.26,
  },
  deploy: { extendDistance: 0.18, overshoot: 0.9, spinDegrees: 45 },
  explosions: {
    defaultEffect: null,
    asteroidEffect: null,
    byShipClass: {},
    burstCount: 60,
    poolPerEffect: 3,
  },
};

/** Resolve `theme.juice` against the built-in defaults. Never throws on partial content. */
export function juiceSettingsOf(theme: ThemeConfig | undefined): JuiceSettings {
  const j: JuiceConfig | undefined = theme?.juice;
  const d = DEFAULT_JUICE_SETTINGS;
  return {
    hitFlash: {
      enabled: j?.hitFlash?.enabled ?? d.hitFlash.enabled,
      durationMs: j?.hitFlash?.durationMs ?? d.hitFlash.durationMs,
      color: j?.hitFlash?.color ?? d.hitFlash.color,
      scale: j?.hitFlash?.scale ?? d.hitFlash.scale,
      intensity: j?.hitFlash?.intensity ?? d.hitFlash.intensity,
      maxConcurrent: j?.hitFlash?.maxConcurrent ?? d.hitFlash.maxConcurrent,
    },
    shieldRipple: {
      enabled: j?.shieldRipple?.enabled ?? d.shieldRipple.enabled,
      color: j?.shieldRipple?.color ?? d.shieldRipple.color,
      periodMs: j?.shieldRipple?.periodMs ?? d.shieldRipple.periodMs,
      radiusScale: j?.shieldRipple?.radiusScale ?? d.shieldRipple.radiusScale,
      scaleWobble: j?.shieldRipple?.scaleWobble ?? d.shieldRipple.scaleWobble,
      minAlpha: j?.shieldRipple?.minAlpha ?? d.shieldRipple.minAlpha,
      maxAlpha: j?.shieldRipple?.maxAlpha ?? d.shieldRipple.maxAlpha,
    },
    deploy: {
      extendDistance: j?.deploy?.extendDistance ?? d.deploy.extendDistance,
      overshoot: j?.deploy?.overshoot ?? d.deploy.overshoot,
      spinDegrees: j?.deploy?.spinDegrees ?? d.deploy.spinDegrees,
    },
    explosions: {
      defaultEffect: j?.explosions?.default ?? d.explosions.defaultEffect,
      asteroidEffect: j?.explosions?.asteroid ?? d.explosions.asteroidEffect,
      byShipClass: j?.explosions?.byShipClass ?? d.explosions.byShipClass,
      burstCount: j?.explosions?.burstCount ?? d.explosions.burstCount,
      poolPerEffect: j?.explosions?.poolPerEffect ?? d.explosions.poolPerEffect,
    },
  };
}

/**
 * Explosion variant for a destroyed entity: asteroids take the asteroid effect,
 * ships take their class's variant and fall back to the default. Returns null
 * when the theme configures nothing — the caller then simply plays no burst.
 */
export function explosionEffectIdFor(
  target: { isAsteroid: boolean; shipClass?: string | null },
  settings: ExplosionSettings,
): string | null {
  if (target.isAsteroid) return settings.asteroidEffect;
  const byClass = target.shipClass ? settings.byShipClass[target.shipClass] : undefined;
  return byClass ?? settings.defaultEffect;
}

/**
 * Shield bubble pose at `elapsedMs` into its (looping) ripple. One cosine cycle
 * per `periodMs`: the bubble breathes between `radiusScale ± scaleWobble` and
 * fades between `minAlpha` and `maxAlpha`, so a shield reads as *alive* rather
 * than as a static sphere stuck to the hull.
 */
export function shieldRipplePose(
  elapsedMs: number,
  settings: ShieldRippleSettings,
): { scale: number; alpha: number } {
  const period = settings.periodMs > 0 ? settings.periodMs : 1;
  // 0..1 over one cycle, rising then falling (cosine → 0 at t=0, 1 at t=0.5).
  const wave = 0.5 - 0.5 * Math.cos((2 * Math.PI * (elapsedMs % period)) / period);
  const scale = settings.radiusScale * (1 - settings.scaleWobble + 2 * settings.scaleWobble * wave);
  const alpha = settings.minAlpha + (settings.maxAlpha - settings.minAlpha) * wave;
  return { scale, alpha };
}
