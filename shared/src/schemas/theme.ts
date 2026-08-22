import { z } from "zod";
import { baseShape, configId } from "./base.js";

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

/** Module-cluster visual language. Family colors are never keyed by module id. */
export const hudModulesSchema = z.object({
  familyColors: z
    .object({
      laser: z.string().optional(),
      kinetic: z.string().optional(),
      missile: z.string().optional(),
      shield: z.string().optional(),
      /** Support families (2026-08-22): the slowing ray and the repair field. */
      disruptor: z.string().optional(),
      repair: z.string().optional(),
      boost: z.string().optional(),
      utility: z.string().optional(),
      engine: z.string().optional(),
      generator: z.string().optional(),
      /** The alloy bay (2026-08-22), on the socket `transformer` used to hold. */
      hull: z.string().optional(),
      countermeasure: z.string().optional(),
      sensors: z.string().optional(),
    })
    .optional(),
  /** Saturated family-color plate opacity. */
  fillOpacity: z.number().min(0).max(1).optional(),
  /** White mixed into the one-pixel inner rim. */
  innerBorderOpacity: z.number().min(0).max(1).optional(),
  /** Reserved gap between the pointy hex and its caption. */
  labelGapPx: z.number().nonnegative().optional(),
  /** Reserved caption line height used by layout collision checks. */
  labelHeightPx: z.number().positive().optional(),
  /** Maximum caption width; prevents edge clipping without hiding short labels. */
  labelMaxWidthPx: z.number().positive().optional(),
  /** Hairline width shared by the secondary-action rings. */
  ringStrokePx: z.number().positive().optional(),
  /** Angular break between the subtle technical ring segments. */
  ringTickGapDeg: z.number().min(0).max(30).optional(),
  /** Dark framed caption-plate opacity. */
  labelPlateOpacity: z.number().min(0).max(1).optional(),
  /** Family tint opacity on the caption-plate rule. */
  labelBorderOpacity: z.number().min(0).max(1).optional(),
});
export type HudModulesConfig = z.infer<typeof hudModulesSchema>;

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
  /**
   * Desktop auto-center: half-life (ms) of the accumulated mouse offset. A
   * finger lifting resets touch steering, but a mouse never "lifts" — so a
   * stationary mouse lets the virtual stick spring back and steering stops.
   * 0 disables and restores the old hold-forever behaviour.
   */
  mouseCenterHalfLifeMs: z.number().nonnegative().optional(),
  /** Radius of the floating origin marker. */
  originRadiusPx: z.number().positive().optional(),
  /** Radius of the marker at the current drag position. */
  currentRadiusPx: z.number().positive().optional(),
  /** Width of the floating vector line. */
  vectorWidthPx: z.number().positive().optional(),
});
export type RelativeSteerConfig = z.infer<typeof relativeSteerSchema>;

/*
 * REMOVED: `hud.gauges` / `hud.gaugeWidthPx` (and the per-orientation copies).
 * The lower-left gauge panel was retired when hull and shield moved to the
 * centre vital arcs — see `Hud.ts` ("the retired lower-left gauges
 * intentionally reserve no layout slot") and `hudLayout.resolveHudLayout`,
 * which never read them again. They stayed in the schema marked @deprecated,
 * which meant the Theme editor kept generating an accordion of anchor /
 * offsets / track height / segment count controls that changed nothing at all
 * — the worst kind of knob, because turning it looks like it should work.
 *
 * Dropping them from the schema does NOT break a theme that still carries
 * them: zod objects strip unknown keys rather than rejecting, which
 * `themeSchema tolerates retired knobs` pins. No shipped theme authored
 * either field.
 */

