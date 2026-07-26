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
 * Virtual joystick (FLIGHT.md §4, left thumb). Two axes since the bubble
 * (BUBBLE.md §C): the horizontal axis becomes the flight order's `turn`, the
 * vertical axis its `pitchStick` (push up = climb, flipped by the player's
 * `sa.controls.invertPitch` setting — a preference, never content). Geometry is
 * pivot-relative in the same convention as {@link moduleClusterSchema} — px
 * before `hud.scale`.
 */
export const joystickSchema = z.object({
  /** Mount the reusable fixed joystick. Shipped false while floating touch steering is active. */
  enabled: z.boolean().optional(),
  anchor: hudAnchor.optional(),
  /** Radius of the fixed base ring the thumb travels inside. */
  baseRadiusPx: z.number().positive().optional(),
  /** Radius of the thumb knob drawn at the current stick position. */
  thumbRadiusPx: z.number().positive().optional(),
  /** Extra push away from the anchored vertical edge. */
  offsetXPx: z.number().nonnegative().optional(),
  /** Extra push away from the anchored horizontal edge. */
  offsetYPx: z.number().nonnegative().optional(),
  /**
   * Stick travel (0..1 of the base radius) treated as centre — kills thumb
   * drift. Shared by BOTH axes: the pitch axis is the same physical thumb on
   * the same base ring, so a separate vertical deadzone would only make the
   * stick feel lopsided.
   */
  deadzone: z.number().min(0).max(0.9).optional(),
  /**
   * Response curve exponent on the de-deadzoned magnitude (1 = linear, >1 =
   * finer control near centre). Applies to turn and pitch alike, and never
   * changes either axis's SIGN.
   */
  expo: z.number().positive().optional(),
});
export type JoystickConfig = z.infer<typeof joystickSchema>;

/**
 * Relative steering shared by desktop RMB mouse deltas and free-area touch
 * drags. Touch distances are CSS pixels; mouse sensitivity converts one mouse
 * delta pixel into a fraction of full stick deflection.
 */
export const relativeSteerSchema = z.object({
  /** CSS-pixel drag radius that produces full steering deflection. */
  maxRadiusPx: z.number().positive().optional(),
  /** CSS-pixel radial deadzone around a touch origin / accumulated mouse origin. */
  deadzonePx: z.number().nonnegative().optional(),
  /** Response exponent after removing the radial deadzone. */
  expo: z.number().positive().optional(),
  /** Normalized stick deflection added per desktop mouse-delta pixel. */
  mouseSensitivity: z.number().positive().optional(),
  /** Radius of the floating origin marker. */
  originRadiusPx: z.number().positive().optional(),
  /** Radius of the marker at the current drag position. */
  currentRadiusPx: z.number().positive().optional(),
  /** Width of the floating vector line. */
  vectorWidthPx: z.number().positive().optional(),
});
export type RelativeSteerConfig = z.infer<typeof relativeSteerSchema>;

/** Theme-driven status-gauge placement and geometry. */
export const gaugesSchema = z.object({
  anchor: hudAnchor.optional(),
  offsetXPx: z.number().nonnegative().optional(),
  offsetYPx: z.number().nonnegative().optional(),
  gapPx: z.number().nonnegative().optional(),
  trackHeightPx: z.number().positive().optional(),
  /**
   * Number of segment cells a gauge bar is divided into (the holographic
   * "cell bar" look). The fill is still continuous — the segments are a
   * repeating gap overlay, so a value change never quantizes. 1 = a solid bar.
   */
  segments: z.number().int().positive().optional(),
});
export type GaugesConfig = z.infer<typeof gaugesSchema>;

/**
 * Look-only knobs shared by every HUD widget frame (the sci-fi shape language).
 * Deliberately separate from the geometry blocks above: these never move a
 * control, so a designer can dial the whole HUD between "clean" and "heavy
 * hologram" without re-auditing the one-thumb reach.
 */
