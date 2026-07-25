import { z } from "zod";
import { baseShape } from "./base.js";

/** Screen corner the module-button cluster hangs off. */
export const hudAnchor = z.enum(["bottom-right", "bottom-left", "top-right", "top-left"]);
export type HudAnchorName = z.infer<typeof hudAnchor>;

/**
 * Layout of the round module buttons (§2.3 "one radial button per fitted
 * module"). Every number is in CSS px *before* `hud.scale` is applied.
 *
 * Geometry is expressed relative to a pivot point at the anchored corner
 * (inside the safe-area inset). `arc` fans the buttons along a circle of
 * `arcRadiusPx` from `arcStartDeg` through `arcSweepDeg` (degrees, CCW from the
 * screen +x axis, canonical for a bottom-right anchor and mirrored
 * automatically for the other corners); `wrap` packs them into rows of
 * `maxPerRow` growing away from the corner.
 */
export const moduleClusterSchema = z.object({
  anchor: hudAnchor.optional(),
  layout: z.enum(["arc", "wrap"]).optional(),
  /** Button radius. Overrides the legacy `hud.moduleButtonRadiusPx`. */
  buttonRadiusPx: z.number().positive().optional(),
  /** Edge-to-edge spacing between buttons. Overrides `hud.moduleButtonGapPx`. */
  gapPx: z.number().nonnegative().optional(),
  /** `arc` only: distance from the pivot to each button centre. */
  arcRadiusPx: z.number().nonnegative().optional(),
  /** `arc` only: angle of the first button, degrees CCW from screen +x. */
  arcStartDeg: z.number().optional(),
  /** `arc` only: total sweep across all buttons (sign = direction). */
  arcSweepDeg: z.number().optional(),
  /** `wrap` only: buttons per row before wrapping away from the corner. */
  maxPerRow: z.number().int().positive().optional(),
  /** Extra push away from the anchored vertical edge. */
  offsetXPx: z.number().nonnegative().optional(),
  /** Extra push away from the anchored horizontal edge. */
  offsetYPx: z.number().nonnegative().optional(),
});
export type ModuleClusterConfig = z.infer<typeof moduleClusterSchema>;

/**
 * Per-orientation overrides layered on top of the base `hud` block. Only the
 * fields a phone actually needs to re-scale between portrait and landscape —
 * anything omitted falls through to the base block.
 */
export const hudOrientationSchema = z.object({
  scale: z.number().positive().optional(),
  safeAreaInsetPx: z.number().nonnegative().optional(),
  minimapSizePx: z.number().positive().optional(),
  gaugeWidthPx: z.number().positive().optional(),
  thumbZoneFraction: z.number().gt(0).max(1).optional(),
  moduleCluster: moduleClusterSchema.optional(),
});
export type HudOrientationConfig = z.infer<typeof hudOrientationSchema>;

/**
 * A sound id (`laser_fire`) or its unbuilt-asset placeholder form
 * (`[SOUND: laser_fire]`). Both resolve to the same id client-side — see
 * `client/src/audio/soundIds.ts` — so content can carry the tagged placeholder
 * until a real sample exists (§ iron rule 5: placeholders, never fake paths).
 */
const soundRef = z.string().min(1);

/**
 * Event → sound-id defaults (5.7). These are the cues that have no natural
 * config home of their own: a module's *own* sounds ride on its action hooks
 * (`onFire`/`onActivate`/… → `action.play_sound.params.sound`) and an
 * explosion's sound rides on its effect config (`effect.sound`), so neither
 * appears here. Omitting a cue silences it.
 */
export const audioCuesSchema = z.object({
  /** The local player's ship taking hull damage. */
  playerDamaged: soundRef.optional(),
  /** A shield module absorbing a hit on the local player's ship. */
  shieldAbsorb: soundRef.optional(),
  /** The local player destroying an enemy ship. */
  playerKill: soundRef.optional(),
  /** The local player's ship being destroyed. */
  playerDeath: soundRef.optional(),
  /** One of the local player's modules force-shutting on overheat. */
  overheat: soundRef.optional(),
  /** The local player's ship touching the arena boundary. */
  boundaryWarning: soundRef.optional(),
});
export type AudioCuesConfig = z.infer<typeof audioCuesSchema>;

/**
 * Web Audio settings (5.7). Volumes here are only the *defaults* used until the
 * player sets their own — the live values live in localStorage under
 * `sa.volume.master` / `sa.volume.sfx`, which the 5.8 settings screen owns.
 */