/** Player-centred, ship-relative 3D sensor-disc presentation. */
export const radarSchema = z.object({
  /** Canvas side length before `hud.scale` is applied. */
  sizePx: z.number().positive().optional(),
  /** Sensor half-range in world units. */
  rangeUnits: z.number().positive().optional(),
  /** Apparent tilt of the horizontal radar plane. */
  elevationDeg: z.number().min(5).max(80).optional(),
  /** Strength of the ship-relative vertical displacement. */
  altitudeScale: z.number().nonnegative().max(2).optional(),
  /** Maximum on-screen length of one altitude stem. */
  altitudeStemMaxPx: z.number().nonnegative().optional(),
  /** Base radius of ship contact markers. */
  contactSizePx: z.number().positive().optional(),
  /** Opacity of disc rings, axes, and cardinal ticks. */
  gridOpacity: z.number().min(0).max(1).optional(),
});
export type RadarConfig = z.infer<typeof radarSchema>;

/** Subtle hull/shield arcs flanking the player's ship at screen centre. */
export const vitalArcsSchema = z.object({
  /** Defaults false so older themes retain their four lower-left bars. */
  enabled: z.boolean().optional(),
  /** Radius of the implied circle the left/right arcs follow. */
  radiusPx: z.number().positive().optional(),
  strokePx: z.number().positive().optional(),
  /** Visible sweep of each side arc. */
  arcDeg: z.number().min(30).max(180).optional(),
  /** Signed vertical nudge from the viewport centre. */
  offsetYPx: z.number().optional(),
  /** Overall foreground opacity. */
  opacity: z.number().min(0).max(1).optional(),
  /** Empty-track opacity, before the overall opacity is applied. */
  trackOpacity: z.number().min(0).max(1).optional(),
});
export type VitalArcsConfig = z.infer<typeof vitalArcsSchema>;

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

/** Match-end MVP hero presentation. All fields are optional for older packs. */
export const mvpPresentationSchema = z.object({
  /** Total DOM entrance sequence; also the tap-to-skip boundary. */
  sequenceMs: z.number().int().positive().optional(),
  /** Hull push-in/settle duration. */
  hullSettleMs: z.number().int().positive().optional(),
  /** MVP medallion punch duration. */
  badgePunchMs: z.number().int().positive().optional(),
  /** Delay before the pilot name enters. */
  nameDelayMs: z.number().int().nonnegative().optional(),
  /** Delay before stat chips enter and begin counting. */
  statsDelayMs: z.number().int().nonnegative().optional(),
  /** Duration of the stat-chip number count-up. */
  statsCountUpMs: z.number().int().positive().optional(),
  /** Delay before the three actions slide into place. */
  actionsDelayMs: z.number().int().nonnegative().optional(),
  /** Width of the medallion in CSS px before HUD scale. */
  badgeSizePx: z.number().positive().optional(),
  /** Automatic beauty-shot orbit speed. */
  orbitDegreesPerSecond: z.number().min(-10).max(10).optional(),
  /** Warm camera-side key light. */
  keyColor: z.string().optional(),
  keyIntensity: z.number().nonnegative().optional(),
  /** Cool back/rim light. */
  rimColor: z.string().optional(),
  rimIntensity: z.number().nonnegative().optional(),
  /** Cheap emissive display disc under the staged hull. */
  pedestalColor: z.string().optional(),
  pedestalDiameter: z.number().positive().optional(),
});
export type MvpPresentationConfig = z.infer<typeof mvpPresentationSchema>;

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
  /** Overall control opacity. */
  opacity: z.number().min(0).max(1).optional(),
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

/**
 * The PRIMARY WEAPON pedestal — the largest, best-placed action on the flight
 * HUD (COMBAT-REWORK.md §8).
 *
 * It was a dedicated FIRE button until 2026-08-21. There is no FIRE button any
 * more: every weapon is its own trigger on the module rail, and the pilot's
 * first weapon inherits this block's footprint, colour and glow. The name and
 * the CSS custom properties are unchanged so a theme that dressed FIRE still
 * dresses the control that replaced it.
 *
 * `icon` and the four `ring*` fields belonged to the old button and are no
 * longer read by anything — a weapon draws its own module glyph, and its ring is
 * the cooldown arc every module button has. They stay accepted so an existing
 * theme still loads; authoring them does nothing.
 */
