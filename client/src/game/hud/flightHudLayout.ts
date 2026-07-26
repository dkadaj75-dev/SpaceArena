import type {
  BoostButtonConfig,
  EnemyArrowsConfig,
  FlightHudConfig,
  FlightOrdersConfig,
  HudAnchorName,
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
  keyRampPerSec: number;
  wheelStepPerNotch: number;
}

export interface BoostLayout {
  anchor: HudAnchorName;
  radiusPx: number;
  offsetXPx: number;
  offsetYPx: number;
  icon: string;
}

export interface ReticleLayout {
  maxRadiusFraction: number;
  strokePx: number;
  bracketSizePx: number;
  ringStrokePx: number;
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
  sizePx: number;
  safeMarginPx: number;
  maxCount: number;
  fadeNearUnits: number;
  fadeFarUnits: number;
  minOpacity: number;
}

export interface FlightHudLayout {
  orientation: Orientation;
  viewport: Viewport;
  scale: number;
  joystick: JoystickLayout;
  relativeSteer: RelativeSteerLayout;
  throttle: ThrottleLayout;
  boost: BoostLayout;
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
    keyRampPerSec: 0.9,
    wheelStepPerNotch: 0.06,
  },
  boost: {
    anchor: "bottom-right",
    radiusPx: 34,
    offsetXPx: 24,
    offsetYPx: 34,
    icon: "»",
  },
  reticle: {
    maxRadiusFraction: 0.82,
    strokePx: 2,
    bracketSizePx: 54,
    ringStrokePx: 4,
  },
  enemyArrows: {
    enabled: true,
    insetXPx: 34,
    insetYPx: 46,
    sizePx: 20,
    safeMarginPx: 26,
    maxCount: 8,
    fadeNearUnits: 60,
    fadeFarUnits: 320,
    minOpacity: 0.35,
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
} as const satisfies Omit<FlightHudLayout, "orientation" | "viewport" | "scale">;

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
  const boost: BoostButtonConfig = merge(base.boost, over.boost);
  const reticle: LockReticleConfig = merge(base.reticle, over.reticle);
  const arrows: EnemyArrowsConfig = merge(base.enemyArrows, over.enemyArrows);
  const orders: FlightOrdersConfig = merge(base.orders, over.orders);
  const d = FLIGHT_HUD_DEFAULTS;
  const turnEpsilon = orders.turnEpsilon ?? d.orders.turnEpsilon;

  return {
    orientation,
    viewport,
    scale,
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
      keyRampPerSec: throttle.keyRampPerSec ?? d.throttle.keyRampPerSec,
      wheelStepPerNotch: throttle.wheelStepPerNotch ?? d.throttle.wheelStepPerNotch,
    },
    boost: {
      anchor: boost.anchor ?? d.boost.anchor,
      radiusPx: (boost.radiusPx ?? d.boost.radiusPx) * scale,
      offsetXPx: (boost.offsetXPx ?? d.boost.offsetXPx) * scale,
      offsetYPx: (boost.offsetYPx ?? d.boost.offsetYPx) * scale,
      icon: boost.icon ?? d.boost.icon,
    },
    reticle: {
      maxRadiusFraction: reticle.maxRadiusFraction ?? d.reticle.maxRadiusFraction,
      strokePx: (reticle.strokePx ?? d.reticle.strokePx) * scale,
      bracketSizePx: (reticle.bracketSizePx ?? d.reticle.bracketSizePx) * scale,
      ringStrokePx: (reticle.ringStrokePx ?? d.reticle.ringStrokePx) * scale,
    },
    enemyArrows: {
      enabled: arrows.enabled ?? d.enemyArrows.enabled,
      insetXPx: (arrows.insetXPx ?? d.enemyArrows.insetXPx) * scale,
      insetYPx: (arrows.insetYPx ?? d.enemyArrows.insetYPx) * scale,
      sizePx: (arrows.sizePx ?? d.enemyArrows.sizePx) * scale,
      safeMarginPx: (arrows.safeMarginPx ?? d.enemyArrows.safeMarginPx) * scale,
      // Not scaled: a pool ceiling and two world-space distances are neither
      // geometry nor feel — they are counts of ships and units of arena.
      maxCount: arrows.maxCount ?? d.enemyArrows.maxCount,
      fadeNearUnits: arrows.fadeNearUnits ?? d.enemyArrows.fadeNearUnits,
      fadeFarUnits: arrows.fadeFarUnits ?? d.enemyArrows.fadeFarUnits,
      minOpacity: arrows.minOpacity ?? d.enemyArrows.minOpacity,
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

/** {@link anchoredBoxOffset} for a circular control (joystick base, boost button). */
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
 * pitch — exactly the bug a chase camera that follows pitch introduces (with a
 * full `pitchFollow` the effective tilt is CONSTANT, which is why the circle
 * should barely breathe in a climb).
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
  reticle: ReticleLayout,
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
  const t = 1 / Math.hypot(dx / rx, dy / ry);
  out.x = cx + dx * t;
  out.y = cy + dy * t;
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
    "--hud-boost-radius": `${layout.boost.radiusPx}px`,
    "--hud-reticle-stroke": `${layout.reticle.strokePx}px`,
    "--hud-reticle-ring-stroke": `${layout.reticle.ringStrokePx}px`,
    "--hud-enemy-arrow-size": `${layout.enemyArrows.sizePx}px`,
  };
}
