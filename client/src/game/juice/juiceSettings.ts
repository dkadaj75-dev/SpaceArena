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

/**
 * Which side of the fight a view reads as, from the local player's seat.
 * Mirrors {@link import("../hud/FloatingDamageText.js")}'s damage relation and
 * the HUD's `--hud-danger` / `--hud-primary` split: red is the enemy, the
 * board's blue stays with my own side.
 */
export type ViewRelation = "friendly" | "hostile";

export interface ShieldRippleSettings {
  enabled: boolean;
  /** Own-side bubble tint (theme `--hud-shield` unless the juice block names one). */
  color: string;
  /** Enemy bubble tint (theme `--hud-danger` unless the juice block names one). */
  hostileColor: string;
  periodMs: number;
  /** Bubble radius as a multiple of the ship's collider radius. */
  radiusScale: number;
  /** Fraction of `radiusScale` the bubble breathes in and out across a cycle. */
  scaleWobble: number;
  /**
   * IDLE alpha band — what an untouched shield costs the frame visually. Kept
   * near-invisible on purpose (owner note 2026-08-14): a shield that is not
   * being shot at is information nobody needs, and a permanent bubble over
   * every hull turned the arena into a bag of marbles. The bubble earns its
   * visibility from {@link impactAlpha} when something actually hits it.
   */
  minAlpha: number;
  maxAlpha: number;
  /** Peak alpha at the instant of an absorb — the "I am being shot" read. */
  impactAlpha: number;
  /** Time an impact flare takes to fall back into the idle band. */
  impactDecayMs: number;
}