export const fireButtonSchema = z.object({
  anchor: hudAnchor.optional(),
  radiusPx: z.number().positive().optional(),
  offsetXPx: z.number().nonnegative().optional(),
  offsetYPx: z.number().nonnegative().optional(),
  /** RETIRED 2026-08-21 (see above). Accepted, ignored. */
  icon: z.string().optional(),
  /** RETIRED 2026-08-21 (see above). Accepted, ignored. */
  ringGapPx: z.number().nonnegative().optional(),
  /** RETIRED 2026-08-21 (see above). Accepted, ignored. */
  ringStrokePx: z.number().nonnegative().optional(),
  /** RETIRED 2026-08-21 (see above). Accepted, ignored. */
  ringArcDeg: z.number().min(0).max(360).optional(),
  /** RETIRED 2026-08-21 (see above). Accepted, ignored. */
  ringTickGapDeg: z.number().min(0).max(30).optional(),
  /** Bright rim/ring color. */
  color: z.string().optional(),
  /** Plate opacity at rest. */
  fillOpacity: z.number().min(0).max(1).optional(),
  /** Rim width. */
  borderPx: z.number().positive().optional(),
  /** Resting outer-glow radius. */
  glowPx: z.number().nonnegative().optional(),
  /** Plate opacity while held/armed. */
  armedFillOpacity: z.number().min(0).max(1).optional(),
  /** Outer-glow radius while held/armed. */
  armedGlowPx: z.number().nonnegative().optional(),
  /** Notification config id for a blocked pull. Absent disables the toast. */
  blockedNotification: z.string().min(1).optional(),
});
export type FireButtonConfig = z.infer<typeof fireButtonSchema>;

/**
 * A secondary flight action (BOOST / JETTISON). Unlike FIRE, its look is
 * shared by the widget; this block only reserves an authored, corner-relative
 * slot in the thumb cluster. Omission preserves the legacy derived placement.
 */
export const flightActionButtonSchema = z.object({
  anchor: hudAnchor.optional(),
  radiusPx: z.number().positive().optional(),
  offsetXPx: z.number().nonnegative().optional(),
  offsetYPx: z.number().nonnegative().optional(),
  /** Family-tinted rim colour for this compact action control. */
  color: z.string().optional(),
});
export type FlightActionButtonConfig = z.infer<typeof flightActionButtonSchema>;

/**
 * One shared radial rail for every secondary flight control.  The rail is
 * centred on FIRE; its slots are re-spaced as the fitting changes.  These are
 * authored intent: the flight-HUD resolver may shorten a narrow-portrait sweep
 * or add an outward overflow ring to retain touch gaps and panel clearance.
 * Angles use screen coordinates (0 = right, -90 = up).
 */
export const flightActionArcSchema = z.object({
  radiusPx: z.number().positive().optional(),
  startDeg: z.number().optional(),
  sweepDeg: z.number().optional(),
  buttonDiameterPx: z.number().positive().optional(),
  captionGapPx: z.number().nonnegative().optional(),
});
export type FlightActionArcConfig = z.infer<typeof flightActionArcSchema>;

/** Authored flight-action rail, plus legacy independent action slots. */
export const flightActionsSchema = z.object({
  arc: flightActionArcSchema.optional(),
  boost: flightActionButtonSchema.optional(),
  jettison: flightActionButtonSchema.optional(),
});
export type FlightActionsConfig = z.infer<typeof flightActionsSchema>;

/**
 * Lock reticle (FLIGHT.md §4). The centre circle's radius is COMPUTED from the
 * ship's resolved `sensors.coneDeg` and the live chase camera (fov + tilt) —
 * see `client/src/game/hud/flightHudLayout.ts` — so it always describes the real
 * sim cone. These knobs are only look + the safety clamp that keeps a cone wider
 * than the camera's field of view on screen.
 */
