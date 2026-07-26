import { describe, expect, it } from "vitest";
import type { ThemeConfig } from "@space-arena/shared";
import {
  anchoredBoxOffset,
  anchoredOffset,
  arrowOpacity,
  flightCssVars,
  FLIGHT_HUD_DEFAULTS,
  FLIGHT_ORDER_BUDGET_SHARE,
  offScreenArrowPlacement,
  orderMinIntervalMs,
  resolveFlightHudLayout,
  reticleRadiusPx,
  type ArrowPlacement,
  type CameraView,
  type EnemyArrowsLayout,
  type FlightHudLayout,
  type ProjectedPoint,
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
      enabled: true,
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

  it("reuses turnEpsilon for an omitted pitchEpsilon, so both stick axes match", () => {
    const layout = resolveFlightHudLayout(theme(), PORTRAIT);
    expect(layout.orders.turnEpsilon).toBe(0.05);
    expect(layout.orders.pitchEpsilon).toBe(0.05);

    const decoupled = theme({
      flight: { orders: { turnEpsilon: 0.2, pitchEpsilon: 0.01 } },
    });
    const resolved = resolveFlightHudLayout(decoupled, PORTRAIT);
    expect(resolved.orders.turnEpsilon).toBe(0.2);
    expect(resolved.orders.pitchEpsilon).toBe(0.01);
    // Still derived when only the turn side moves.
    const shifted = resolveFlightHudLayout(theme({ flight: { orders: { turnEpsilon: 0.2 } } }), PORTRAIT);
    expect(shifted.orders.pitchEpsilon).toBe(0.2);
  });

  it("resolves the enemy-arrow block, scaling geometry but not counts or distances", () => {
    const arrows = theme({
      flight: {
        enemyArrows: { insetXPx: 40, insetYPx: 50, sizePx: 20, safeMarginPx: 30, maxCount: 6, fadeFarUnits: 300 },
      },
      scale: 2,
    });
    const layout = resolveFlightHudLayout(arrows, PORTRAIT);
    expect(layout.enemyArrows.insetXPx).toBe(80);
    expect(layout.enemyArrows.sizePx).toBe(40);
    expect(layout.enemyArrows.safeMarginPx).toBe(60);
    // Counts are ships and distances are world units — neither is screen geometry.
    expect(layout.enemyArrows.maxCount).toBe(6);
    expect(layout.enemyArrows.fadeFarUnits).toBe(300);
    // Absent knobs fall back per field, master switch included.
    expect(layout.enemyArrows.enabled).toBe(FLIGHT_HUD_DEFAULTS.enemyArrows.enabled);
    expect(layout.enemyArrows.minOpacity).toBe(FLIGHT_HUD_DEFAULTS.enemyArrows.minOpacity);
  });

  it("resolves the throttle's wheel step (the pointer-side nudge)", () => {
    expect(resolveFlightHudLayout(theme(), PORTRAIT).throttle.wheelStepPerNotch).toBe(
      FLIGHT_HUD_DEFAULTS.throttle.wheelStepPerNotch,
    );
    const custom = theme({ flight: { throttle: { wheelStepPerNotch: 0.25 } } });
    // Feel, not geometry: never scaled.
    expect(resolveFlightHudLayout(custom, LANDSCAPE).throttle.wheelStepPerNotch).toBe(0.25);
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

describe("flightCssVars", () => {
  it("publishes the geometry the stylesheet consumes", () => {
    const vars = flightCssVars(resolveFlightHudLayout(theme(), PORTRAIT));
    expect(vars["--hud-joy-base-radius"]).toBe("62px");
    expect(vars["--hud-throttle-height"]).toBe("200px");
    expect(vars["--hud-boost-radius"]).toBe("34px");
    expect(vars["--hud-steer-origin-radius"]).toBe("7px");
  });
});

/**
 * FLIGHT.md §4: the circle must be an honest envelope of the sim's facing-relative
 * lock cone under the live chase camera, not a decorative ring. BUBBLE.md §C adds
 * the pitch axis, which is why the ship's own pitch is part of the geometry.
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

  it("includes the camera-axis offset plus the cone half-angle at the far edge", () => {
    const view = { fovRad: 1.05, betaRad: 1.45 };
    const halfCone = (10 * Math.PI) / 360;
    const axisOffset = Math.abs(Math.PI / 2 - view.betaRad);
    const expected = ((VIEWPORT.height / 2) * Math.tan(axisOffset + halfCone)) / Math.tan(view.fovRad / 2);
    const size = reticleRadiusPx(10, view, VIEWPORT, RETICLE);
    expect(size.clamped).toBe(false);
    expect(size.radiusPx).toBeCloseTo(expected, 9);
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

  /**
   * BUBBLE.md §C — the cone follows the nose and so does the camera, so the tilt
   * this projection cares about is the DIFFERENCE. Getting this wrong would swell
   * the reticle through every climb and shrink it through every dive, while the
   * sim's zone never moved at all.
   */
  describe("with the ship pitched (BUBBLE.md §C)", () => {
    const BASE = 1.34;

    it("holds the circle steady through a climb when the camera follows pitch fully", () => {
      const levelSize = reticleRadiusPx(20, { fovRad: 1.05, betaRad: BASE }, VIEWPORT, RETICLE, 0);
      for (const pitch of [-1.4, -0.5, 0.5, 1.4]) {
        // pitchFollow 1 ⇒ beta = base + pitch, so the effective tilt is `base`.
        const climbing = reticleRadiusPx(
          20,
          { fovRad: 1.05, betaRad: BASE + pitch },
          VIEWPORT,
          RETICLE,
          pitch,
        );
        expect(climbing.radiusPx).toBeCloseTo(levelSize.radiusPx, 9);
      }
    });

    it("uses beta − pitch, not beta", () => {
      // A nose-up ship under a camera that did NOT follow it is viewed further off
      // its own axis, i.e. more side-on — which puts MORE of the cone in frame,
      // the same way lifting the camera off level does.
      const ignoredPitch = reticleRadiusPx(20, { fovRad: 1.05, betaRad: BASE }, VIEWPORT, RETICLE, 0);
      const pitchedUp = reticleRadiusPx(20, { fovRad: 1.05, betaRad: BASE }, VIEWPORT, RETICLE, 0.6);
      expect(pitchedUp.radiusPx).toBeGreaterThan(ignoredPitch.radiusPx);
      // Equivalence with the un-pitched case at the same effective tilt.
      const equivalent = reticleRadiusPx(
        20,
        { fovRad: 1.05, betaRad: BASE - 0.6 },
        VIEWPORT,
        RETICLE,
        0,
      );
      expect(pitchedUp.radiusPx).toBeCloseTo(equivalent.radiusPx, 9);
    });

    it("clamps rather than inverting when the effective tilt leaves the front hemisphere", () => {
      // A pitch past the camera's tilt would put the cone axis behind the view
      // axis; the pole margin in chaseBetaFor keeps a real rig out of this, and
      // the clamp is the answer if content ever gets there anyway.
      const degenerate = reticleRadiusPx(20, { fovRad: 1.05, betaRad: 0.4 }, VIEWPORT, RETICLE, 1.4);
      expect(degenerate.clamped).toBe(true);
      expect(Number.isFinite(degenerate.radiusPx)).toBe(true);
    });

    it("defaults to a level ship when no pitch is supplied", () => {
      expect(reticleRadiusPx(20, level, VIEWPORT, RETICLE)).toEqual(
        reticleRadiusPx(20, level, VIEWPORT, RETICLE, 0),
      );
    });
  });
});

/**
 * BUBBLE.md §C — the off-screen enemy arrows. Three things have to be right or
 * the feature actively misleads: WHEN an arrow appears, WHERE on the track it
 * lands, and which way the glyph points once a contact is behind the camera.
 */
describe("offScreenArrowPlacement", () => {
  const VIEWPORT = { width: 800, height: 600 };
  const CENTRE = { x: 400, y: 300 };
  const ARROWS: EnemyArrowsLayout = {
    enabled: true,
    insetXPx: 40, // ⇒ x radius 360
    insetYPx: 50, // ⇒ y radius 250
    sizePx: 20,
    safeMarginPx: 30,
    maxCount: 8,
    fadeNearUnits: 60,
    fadeFarUnits: 320,
    minOpacity: 0.35,
  };
  const RX = VIEWPORT.width / 2 - ARROWS.insetXPx;
  const RY = VIEWPORT.height / 2 - ARROWS.insetYPx;

  function place(x: number, y: number, behind = false): ArrowPlacement | null {
    const out: ArrowPlacement = { x: 0, y: 0, rotationRad: 0 };
    const point: ProjectedPoint = { x, y, behind };
    return offScreenArrowPlacement(point, VIEWPORT, ARROWS, out) ? out : null;
  }

  /** Every track point must satisfy the ellipse equation — that IS the track. */
  function onEllipse(p: ArrowPlacement): number {
    return ((p.x - CENTRE.x) / RX) ** 2 + ((p.y - CENTRE.y) / RY) ** 2;
  }

  it("draws nothing for an enemy comfortably inside the safe rect", () => {
    expect(place(CENTRE.x, CENTRE.y)).toBeNull();
    expect(place(ARROWS.safeMarginPx + 1, ARROWS.safeMarginPx + 1)).toBeNull();
    expect(place(VIEWPORT.width - ARROWS.safeMarginPx - 1, VIEWPORT.height - ARROWS.safeMarginPx - 1)).toBeNull();
  });

  it("hands the arrow over at the safe margin, before the blip touches the edge", () => {
    // The margin is what stops a contact on the rim flickering between the ship
    // and its own arrow.
    expect(place(CENTRE.x, ARROWS.safeMarginPx + 1)).toBeNull();
    expect(place(CENTRE.x, ARROWS.safeMarginPx - 1)).not.toBeNull();
    expect(place(ARROWS.safeMarginPx - 1, CENTRE.y)).not.toBeNull();
  });

  it("parks the arrow on the ellipse, pointing along the bearing to the enemy", () => {
    // Straight up: the track's top, glyph rotated to -90°.
    const up = place(CENTRE.x, -500)!;
    expect(up.x).toBeCloseTo(CENTRE.x, 6);
    expect(up.y).toBeCloseTo(CENTRE.y - RY, 6);
    expect(up.rotationRad).toBeCloseTo(-Math.PI / 2, 6);

    // Straight right: the track's right edge, rotation 0 (the glyph's own axis).
    const right = place(2000, CENTRE.y)!;
    expect(right.x).toBeCloseTo(CENTRE.x + RX, 6);
    expect(right.y).toBeCloseTo(CENTRE.y, 6);
    expect(right.rotationRad).toBeCloseTo(0, 6);

    const down = place(CENTRE.x, 5000)!;
    expect(down.rotationRad).toBeCloseTo(Math.PI / 2, 6);
    const left = place(-900, CENTRE.y)!;
    expect(Math.abs(left.rotationRad)).toBeCloseTo(Math.PI, 6);
  });

  it("stays ON the ellipse at every bearing — no rectangular corner jump", () => {
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 16) {
      const p = place(CENTRE.x + Math.cos(a) * 5000, CENTRE.y + Math.sin(a) * 5000)!;
      expect(p).not.toBeNull();
      expect(onEllipse(p)).toBeCloseTo(1, 9);
      // The glyph always points the way the enemy is.
      expect(p.rotationRad).toBeCloseTo(Math.atan2(Math.sin(a), Math.cos(a)), 6);
    }
  });

  it("respects the inset: the track never touches the viewport edge", () => {
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 12) {
      const p = place(CENTRE.x + Math.cos(a) * 5000, CENTRE.y + Math.sin(a) * 5000)!;
      expect(p.x).toBeGreaterThanOrEqual(ARROWS.insetXPx);
      expect(p.x).toBeLessThanOrEqual(VIEWPORT.width - ARROWS.insetXPx);
      expect(p.y).toBeGreaterThanOrEqual(ARROWS.insetYPx);
      expect(p.y).toBeLessThanOrEqual(VIEWPORT.height - ARROWS.insetYPx);
    }
  });

  it("FLIPS a behind-camera contact, because its projection is mirrored", () => {
    // Babylon's projection divides by a negative w, so an enemy behind and to the
    // player's left comes back on the RIGHT of the screen. Pointing at the raw
    // projection would send the pilot exactly the wrong way.
    const front = place(CENTRE.x - 900, CENTRE.y)!;
    const mirrored = place(CENTRE.x + 900, CENTRE.y, true)!;
    expect(mirrored.x).toBeCloseTo(front.x, 6);
    expect(mirrored.y).toBeCloseTo(front.y, 6);
    // Straight left is the branch cut: `atan2` reports it as +π one way round and
    // −π the other. Same direction, so compare the cosine/sine, not the number.
    expect(Math.cos(mirrored.rotationRad)).toBeCloseTo(Math.cos(front.rotationRad), 6);
    expect(Math.sin(mirrored.rotationRad)).toBeCloseTo(Math.sin(front.rotationRad), 6);

    const diagonal = place(CENTRE.x + 300, CENTRE.y - 200, true)!;
    expect(diagonal.rotationRad).toBeCloseTo(Math.atan2(200, -300), 6);
  });

  it("draws an arrow for a behind-camera enemy even when it projects ON SCREEN", () => {
    // The whole reason `behind` had to reach the HUD: the mirrored projection can
    // land dead centre, where the "is it off screen" test would say "no arrow".
    const p = place(CENTRE.x + 10, CENTRE.y + 10, true);
    expect(p).not.toBeNull();
    expect(onEllipse(p!)).toBeCloseTo(1, 9);
  });

  it("points DOWN for an enemy dead astern, which has no screen bearing at all", () => {
    const p = place(CENTRE.x, CENTRE.y, true)!;
    expect(p.rotationRad).toBeCloseTo(Math.PI / 2, 9);
    expect(p.x).toBeCloseTo(CENTRE.x, 9);
    expect(p.y).toBeCloseTo(CENTRE.y + RY, 9);
  });

  it("survives a viewport smaller than its own insets instead of inverting", () => {
    const out: ArrowPlacement = { x: 0, y: 0, rotationRad: 0 };
    const tiny = { width: 60, height: 40 };
    expect(offScreenArrowPlacement({ x: 500, y: 20, behind: false }, tiny, ARROWS, out)).toBe(true);
    expect(Number.isFinite(out.x)).toBe(true);
    expect(Number.isFinite(out.y)).toBe(true);
    // A degenerate viewport (pre-layout) draws nothing rather than NaN.
    expect(offScreenArrowPlacement({ x: 5, y: 5, behind: true }, { width: 0, height: 0 }, ARROWS, out)).toBe(false);
  });

  it("writes into the caller's object and leaves it untouched when there is no arrow", () => {
    const out: ArrowPlacement = { x: -1, y: -1, rotationRad: -1 };
    expect(offScreenArrowPlacement({ x: CENTRE.x, y: CENTRE.y, behind: false }, VIEWPORT, ARROWS, out)).toBe(false);
    expect(out).toEqual({ x: -1, y: -1, rotationRad: -1 });
  });
});

