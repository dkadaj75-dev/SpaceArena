import { describe, expect, it } from "vitest";
import type { ThemeConfig } from "@space-arena/shared";
import {
  anchoredBoxOffset,
  anchoredOffset,
  flightCssVars,
  FLIGHT_HUD_DEFAULTS,
  FLIGHT_ORDER_BUDGET_SHARE,
  joystickReachPx,
  orderMinIntervalMs,
  resolveFlightHudLayout,
  reticleRadiusPx,
  type CameraView,
  type FlightHudLayout,
} from "./flightHudLayout.js";

/** The shipped theme's flight block, inlined so the test pins behaviour, not content. */
function theme(overrides: Partial<NonNullable<ThemeConfig["hud"]>> = {}): ThemeConfig {
  return {
    id: "theme.default",
    type: "theme",
    version: 1,
    colors: {},
    hud: {
      scale: 1,
      flight: {
        joystick: { anchor: "bottom-left", baseRadiusPx: 62, thumbRadiusPx: 28, offsetXPx: 22, offsetYPx: 22, deadzone: 0.12, expo: 1.35 },
        throttle: { anchor: "bottom-right", widthPx: 44, heightPx: 200, thumbHeightPx: 26, offsetXPx: 6, offsetYPx: 212, keyRampPerSec: 0.9 },
        boost: { anchor: "bottom-right", radiusPx: 34, offsetXPx: 24, offsetYPx: 34, icon: "»" },
        reticle: { maxRadiusFraction: 0.82, strokePx: 2, bracketSizePx: 54, ringStrokePx: 4 },
        orders: { throttleEpsilon: 0.02, turnEpsilon: 0.05, heartbeatMs: 250, minIntervalMs: 120 },
      },
      landscape: {
        scale: 0.5,
        flight: {
          joystick: { baseRadiusPx: 56, offsetYPx: 18 },
          throttle: { heightPx: 150 },
        },
      },
      ...overrides,
    },
  } as ThemeConfig;
}

const PORTRAIT = { width: 400, height: 800 };
const LANDSCAPE = { width: 800, height: 400 };

describe("resolveFlightHudLayout", () => {
  it("reads every knob from the theme's flight block", () => {
    const layout = resolveFlightHudLayout(theme(), PORTRAIT);
    expect(layout.orientation).toBe("portrait");
    expect(layout.joystick).toEqual({
      anchor: "bottom-left",
      baseRadiusPx: 62,
      thumbRadiusPx: 28,
      offsetXPx: 22,
      offsetYPx: 22,
      deadzone: 0.12,
      expo: 1.35,
    });
    expect(layout.throttle.heightPx).toBe(200);
    expect(layout.boost.icon).toBe("»");
    expect(layout.orders.heartbeatMs).toBe(250);
  });

  it("falls back to the built-in defaults for a theme with no flight block at all", () => {
    const layout = resolveFlightHudLayout(undefined, PORTRAIT);
    expect(layout.joystick.baseRadiusPx).toBe(FLIGHT_HUD_DEFAULTS.joystick.baseRadiusPx);
    expect(layout.throttle.anchor).toBe(FLIGHT_HUD_DEFAULTS.throttle.anchor);
    expect(layout.reticle.maxRadiusFraction).toBe(FLIGHT_HUD_DEFAULTS.reticle.maxRadiusFraction);
    expect(layout.orders.minIntervalMs).toBe(FLIGHT_HUD_DEFAULTS.orders.minIntervalMs);
  });

  it("layers the landscape override PER SUB-BLOCK, keeping untouched fields", () => {
    const layout = resolveFlightHudLayout(theme(), LANDSCAPE);
    expect(layout.orientation).toBe("landscape");
    // Overridden (and then scaled by the landscape scale of 0.5).
    expect(layout.joystick.baseRadiusPx).toBe(28);
    expect(layout.joystick.offsetYPx).toBe(9);
    // NOT overridden — the base value survives, scaled.
    expect(layout.joystick.thumbRadiusPx).toBe(14);
    expect(layout.joystick.anchor).toBe("bottom-left");
    // A landscape override of the joystick must not disturb the boost block.
    expect(layout.boost.radiusPx).toBe(17);
  });

  it("scales geometry by hud.scale but never feel (deadzone / expo / ramp / order thresholds)", () => {
    const layout = resolveFlightHudLayout(theme(), LANDSCAPE);
    expect(layout.scale).toBe(0.5);
    expect(layout.throttle.heightPx).toBe(75);
    expect(layout.reticle.bracketSizePx).toBe(27);
    // Feel is untouched.
    expect(layout.joystick.deadzone).toBe(0.12);
    expect(layout.joystick.expo).toBe(1.35);
    expect(layout.throttle.keyRampPerSec).toBe(0.9);
    expect(layout.orders.turnEpsilon).toBe(0.05);
    expect(layout.reticle.maxRadiusFraction).toBe(0.82);
  });
});