export const hudStyleSchema = z.object({
  /**
   * Corner chamfer on HUD panels, gauge frames and module buttons, in px.
   * Drives the `clip-path` cut — 0 gives ordinary square/round corners.
   */
  chamferPx: z.number().nonnegative().optional(),
  /** Outer-glow strength 0..1 on luminous borders and active states. 0 = flat. */
  glow: z.number().min(0).max(1).optional(),
  /** Fill opacity 0..1 of the translucent panel behind framed widgets. */
  panelOpacity: z.number().min(0).max(1).optional(),
  /** Opacity 0..1 of the fine tick marks on gauges/throttle/minimap. 0 hides them. */
  tickOpacity: z.number().min(0).max(1).optional(),
  /**
   * Backdrop blur radius behind translucent panels, in px. 0 disables the
   * filter entirely — it is the one genuinely expensive knob here, so a low-end
   * pack can switch it off without losing the rest of the look.
   */
  blurPx: z.number().nonnegative().optional(),
});
export type HudStyleConfig = z.infer<typeof hudStyleSchema>;

/**
 * Throttle strip (FLIGHT.md §4, right edge, vertical). 0 % at the bottom, 100 %
 * at the top; the thumb stays where it is released, so throttle is a held
 * state, not a spring.
 */
export const throttleStripSchema = z.object({
  anchor: hudAnchor.optional(),
  /** Track width. */
  widthPx: z.number().positive().optional(),
  /** Track height — the full 0..100 % travel. */
  heightPx: z.number().positive().optional(),
  /** Height of the draggable thumb. */
  thumbHeightPx: z.number().positive().optional(),
  /** Extra push away from the anchored vertical edge. */
  offsetXPx: z.number().nonnegative().optional(),
  /** Extra push away from the anchored horizontal edge. */
  offsetYPx: z.number().nonnegative().optional(),
  /**
   * Desktop W/S throttle-key ramp rate, in throttle fraction per second held.
   */
  keyRampPerSec: z.number().positive().optional(),
  /**
   * Throttle change per mouse-wheel notch over the strip — the pointer-side
   * replacement for the W/S nudge. The strip DRAG is unchanged; this is the
   * one-notch fallback for players who never grab the lever.
   */
  wheelStepPerNotch: z.number().positive().optional(),
  /**
   * Number of scale ticks drawn beside the track (look only — the lever is
   * continuous and a tick is never a stop). 0 hides the scale.
   */
  tickCount: z.number().int().nonnegative().optional(),
});
export type ThrottleStripConfig = z.infer<typeof throttleStripSchema>;

/** Hold-to-boost button (FLIGHT.md §4), placed in the module-cluster corner. */
export const boostButtonSchema = z.object({
  anchor: hudAnchor.optional(),
  radiusPx: z.number().positive().optional(),
  offsetXPx: z.number().nonnegative().optional(),
  offsetYPx: z.number().nonnegative().optional(),
  /** Glyph drawn on the button. */
  icon: z.string().optional(),
});
export type BoostButtonConfig = z.infer<typeof boostButtonSchema>;

/**
 * Lock reticle (FLIGHT.md §4). The centre circle's radius is COMPUTED from the
 * ship's resolved `sensors.coneDeg` and the live chase camera (fov + tilt) —
 * see `client/src/game/hud/flightHudLayout.ts` — so it always describes the real
 * sim cone. These knobs are only look + the safety clamp that keeps a cone wider
 * than the camera's field of view on screen.
 */
export const lockReticleSchema = z.object({
  /** Ceiling on the reticle radius as a fraction of the viewport's SHORT side / 2. */
  maxRadiusFraction: z.number().gt(0).max(1).optional(),
  /** Circle stroke width. */
  strokePx: z.number().nonnegative().optional(),
  /** Side length of the bracket drawn on the current lock candidate. */
  bracketSizePx: z.number().positive().optional(),
  /** Stroke width of the lock-progress ring around the bracket. */
  ringStrokePx: z.number().nonnegative().optional(),
});
export type LockReticleConfig = z.infer<typeof lockReticleSchema>;

/**
 * Flight-order emission (FLIGHT.md §4). The client holds the latest input state
 * and only sends when something meaningful changed, so continuous stick/throttle
 * movement stays comfortably inside `tuning.maxOrdersPerSec`.
 */
