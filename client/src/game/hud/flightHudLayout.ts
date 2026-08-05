import type {
  EnemyArrowsConfig,
  FlightActionButtonConfig,
  FlightActionArcConfig,
  FlightActionsConfig,
  FireButtonConfig,
  FlightHudConfig,
  FlightOrdersConfig,
  HudAnchorName,
  HudModulesConfig,
  JoystickConfig,
  LockReticleConfig,
  RelativeSteerConfig,
  ThemeConfig,
  ThrottleStripConfig,
} from "@space-arena/shared";
import { anchorSigns, orientationOf, type Orientation, type Viewport } from "./hudLayout.js";

/**
 * Pure layout/geometry math for the flight HUD (FLIGHT.md §4), the same shape as
 * {@link import("./hudLayout.js")}: a plain function of `theme.json` + the
 * viewport, so the portrait/landscape switch, every control dimension and the
 * lock-reticle sizing are unit-testable without a browser — and so nothing
 * flight-related is hardcoded in CSS or in the widgets.
 */

export interface JoystickLayout {
  enabled: boolean;
  anchor: HudAnchorName;
  baseRadiusPx: number;
  thumbRadiusPx: number;
  offsetXPx: number;
  offsetYPx: number;
  deadzone: number;
  expo: number;
}

export interface RelativeSteerLayout {
  maxRadiusPx: number;
  deadzonePx: number;
  expo: number;
  mouseSensitivity: number;
  originRadiusPx: number;
  currentRadiusPx: number;
  vectorWidthPx: number;
}

export interface ThrottleLayout {
  anchor: HudAnchorName;
  widthPx: number;
  heightPx: number;
  thumbHeightPx: number;
  offsetXPx: number;
  offsetYPx: number;
  opacity: number;
  keyRampPerSec: number;
  wheelStepPerNotch: number;
  /** Scale ticks drawn beside the track (look only). 0 hides the scale. */
  tickCount: number;
}

interface CircularControlLayout {
  anchor: HudAnchorName;
  radiusPx: number;
  offsetXPx: number;
  offsetYPx: number;
  icon: string;
}

/** FIRE uses boost geometry plus optional content-bound blocked-pull feedback. */
export interface FireLayout extends CircularControlLayout {
  ringGapPx: number;
  ringStrokePx: number;
  ringArcDeg: number;
  color: string;
  fillOpacity: number;
  borderPx: number;
  glowPx: number;
  armedFillOpacity: number;
  armedGlowPx: number;
  blockedNotification?: string;
}

/** A themed slot for a secondary action in the bottom-right flight cluster. */
export interface FlightActionLayout {
  anchor: HudAnchorName;
  radiusPx: number;
  offsetXPx: number;
  offsetYPx: number;
  color: string;
}

/** Resolved authored rail for fitted modules plus the two dedicated actions. */
export interface FlightActionArcLayout {
  /** Effective (viewport-adapted) outer radius, derived from the authored intent. */
  radiusPx: number;
  startDeg: number;
  /** Effective sweep; narrow portrait rails stop before the lower-left panels. */
  sweepDeg: number;
  buttonDiameterPx: number;
  captionGapPx: number;
  /** A second concentric rail receives overflow so every visible gap stays generous. */
  innerRadiusPx: number;
  /** Keep both rails balanced instead of leaving a single button on the inner arc. */
  outerSlotCapacity: number;
  /** Inner rail omits the throttle-side end cap while keeping a generous pitch. */
  innerStartDeg: number;
  innerSweepDeg: number;
}

/** One slot expressed in the anchored-offset convention used by the widgets. */
export interface FlightActionArcSlot {
  anchor: HudAnchorName;
  radiusPx: number;
  offsetXPx: number;
  offsetYPx: number;
  /** Caption direction; outer rail captions point outward, inner rail inward. */
  captionX: number;
  captionY: number;
  captionGapPx: number;
}

/** BOOST uses the same compact action geometry, tinted with the boost family colour. */
export type BoostLayout = FlightActionLayout;

export interface ModuleVisualLayout {
  fillOpacity: number;
  innerBorderOpacity: number;
  labelGapPx: number;
  labelHeightPx: number;
  labelMaxWidthPx: number;
  boostColor: string;
}

export interface ReticleLayout {
  showZone: boolean;
  maxRadiusFraction: number;
  strokePx: number;
  bracketSizePx: number;
  ringStrokePx: number;
  targetNameOffsetPx: number;
  targetNameSizePx: number;
  blockedText: string;
  blockedFlashMs: number;
}

export interface FlightOrderLayout {
  throttleEpsilon: number;
  turnEpsilon: number;
  pitchEpsilon: number;
  heartbeatMs: number;
  minIntervalMs: number;
}

/** Off-screen enemy arrows (BUBBLE.md §C), fully resolved and scaled. */
export interface EnemyArrowsLayout {
  enabled: boolean;
  insetXPx: number;
  insetYPx: number;
  /**
   * Radius of the CENTRE-RING track, or null for the legacy viewport-edge
   * ellipse. The shipped theme authors it just inside the hull/shield vital
   * arcs so off-screen contacts read in the pilot's central field of view.
   */
  ringRadiusPx: number | null;
  /** Vertical offset of the ring centre (concentric with the vital arcs). */
  ringOffsetYPx: number;
  sizePx: number;
  safeMarginPx: number;
  maxCount: number;
  fadeNearUnits: number;
  fadeFarUnits: number;
  minOpacity: number;
  outOfRangeScale: number;
  outOfRangeOpacity: number;
  markerMinOpacity: number;
  markerSizePx: number;
}