describe("arrowOpacity", () => {
  const ARROWS: EnemyArrowsLayout = {
    enabled: true,
    insetXPx: 34,
    insetYPx: 46,
    sizePx: 20,
    safeMarginPx: 26,
    maxCount: 8,
    fadeNearUnits: 60,
    fadeFarUnits: 320,
    minOpacity: 0.35,
  };

  it("is opaque up to the near distance and floors at the far one", () => {
    expect(arrowOpacity(0, ARROWS)).toBe(1);
    expect(arrowOpacity(60, ARROWS)).toBe(1);
    expect(arrowOpacity(320, ARROWS)).toBe(0.35);
    expect(arrowOpacity(9999, ARROWS)).toBe(0.35);
  });

  it("interpolates linearly between them", () => {
    expect(arrowOpacity(190, ARROWS)).toBeCloseTo(0.675, 9);
  });

  it("disables the fade for minOpacity 1 or a non-increasing band", () => {
    expect(arrowOpacity(500, { ...ARROWS, minOpacity: 1 })).toBe(1);
    expect(arrowOpacity(500, { ...ARROWS, fadeFarUnits: ARROWS.fadeNearUnits })).toBe(1);
    expect(arrowOpacity(500, { ...ARROWS, fadeFarUnits: 0 })).toBe(1);
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