export const audioSchema = z.object({
  /** Master switch — false means no AudioContext is ever created. */
  enabled: z.boolean().optional(),
  defaultMasterVolume: z.number().min(0).max(1).optional(),
  defaultSfxVolume: z.number().min(0).max(1).optional(),
  /** Max simultaneously playing synthesized voices; extra plays are dropped. */
  maxVoices: z.number().int().positive().optional(),
  /** Minimum gap between two plays of the SAME sound id (anti machine-gun). */
  retriggerGapMs: z.number().nonnegative().optional(),
  cues: audioCuesSchema.optional(),
});
export type AudioConfig = z.infer<typeof audioSchema>;

/**
 * Combat "juice" knobs (5.7): hit flashes, the shield bubble ripple, hardpoint
 * deploy/retract animation shaping, and explosion variant selection. Camera
 * micro-shake is NOT here — it is a camera-rig knob and lives in `camera.json`.
 */
export const juiceSchema = z.object({
  /** Emissive shell popped on a ship view when it takes damage. */
  hitFlash: z
    .object({
      enabled: z.boolean().optional(),
      durationMs: z.number().positive().optional(),
      /** Hex tint of the flash shell. */
      color: z.string().optional(),
      /** Shell radius as a multiple of the ship's collider radius. */
      scale: z.number().positive().optional(),
      /** Peak alpha at the instant of the hit. */
      intensity: z.number().min(0).max(1).optional(),
      /** Pool size — flashes beyond this in one window are dropped, never allocated. */
      maxConcurrent: z.number().int().positive().optional(),
    })
    .optional(),
  /** Pulsing bubble drawn around a ship while any shield module holds a reservoir. */
  shieldRipple: z
    .object({
      enabled: z.boolean().optional(),
      color: z.string().optional(),
      /** Full ripple cycle duration. */
      periodMs: z.number().positive().optional(),
      /** Bubble radius as a multiple of the ship's collider radius. */
      radiusScale: z.number().positive().optional(),
      /** Scale wobble around `radiusScale` across one cycle. */
      scaleWobble: z.number().min(0).max(1).optional(),
      minAlpha: z.number().min(0).max(1).optional(),
      maxAlpha: z.number().min(0).max(1).optional(),
    })
    .optional(),
  /**
   * Shaping of the hardpoint deploy/retract sweep. The *timing* stays in the
   * module config (`activation.deployTime`/`retractTime`) — this is only how
   * the mesh moves across that time.
   */
  deploy: z
    .object({
      /** World units the module mesh rises along its socket's local +Y while deploying. */
      extendDistance: z.number().nonnegative().optional(),
      /** Back-ease overshoot amount (0 = plain ease-out, no overshoot). */
      overshoot: z.number().min(0).max(3).optional(),
      /** Degrees of settle-spin unwound across the sweep. */
      spinDegrees: z.number().optional(),
    })
    .optional(),
  /** Explosion variant selection for `entityDestroyed` (effect ids, `fx.*`). */
  explosions: z
    .object({
      /** Fallback effect for a destroyed ship with no class-specific variant. */
      default: z.string().optional(),
      /** Effect for a destroyed asteroid. */
      asteroid: z.string().optional(),
      /** Ship `class` → effect id (`light`/`medium`/`heavy`, or any class a pack invents). */
      byShipClass: z.record(z.string(), z.string()).optional(),
      /** Particles emitted per burst BEFORE the quality tier's particle budget scales it. */
      burstCount: z.number().int().positive().optional(),
      /** Pooled particle systems per effect id (round-robin for overlapping bursts). */
      poolPerEffect: z.number().int().positive().optional(),
    })
    .optional(),
});
export type JuiceConfig = z.infer<typeof juiceSchema>;

/**
 * Full-screen menu look (5.8): the Lobby / Settings / Auth screens render
 * *before* the HUD exists, so they cannot read the `--hud-*` custom properties
 * (scoped to `#hud`). This block is their palette, resolved into `--sa-menu-*`
 * variables by `client/src/game/screens/menuTheme.ts`.
 *
 * Everything is optional — omitting the whole block keeps the built-in
 * dark/cyan defaults, which is exactly what every pre-5.8 content pack does.
 */