export interface FlightHudLayout {
  orientation: Orientation;
  viewport: Viewport;
  scale: number;
  /**
   * Display-only world-unit → printed-metre factor (`theme.hud.metersPerUnit`,
   * default 1). NOT multiplied by `hud.scale`: it scales numbers, not pixels.
   */
  metersPerUnit: number;
  joystick: JoystickLayout;
  relativeSteer: RelativeSteerLayout;
  throttle: ThrottleLayout;
  modules: ModuleVisualLayout;
  fire: FireLayout;
  /** Null retains independent legacy module/action placement. */
  actionArc: FlightActionArcLayout | null;
  boost: BoostLayout;
  jettison: FlightActionLayout;
  reticle: ReticleLayout;
  enemyArrows: EnemyArrowsLayout;
  orders: FlightOrderLayout;
}

/** Fallbacks for a theme with no (or a partial) `hud.flight` block. */
export const FLIGHT_HUD_DEFAULTS = {
  joystick: {
    enabled: true,
    anchor: "bottom-left",
    baseRadiusPx: 62,
    thumbRadiusPx: 28,
    offsetXPx: 22,
    offsetYPx: 22,
    deadzone: 0.12,
    expo: 1.35,
  },
  relativeSteer: {
    maxRadiusPx: 72,
    deadzonePx: 9,
    expo: 1.35,
    mouseSensitivity: 0.012,
    originRadiusPx: 7,
    currentRadiusPx: 12,
    vectorWidthPx: 2,
  },
  throttle: {
    anchor: "bottom-right",
    widthPx: 44,
    heightPx: 200,
    thumbHeightPx: 26,
    offsetXPx: 6,
    offsetYPx: 212,
    opacity: 1,
    keyRampPerSec: 0.9,
    wheelStepPerNotch: 0.06,
    tickCount: 8,
  },
  modules: {
    // Restrained circular buttons (2026-07-31): the family colour fills only
    // the ACTIVE state at this opacity, and the rim carries it otherwise.
    fillOpacity: 0.32,
    innerBorderOpacity: 0.55,
    labelGapPx: 4,
    labelHeightPx: 11,
    labelMaxWidthPx: 64,
    boostColor: "#e8b44f",
  },
  fire: {
    anchor: "bottom-right",
    radiusPx: 42,
    offsetXPx: 24,
    offsetYPx: 34,
    icon: "FIRE",
    ringGapPx: 7,
    ringStrokePx: 2,
    ringArcDeg: 260,
    color: "#ff4655",
    fillOpacity: 0.3,
    borderPx: 2,
    glowPx: 10,
    armedFillOpacity: 0.52,
    armedGlowPx: 18,
    blockedNotification: undefined,
  },
  reticle: {
    showZone: true,
    maxRadiusFraction: 0.82,
    strokePx: 2,
    bracketSizePx: 54,
    ringStrokePx: 4,
    targetNameOffsetPx: 12,
    targetNameSizePx: 10,
    blockedText: "NO LOCK",
    blockedFlashMs: 650,
  },
  enemyArrows: {
    enabled: true,
    insetXPx: 34,
    insetYPx: 46,
    // Built-in default stays the legacy edge track: the centre ring is an
    // opt-in whose radius only makes sense against a theme's own vital arcs.
    ringRadiusPx: null as number | null,
    ringOffsetYPx: 0,
    sizePx: 20,
    safeMarginPx: 26,
    maxCount: 8,
    fadeNearUnits: 60,
    fadeFarUnits: 320,
    minOpacity: 0.35,
    outOfRangeScale: 0.6,
    outOfRangeOpacity: 0.4,
    markerMinOpacity: 0.35,
    markerSizePx: 10,
  },
  orders: {
    throttleEpsilon: 0.02,
    turnEpsilon: 0.05,
    // No built-in of its own: an omitted pitch epsilon IS the turn epsilon (see
    // `resolveFlightHudLayout`), which is what keeps the two stick axes matched.
    pitchEpsilon: 0.05,
    heartbeatMs: 250,
    minIntervalMs: 120,
  },
  actions: {
    // The old boost implementation mirrored FIRE onto the left thumb. These
    // fallbacks keep unextended themes functional while placing both auxiliary
    // controls in the same bottom-right cluster as FIRE.
    boost: { anchor: "bottom-right", radiusPx: 26, offsetXPx: 132, offsetYPx: 96, color: "#e8b44f" },
    jettison: { anchor: "bottom-right", radiusPx: 26, offsetXPx: 72, offsetYPx: 142, color: "#5ec9e8" },
  },
  actionArc: null,
} as const satisfies Omit<
  FlightHudLayout,
  "orientation" | "viewport" | "scale" | "metersPerUnit" | "boost" | "jettison"
> & { actions: { boost: FlightActionLayout; jettison: FlightActionLayout } };

/**
 * BOOST's radius as a fraction of FIRE's. It is the secondary control of the
 * pair, but the ratio is chosen so the shipped theme still clears a 44 px touch
 * target at landscape scale (36 px × 0.85 × 2 × 0.72 ≈ 44 px).
 */