export const lockReticleSchema = z.object({
  /** Show the full projected lock-cone circle. Target brackets remain active. */
  showZone: z.boolean().optional(),
  /** Ceiling on the reticle radius as a fraction of the viewport's SHORT side / 2. */
  maxRadiusFraction: z.number().gt(0).max(1).optional(),
  /** Circle stroke width. */
  strokePx: z.number().nonnegative().optional(),
  /** Side length of the bracket drawn on the current lock candidate. */
  bracketSizePx: z.number().positive().optional(),
  /** Stroke width of the lock-progress ring around the bracket, while ACQUIRING. */
  ringStrokePx: z.number().nonnegative().optional(),
  /**
   * Stroke width of the same ring once the lock is ACQUIRED (owner 2026-08-22:
   * "lock circle 50% thinner when locked").
   *
   * WHY a second knob rather than one width for both states: the acquiring ring
   * is a *filling gauge* — it has to be thick enough to read a partial sweep
   * against the arena at a glance. Once it completes, the same weight is just a
   * heavy red donut sitting on the target the pilot is trying to look at, and
   * the bracket's corner ticks plus the LOCKED readout already carry the state.
   * Thinning it on completion keeps the confirmation without the mask.
   *
   * Absent, it derives as HALF of {@link ringStrokePx} (see
   * `LOCKED_RING_STROKE_FACTOR` in `client/src/game/hud/flightHudLayout.ts`), so
   * a theme that only authors the acquiring width still gets the thinning — and
   * a theme that wants the old single-weight look sets both to the same number.
   */
  lockedRingStrokePx: z.number().nonnegative().optional(),
  /** Gap from the bracket's right edge to the locked target name. */
  targetNameOffsetPx: z.number().nonnegative().optional(),
  /** Locked target-name font size. */
  targetNameSizePx: z.number().positive().optional(),
  /** Text flashed for a blocked trigger pull. Absent defaults to "NO LOCK". */
  blockedText: z.string().optional(),
  /** Blocked-pull flash duration in milliseconds. Absent defaults to 650. */
  blockedFlashMs: z.number().positive().optional(),
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
  /**
   * Authored, the arrow track is a CIRCLE of this radius about the screen
   * centre instead of the viewport-edge ellipse — sized to sit in the interior
   * of the hull/shield vital arcs, it keeps off-screen contacts inside the
   * pilot's central field of view. Absent = the legacy edge track. The circle
   * is clamped inside the edge ellipse, so a small viewport cannot push arrows
   * off screen.
   */
  ringRadiusPx: z.number().positive().optional(),
  /** Vertical offset of the ring centre, to stay concentric with `vitalArcs.offsetYPx`. */
  ringOffsetYPx: z.number().optional(),
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
  /** Scale applied to enemies that are not the current lock-relevant target. */
  outOfRangeScale: z.number().positive().optional(),
  /** Opacity multiplier applied to non-lock-relevant markers and arrows. */
  outOfRangeOpacity: z.number().min(0).max(1).optional(),
  /** Opacity floor applied after choosing the candidate/far-contact opacity path. */
  markerMinOpacity: z.number().min(0).max(1).optional(),
  /** Side length of the hollow in-view contact diamond before out-of-range scale. */
  markerSizePx: z.number().positive().optional(),
});
export type EnemyArrowsConfig = z.infer<typeof enemyArrowsSchema>;