export interface DeploySettings {
  /**
   * Whether fitted module meshes are drawn on the hull at all. The shipped
   * theme turns this off while the module models are placeholders; the deploy
   * state machine, HUD buttons, emitters and shield stay fully live.
   */
  showMeshes: boolean;
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

/**
 * Visual bank roll (BUBBLE.md §C) — the hull leaning into a turn. Client-only
 * decoration: the sim's orientation model is yaw + pitch with no roll.
 */
export interface BankSettings {
  /** Peak lean in radians at (or past) `referenceRateRadPerSec`; 0 disables banking. */
  maxRad: number;
  /** Turn rate that produces the full lean. */
  referenceRateRadPerSec: number;
  /** Roll smoothing 0..1 per 60 Hz frame (higher = snappier); 1 snaps. */
  lag: number;
}

export interface JuiceSettings {
  hitFlash: HitFlashSettings;
  shieldRipple: ShieldRippleSettings;
  deploy: DeploySettings;
  explosions: ExplosionSettings;
  bank: BankSettings;
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
    hostileColor: "#EF4444",
    periodMs: 1400,
    radiusScale: 1.5,
    scaleWobble: 0.06,
    minAlpha: 0.012,
    maxAlpha: 0.032,
    impactAlpha: 0.5,
    impactDecayMs: 420,
  },
  deploy: { showMeshes: true, extendDistance: 0.18, overshoot: 0.9, spinDegrees: 45 },
  // ~26° at a 1.5 rad/s turn: readable as a lean, well short of the barrel roll
  // the sim would never agree to.
  bank: { maxRad: 0.45, referenceRateRadPerSec: 1.5, lag: 0.12 },
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
      // The bubble is a WORLD mesh, so it cannot read the HUD's CSS custom
      // properties — but it must still agree with them, or a ship's shield and
      // its marker would disagree about which side it is on. So the tints fall
      // back through the very same theme entries the HUD variables are built
      // from, and only then to the built-in defaults.
      color: j?.shieldRipple?.color ?? theme?.colors?.["--hud-shield"] ?? d.shieldRipple.color,
      hostileColor:
        j?.shieldRipple?.hostileColor ?? theme?.colors?.["--hud-danger"] ?? d.shieldRipple.hostileColor,
      periodMs: j?.shieldRipple?.periodMs ?? d.shieldRipple.periodMs,
      radiusScale: j?.shieldRipple?.radiusScale ?? d.shieldRipple.radiusScale,
      scaleWobble: j?.shieldRipple?.scaleWobble ?? d.shieldRipple.scaleWobble,
      minAlpha: j?.shieldRipple?.minAlpha ?? d.shieldRipple.minAlpha,
      maxAlpha: j?.shieldRipple?.maxAlpha ?? d.shieldRipple.maxAlpha,
      impactAlpha: j?.shieldRipple?.impactAlpha ?? d.shieldRipple.impactAlpha,
      impactDecayMs: j?.shieldRipple?.impactDecayMs ?? d.shieldRipple.impactDecayMs,
    },
    deploy: {
      showMeshes: j?.deploy?.showMeshes ?? d.deploy.showMeshes,
      extendDistance: j?.deploy?.extendDistance ?? d.deploy.extendDistance,
      overshoot: j?.deploy?.overshoot ?? d.deploy.overshoot,
      spinDegrees: j?.deploy?.spinDegrees ?? d.deploy.spinDegrees,
    },
    bank: {
      maxRad: j?.bank?.maxRad ?? d.bank.maxRad,
      referenceRateRadPerSec: j?.bank?.referenceRateRadPerSec ?? d.bank.referenceRateRadPerSec,
      lag: j?.bank?.lag ?? d.bank.lag,
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
 * How much the shell swells at the peak of an impact flare, as a fraction of
 * its idle radius. A module constant rather than a theme knob: it is the shape
 * of the "something just hit this" gesture, not a colour choice — the visible
 * strength of the beat is {@link ShieldRippleSettings.impactAlpha}.
 */
const IMPACT_SCALE_BOOST = 0.06;

/**
 * Strength (0..1) of the impact flare `msSinceImpact` after an absorb landed.
 * Squared falloff — a hard pop on the frame of the hit that is most of the way
 * gone by mid-decay, so consecutive hits read as separate beats instead of
 * smearing into one lit balloon.
 *
 * A non-finite age means "no impact on record" (the initial state, and what a
 * shield-down reset restores), which is flatly zero.
 */
export function shieldImpactFlare(msSinceImpact: number, decayMs: number): number {
  if (!Number.isFinite(msSinceImpact) || decayMs <= 0) return 0;
  const age = Math.max(0, msSinceImpact);
  if (age >= decayMs) return 0;
  const remaining = 1 - age / decayMs;
  return remaining * remaining;
}

/**
 * Shield bubble pose at `elapsedMs` into its (looping) ripple. One cosine cycle
 * per `periodMs`: the bubble breathes between `radiusScale ± scaleWobble` and
 * fades between `minAlpha` and `maxAlpha`, so a shield reads as *alive* rather
 * than as a static sphere stuck to the hull.
 *
 * That idle band is deliberately almost invisible; `msSinceImpact` is what
 * makes a shield legible. On an absorb the shell jumps to `impactAlpha` and
 * swells slightly, then falls back over `impactDecayMs` — so the bubble is a
 * REACTION the player reads as "that shot was stopped", not permanent chrome.
 * Omitting the argument means no impact on record and yields the pure idle
 * pose, which is exactly the state a freshly raised shield sits in.
 */
export function shieldRipplePose(
  elapsedMs: number,
  settings: ShieldRippleSettings,
  msSinceImpact: number = Number.POSITIVE_INFINITY,
): { scale: number; alpha: number } {
  const period = settings.periodMs > 0 ? settings.periodMs : 1;
  // 0..1 over one cycle, rising then falling (cosine → 0 at t=0, 1 at t=0.5).
  const wave = 0.5 - 0.5 * Math.cos((2 * Math.PI * (elapsedMs % period)) / period);
  const idleScale = settings.radiusScale * (1 - settings.scaleWobble + 2 * settings.scaleWobble * wave);
  const idleAlpha = settings.minAlpha + (settings.maxAlpha - settings.minAlpha) * wave;
  const flare = shieldImpactFlare(msSinceImpact, settings.impactDecayMs);
  // `Math.max(0, …)` so a theme that authors an impactAlpha BELOW its own idle
  // band can only ever fail to brighten — a hit must never dim the bubble.
  const alpha = idleAlpha + Math.max(0, settings.impactAlpha - idleAlpha) * flare;
  return { scale: idleScale * (1 + IMPACT_SCALE_BOOST * flare), alpha };
}

/**
 * Bubble tint for a ship, by which side it flies for. Enemy shields read in the
 * board's danger red exactly like their HUD markers and the damage they deal;
 * my own and my team's stay the shield blue.
 */
export function shieldBubbleColorOf(relation: ViewRelation, settings: ShieldRippleSettings): string {
  return relation === "hostile" ? settings.hostileColor : settings.color;
}

/**
 * Which side a ship reads as from the viewer's seat. The viewer's own hull is
 * always friendly whatever the snapshot says about teams; everything else is
 * decided by team, the same test {@link import("../hud/FloatingDamageText.js")}
 * applies to a damage value.
 *
 * An unknown viewer team — spectating, or the frames before the local ship
 * first appears in a snapshot — reads FRIENDLY. That is the safe direction
 * here: painting every hull in the arena red would be a far louder lie than a
 * shield that stays blue for a moment longer than it should.
 */
export function viewRelationOf(
  shipId: number,
  shipTeam: number | undefined,
  viewerId: number | null,
  viewerTeam: number | null,
): ViewRelation {
  if (viewerId !== null && shipId === viewerId) return "friendly";
  if (viewerTeam === null || shipTeam === undefined) return "friendly";
  return shipTeam === viewerTeam ? "friendly" : "hostile";
}