export const BOOST_RADIUS_RATIO = 0.72;

/**
 * How far BOOST is lifted off its corner inset, in FIRE RADII, on top of FIRE's
 * own offset. The mirrored corner is where the gauge stack lives, and this is
 * the shortest lift that clears it in both orientations of the shipped theme
 * while keeping the button inside the bottom thumb band — the
 * "shipped phone control geometry" audit in flightHudLayout.test.ts is what
 * holds that claim honest.
 */
export const BOOST_LIFT_RADII = 3;

/** Mirror an anchor across the vertical axis (bottom-right ⇄ bottom-left). */
export function mirrorAnchorX(anchor: HudAnchorName): HudAnchorName {
  switch (anchor) {
    case "bottom-right":
      return "bottom-left";
    case "bottom-left":
      return "bottom-right";
    case "top-right":
      return "top-left";
    default:
      return "top-right";
  }
}

/**
 * BOOST's geometry, derived from the already-scaled FIRE layout (so nothing here
 * multiplies by `hud.scale` a second time).
 *
 * See {@link BOOST_LIFT_RADII} for why it is lifted rather than sitting at
 * FIRE's own height.
 */
export function boostLayoutFrom(fire: FireLayout, color: string): BoostLayout {
  return {
    anchor: mirrorAnchorX(fire.anchor),
    radiusPx: fire.radiusPx * BOOST_RADIUS_RATIO,
    offsetXPx: fire.offsetXPx,
    offsetYPx: fire.offsetYPx + fire.radiusPx * BOOST_LIFT_RADII,
    color,
  };
}

function actionLayoutFrom(
  action: FlightActionButtonConfig | undefined,
  fallback: (typeof FLIGHT_HUD_DEFAULTS.actions)[keyof typeof FLIGHT_HUD_DEFAULTS.actions],
  scale: number,
): FlightActionLayout {
  return {
    anchor: action?.anchor ?? fallback.anchor,
    radiusPx: (action?.radiusPx ?? fallback.radiusPx) * scale,
    offsetXPx: (action?.offsetXPx ?? fallback.offsetXPx) * scale,
    offsetYPx: (action?.offsetYPx ?? fallback.offsetYPx) * scale,
    color: action?.color ?? fallback.color,
  };
}

function actionArcLayoutFrom(
  action: FlightActionArcConfig | undefined,
  scale: number,
  viewport: Viewport,
): FlightActionArcLayout | null {
  if (!action) return null;
  const radiusPx = (action.radiusPx ?? 0) * scale;
  const startDeg = action.startDeg ?? -90;
  const authoredSweepDeg = action.sweepDeg ?? -90;
  const buttonDiameterPx = (action.buttonDiameterPx ?? 48) * scale;
  // At phone widths, the authored -180° end point puts the far rail button at
  // the height of the left-side vitals.  Preserve the upward FIRE-centred
  // gesture, but stop at -150° before it can enter that reserved panel area.
  const sweepDeg =
    viewport.width < 600 && viewport.height >= viewport.width && authoredSweepDeg < 0
      ? Math.max(authoredSweepDeg, -150 - startDeg)
      : authoredSweepDeg;
  const narrowPortrait = viewport.width < 600 && viewport.height >= viewport.width;
  const sweepDirection = Math.sign(sweepDeg) || 1;
  return {
    radiusPx,
    startDeg,
    sweepDeg,
    buttonDiameterPx,
    captionGapPx: (action.captionGapPx ?? 4) * scale,
    // A radial separation of one square diagonal plus the circular 8px gap
    // makes two same-angle slots clear under both the touch-circle and the
    // audit's conservative axis-aligned button rectangles.
    innerRadiusPx: radiusPx - (buttonDiameterPx * Math.SQRT2 + 8 * scale),
    outerSlotCapacity: 4,
    innerStartDeg: narrowPortrait ? startDeg + sweepDirection * 8 : startDeg + sweepDeg * 0.08,
    innerSweepDeg: narrowPortrait ? sweepDeg - sweepDirection * 3 : sweepDeg * 0.84,
  };
}

/**
 * The only positioning rule for the shipped bottom-right flight controls.
 * Modules occupy the first slots (weapons are supplied before utilities by the
 * fitting), then BOOST, then JETTISON.  Legacy themes without `actions.arc`
 * deliberately receive no slots and continue through their old offsets.
 */
