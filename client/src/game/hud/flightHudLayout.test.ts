import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { ThemeConfig } from "@space-arena/shared";
import {
  anchoredOffset,
  anchoredBoxOffset,
  arrowOpacity,
  flightCssVars,
  resolveFlightSecondaryControls,
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
import { anchorSigns, resolveHudLayout } from "./hudLayout.js";
import { MODULE_FAMILY_COLOR_FALLBACKS } from "./ModuleButtons.js";

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
        fire: { anchor: "bottom-right", radiusPx: 34, offsetXPx: 24, offsetYPx: 34, icon: "FIRE" },
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
  it("packs sparse action rails from the FIRE-side end at the safe chord pitch", () => {
    const flight = resolveFlightHudLayout(
      theme({ flight: { actions: { arc: { radiusPx: 240, startDeg: -100, sweepDeg: -80, buttonDiameterPx: 48 } } } }),
      PORTRAIT,
    );
    const secondary = resolveFlightSecondaryControls(flight, 2);
    if (!secondary.usesActionArc) throw new Error("expected authored action arc");
    const slots = secondary.modules.concat(secondary.boost, secondary.jettison);
    const fire = anchoredOffset(flight.fire.anchor, flight.fire.offsetXPx, flight.fire.offsetYPx, flight.fire.radiusPx);
    const angles = slots.map((slot) => {
      const point = anchoredOffset(slot.anchor, slot.offsetXPx, slot.offsetYPx, slot.radiusPx);
      return Math.atan2(point.dy - fire.dy, point.dx - fire.dx) * 180 / Math.PI;
    });
    // Four actions fit on one rail, so their pitch is the minimum safe chord,
    // not the authored span divided into three distant slots.
    expect(angles[0]).toBeCloseTo(-100, 6);
    expect(Math.abs(angles[1]! - angles[0]!)).toBeLessThan(25);
    expect(Math.abs(angles[3]! - angles[0]!)).toBeLessThan(80);
  });

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
    expect(layout.throttle.opacity).toBe(1);
    expect(layout.reticle.showZone).toBe(true);
    expect(layout.fire).toEqual({
      anchor: "bottom-right",
      radiusPx: 34,
      offsetXPx: 24,
      offsetYPx: 34,
      icon: "FIRE",
      ringGapPx: 7,
      ringStrokePx: 2,
      ringArcDeg: 260,
      ringTickGapDeg: 3,
      color: "#EF4444",
      fillOpacity: 0.3,
      borderPx: 2,
      glowPx: 10,
      armedFillOpacity: 0.52,
      armedGlowPx: 18,
      blockedNotification: undefined,
    });
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

  it("resolves the centre-ring track: scaled when authored, null (edge track) when absent", () => {
    const ringed = theme({
      flight: { enemyArrows: { ringRadiusPx: 100, ringOffsetYPx: 8 } },
      scale: 2,
    });
    const layout = resolveFlightHudLayout(ringed, PORTRAIT);
    expect(layout.enemyArrows.ringRadiusPx).toBe(200);
    expect(layout.enemyArrows.ringOffsetYPx).toBe(16);
    // Unauthored stays null — the legacy viewport-edge ellipse — not NaN.
    const plain = resolveFlightHudLayout(theme(), PORTRAIT);
    expect(plain.enemyArrows.ringRadiusPx).toBeNull();
    expect(plain.enemyArrows.ringOffsetYPx).toBe(0);
  });

  it("resolves the throttle's wheel step (the pointer-side nudge)", () => {
    expect(resolveFlightHudLayout(theme(), PORTRAIT).throttle.wheelStepPerNotch).toBe(
      FLIGHT_HUD_DEFAULTS.throttle.wheelStepPerNotch,
    );
    const custom = theme({ flight: { throttle: { wheelStepPerNotch: 0.25 } } });
    // Feel, not geometry: never scaled.
    expect(resolveFlightHudLayout(custom, LANDSCAPE).throttle.wheelStepPerNotch).toBe(0.25);
  });

  it("resolves throttle opacity and the optional lock-zone visibility switch", () => {
    const layout = resolveFlightHudLayout(
      theme({ flight: { throttle: { opacity: 0.6 }, reticle: { showZone: false } } }),
      PORTRAIT,
    );
    expect(layout.throttle.opacity).toBe(0.6);
    expect(layout.reticle.showZone).toBe(false);
    expect(flightCssVars(layout)["--hud-throttle-opacity"]).toBe("0.6");
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
    // A landscape override of the joystick must not disturb the FIRE block.
    expect(layout.fire.radiusPx).toBe(17);
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

  /**
   * Owner 2026-08-22: "lock circle 50% thinner when locked". The rule is
   * expressed against whatever the theme authored for the ACQUIRING ring, not
   * against the built-in default — otherwise a pack with a hairline progress
   * ring would get a *thicker* one on completion.
   */
  it("halves the acquiring ring for the locked state, relative to the theme's own width", () => {
    const shipped = resolveFlightHudLayout(theme(), PORTRAIT);
    expect(shipped.reticle.ringStrokePx).toBe(4);
    expect(shipped.reticle.lockedRingStrokePx).toBe(2);

    const thick = resolveFlightHudLayout(
      theme({ flight: { reticle: { ringStrokePx: 9 } } }),
      PORTRAIT,
    );
    expect(thick.reticle.lockedRingStrokePx).toBe(4.5);

    // An explicit authored value wins outright, including "keep them equal".
    const pinned = resolveFlightHudLayout(
      theme({ flight: { reticle: { ringStrokePx: 4, lockedRingStrokePx: 4 } } }),
      PORTRAIT,
    );
    expect(pinned.reticle.lockedRingStrokePx).toBe(4);

    // It is geometry, so it scales with the orientation block like its sibling.
    const landscape = resolveFlightHudLayout(theme(), LANDSCAPE);
    expect(landscape.reticle.ringStrokePx).toBe(2);
    expect(landscape.reticle.lockedRingStrokePx).toBe(1);
  });
});

describe("secondary action geometry", () => {
  it("ignores legacy action offsets whenever an authored rail exists", () => {
    const layout = resolveFlightHudLayout(
      theme({
        flight: {
          actions: {
            arc: { radiusPx: 180, startDeg: -100, sweepDeg: -80, buttonDiameterPx: 48 },
            boost: { offsetXPx: 999, offsetYPx: 999 },
            jettison: { offsetXPx: 888, offsetYPx: 888 },
          },
        },
      }),
      PORTRAIT,
    );
    const secondary = resolveFlightSecondaryControls(layout, 2);
    expect(secondary.usesActionArc).toBe(true);
    if (!secondary.usesActionArc) throw new Error("expected authored action arc");
    expect(secondary.boost.offsetXPx).not.toBe(999);
    expect(secondary.jettison.offsetXPx).not.toBe(888);
  });

  it("uses bottom-right authored action slots, with backwards-compatible defaults", () => {
    const layout = resolveFlightHudLayout(theme(), PORTRAIT);
    expect(layout.boost.anchor).toBe("bottom-right");
    expect(layout.jettison.anchor).toBe("bottom-right");
    expect(layout.boost.radiusPx).toBe(26);
    expect(layout.jettison.radiusPx).toBe(26);
    expect(layout.boost.color).toBe(MODULE_FAMILY_COLOR_FALLBACKS.boost);
  });

  it("scales authored slots through the orientation override", () => {
    const landscape = resolveFlightHudLayout(theme(), LANDSCAPE);
    expect(landscape.boost.radiusPx).toBe(13);
    expect(landscape.jettison.radiusPx).toBe(13);
  });

  it("takes the boost family's authored colour, so the hangar and the HUD agree", () => {
    const tinted = resolveFlightHudLayout(
      theme({ modules: { familyColors: { boost: "#00ff88" } } }),
      PORTRAIT,
    );
    expect(tinted.boost.color).toBe("#00ff88");
    expect(flightCssVars(tinted)["--hud-boost-color"]).toBe("#00ff88");
    expect(flightCssVars(tinted)["--hud-boost-radius"]).toBe(`${tinted.boost.radiusPx}px`);
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
    expect(vars["--hud-fire-radius"]).toBe("34px");
    expect(vars["--hud-module-fill-pct"]).toBe("32%"); // restrained active-fill default (2026-07-31)
    expect(vars["--hud-fire-color"]).toBe("#EF4444"); // board RED 500 (design system v1.0)
    expect(vars["--hud-steer-origin-radius"]).toBe("7px");
  });
});

describe("shipped FIRE-centred control rail", () => {
  interface Rect {
    name: string;
    left: number;
    top: number;
    right: number;
    bottom: number;
  }

  const shipped = JSON.parse(
    readFileSync("content/themes/default.json", "utf8"),
  ) as ThemeConfig;

  function pivot(
    anchor: "bottom-right" | "bottom-left" | "top-right" | "top-left",
    viewport: { width: number; height: number },
    inset: number,
  ): { x: number; y: number } {
    const signs = anchorSigns(anchor);
    return {
      x: signs.x < 0 ? viewport.width - inset : inset,
      y: signs.y < 0 ? viewport.height - inset : inset,
    };
  }

  function around(name: string, x: number, y: number, halfWidth: number, halfHeight = halfWidth): Rect {
    return {
      name,
      left: x - halfWidth,
      top: y - halfHeight,
      right: x + halfWidth,
      bottom: y + halfHeight,
    };
  }

  function boxes(viewport: { width: number; height: number }, moduleCount: number): {
    controls: Rect[];
    captions: Rect[];
    obstacles: Rect[];
    centres: { x: number; y: number; radius: number }[];
    inset: number;
  } {
    const hud = resolveHudLayout(shipped, viewport);
    const flight = resolveFlightHudLayout(shipped, viewport);
    const controls: Rect[] = [];
    const captions: Rect[] = [];
    const centres: { x: number; y: number; radius: number }[] = [];

    const flightPivot = (anchor: typeof flight.fire.anchor) =>
      pivot(anchor, viewport, hud.safeAreaInsetPx);
    const fireCorner = flightPivot(flight.fire.anchor);
    const fireOffset = anchoredOffset(
      flight.fire.anchor,
      flight.fire.offsetXPx,
      flight.fire.offsetYPx,
      flight.fire.radiusPx,
    );
    const fireRingVisible = flight.fire.ringArcDeg > 0 && flight.fire.ringStrokePx > 0;
    controls.push(
      around(
        fireRingVisible ? "fire-ring" : "fire",
        fireCorner.x + fireOffset.dx,
        fireCorner.y + fireOffset.dy,
        flight.fire.radiusPx + (fireRingVisible ? flight.fire.ringGapPx : 0),
      ),
    );
    // This is the exact resolver output consumed by ModuleButtons, BOOST and
    // JETTISON at runtime; the audit owns no parallel rail math.
    const secondary = resolveFlightSecondaryControls(flight, moduleCount);
    expect(secondary.usesActionArc).toBe(true);
    if (!secondary.usesActionArc) throw new Error("expected shipped action arc");
    const slots = secondary.modules.concat(secondary.boost, secondary.jettison);
    expect(slots).toHaveLength(moduleCount + 2);
    for (const [index, slot] of slots.entries()) {
      const corner = flightPivot(slot.anchor);
      const offset = anchoredOffset(slot.anchor, slot.offsetXPx, slot.offsetYPx, slot.radiusPx);
      const x = corner.x + offset.dx;
      const y = corner.y + offset.dy;
      const name = index < moduleCount ? `module-${index}` : index === moduleCount ? "boost" : "jettison";
      controls.push(around(name, x, y, slot.radiusPx));
      centres.push({ x, y, radius: slot.radiusPx });
      const captionDistance = slot.radiusPx + slot.captionGapPx + flight.modules.labelHeightPx / 2;
      const captionX = x + slot.captionX * captionDistance;
      const captionY = y + slot.captionY * captionDistance;
      captions.push(around(`${name}-caption`, captionX, captionY, flight.modules.labelMaxWidthPx / 2, flight.modules.labelHeightPx / 2));
    }

    const throttleCorner = flightPivot(flight.throttle.anchor);
    const throttleOffset = anchoredBoxOffset(
      flight.throttle.anchor,
      flight.throttle.offsetXPx,
      flight.throttle.offsetYPx,
      flight.throttle.widthPx / 2,
      flight.throttle.heightPx / 2,
    );
    const throttleX = throttleCorner.x + throttleOffset.dx;
    const throttleY = throttleCorner.y + throttleOffset.dy;
    const speedY =
      throttleY +
      (flight.throttle.anchor.startsWith("bottom") ? 1 : -1) *
        (flight.throttle.heightPx / 2 + 10 * flight.scale);
    const minimapSize = Math.min(hud.minimapSizePx, viewport.width * 0.4);
    const obstacles = [
      {
        name: "minimap",
        left: hud.safeAreaInsetPx,
        top: hud.safeAreaInsetPx,
        right: hud.safeAreaInsetPx + minimapSize,
        bottom: hud.safeAreaInsetPx + minimapSize,
      },
      around(
        "throttle",
        throttleX,
        throttleY,
        flight.throttle.widthPx / 2,
        flight.throttle.heightPx / 2,
      ),
      around("speed", throttleX, speedY, 34 * flight.scale, 9 * flight.scale),
    ];
    return { controls, captions, obstacles, centres, inset: hud.safeAreaInsetPx };
  }

  function overlaps(a: Rect, b: Rect): boolean {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  }

  it("resolves the 820 x 1180 brawler fit in authored thumb order", () => {
    const viewport = { width: 820, height: 1180 };
    const hud = resolveHudLayout(shipped, viewport);
    const flight = resolveFlightHudLayout(shipped, viewport);
    // ModuleButtons orders weapons first, then utilities; these four slots are
    // therefore BEAM, MISSILE, weapon three, ARMOR PLATE. The dedicated
    // actions must follow them on the same resolver output, never legacy offsets.
    const secondary = resolveFlightSecondaryControls(flight, 4);
    expect(secondary.usesActionArc).toBe(true);
    if (!secondary.usesActionArc) throw new Error("expected shipped action arc");
    const ordered = secondary.modules.concat(secondary.boost, secondary.jettison);
    expect(ordered).toHaveLength(6);

    const corner = pivot(flight.fire.anchor, viewport, hud.safeAreaInsetPx);
    const centres = ordered.map((slot) => {
      const offset = anchoredOffset(slot.anchor, slot.offsetXPx, slot.offsetYPx, slot.radiusPx);
      return { x: corner.x + offset.dx, y: corner.y + offset.dy };
    });
    // These values pin the real resolver output for the owner's portrait case.
    expect(centres).toEqual([
      { x: expect.closeTo(728.6, 2), y: expect.closeTo(978.78, 2) },
      { x: expect.closeTo(677.65, 2), y: expect.closeTo(1002.27, 2) },
      { x: expect.closeTo(641.8, 2), y: expect.closeTo(1045.42, 2) },
      { x: expect.closeTo(628.04, 2), y: expect.closeTo(1099.81, 2) },
      { x: expect.closeTo(714.83, 2), y: expect.closeTo(914.02, 2) },
      { x: expect.closeTo(662.23, 2), y: expect.closeTo(933.53, 2) },
    ]);
  });

  it.each([
    { width: 390, height: 740 },
    { width: 820, height: 1180 },
    { width: 1280, height: 800 },
  ])("puts every action on ONE ring for every shipped fitting at $width x $height", (viewport) => {
    // The owner's report (2026-08-21): buttons sat at different distances from
    // the thumb depending on the fitting, because the rail split onto a second
    // ring the moment the authored radius was full. It now GROWS instead. Every
    // shipped hull asks for at most 3 arc modules (the heavy: 3 weapons + a
    // shield, one weapon on the pedestal) plus BOOST and JETTISON — 5 slots.
    const flight = resolveFlightHudLayout(shipped, viewport);
    for (let arcModules = 0; arcModules <= 3; arcModules++) {
      const { modules, boost, jettison } = resolveFlightSecondaryControls(flight, arcModules + 1, {
        primaryOnFireSlot: true,
      });
      // The pedestal is its own footprint by design; the ARC is what must be uniform.
      const onArc = [...modules.slice(1), boost, jettison];
      const centre = anchoredOffset(
        flight.fire.anchor,
        flight.fire.offsetXPx,
        flight.fire.offsetYPx,
        flight.fire.radiusPx,
      );
      const radii = onArc.map((slot) => {
        const at = anchoredOffset(slot.anchor, slot.offsetXPx, slot.offsetYPx, slot.radiusPx);
        return Math.hypot(at.dx - centre.dx, at.dy - centre.dy);
      });
      for (const r of radii) {
        expect(r, `arcModules=${arcModules}: every action shares one ring radius`).toBeCloseTo(radii[0]!, 6);
      }
      // …and they are all the same SIZE, too.
      for (const slot of onArc) expect(slot.radiusPx).toBeCloseTo(onArc[0]!.radiusPx, 6);
    }
  });

  it.each([
    { width: 390, height: 740 },
    { width: 820, height: 1180 },
    { width: 1280, height: 800 },
  ])("keeps every fitted rail arrangement clear at $width x $height", (viewport) => {
    for (const moduleCount of [2, 4, 6]) {
      const { controls, captions, obstacles, centres, inset } = boxes(viewport, moduleCount);
      const fire = controls.find((control) => control.name === "fire-ring")!;
      const fireX = (fire.left + fire.right) / 2;
      const fireY = (fire.top + fire.bottom) / 2;
      const fireRadius = (fire.right - fire.left) / 2;
      for (let i = 0; i < centres.length; i++) {
        const fireGap = Math.hypot(centres[i]!.x - fireX, centres[i]!.y - fireY) - centres[i]!.radius - fireRadius;
        expect(fireGap, `modules=${moduleCount}: ${i} / FIRE edge gap`).toBeGreaterThanOrEqual(8);
        for (let j = i + 1; j < centres.length; j++) {
          const a = centres[i]!;
          const b = centres[j]!;
          const edgeGap = Math.hypot(a.x - b.x, a.y - b.y) - a.radius - b.radius;
          expect(edgeGap, `modules=${moduleCount}: ${i} / ${j} edge gap`).toBeGreaterThanOrEqual(8);
        }
      }
      if (moduleCount === 2) {
        for (const centre of centres) {
          expect(
            Math.hypot(centre.x - fireX, centre.y - fireY),
            "two fitted modules stay in FIRE's 180px thumb cluster",
          ).toBeLessThanOrEqual(180);
        }
      }
    for (let i = 0; i < controls.length; i++) {
      const box = controls[i]!;
      expect(box.left, `${box.name} left`).toBeGreaterThanOrEqual(inset);
      expect(box.top, `${box.name} top`).toBeGreaterThanOrEqual(inset);
      expect(box.right, `${box.name} right`).toBeLessThanOrEqual(viewport.width - inset);
      expect(box.bottom, `${box.name} bottom`).toBeLessThanOrEqual(viewport.height - inset);
      for (const obstacle of obstacles) {
        expect(overlaps(box, obstacle), `${box.name} overlaps ${obstacle.name}`).toBe(false);
      }
      for (const caption of captions) {
        for (const control of controls) {
          if (caption.name.startsWith(control.name)) continue;
          expect(overlaps(caption, control), `${caption.name} overlaps ${control.name}`).toBe(false);
        }
      }
    }
    }
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
        // A ship-relative camera reports beta = base + pitch in world terms,
        // so the effective tilt remains `base`.
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
      // axis; the live chase rig stays in the front hemisphere, and the clamp
      // is the answer if authored camera geometry ever gets there anyway.
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
    ringRadiusPx: null,
    ringOffsetYPx: 0,
    sizePx: 20,
    safeMarginPx: 30,
    maxCount: 8,
    fadeNearUnits: 60,
    fadeFarUnits: 320,
    minOpacity: 0.35,
    outOfRangeScale: 0.6,
    outOfRangeOpacity: 0.4,
    markerMinOpacity: 0.35,
    markerSizePx: 10,
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

describe("offScreenArrowPlacement — centre-ring track (interior of the vital arcs)", () => {
  const VIEWPORT = { width: 800, height: 600 };
  const CENTRE = { x: 400, y: 300 };
  const RING = 92;
  const OFFSET_Y = 8;
  const ARROWS: EnemyArrowsLayout = {
    enabled: true,
    insetXPx: 40,
    insetYPx: 50,
    ringRadiusPx: RING,
    ringOffsetYPx: OFFSET_Y,
    sizePx: 20,
    safeMarginPx: 30,
    maxCount: 8,
    fadeNearUnits: 60,
    fadeFarUnits: 320,
    minOpacity: 0.35,
    outOfRangeScale: 0.6,
    outOfRangeOpacity: 0.4,
    markerMinOpacity: 0.35,
    markerSizePx: 10,
  };

  function place(x: number, y: number, behind = false, arrows = ARROWS, viewport = VIEWPORT): ArrowPlacement | null {
    const out: ArrowPlacement = { x: 0, y: 0, rotationRad: 0 };
    return offScreenArrowPlacement({ x, y, behind }, viewport, arrows, out) ? out : null;
  }

  it("parks every arrow on the ring, concentric with the vital arcs", () => {
    for (const [x, y] of [
      [CENTRE.x, -500],
      [2000, CENTRE.y],
      [-300, 5000],
      [1400, -900],
    ]) {
      const p = place(x!, y!)!;
      const r = Math.hypot(p.x - CENTRE.x, p.y - (CENTRE.y + OFFSET_Y));
      expect(r).toBeCloseTo(RING, 6);
    }
  });

  it("still points along the true bearing — the ring changes the perch, not the direction", () => {
    const up = place(CENTRE.x, -500)!;
    expect(up.x).toBeCloseTo(CENTRE.x, 6);
    expect(up.y).toBeCloseTo(CENTRE.y + OFFSET_Y - RING, 6);
    expect(up.rotationRad).toBeCloseTo(-Math.PI / 2, 6);
    const right = place(2000, CENTRE.y)!;
    expect(right.x).toBeCloseTo(CENTRE.x + RING, 6);
    expect(right.rotationRad).toBeCloseTo(0, 6);
  });

  it("keeps the on-screen safe-rect handover unchanged: only off-screen enemies ride the ring", () => {
    expect(place(CENTRE.x + 150, CENTRE.y)).toBeNull(); // on screen, outside the ring
    expect(place(CENTRE.x, ARROWS.safeMarginPx - 1)).not.toBeNull();
  });

  it("flips a behind-camera contact exactly like the edge track", () => {
    const p = place(CENTRE.x - 100, CENTRE.y, true)!;
    // Mirrored: the enemy is really to screen RIGHT.
    expect(p.x).toBeGreaterThan(CENTRE.x);
    expect(Math.abs(p.rotationRad)).toBeLessThan(0.01);
  });

  it("clamps the ring inside the edge ellipse on a viewport smaller than the ring", () => {
    const tiny = { width: 160, height: 120 };
    const p = place(500, 60, false, ARROWS, tiny)!;
    expect(p.x).toBeGreaterThan(0);
    expect(p.x).toBeLessThanOrEqual(tiny.width);
    expect(p.y).toBeGreaterThan(0);
    expect(p.y).toBeLessThanOrEqual(tiny.height);
  });
});

describe("arrowOpacity", () => {
  const ARROWS: EnemyArrowsLayout = {
    enabled: true,
    insetXPx: 34,
    insetYPx: 46,
    ringRadiusPx: null,
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