describe("anchor offsets", () => {
  it("grows away from whichever corner the theme names", () => {
    expect(anchoredOffset("bottom-left", 20, 30, 10)).toEqual({ dx: 30, dy: -40 });
    expect(anchoredOffset("bottom-right", 20, 30, 10)).toEqual({ dx: -30, dy: -40 });
    expect(anchoredOffset("top-left", 20, 30, 10)).toEqual({ dx: 30, dy: 40 });
    expect(anchoredOffset("top-right", 20, 30, 10)).toEqual({ dx: -30, dy: 40 });
  });

  it("takes independent half-extents for a rectangular control", () => {
    expect(anchoredBoxOffset("bottom-right", 6, 212, 22, 100)).toEqual({ dx: -28, dy: -312 });
  });
});

describe("joystickReachPx / flightCssVars", () => {
  it("reports how far a bottom-anchored stick reaches, rim included", () => {
    const layout = resolveFlightHudLayout(theme(), PORTRAIT);
    expect(joystickReachPx(layout)).toBe(22 + 62 * 2);
  });

  it("reports no reach for a top-anchored stick (nothing to lift the gauges over)", () => {
    const top = theme({ flight: { joystick: { anchor: "top-left", baseRadiusPx: 60, offsetYPx: 10 } } });
    expect(joystickReachPx(resolveFlightHudLayout(top, PORTRAIT))).toBe(0);
  });

  it("publishes the geometry the stylesheet consumes", () => {
    const vars = flightCssVars(resolveFlightHudLayout(theme(), PORTRAIT));
    expect(vars["--hud-joy-base-radius"]).toBe("62px");
    expect(vars["--hud-throttle-height"]).toBe("200px");
    expect(vars["--hud-boost-radius"]).toBe("34px");
    expect(vars["--hud-gauge-lift"]).toBe("146px");
  });
});

/**
 * FLIGHT.md §4: the circle must be an honest envelope of the sim's ground-plane
 * lock cone under the live chase camera, not a decorative ring.
 */