export const flightOrdersSchema = z.object({
  /** Minimum |Δthrottle| that justifies an order. */
  throttleEpsilon: z.number().positive().optional(),
  /** Minimum |Δturn| that justifies an order. */
  turnEpsilon: z.number().positive().optional(),
  /**
   * Minimum |ΔpitchStick| that justifies an order (BUBBLE.md §C). OMITTED ⇒ the
   * sender reuses `turnEpsilon`: both axes are the same physical thumb on the
   * same −1..1 scale, so a pack that never asked for a separate pitch feel gets
   * an identical one instead of an invented number.
   */
  pitchEpsilon: z.number().positive().optional(),
  /** Resend interval while the input keeps changing (also the trailing-send delay). */
  heartbeatMs: z.number().positive().optional(),
  /**
   * Floor on the gap between two flight orders. Raised automatically if it would
   * let flight alone eat more than its share of `tuning.maxOrdersPerSec`.
   */
  minIntervalMs: z.number().nonnegative().optional(),
});
export type FlightOrdersConfig = z.infer<typeof flightOrdersSchema>;

/**
 * Off-screen enemy direction arrows (BUBBLE.md §C, the bubble's headline HUD
 * feature). In 3D an enemy leaves the frame in any direction — including
 * straight behind — so each one that is not inside the safe viewport rect gets
 * an arrow parked on an elliptical track inset from the screen edges, rotated
 * along the screen-space bearing to it.
 *
 * Tints are NOT here: they reuse the reticle's own custom properties
 * (`--hud-danger` for a plain enemy, `--hud-primary` for the current lock
 * candidate) so a repaint of the lock visuals repaints the arrows with it.
 */
export const enemyArrowsSchema = z.object({
  /** Master switch — false mounts nothing at all. */
  enabled: z.boolean().optional(),
  /** Track inset from the LEFT/RIGHT viewport edges to the ellipse's x radius. */
  insetXPx: z.number().nonnegative().optional(),
  /** Track inset from the TOP/BOTTOM viewport edges to the ellipse's y radius. */
  insetYPx: z.number().nonnegative().optional(),
  /** Arrow glyph side length (it is drawn pointing along +x and rotated). */
  sizePx: z.number().positive().optional(),
  /**
   * Margin inside the viewport an enemy must clear before its arrow appears.
   * Larger values hand the arrow over before the ship visually touches the
   * edge, which stops a blip on the rim from flickering between the two.
   */
  safeMarginPx: z.number().nonnegative().optional(),
  /**
   * Pool ceiling: at most this many arrows exist, ever. Sized for the arena's
   * ship count — the DOM nodes are created once and reused, never per frame.
   */
  maxCount: z.number().int().positive().optional(),
  /** Distance (world units) at or under which an arrow is fully opaque. */
  fadeNearUnits: z.number().nonnegative().optional(),
  /** Distance at or past which an arrow sits at `minOpacity`. Must exceed `fadeNearUnits`. */
  fadeFarUnits: z.number().nonnegative().optional(),
  /** Opacity floor for the most distant enemy — 1 disables the distance fade. */
  minOpacity: z.number().min(0).max(1).optional(),
});
export type EnemyArrowsConfig = z.infer<typeof enemyArrowsSchema>;

/** The whole flight HUD block: steering, throttle, boost, reticle, arrows, and order feel. */
export const flightHudSchema = z.object({
  joystick: joystickSchema.optional(),
  relativeSteer: relativeSteerSchema.optional(),
  throttle: throttleStripSchema.optional(),
  boost: boostButtonSchema.optional(),
  reticle: lockReticleSchema.optional(),
  /** Off-screen enemy direction arrows (BUBBLE.md §C). */
  enemyArrows: enemyArrowsSchema.optional(),
  orders: flightOrdersSchema.optional(),
});
export type FlightHudConfig = z.infer<typeof flightHudSchema>;

/**
 * Per-orientation overrides layered on top of the base `hud` block. Only the
 * fields a phone actually needs to re-scale between portrait and landscape —
 * anything omitted falls through to the base block.
 */