/** The whole flight HUD block: steering, throttle, boost/FIRE, reticle, arrows, and order feel. */
export const flightHudSchema = z.object({
  joystick: joystickSchema.optional(),
  relativeSteer: relativeSteerSchema.optional(),
  throttle: throttleStripSchema.optional(),
  fire: fireButtonSchema.optional(),
  actions: flightActionsSchema.optional(),
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
  radar: radarSchema.optional(),
  vitalArcs: vitalArcsSchema.optional(),
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
  /** The local player's ship touching the arena boundary. */
  boundaryWarning: soundRef.optional(),
  /** The local player's sensors completing a lock (FLIGHT.md §2/§4). */
  lockAcquired: soundRef.optional(),
  /** The local player losing a completed lock. */
  lockLost: soundRef.optional(),
  /** The local player pulling FIRE without a completed lock. */
  fireBlocked: soundRef.optional(),
  /** Each whole second of the match-start countdown ("3", "2", "1"). */
  countdownTick: soundRef.optional(),
  /** The countdown reaching zero — the "GO" stinger. */
  countdownGo: soundRef.optional(),
});
export type AudioCuesConfig = z.infer<typeof audioCuesSchema>;

/** One streamed/decode-on-demand music asset authored by the theme designer. */
export const musicTrackSchema = z.object({
  /** Pack-relative/public content path, for example `content/sounds/menu.mp3`. */
  src: z.string().min(1),
  /** Per-track trim, multiplied by the player's music volume. */
  volume: z.number().min(0).max(1).optional(),
  loop: z.boolean().optional(),
  /** Attribution, clearance status, or other usage restrictions. */
  license: z.string().optional(),
});
export type MusicTrackConfig = z.infer<typeof musicTrackSchema>;

export const musicScreenSchema = z.enum(["boot", "menu", "hangar", "shop", "match"]);
export type MusicScreen = z.infer<typeof musicScreenSchema>;

/** Theme-owned music library and screen routing. Null explicitly means silence. */
export const musicSchema = z.object({
  enabled: z.boolean().optional(),
  defaultVolume: z.number().min(0).max(1).optional(),
  fadeInSec: z.number().nonnegative().optional(),
  fadeOutSec: z.number().nonnegative().optional(),
  tracks: z.record(z.string().min(1), musicTrackSchema).optional(),
  screens: z
    .object({
      boot: z.string().min(1).nullable().optional(),
      menu: z.string().min(1).nullable().optional(),
      hangar: z.string().min(1).nullable().optional(),
      shop: z.string().min(1).nullable().optional(),
      match: z.string().min(1).nullable().optional(),
    })
    .optional(),
});
export type MusicConfig = z.infer<typeof musicSchema>;