describe("reticleRadiusPx", () => {
  // A roomy viewport and narrow cones, so the honest projection is exercised
  // clear of the on-screen clamp (which gets its own tests below).
  const VIEWPORT = { width: 1600, height: 900 };
  const RETICLE = { maxRadiusFraction: 0.82, strokePx: 2, bracketSizePx: 54, ringStrokePx: 4 };
  const level: CameraView = { fovRad: 1.05, betaRad: Math.PI / 2 };
  const MAX_RADIUS = (Math.min(VIEWPORT.width, VIEWPORT.height) / 2) * RETICLE.maxRadiusFraction;

  it("collapses to the plain perspective projection of the cone for a level camera", () => {
    const coneDeg = 20;
    const expected =
      ((VIEWPORT.height / 2) * Math.tan((coneDeg * Math.PI) / 360)) / Math.tan(level.fovRad / 2);
    const size = reticleRadiusPx(coneDeg, level, VIEWPORT, RETICLE);
    expect(size.clamped).toBe(false);
    expect(size.radiusPx).toBeCloseTo(expected, 6);
  });

  it("grows with the cone and shrinks with a wider field of view", () => {
    const narrow = reticleRadiusPx(10, level, VIEWPORT, RETICLE).radiusPx;
    const wide = reticleRadiusPx(20, level, VIEWPORT, RETICLE).radiusPx;
    expect(wide).toBeGreaterThan(narrow);
    const zoomedOut = reticleRadiusPx(10, { fovRad: 1.5, betaRad: Math.PI / 2 }, VIEWPORT, RETICLE).radiusPx;
    expect(zoomedOut).toBeLessThan(narrow);
  });

  it("widens as the camera lifts off level, which is more of the cone in frame", () => {
    const tilted = reticleRadiusPx(10, { fovRad: 1.05, betaRad: 1.45 }, VIEWPORT, RETICLE);
    expect(tilted.clamped).toBe(false);
    expect(tilted.radiusPx).toBeGreaterThan(reticleRadiusPx(10, level, VIEWPORT, RETICLE).radiusPx);
  });

  it("clamps a cone wider than the camera can show and flags it", () => {
    const huge = reticleRadiusPx(178, level, VIEWPORT, RETICLE);
    expect(huge.clamped).toBe(true);
    expect(huge.radiusPx).toBe(MAX_RADIUS);
    // A 180°+ cone has no finite envelope at all — still clamped, never NaN.
    const degenerate = reticleRadiusPx(200, level, VIEWPORT, RETICLE);
    expect(degenerate.clamped).toBe(true);
    expect(Number.isFinite(degenerate.radiusPx)).toBe(true);
  });

  /**
   * The shipped combination (70° cone, ~60° FOV, low chase tilt) genuinely does
   * NOT fit: a target 35° off the nose is outside the frustum. The clamp is the
   * honest answer, and the flag is what tells the widget to draw the circle as
   * an open boundary rather than the edge of the zone.
   */
  it("clamps the shipped phone case, because a 70° cone does not fit a 60° FOV", () => {
    const phone = reticleRadiusPx(70, { fovRad: 1.05, betaRad: 1.34 }, { width: 400, height: 800 }, RETICLE);
    expect(phone.clamped).toBe(true);
    expect(phone.radiusPx).toBe((400 / 2) * RETICLE.maxRadiusFraction);
  });

  it("draws nothing for a zero cone or a degenerate viewport", () => {
    expect(reticleRadiusPx(0, level, VIEWPORT, RETICLE)).toEqual({ radiusPx: 0, clamped: false });
    expect(reticleRadiusPx(20, level, { width: 0, height: 0 }, RETICLE).radiusPx).toBe(0);
  });

  it("is clamped against the SHORT side, so the circle always fits either way up", () => {
    const portrait = reticleRadiusPx(178, level, { width: 400, height: 800 }, RETICLE);
    const landscape = reticleRadiusPx(178, level, { width: 800, height: 400 }, RETICLE);
    expect(landscape.radiusPx).toBe(portrait.radiusPx);
  });
});

describe("orderMinIntervalMs", () => {
  const layout = { orders: { throttleEpsilon: 0.02, turnEpsilon: 0.05, heartbeatMs: 250, minIntervalMs: 120 } } as FlightHudLayout;

  it("keeps the theme's floor when it already fits the server budget", () => {
    // 20 orders/s × 50 % share = 10/s = 100 ms, which 120 ms already clears.
    expect(orderMinIntervalMs(layout, 20)).toBe(120);
  });

  it("raises the floor when the theme would overspend the server's rate limit", () => {
    // 4 orders/s × 50 % share = 2/s ⇒ 500 ms.
    expect(orderMinIntervalMs(layout, 4)).toBeCloseTo(1000 / (4 * FLIGHT_ORDER_BUDGET_SHARE), 9);
  });

  it("leaves the theme value alone when no server cap is known", () => {
    expect(orderMinIntervalMs(layout, undefined)).toBe(120);
    expect(orderMinIntervalMs(layout, 0)).toBe(120);
  });
});