export const menuSchema = z.object({
  /** Screen palette. Hex colors get a swatch picker in the Theme editor. */
  colors: z
    .object({
      /** Deepest backdrop color, behind the nebula blooms. */
      base: z.string().optional(),
      /** Card/panel fill for grouped sections. */
      panel: z.string().optional(),
      /** Primary accent (cyan in the reference) — titles, primary buttons. */
      primary: z.string().optional(),
      /** Secondary accent (orange in the reference) — hangar/section marks. */
      accent: z.string().optional(),
      /** Body text. */
      text: z.string().optional(),
      /** De-emphasized text (status lines, hints). */
      muted: z.string().optional(),
      /** Control borders / section rules. */
      border: z.string().optional(),
    })
    .optional(),
  /**
   * The dark nebula backdrop. Pure CSS: two radial blooms over `colors.base`
   * plus a procedurally generated star tile — no image assets, no per-frame
   * work.
   */
  backdrop: z
    .object({
      /** Cyan-side bloom color. */
      nebulaPrimary: z.string().optional(),
      /** Orange-side bloom color. */
      nebulaAccent: z.string().optional(),
      /** Bloom opacity 0..1 (0 = flat background). */
      nebulaOpacity: z.number().min(0).max(1).optional(),
      /** Stars per 256x256 tile, 0..1 of the built-in maximum (0 = no starfield). */
      starDensity: z.number().min(0).max(1).optional(),
      /** Corner darkening 0..1. */
      vignette: z.number().min(0).max(1).optional(),
    })
    .optional(),
  /** Title treatment for the main menu. */
  title: z
    .object({
      /** Overrides the built-in "SPACE ARENA" wordmark. */
      text: z.string().optional(),
      /** Tagline under the wordmark; empty string hides it. */
      subtitle: z.string().optional(),
      /** Tracking in em. */
      letterSpacingEm: z.number().min(0).max(2).optional(),
      /** Text-shadow bloom strength 0..1. */
      glow: z.number().min(0).max(1).optional(),
    })
    .optional(),
});
export type MenuConfig = z.infer<typeof menuSchema>;

export const themeSchema = z.object({
  ...baseShape("theme"),
  /** CSS custom-property values, e.g. { "--hud-primary": "#57d8ff" }. */
  colors: z.record(z.string(), z.string()),
  fonts: z
    .object({
      body: z.string().optional(),
      display: z.string().optional(),
    })
    .optional(),
  hud: z
    .object({
      scale: z.number().positive().optional(),
      moduleButtonRadiusPx: z.number().positive().optional(),
      safeAreaInsetPx: z.number().nonnegative().optional(),
      /** Gap between module buttons in the bottom-right radial cluster. */
      moduleButtonGapPx: z.number().nonnegative().optional(),
      /** Minimap canvas side length (square), top-left. */
      minimapSizePx: z.number().positive().optional(),
      /** World-space half-extent shown on the minimap (units from center). */
      minimapRangeUnits: z.number().positive().optional(),
      /** Width of the hull/shield/energy/heat gauge bars. */
      gaugeWidthPx: z.number().positive().optional(),
      /** Max simultaneously visible toast notifications. */
      notificationMaxVisible: z.number().int().positive().optional(),
      /**
       * Bottom fraction of a PORTRAIT screen every in-match control must stay
       * inside (ROADMAP S3 "one thumb"). The module cluster's arc radius/gap is
       * scaled down automatically if the configured layout would break it.
       */
      thumbZoneFraction: z.number().gt(0).max(1).optional(),
      /** Module-button cluster geometry (portrait/base values). */
      moduleCluster: moduleClusterSchema.optional(),
      /** Overrides applied when the viewport is taller than wide. */
      portrait: hudOrientationSchema.optional(),
      /** Overrides applied when the viewport is wider than tall. */
      landscape: hudOrientationSchema.optional(),
    })
    .optional(),
  /**
   * `navigator.vibrate` feedback (5.4). Patterns are raw vibrate arguments in
   * ms (`[on, off, on, ...]`); an empty/absent pattern disables that cue.
   * Browsers without the API are no-ops — no feature detection in content.
   */
  haptics: z
    .object({
      /** Master switch — false silences every cue regardless of pattern. */
      enabled: z.boolean().optional(),
      /** Played when one of the player's own modules force-shuts on overheat. */
      overheatPattern: z.array(z.number().int().nonnegative()).optional(),
      /** Played when the player destroys an enemy ship. */
      killPattern: z.array(z.number().int().nonnegative()).optional(),
    })
    .optional(),
  /**
   * Synthesized SFX (5.7). Sound ids resolve against the client's synth registry
   * (`client/src/audio/synths.ts`); an unknown id warns once and plays nothing.
   */
  audio: audioSchema.optional(),
  /** Hit flash / shield ripple / deploy sweep / explosion variants (5.7). */
  juice: juiceSchema.optional(),
  /** Full-screen menu palette / nebula backdrop / title treatment (5.8). */
  menu: menuSchema.optional(),
});

export type ThemeConfig = z.infer<typeof themeSchema>;