/**
 * Web Audio settings (5.7). Volumes here are only the *defaults* used until the
 * player sets their own — the live values live in localStorage under
 * `sa.volume.master` / `sa.volume.sfx` / `sa.volume.music`, which the 5.8
 * settings screen owns.
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
  music: musicSchema.optional(),
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
      /**
       * Own-side bubble tint. Omitted, it follows the theme's `--hud-shield`,
       * so the world mesh and the HUD's shield readouts cannot drift apart.
       */
      color: z.string().optional(),
      /**
       * ENEMY bubble tint. Omitted, it follows the theme's `--hud-danger` —
       * enemy is red everywhere on the board, markers and shields alike.
       */
      hostileColor: z.string().optional(),
      /** Full ripple cycle duration. */
      periodMs: z.number().positive().optional(),
      /** Bubble radius as a multiple of the ship's collider radius. */
      radiusScale: z.number().positive().optional(),
      /** Scale wobble around `radiusScale` across one cycle. */
      scaleWobble: z.number().min(0).max(1).optional(),
      /**
       * IDLE alpha band — a shield nobody is shooting at. Keep it very low:
       * the bubble is meant to be felt rather than seen until it is hit.
       */
      minAlpha: z.number().min(0).max(1).optional(),
      maxAlpha: z.number().min(0).max(1).optional(),
      /** Peak alpha on an absorb — the flare that makes the shell legible. */
      impactAlpha: z.number().min(0).max(1).optional(),
      /** How long that flare takes to fall back into the idle band. */
      impactDecayMs: z.number().nonnegative().optional(),
    })
    .optional(),
  /**
   * Shaping of the hardpoint deploy/retract sweep. The *timing* stays in the
   * module config (`activation.deployTime`/`retractTime`) — this is only how
   * the mesh moves across that time.
   */
  deploy: z
    .object({
      /**
       * Whether fitted module meshes are drawn on the hull at all (omitted =
       * true). The shipped theme turns this OFF while the module models are
       * placeholders; the deploy/retract state machine, HUD buttons, emitters
       * and shield bubble are untouched — only the hardpoint meshes vanish.
       */
      showMeshes: z.boolean().optional(),
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
/** Key light for a menu scene: where the star is, and how hard it burns. */
const dioramaSun = z.object({
  azimuthDeg: z.number().optional(),
  elevationDeg: z.number().optional(),
  intensity: z.number().nonnegative().optional(),
  /**
   * Degrees of slow azimuth sway around `azimuthDeg`. The specular sheen
   * crawls across the hull while the drawn star never moves — a few degrees
   * is a living highlight, tens of degrees is a searchlight. 0/omitted = off.
   */
  sweepDeg: z.number().nonnegative().max(45).optional(),
  /** Seconds for one full sway cycle. */
  sweepPeriodSec: z.number().positive().optional(),
});

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
  /**
   * The main menu's 3D scene. `kind` picks which one is staged; the others
   * stay authored right here, one word away from coming back — swapping the
   * menu's look must never mean deleting the look it had.
   *
   * Every asset path lives in content rather than in the renderer, so the Theme
   * tool can move a scene without a rebuild and the reachability sweep in
   * `tools/validate-content.ts` can see the art.
   */
  scene: z
    .object({
      /** Which scene to stage. `none` keeps the flat CSS backdrop above. */
      kind: z.enum(["earthrise", "starfield", "none"]).optional(),

      /** The pilot's hull, parked on lunar regolith, with Earth over the horizon. */
      earthrise: z
        .object({
          ground: z
            .object({
              albedo: z.string().min(1),
              normal: z.string().min(1).optional(),
              /** Ambient-occlusion map, if the set ships one. */
              ao: z.string().min(1).optional(),
              /** UV repeats across the plain. Regolith needs a lot of them. */
              tiling: z.number().positive().optional(),
              /** World radius of the plain. Big enough that its edge is off-camera. */
              radius: z.number().positive().optional(),
              /** Height of the gentle undulation displaced into it, in world units. */
              relief: z.number().nonnegative().optional(),
            })
            .optional(),
          /** Prop ids scattered across the plain (boulders). Absent = a bare plain. */
          rocks: z.array(configId).optional(),
          /** Earth on the horizon. Equirectangular maps, content-relative. */
          earth: z
            .object({
              albedo: z.string().min(1),
              /** Grayscale cloud COVERAGE, read as opacity — see the texture credits. */
              clouds: z.string().min(1).optional(),
              /** City lights, shown only on the night side. */
              night: z.string().min(1).optional(),
              normal: z.string().min(1).optional(),
              /** Land/water mask; water gets the specular glint. */
              ocean: z.string().min(1).optional(),
              /** Apparent diameter on screen, as a fraction of viewport height. */
              apparentSize: z.number().positive().max(2).optional(),
              /** Degrees left(-)/right(+) of the camera's forward. */
              azimuthDeg: z.number().optional(),
              /** Degrees above the horizon. Small values are the "rise". */
              elevationDeg: z.number().optional(),
              /** Axial tilt, degrees. */
              tiltDeg: z.number().optional(),
              /** Rotation rate, degrees per second. Slow to notice, not to watch. */
              spinDegPerSec: z.number().optional(),
            })
            .optional(),
          sun: dioramaSun.optional(),
        })
        .optional(),

      /** The hull adrift against a live star, with the galaxy behind it. */
      starfield: z
        .object({
          /**
           * Cubemap prefix, content-relative and WITHOUT the face suffix:
           * `textures/sky/milkyway` loads `milkyway_px.webp` … `_nz.webp`.
           */
          sky: z.string().min(1).optional(),
          /** File extension of the cubemap faces. */
          skyExtension: z.string().min(1).optional(),
          /** How much the galaxy is allowed to light the hull, 0..1. */
          skyLight: z.number().min(0).max(1).optional(),
          /** Degrees per second the sky rotates. Slow — this is drift, not spin. */
          skyDriftDegPerSec: z.number().optional(),
          /**
           * Degrees per second the ENVIRONMENT reflections drift across the
           * hull. Defaults to skyDriftDegPerSec; author it faster to make the
           * metal feel alive without visibly speeding up the galaxy behind it.
           */
          reflectionDriftDegPerSec: z.number().optional(),
          /**
           * Where the pilot's hull sits in frame, and how it is turned.
           *
           * Expressed in the CAMERA's own basis, not in world axes: the diorama
           * camera is placed by the same code that reads this, so "push it
           * right" has to mean right ON SCREEN whatever the camera's yaw is.
           */
          ship: z
            .object({
              /** World units along the camera's right axis. Positive moves the hull right on screen. */
              shiftRight: z.number().optional(),
              /** World units along the camera's up axis. Positive lifts it. */
              lift: z.number().optional(),
              /** Hull yaw in degrees. Picks which face of the ship the camera gets. */
              yawDeg: z.number().optional(),
              /** Hull pitch in degrees; a little nose-up reads as flight, not parking. */
              pitchDeg: z.number().optional(),
              /** Hull roll in degrees, banking the silhouette. */
              rollDeg: z.number().optional(),
            })
            .optional(),
          /** The star itself, drawn by the same animated shader as the title screen. */
          star: z
            .object({
              /** Apparent diameter on screen, as a fraction of viewport height. */
              apparentSize: z.number().positive().max(3).optional(),
              /** Degrees left(-)/right(+) of the camera's forward. */
              azimuthDeg: z.number().optional(),
              /** Degrees above(+)/below(-) the camera's forward. */
              elevationDeg: z.number().optional(),
              /** Photosphere colour at its hottest. */
              core: z.string().optional(),
              /** Photosphere colour in its cooler granulation lanes. */
              shell: z.string().optional(),
              /** Corona and glare colour. */
              corona: z.string().optional(),
              /** Churn rate of the granulation and the corona. 1 = as authored. */
              speed: z.number().nonnegative().max(8).optional(),
            })
            .optional(),
          sun: dioramaSun.optional(),
        })
        .optional(),
    })
    .optional(),
  /** Title treatment for the main menu. */
  title: z
    .object({
      /** Overrides the built-in "ORION'S ARM" wordmark. */
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
      /**
       * How long a menu button's press flash lasts, in ms. The flash is the
       * only feedback a touch player gets that a tap registered, so 0 (off) is
       * a deliberate choice rather than a default worth having.
       */
      clickFlashMs: z.number().int().nonnegative().max(2000).optional(),
    })
    .optional(),
  /** Content-authored copy and timing for the matchmaking search screen. */
  matchmaking: z
    .object({
      flavorLines: z.array(z.string().min(1).max(120)).min(1).optional(),
      /**
       * How long one flavor line holds before the next takes over, in ms.
       * Honoured by `LobbyWaitingOverlay`.
       *
       * REMOVED alongside it: `foundBeatMs` and `pollIntervalMs`. Both
       * described a matchmaker this client does not have — the lobby is pushed
       * by the server as a replicated `phase: "waiting"` snapshot, so there is
       * nothing to poll, and the "match found" hold is already authored as
       * `menu.matchLoadingMinVisibleMs`. Neither was ever read by anything;
       * they only generated Theme-editor controls that did nothing.
       */
      flavorRotationMs: z.number().int().positive().optional(),
    })
    .optional(),
  /** Minimum time the resolved arena card stays visible, even with cached assets. */
  matchLoadingMinVisibleMs: z.number().int().nonnegative().optional(),
});
export type MenuConfig = z.infer<typeof menuSchema>;