export function flightActionArcSlots(layout: FlightHudLayout, moduleCount: number): FlightActionArcSlot[] {
  const arc = layout.actionArc;
  if (!arc) return [];
  const total = Math.max(1, moduleCount + 2);
  const fire = layout.fire;
  const fireCentre = anchoredOffset(fire.anchor, fire.offsetXPx, fire.offsetYPx, fire.radiusPx);
  const radiusPx = arc.buttonDiameterPx / 2;
  // A rail of five or more controls uses two evenly populated concentric arcs.
  // This avoids tight mid-arc pairs and keeps the visual rhythm symmetrical as
  // fitted modules are added.  Order remains modules, BOOST, then JETTISON.
  const outerCount = total > arc.outerSlotCapacity ? Math.ceil(total / 2) : total;
  const innerCount = total - outerCount;
  const slots: FlightActionArcSlot[] = [];
  for (let index = 0; index < total; index++) {
    const isInner = index >= outerCount;
    const countOnRail = isInner ? innerCount : outerCount;
    const indexOnRail = isInner ? index - outerCount : index;
    // The inner rail is centred on the outer rail on regular viewports and
    // omits its end caps. Narrow portrait shifts it a few degrees left of the
    // throttle-side approach, while retaining even, unclustered spacing.
    const railStartDeg = isInner ? arc.innerStartDeg : arc.startDeg;
    const railSweepDeg = isInner ? arc.innerSweepDeg : arc.sweepDeg;
    const deg =
      railStartDeg +
      (countOnRail === 1 ? railSweepDeg / 2 : (railSweepDeg * indexOnRail) / (countOnRail - 1));
    const radians = (deg * Math.PI) / 180;
    const radialX = Math.cos(radians);
    const radialY = Math.sin(radians);
    const railRadiusPx = isInner ? arc.innerRadiusPx : arc.radiusPx;
    const centreX = fireCentre.dx + railRadiusPx * radialX;
    const centreY = fireCentre.dy + railRadiusPx * radialY;
    // Convert an exact pivot-relative centre back to the existing anchored
    // offset representation, so no widget needs bespoke corner math.
    const signs = anchorSigns(fire.anchor);
    slots.push({
      anchor: fire.anchor,
      radiusPx,
      offsetXPx: signs.x < 0 ? -centreX - radiusPx : centreX - radiusPx,
      offsetYPx: signs.y < 0 ? -centreY - radiusPx : centreY - radiusPx,
      // Inner captions face the open centre rather than crossing the outer
      // rail's buttons; their own action surface remains immediately outside.
      captionX: isInner ? -radialX : radialX,
      captionY: isInner ? -radialY : radialY,
      captionGapPx: arc.captionGapPx,
    });
  }
  return slots;
}

/**
 * Share of `tuning.maxOrdersPerSec` the flight sender may spend. The rest is
 * headroom for the orders a player issues WHILE flying (module toggles, and the
 * interim target pin), so a full-rate stick can never starve them or trip the
 * server's rate limiter.
 */
export const FLIGHT_ORDER_BUDGET_SHARE = 0.5;

function merge<T extends object>(base: T | undefined, over: T | undefined): T {
  const out: Record<string, unknown> = { ...(base ?? {}) };
  for (const [key, value] of Object.entries(over ?? {})) if (value !== undefined) out[key] = value;
  return out as T;
}

/**
 * Resolve `theme.hud.flight`, layer the matching orientation override on top
 * (per sub-block, so a landscape override of the joystick keeps the base
 * throttle), then scale every control dimension by `hud.scale` — exactly the
 * contract {@link import("./hudLayout.js").resolveHudLayout} follows. Deadzone,
 * expo, ramp rate and the order thresholds are NOT scaled: they are feel, not
 * geometry.
 */
