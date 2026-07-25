import type {
  BoostButtonConfig,
  FlightHudConfig,
  FlightOrdersConfig,
  HudAnchorName,
  JoystickConfig,
  LockReticleConfig,
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
  anchor: HudAnchorName;
  baseRadiusPx: number;
  thumbRadiusPx: number;
  offsetXPx: number;
  offsetYPx: number;
  deadzone: number;
  expo: number;
}

export interface ThrottleLayout {
  anchor: HudAnchorName;
  widthPx: number;
  heightPx: number;
  thumbHeightPx: number;
  offsetXPx: number;
  offsetYPx: number;
  keyRampPerSec: number;
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
  heartbeatMs: number;
  minIntervalMs: number;
}

export interface FlightHudLayout {
  orientation: Orientation;
  viewport: Viewport;
  scale: number;
  joystick: JoystickLayout;
  throttle: ThrottleLayout;
  boost: BoostLayout;
  reticle: ReticleLayout;
  orders: FlightOrderLayout;
}

/** Fallbacks for a theme with no (or a partial) `hud.flight` block. */
export const FLIGHT_HUD_DEFAULTS = {
  joystick: {
    anchor: "bottom-left",
    baseRadiusPx: 62,
    thumbRadiusPx: 28,
    offsetXPx: 22,
    offsetYPx: 22,
    deadzone: 0.12,
    expo: 1.35,
  },
  throttle: {
    anchor: "bottom-right",
    widthPx: 44,
    heightPx: 200,
    thumbHeightPx: 26,
    offsetXPx: 6,
    offsetYPx: 212,
    keyRampPerSec: 0.9,
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
  orders: {
    throttleEpsilon: 0.02,
    turnEpsilon: 0.05,
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
  const throttle: ThrottleStripConfig = merge(base.throttle, over.throttle);
  const boost: BoostButtonConfig = merge(base.boost, over.boost);
  const reticle: LockReticleConfig = merge(base.reticle, over.reticle);
  const orders: FlightOrdersConfig = merge(base.orders, over.orders);
  const d = FLIGHT_HUD_DEFAULTS;

  return {
    orientation,
    viewport,
    scale,
    joystick: {
      anchor: joystick.anchor ?? d.joystick.anchor,
      baseRadiusPx: (joystick.baseRadiusPx ?? d.joystick.baseRadiusPx) * scale,
      thumbRadiusPx: (joystick.thumbRadiusPx ?? d.joystick.thumbRadiusPx) * scale,
      offsetXPx: (joystick.offsetXPx ?? d.joystick.offsetXPx) * scale,
      offsetYPx: (joystick.offsetYPx ?? d.joystick.offsetYPx) * scale,
      deadzone: joystick.deadzone ?? d.joystick.deadzone,
      expo: joystick.expo ?? d.joystick.expo,
    },
    throttle: {
      anchor: throttle.anchor ?? d.throttle.anchor,
      widthPx: (throttle.widthPx ?? d.throttle.widthPx) * scale,
      heightPx: (throttle.heightPx ?? d.throttle.heightPx) * scale,
      thumbHeightPx: (throttle.thumbHeightPx ?? d.throttle.thumbHeightPx) * scale,
      offsetXPx: (throttle.offsetXPx ?? d.throttle.offsetXPx) * scale,
      offsetYPx: (throttle.offsetYPx ?? d.throttle.offsetYPx) * scale,
      keyRampPerSec: throttle.keyRampPerSec ?? d.throttle.keyRampPerSec,
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
    orders: {
      throttleEpsilon: orders.throttleEpsilon ?? d.orders.throttleEpsilon,
      turnEpsilon: orders.turnEpsilon ?? d.orders.turnEpsilon,
      heartbeatMs: orders.heartbeatMs ?? d.orders.heartbeatMs,
      minIntervalMs: orders.minIntervalMs ?? d.orders.minIntervalMs,
    },
  };
}

/**
 * How far up the screen the left-hand flight controls reach, button rim
 * included. The gauges are bottom-left too, so the HUD pushes them above this
 * (`--hud-gauge-lift`) instead of anyone hardcoding a magic offset.
 */
export function joystickReachPx(layout: FlightHudLayout): number {
  const j = layout.joystick;
  if (!j.anchor.startsWith("bottom")) return 0;
  return j.offsetYPx + j.baseRadiusPx * 2;
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
 * The cone is a heading-relative GROUND-PLANE wedge of half-angle `θ =
 * coneDeg/2` (FLIGHT.md §2), and the chase camera looks down its axis from
 * behind at tilt `β`. Put the ship at the origin with `F` = heading, `L` =
 * left/right in the ground plane; the camera sits at `-F·R·sinβ + Y·R·cosβ` with
 * view axis `d = F·sinβ − Y·cosβ` and up `u = F·cosβ + Y·sinβ`. A point `s` units
 * along a cone edge, `P = s(cosθ·F + sinθ·L)`, then has camera-space components
 *
 *     depth      z = s·cosθ·sinβ + R
 *     vertical   y = s·cosθ·cosβ
 *     horizontal x = s·sinθ
 *
 * so its screen radius is `(H/2)/tan(fov/2) · hypot(y, x)/z`, which grows
 * monotonically with `s` toward the edge's vanishing point:
 *
 *     tanφ = hypot(sinθ, cosθ·cosβ) / (cosθ·sinβ)
 *
 * That asymptote is what we draw: **every point inside the cone, at any
 * distance, projects inside a circle of this radius** — the circle is an honest
 * envelope of the zone rather than a decorative ring. (Sanity check: at β = π/2
 * the camera is level, `tanφ` collapses to `tanθ`, and the circle is the plain
 * perspective projection of the cone.)
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
): ReticleSize {
  const shortSide = Math.min(viewport.width, viewport.height);
  const maxRadius = (shortSide / 2) * reticle.maxRadiusFraction;
  const halfCone = (coneDeg * Math.PI) / 360;
  const tanHalfFov = Math.tan(view.fovRad / 2);
  if (!(halfCone > 0) || !(tanHalfFov > 0) || viewport.height <= 0) {
    return { radiusPx: 0, clamped: false };
  }
  // A cone at/over 180° (or a level-to-inverted rig) has no finite envelope.
  const cosTheta = Math.cos(halfCone);
  const sinBeta = Math.sin(view.betaRad);
  if (cosTheta <= 1e-4 || sinBeta <= 1e-4) return { radiusPx: maxRadius, clamped: true };

  const tanPhi = Math.hypot(Math.sin(halfCone), cosTheta * Math.cos(view.betaRad)) / (cosTheta * sinBeta);
  const honest = ((viewport.height / 2) * tanPhi) / tanHalfFov;
  return honest > maxRadius ? { radiusPx: maxRadius, clamped: true } : { radiusPx: honest, clamped: false };
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
    "--hud-throttle-width": `${layout.throttle.widthPx}px`,
    "--hud-throttle-height": `${layout.throttle.heightPx}px`,
    "--hud-throttle-thumb-height": `${layout.throttle.thumbHeightPx}px`,
    "--hud-boost-radius": `${layout.boost.radiusPx}px`,
    "--hud-reticle-stroke": `${layout.reticle.strokePx}px`,
    "--hud-reticle-ring-stroke": `${layout.reticle.ringStrokePx}px`,
    // Keeps the bottom-left gauges clear of the joystick without either widget
    // knowing the other's geometry.
    "--hud-gauge-lift": `${joystickReachPx(layout)}px`,
  };
}