export const hudOrientationSchema = z.object({
  scale: z.number().positive().optional(),
  safeAreaInsetPx: z.number().nonnegative().optional(),
  minimapSizePx: z.number().positive().optional(),
  minimapAltitudeTickPx: z.number().nonnegative().optional(),
  gaugeWidthPx: z.number().positive().optional(),
  gauges: gaugesSchema.optional(),
  thumbZoneFraction: z.number().gt(0).max(1).optional(),
  moduleCluster: moduleClusterSchema.optional(),
  /** Flight-control geometry for this orientation (merged per sub-block). */
  flight: flightHudSchema.optional(),
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
  /** The local player's sensors completing a lock (FLIGHT.md §2/§4). */
  lockAcquired: soundRef.optional(),
  /** The local player losing a completed lock. */
  lockLost: soundRef.optional(),
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
  /**
   * Visual bank roll — the hull leaning into a turn (BUBBLE.md §C). Purely a
   * CLIENT decoration: the sim's orientation model is yaw + pitch with no roll,
   * so nothing here can ever change where a ship flies or what it can shoot.
   * Derived from the heading delta between snapshots, not from stick input, so
   * it reads the same for the local player, a remote pilot and a bot.
   */
  bank: z
    .object({
      /** Peak lean in radians at (or past) `referenceRateRadPerSec`. 0 disables banking. */
      maxRad: z.number().nonnegative().optional(),
      /** Turn rate that produces the full `maxRad` lean. */
      referenceRateRadPerSec: z.number().positive().optional(),
      /** Roll smoothing 0..1 per 60 Hz frame (higher = snappier); 1 snaps. */
      lag: z.number().min(0).max(1).optional(),
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
  /**
   * Panel/button shape language for the menus — the screen-side twin of
   * {@link hudStyleSchema}, so the Lobby, Settings and Results panels can be
   * dialled to the same chamfer and glow as the in-match widgets.
   */
  style: z
    .object({
      /** Corner chamfer on menu panels and buttons, in px. 0 = plain rounded corners. */
      chamferPx: z.number().nonnegative().optional(),
      /** Outer-glow strength 0..1 on panel borders and primary buttons. */
      glow: z.number().min(0).max(1).optional(),
      /** Panel fill opacity 0..1 over the nebula backdrop. */
      panelOpacity: z.number().min(0).max(1).optional(),
    })
    .optional(),
  /** Content-authored copy and timing for the matchmaking search screen. */
  matchmaking: z
    .object({
      flavorLines: z.array(z.string().min(1).max(120)).min(1).optional(),
      flavorRotationMs: z.number().int().positive().optional(),
      foundBeatMs: z.number().int().nonnegative().optional(),
      pollIntervalMs: z.number().int().positive().optional(),
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
      /**
       * World-space half-extent shown on the minimap (units from center).
       * OMIT IT and the minimap fits the arena's own bounds — which is what
       * you want once arenas differ in size (ring-nebula 90 vs deep-field 300,
       * FLIGHT.md §6). Set it only to deliberately crop or zoom out.
       */
      minimapRangeUnits: z.number().positive().optional(),
      /**
       * Length of the relative-altitude tick drawn beside each minimap blip
       * (BUBBLE.md §C). The map stays a top-down (x,z) projection, so the tick
       * is the only thing carrying the bubble's third axis: it grows upward for
       * a contact above the player and downward for one below, saturating at
       * this many px. 0 hides the ticks.
       */
      minimapAltitudeTickPx: z.number().nonnegative().optional(),
      /** Width of the hull/shield/energy/heat gauge bars. */
      gaugeWidthPx: z.number().positive().optional(),
      /** Status-gauge placement and bar geometry. */
      gauges: gaugesSchema.optional(),
      /** Chamfer / glow / panel-fill knobs shared by every HUD widget frame. */
      style: hudStyleSchema.optional(),
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
      /** Flight controls: joystick, throttle strip, boost button, lock reticle (FLIGHT.md §4). */
      flight: flightHudSchema.optional(),
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
      /**
       * Played the instant the player's sensors complete a lock (FLIGHT.md §4).
       * The lock flip is the moment weapons come live, so it gets its own cue —
       * a short double tick reads as "you may fire" without competing with the
       * heavier overheat/kill buzzes.
       */
      lockPattern: z.array(z.number().int().nonnegative()).optional(),
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