export function resolveFlightHudLayout(
  theme: ThemeConfig | undefined,
  viewport: Viewport,
): FlightHudLayout {
  const orientation = orientationOf(viewport);
  const hud = theme?.hud;
  const override = (orientation === "landscape" ? hud?.landscape : hud?.portrait) ?? {};
  const scale = override.scale ?? hud?.scale ?? 1;

  const base: FlightHudConfig = hud?.flight ?? {};
  const over: FlightHudConfig = override.flight ?? {};
  const joystick: JoystickConfig = merge(base.joystick, over.joystick);
  const relativeSteer: RelativeSteerConfig = merge(base.relativeSteer, over.relativeSteer);
  const throttle: ThrottleStripConfig = merge(base.throttle, over.throttle);
  const modules: HudModulesConfig = hud?.modules ?? {};
  const fire: FireButtonConfig = merge(base.fire, over.fire);
  const actions: FlightActionsConfig = {
    arc:
      base.actions?.arc || over.actions?.arc
        ? merge(base.actions?.arc, over.actions?.arc)
        : undefined,
    boost: merge(base.actions?.boost, over.actions?.boost),
    jettison: merge(base.actions?.jettison, over.actions?.jettison),
  };
  const reticle: LockReticleConfig = merge(base.reticle, over.reticle);
  const arrows: EnemyArrowsConfig = merge(base.enemyArrows, over.enemyArrows);
  const orders: FlightOrdersConfig = merge(base.orders, over.orders);
  const d = FLIGHT_HUD_DEFAULTS;
  const turnEpsilon = orders.turnEpsilon ?? d.orders.turnEpsilon;
  const boostColor = modules.familyColors?.boost ?? d.modules.boostColor;
  // Resolved up front, not inline: BOOST's geometry is derived from it.
  const fireLayout: FireLayout = {
    anchor: fire.anchor ?? d.fire.anchor,
    radiusPx: (fire.radiusPx ?? d.fire.radiusPx) * scale,
    offsetXPx: (fire.offsetXPx ?? d.fire.offsetXPx) * scale,
    offsetYPx: (fire.offsetYPx ?? d.fire.offsetYPx) * scale,
    icon: fire.icon ?? d.fire.icon,
    ringGapPx: (fire.ringGapPx ?? d.fire.ringGapPx) * scale,
    ringStrokePx: (fire.ringStrokePx ?? d.fire.ringStrokePx) * scale,
    ringArcDeg: fire.ringArcDeg ?? d.fire.ringArcDeg,
    color: fire.color ?? d.fire.color,
    fillOpacity: fire.fillOpacity ?? d.fire.fillOpacity,
    borderPx: (fire.borderPx ?? d.fire.borderPx) * scale,
    glowPx: (fire.glowPx ?? d.fire.glowPx) * scale,
    armedFillOpacity: fire.armedFillOpacity ?? d.fire.armedFillOpacity,
    armedGlowPx: (fire.armedGlowPx ?? d.fire.armedGlowPx) * scale,
    blockedNotification: fire.blockedNotification,
  };

  return {
    orientation,
    viewport,
    scale,
    metersPerUnit: hud?.metersPerUnit ?? 1,
    joystick: {
      enabled: joystick.enabled ?? d.joystick.enabled,
      anchor: joystick.anchor ?? d.joystick.anchor,
      baseRadiusPx: (joystick.baseRadiusPx ?? d.joystick.baseRadiusPx) * scale,
      thumbRadiusPx: (joystick.thumbRadiusPx ?? d.joystick.thumbRadiusPx) * scale,
      offsetXPx: (joystick.offsetXPx ?? d.joystick.offsetXPx) * scale,
      offsetYPx: (joystick.offsetYPx ?? d.joystick.offsetYPx) * scale,
      deadzone: joystick.deadzone ?? d.joystick.deadzone,
      expo: joystick.expo ?? d.joystick.expo,
    },
    relativeSteer: {
      maxRadiusPx: (relativeSteer.maxRadiusPx ?? d.relativeSteer.maxRadiusPx) * scale,
      deadzonePx: (relativeSteer.deadzonePx ?? d.relativeSteer.deadzonePx) * scale,
      expo: relativeSteer.expo ?? d.relativeSteer.expo,
      mouseSensitivity: relativeSteer.mouseSensitivity ?? d.relativeSteer.mouseSensitivity,
      originRadiusPx: (relativeSteer.originRadiusPx ?? d.relativeSteer.originRadiusPx) * scale,
      currentRadiusPx: (relativeSteer.currentRadiusPx ?? d.relativeSteer.currentRadiusPx) * scale,
      vectorWidthPx: (relativeSteer.vectorWidthPx ?? d.relativeSteer.vectorWidthPx) * scale,
    },
    throttle: {
      anchor: throttle.anchor ?? d.throttle.anchor,
      widthPx: (throttle.widthPx ?? d.throttle.widthPx) * scale,
      heightPx: (throttle.heightPx ?? d.throttle.heightPx) * scale,
      thumbHeightPx: (throttle.thumbHeightPx ?? d.throttle.thumbHeightPx) * scale,
      offsetXPx: (throttle.offsetXPx ?? d.throttle.offsetXPx) * scale,
      offsetYPx: (throttle.offsetYPx ?? d.throttle.offsetYPx) * scale,
      opacity: throttle.opacity ?? d.throttle.opacity,
      keyRampPerSec: throttle.keyRampPerSec ?? d.throttle.keyRampPerSec,
      wheelStepPerNotch: throttle.wheelStepPerNotch ?? d.throttle.wheelStepPerNotch,
      // A COUNT, not a length: scaling it would change how finely the scale is
      // divided instead of how big it is.
      tickCount: throttle.tickCount ?? d.throttle.tickCount,
    },
    modules: {
      fillOpacity: modules.fillOpacity ?? d.modules.fillOpacity,
      innerBorderOpacity: modules.innerBorderOpacity ?? d.modules.innerBorderOpacity,
      labelGapPx: (modules.labelGapPx ?? d.modules.labelGapPx) * scale,
      labelHeightPx: (modules.labelHeightPx ?? d.modules.labelHeightPx) * scale,
      labelMaxWidthPx: (modules.labelMaxWidthPx ?? d.modules.labelMaxWidthPx) * scale,
      boostColor,
    },
    fire: fireLayout,
    actionArc: actionArcLayoutFrom(actions.arc, scale, viewport),
    boost: { ...actionLayoutFrom(actions.boost, d.actions.boost, scale), color: actions.boost?.color ?? boostColor },
    jettison: actionLayoutFrom(actions.jettison, d.actions.jettison, scale),
    reticle: {
      showZone: reticle.showZone ?? d.reticle.showZone,
      maxRadiusFraction: reticle.maxRadiusFraction ?? d.reticle.maxRadiusFraction,
      strokePx: (reticle.strokePx ?? d.reticle.strokePx) * scale,
      bracketSizePx: (reticle.bracketSizePx ?? d.reticle.bracketSizePx) * scale,
      ringStrokePx: (reticle.ringStrokePx ?? d.reticle.ringStrokePx) * scale,
      targetNameOffsetPx: (reticle.targetNameOffsetPx ?? d.reticle.targetNameOffsetPx) * scale,
      targetNameSizePx: (reticle.targetNameSizePx ?? d.reticle.targetNameSizePx) * scale,
      blockedText: reticle.blockedText ?? d.reticle.blockedText,
      blockedFlashMs: reticle.blockedFlashMs ?? d.reticle.blockedFlashMs,
    },
    enemyArrows: {
      enabled: arrows.enabled ?? d.enemyArrows.enabled,
      insetXPx: (arrows.insetXPx ?? d.enemyArrows.insetXPx) * scale,
      insetYPx: (arrows.insetYPx ?? d.enemyArrows.insetYPx) * scale,
      // The ring is geometry, so an authored radius scales; "unauthored" must
      // survive scaling as null rather than becoming NaN.
      ringRadiusPx: arrows.ringRadiusPx !== undefined ? arrows.ringRadiusPx * scale : d.enemyArrows.ringRadiusPx,
      ringOffsetYPx: (arrows.ringOffsetYPx ?? d.enemyArrows.ringOffsetYPx) * scale,
      sizePx: (arrows.sizePx ?? d.enemyArrows.sizePx) * scale,
      safeMarginPx: (arrows.safeMarginPx ?? d.enemyArrows.safeMarginPx) * scale,
      // Not scaled: a pool ceiling and two world-space distances are neither
      // geometry nor feel — they are counts of ships and units of arena.
      maxCount: arrows.maxCount ?? d.enemyArrows.maxCount,
      fadeNearUnits: arrows.fadeNearUnits ?? d.enemyArrows.fadeNearUnits,
      fadeFarUnits: arrows.fadeFarUnits ?? d.enemyArrows.fadeFarUnits,
      minOpacity: arrows.minOpacity ?? d.enemyArrows.minOpacity,
      outOfRangeScale: arrows.outOfRangeScale ?? d.enemyArrows.outOfRangeScale,
      outOfRangeOpacity: arrows.outOfRangeOpacity ?? d.enemyArrows.outOfRangeOpacity,
      markerMinOpacity: arrows.markerMinOpacity ?? d.enemyArrows.markerMinOpacity,
      markerSizePx: (arrows.markerSizePx ?? d.enemyArrows.markerSizePx) * scale,
    },
    orders: {
      throttleEpsilon: orders.throttleEpsilon ?? d.orders.throttleEpsilon,
      turnEpsilon,
      pitchEpsilon: orders.pitchEpsilon ?? turnEpsilon,
      heartbeatMs: orders.heartbeatMs ?? d.orders.heartbeatMs,
      minIntervalMs: orders.minIntervalMs ?? d.orders.minIntervalMs,
    },
  };
}

