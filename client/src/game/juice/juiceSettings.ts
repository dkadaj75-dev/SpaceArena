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
   *
   * HALVED again on 2026-08-14 (owner request: "shields more transparent"):
   * both the idle band and the impact flare are exactly half their previous
   * values, so the shell reads as glass rather than paint. Halving the WHOLE
   * scale rather than just the idle band keeps the on-hit beat as many times
   * brighter than idle as it ever was — the flare is still the thing you see.
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
  /**
   * Effect id for a MISSILE detonating on what it hit — a warhead going off, not
   * a hull coming apart, so it is a separate (and much smaller) variant from
   * every `entityDestroyed` burst above. Unlike its neighbours this one has no
   * theme key yet: `theme.juice.explosions` is schema-owned elsewhere and zod
   * would strip an unknown field, so the shipped id lives in
   * {@link DEFAULT_JUICE_SETTINGS} until that schema next opens. The renderer
   * falls back to {@link defaultEffect} if a content pack has no such effect.
   */
  missileImpactEffect: string | null;
  /** Ship `class` → effect id. */
  byShipClass: Readonly<Record<string, string>>;
  /** Particles per burst BEFORE the quality tier's particle budget scales it. */
  burstCount: number;
  /** Pooled particle systems per effect id (round-robin across overlapping bursts). */
  poolPerEffect: number;
}

/**
 * WEAPON IMPACT SPARKS (owner request 2026-08-14) — the little spray thrown
 * where a shot actually lands, on a hull, a rock, a prop or the regolith.
 *
 * The split is by DAMAGE TYPE, because that is the one property a player can
 * already feel: energy weapons (lasers, beam lasers) throw a tight pale-blue
 * flash, kinetic ones (the autocannons) throw a wider, longer-lived orange
 * shower. Both are authored as ordinary effect configs
 * (`content/effects/impact-*.json`), so retuning the difference is a content
 * edit — the code only decides WHICH id to play.
 *
 * Like {@link ExplosionSettings.missileImpactEffect} these ids have no theme
 * key yet: `theme.juice` is schema-owned elsewhere and zod would strip an
 * unknown field, so the shipped ids live in {@link DEFAULT_JUICE_SETTINGS}
 * until that schema next opens.
 */
export interface ImpactSparkSettings {
  /** Effect id for an ENERGY weapon landing (`fire.damageType: "energy"`). */
  energyEffect: string | null;
  /** Effect id for a KINETIC weapon landing, and the fallback for anything else. */
  kineticEffect: string | null;
  /**
   * Milliseconds between sparks from ONE channelling beam. A continuous weapon
   * has no per-shot beat to hang a spark on, so it sizzles on this cadence
   * instead — slow enough that a single beam cannot monopolise the pool, fast
   * enough to read as a continuous burn.
   */
  channelIntervalMs: number;
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
  sparks: ImpactSparkSettings;
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
    // Half of the pre-2026-08-14 band (0.012 / 0.032 / 0.5) — see ShieldRippleSettings.
    minAlpha: 0.006,
    maxAlpha: 0.016,
    impactAlpha: 0.25,
    impactDecayMs: 420,
  },
  deploy: { showMeshes: true, extendDistance: 0.18, overshoot: 0.9, spinDegrees: 45 },
  // ~26° at a 1.5 rad/s turn: readable as a lean, well short of the barrel roll
  // the sim would never agree to.
  bank: { maxRad: 0.45, referenceRateRadPerSec: 1.5, lag: 0.12 },
  explosions: {
    defaultEffect: null,
    asteroidEffect: null,
    missileImpactEffect: "fx.missile-impact",
    byShipClass: {},
    burstCount: 60,
    poolPerEffect: 3,
  },
  sparks: {
    energyEffect: "fx.impact-energy",
    kineticEffect: "fx.impact-kinetic",
    channelIntervalMs: 120,
  },
};

/**
 * How much of a full explosion a missile detonation draws. The effect config
 * already authors a smaller, shorter particle burst; this shrinks the flash,
 * shockwave and debris the pooled {@link import("./ExplosionFx.js").ExplosionFx}
 * slot draws around it, so a warhead landing on a hull cannot be mistaken for
 * that hull dying.
 */
export const MISSILE_IMPACT_SCALE = 0.45;

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
      // No theme key (see ExplosionSettings.missileImpactEffect) — the shipped
      // default is the only source until the juice schema carries one.
      missileImpactEffect: d.explosions.missileImpactEffect,
      byShipClass: j?.explosions?.byShipClass ?? d.explosions.byShipClass,
      burstCount: j?.explosions?.burstCount ?? d.explosions.burstCount,
      poolPerEffect: j?.explosions?.poolPerEffect ?? d.explosions.poolPerEffect,
    },
    // No theme keys yet (see ImpactSparkSettings) — the shipped ids and cadence
    // are the only source until the juice schema carries them.
    sparks: { ...d.sparks },
  };
}

/**
 * Which spark effect a landing weapon throws, from the damage type the sim
 * reported for it (`module.fire.damageType`).
 *
 * Energy gets its own tight blue spray; EVERYTHING ELSE takes the kinetic
 * shower. That is deliberate rather than lazy: `kinetic` and `energy` are the
 * only leaf types, and a composite or future one (`hybrid`, which is what
 * missiles carry) has no honest colour of its own — the neutral orange debris
 * spray is the reading that can never be mistaken for "a laser is on you".
 * Missiles do not normally reach here at all: a warhead draws its detonation.
 */
export function sparkEffectIdFor(
  damageType: string | null | undefined,
  settings: ImpactSparkSettings,
): string | null {
  if (damageType === "energy") return settings.energyEffect ?? settings.kineticEffect;
  return settings.kineticEffect ?? settings.energyEffect;
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
 * Effect ids to try for a missile detonation, best first. The dedicated warhead
 * burst leads; the generic death explosion is the fallback so a content pack
 * that predates `fx.missile-impact` still shows SOMETHING at the impact point
 * rather than a missile silently blinking out of existence.
 */
export function missileImpactEffectIdsFor(settings: ExplosionSettings): readonly string[] {
  const ids: string[] = [];
  if (settings.missileImpactEffect) ids.push(settings.missileImpactEffect);
  if (settings.defaultEffect && settings.defaultEffect !== settings.missileImpactEffect) {
    ids.push(settings.defaultEffect);
  }
  return ids;
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