/** Optional design-system foundation. Older themes remain valid when omitted. */
export const designTokensSchema = z.object({
  palette: z
    .object({
      blue500: z.string().optional(),
      red500: z.string().optional(),
      /**
       * The one HELPFUL colour (2026-08-22). Blue is "a system of yours is
       * doing something" and red is "ordnance"; a repair field is neither, and
       * the heal numbers it floats have to be readable as good news next to the
       * red damage numbers. Absent keeps the built-in green.
       */
      green500: z.string().optional(),
      white: z.string().optional(),
      n900: z.string().optional(),
      n800: z.string().optional(),
      n700: z.string().optional(),
      n600: z.string().optional(),
      n500: z.string().optional(),
      n400: z.string().optional(),
    })
    .optional(),
  typography: z
    .object({
      h1: z.string().optional(),
      h2: z.string().optional(),
      h3: z.string().optional(),
      body: z.string().optional(),
      caption: z.string().optional(),
      data: z.string().optional(),
    })
    .optional(),
  lineWeights: z
    .object({ hairline: z.string().optional(), thin: z.string().optional(), medium: z.string().optional(), strong: z.string().optional() })
    .optional(),
  radii: z
    .object({ small: z.string().optional(), medium: z.string().optional(), large: z.string().optional() })
    .optional(),
});
export type DesignTokensConfig = z.infer<typeof designTokensSchema>;

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
  /** Shared palette, type, stroke, and corner tokens exposed as CSS variables. */
  tokens: designTokensSchema.optional(),
  hud: z
    .object({
      scale: z.number().positive().optional(),
      /**
       * DISPLAY-ONLY scale from world units to the metres the HUD prints
       * (speed readout, contact/target distance labels). Purely cosmetic — the
       * sim, wire and radar geometry all stay in world units; this just makes
       * the numbers read at the fiction's scale (shipped: 2 m per unit).
       */
      metersPerUnit: z.number().positive().optional(),
      moduleButtonRadiusPx: z.number().positive().optional(),
      safeAreaInsetPx: z.number().nonnegative().optional(),
      /** Gap between module buttons in the bottom-right radial cluster. */
      moduleButtonGapPx: z.number().nonnegative().optional(),
      /** Minimap canvas side length (square), top-left. */
      minimapSizePx: z.number().positive().optional(),
      /**
       * World-space half-extent shown on the minimap (units from center).
       * OMIT IT and the minimap fits the arena's own bounds — which is what
       * you want once arenas differ in size (the Ring's radius-126 bubble vs
       * lunar-rift's box, FLIGHT.md §6). Set it only to deliberately crop or
       * zoom out.
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
      /** Player-centred 3D sensor disc. Legacy minimap fields remain fallbacks. */
      radar: radarSchema.optional(),
      /** Hull/shield arcs flanking the ship at the viewport centre. */
      vitalArcs: vitalArcsSchema.optional(),
      /** Chamfer / glow / panel-fill knobs shared by every HUD widget frame. */
      style: hudStyleSchema.optional(),
      /** Match-end MVP hero-shot choreography and lighting. */
      mvp: mvpPresentationSchema.optional(),
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
      /** Module-cluster family palette and visual treatment. */
      modules: hudModulesSchema.optional(),
      /** Flight controls: joystick, throttle strip, FIRE button, lock reticle (FLIGHT.md §4). */
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
      /** Played when the player destroys an enemy ship. */
      killPattern: z.array(z.number().int().nonnegative()).optional(),
      /**
       * Played the instant the player's sensors complete a lock (FLIGHT.md §4).
       * The lock flip is the moment weapons come live, so it gets its own cue —
       * a short double tick reads as "you may fire" without competing with the
       * heavier kill buzzes.
       */
      lockPattern: z.array(z.number().int().nonnegative()).optional(),
      /** Played when FIRE is pulled without a completed target lock. */
      fireBlockedPattern: z.array(z.number().int().nonnegative()).optional(),
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