/**
 * A rectangular control's centre in px from its anchored corner pivot (x right,
 * y down). The offsets measure the gap between the corner and the control's
 * NEAR edges, so a designer moves a control away from its corner without having
 * to know its size — same convention as the module cluster.
 */
export function anchoredBoxOffset(
  anchor: HudAnchorName,
  offsetXPx: number,
  offsetYPx: number,
  halfWidthPx: number,
  halfHeightPx: number,
): { dx: number; dy: number } {
  const { x: sx, y: sy } = anchorSigns(anchor);
  return { dx: sx * (offsetXPx + halfWidthPx), dy: sy * (offsetYPx + halfHeightPx) };
}

/** {@link anchoredBoxOffset} for a circular control (joystick base or FIRE button). */
export function anchoredOffset(
  anchor: HudAnchorName,
  offsetXPx: number,
  offsetYPx: number,
  halfSizePx: number,
): { dx: number; dy: number } {
  return anchoredBoxOffset(anchor, offsetXPx, offsetYPx, halfSizePx, halfSizePx);
}

/** The live chase-camera geometry the reticle sizing needs. */
export interface CameraView {
  /** Vertical field of view (radians) — Babylon's default FOV mode. */
  fovRad: number;
  /** Orbit tilt (radians, polar from +Y): π/2 is dead level. */
  betaRad: number;
}

/** Result of {@link reticleRadiusPx}: the drawn radius plus whether it had to be clamped. */
export interface ReticleSize {
  radiusPx: number;
  /** True when the honest projection exceeded `maxRadiusFraction` and was clipped. */
  clamped: boolean;
}

/**
 * Screen radius (CSS px) of the circle that visualizes the sim's lock cone.
 *
 * The cone is a facing-relative cone of half-angle `θ = coneDeg/2` (FLIGHT.md §2,
 * 3D since BUBBLE.md §A), and the chase camera looks down its axis from behind.
 * Put the ship at the origin with `G` = its 3D facing and `L` any unit vector
 * perpendicular to it; the camera's view axis at orbit tilt `β` is
 * `d = (cos h·sinβ, −cosβ, sin h·sinβ)`, and
 *
 *     d · G = cosβ·(−sin p) + sinβ·cos p = sin(β − p)
 *
 * so the angle between the view axis and the cone's axis is `π/2 − (β − p)`.
 * **`βₑ = β − shipPitchRad` is therefore the only tilt this projection cares
 * about**, and passing the raw `β` would over-report the zone by the ship's whole
 * pitch — exactly the bug a ship-relative chase camera would expose if its
 * orbit beta were treated as world-relative. In the ship frame the effective
 * tilt is constant, which is why the circle should barely breathe in a climb.
 *
 * The cone axis is offset from the view axis by
 * `α = |π/2 − βₑ|`. Its farthest edge is therefore `α + θ` from the view
 * axis, including the cross-term between camera offset and cone angle. The
 * vanishing-point envelope is simply `tanφ = tan(α + θ)`.
 *
 * That asymptote is what we draw: **every point inside the cone, at any
 * distance, projects inside a circle of this radius** — the circle is an honest
 * envelope of the zone rather than a decorative ring. (Sanity check: at
 * `βₑ = π/2` the camera looks straight down the nose, `tanφ` collapses to `tanθ`,
 * and the circle is the plain perspective projection of the cone.)
 *
 * A cone wider than the camera's field of view genuinely does not fit on screen
 * (60° of cone against ~60° of FOV), so the result is clamped to
 * `maxRadiusFraction` of the viewport's short side and flagged — the widget
 * marks a clamped reticle so the ring is never read as "the zone ends here".
 */
export function reticleRadiusPx(
  coneDeg: number,
  view: CameraView,
  viewport: Viewport,
  reticle: Pick<ReticleLayout, "maxRadiusFraction">,
  shipPitchRad = 0,
): ReticleSize {
  const shortSide = Math.min(viewport.width, viewport.height);
  const maxRadius = (shortSide / 2) * reticle.maxRadiusFraction;
  const halfCone = (coneDeg * Math.PI) / 360;
  const tanHalfFov = Math.tan(view.fovRad / 2);
  if (!(halfCone > 0) || !(tanHalfFov > 0) || viewport.height <= 0) {
    return { radiusPx: 0, clamped: false };
  }
  // A cone at/over 180° (or a rig looking at the cone from the side or behind)
  // has no finite envelope.
  const betaEff = view.betaRad - shipPitchRad;
  const sinBeta = Math.sin(betaEff);
  const axisOffset = Math.abs(Math.PI / 2 - betaEff);
  const farEdgeAngle = axisOffset + halfCone;
  if (farEdgeAngle >= Math.PI / 2 - 1e-4 || sinBeta <= 1e-4) {
    return { radiusPx: maxRadius, clamped: true };
  }

  // The far cone edge is halfCone farther from the view axis than the cone
  // axis itself. Adding the angles includes the cross-term omitted by combining
  // their tangents in quadrature.
  const tanPhi = Math.tan(farEdgeAngle);
  const honest = ((viewport.height / 2) * tanPhi) / tanHalfFov;
  return honest > maxRadius ? { radiusPx: maxRadius, clamped: true } : { radiusPx: honest, clamped: false };
}

/**
 * A world point run through the 3D layer's projection (`FlightHudBinding`).
 *
 * `behind` is not a synonym for "invisible": a point behind the camera still
 * yields usable numbers, because the projection divides by a negative `w` and
 * comes back MIRRORED through the screen centre. The lock bracket treats that as
 * "hide", but the off-screen arrows need it — mirroring is exactly the extra
 * information that says which way to point (see {@link offScreenArrowPlacement}).
 */
export interface ProjectedPoint {
  x: number;
  y: number;
  behind: boolean;
}

/** Where one off-screen arrow goes: HUD-root CSS px + its glyph rotation. */
export interface ArrowPlacement {
  x: number;
  y: number;
  /** Radians; 0 points along +x (screen right), growing clockwise on screen. */
  rotationRad: number;
}

/**
 * Place an off-screen enemy's arrow (BUBBLE.md §C). Returns **false** when the
 * enemy needs no arrow — it is on screen, inside `safeMarginPx` of the edges,
 * and in front of the camera — in which case `out` is untouched.
 *
 * The track is an ELLIPSE inset from the viewport edges (`insetXPx`/`insetYPx`),
 * not a rectangle: a rectangle's corners make an arrow jump as the bearing
 * sweeps past 45°, and an ellipse inscribed in the safe rect is the shape whose
 * radius varies smoothly with the angle. For a direction `(c, s)` the point on
 * the ellipse is `t·(c, s)` with `t = 1 / hypot(c/rx, s/ry)`, which is the
 * positive root of `(t·c/rx)² + (t·s/ry)² = 1`.
 *
 * With `ringRadiusPx` authored the track is instead a CIRCLE of that radius
 * about the screen centre (shifted by `ringOffsetYPx`), sized by the shipped
 * theme to sit in the interior of the hull/shield vital arcs — off-screen
 * contacts then read right around the ship instead of at the viewport rim. The
 * bearing math is identical; only the parked distance changes, clamped to the
 * edge ellipse so a viewport smaller than the ring never pushes arrows off
 * screen.
 *
 * **Behind-camera flip.** The projection mirrors a point behind the camera
 * through the screen centre, so the raw direction points *away* from the enemy;
 * negating it restores the true bearing. An enemy dead astern projects onto the
 * centre itself and has no bearing at all — that is the one degenerate case, and
 * it resolves to straight DOWN the screen, which reads as "behind you" and is
 * stable rather than flickering between opposite edges.
 *
 * Allocation-free: the result is written into the caller's `out`.
 */
export function offScreenArrowPlacement(
  point: ProjectedPoint,
  viewport: Viewport,
  arrows: EnemyArrowsLayout,
  out: ArrowPlacement,
): boolean {
  const width = viewport.width;
  const height = viewport.height;
  if (width <= 0 || height <= 0) return false;

  const margin = arrows.safeMarginPx;
  const inside =
    point.x >= margin && point.x <= width - margin && point.y >= margin && point.y <= height - margin;
  if (!point.behind && inside) return false;

  const cx = width / 2;
  const cy = height / 2;
  // Behind the camera the projection is mirrored through the centre, so the
  // vector to the projected point is the OPPOSITE of the bearing to the ship.
  const sign = point.behind ? -1 : 1;
  let dx = (point.x - cx) * sign;
  let dy = (point.y - cy) * sign;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) {
    // Dead astern: no screen-space bearing exists. Point down.
    dx = 0;
    dy = 1;
  } else {
    dx /= len;
    dy /= len;
  }

  // The ellipse can never be inverted by a fat inset on a small viewport.
  const rx = Math.max(1, cx - arrows.insetXPx);
  const ry = Math.max(1, cy - arrows.insetYPx);
  const tEdge = 1 / Math.hypot(dx / rx, dy / ry);
  if (arrows.ringRadiusPx !== null) {
    const t = Math.min(arrows.ringRadiusPx, tEdge);
    out.x = cx + dx * t;
    out.y = cy + arrows.ringOffsetYPx + dy * t;
    out.rotationRad = Math.atan2(dy, dx);
    return true;
  }
  out.x = cx + dx * tEdge;
  out.y = cy + dy * tEdge;
  out.rotationRad = Math.atan2(dy, dx);
  return true;
}

/**
 * Distance fade for one arrow (BUBBLE.md §C): fully opaque at or inside
 * `fadeNearUnits`, `minOpacity` at or beyond `fadeFarUnits`, linear between. A
 * `fadeFarUnits` that does not exceed `fadeNearUnits` disables the fade rather
 * than dividing by zero — the same "content can't break the HUD" rule the rest
 * of the layout follows.
 */
export function arrowOpacity(distanceUnits: number, arrows: EnemyArrowsLayout): number {
  const near = arrows.fadeNearUnits;
  const far = arrows.fadeFarUnits;
  if (!(far > near)) return 1;
  if (distanceUnits <= near) return 1;
  if (distanceUnits >= far) return arrows.minOpacity;
  const t = (distanceUnits - near) / (far - near);
  return 1 + (arrows.minOpacity - 1) * t;
}

/**
 * Minimum interval between two flight orders: the theme's floor, raised if it
 * would spend more than {@link FLIGHT_ORDER_BUDGET_SHARE} of the server's
 * `tuning.maxOrdersPerSec`. `undefined`/non-positive caps mean "no server cap
 * known", so the theme value stands.
 */
export function orderMinIntervalMs(layout: FlightHudLayout, maxOrdersPerSec: number | undefined): number {
  const themeFloor = Math.max(0, layout.orders.minIntervalMs);
  if (!maxOrdersPerSec || maxOrdersPerSec <= 0) return themeFloor;
  const budgetFloor = 1000 / (maxOrdersPerSec * FLIGHT_ORDER_BUDGET_SHARE);
  return Math.max(themeFloor, budgetFloor);
}

/** CSS custom properties the HUD root carries for the flight controls. */
export function flightCssVars(layout: FlightHudLayout): Record<string, string> {
  return {
    "--hud-joy-base-radius": `${layout.joystick.baseRadiusPx}px`,
    "--hud-joy-thumb-radius": `${layout.joystick.thumbRadiusPx}px`,
    "--hud-steer-origin-radius": `${layout.relativeSteer.originRadiusPx}px`,
    "--hud-steer-current-radius": `${layout.relativeSteer.currentRadiusPx}px`,
    "--hud-steer-vector-width": `${layout.relativeSteer.vectorWidthPx}px`,
    "--hud-throttle-width": `${layout.throttle.widthPx}px`,
    "--hud-throttle-height": `${layout.throttle.heightPx}px`,
    "--hud-throttle-thumb-height": `${layout.throttle.thumbHeightPx}px`,
    "--hud-throttle-opacity": String(layout.throttle.opacity),
    // Tick pitch as a fraction of the track, so the scale is one repeating
    // gradient rather than N pooled DOM nodes.
    "--hud-throttle-tick-pct": `${layout.throttle.tickCount > 0 ? 100 / layout.throttle.tickCount : 100}%`,
    "--hud-module-fill-pct": `${layout.modules.fillOpacity * 100}%`,
    "--hud-module-inner-border-pct": `${layout.modules.innerBorderOpacity * 100}%`,
    "--hud-module-label-gap": `${layout.modules.labelGapPx}px`,
    "--hud-module-label-height": `${layout.modules.labelHeightPx}px`,
    "--hud-module-label-max-width": `${layout.modules.labelMaxWidthPx}px`,
    "--hud-module-boost-color": layout.modules.boostColor,
    "--hud-fire-radius": `${layout.fire.radiusPx}px`,
    "--hud-fire-ring-gap": `${layout.fire.ringGapPx}px`,
    "--hud-fire-ring-stroke": `${layout.fire.ringStrokePx}px`,
    "--hud-fire-ring-arc": `${layout.fire.ringArcDeg}deg`,
    "--hud-fire-color": layout.fire.color,
    "--hud-fire-fill-pct": `${layout.fire.fillOpacity * 100}%`,
    "--hud-fire-border": `${layout.fire.borderPx}px`,
    "--hud-fire-glow": `${layout.fire.glowPx}px`,
    "--hud-fire-armed-fill-pct": `${layout.fire.armedFillOpacity * 100}%`,
    "--hud-fire-armed-glow": `${layout.fire.armedGlowPx}px`,
    "--hud-boost-color": layout.boost.color,
    "--hud-jettison-color": layout.jettison.color,
    "--hud-boost-radius": `${layout.boost.radiusPx}px`,
    "--hud-reticle-stroke": `${layout.reticle.strokePx}px`,
    "--hud-reticle-ring-stroke": `${layout.reticle.ringStrokePx}px`,
    "--hud-enemy-arrow-size": `${layout.enemyArrows.sizePx}px`,
  };
}
