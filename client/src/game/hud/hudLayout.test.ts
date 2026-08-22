import { describe, expect, it } from "vitest";
import type { ThemeConfig } from "@space-arena/shared";
import {
  clusterOffsets,
  clusterReachPx,
  clusterTopPx,
  hudCssVars,
  orientationOf,
  rawClusterOffsets,
  resolveHudLayout,
  thumbZoneFactor,
} from "./hudLayout.js";

/** The shipped theme's shape, inlined so the test pins behaviour, not content. */
function theme(overrides: Partial<ThemeConfig["hud"]> = {}): ThemeConfig {
  return {
    id: "theme.default",
    type: "theme",
    version: 1,
    colors: {},
    hud: {
      scale: 1,
      safeAreaInsetPx: 12,
      minimapSizePx: 128,
      thumbZoneFraction: 0.4,
      moduleCluster: {
        anchor: "bottom-right",
        layout: "arc",
        buttonRadiusPx: 32,
        gapPx: 10,
        arcRadiusPx: 144,
        arcStartDeg: 180,
        arcSweepDeg: -90,
        maxPerRow: 2,
        offsetXPx: 24,
        offsetYPx: 34,
      },
      landscape: {
        scale: 0.85,
        safeAreaInsetPx: 10,
        minimapSizePx: 104,
        moduleCluster: { buttonRadiusPx: 28, gapPx: 8, arcRadiusPx: 126, offsetXPx: 22, offsetYPx: 30 },
      },
      ...overrides,
    },
  } as ThemeConfig;
}

const PORTRAIT = { width: 375, height: 812 };
const LANDSCAPE = { width: 812, height: 375 };
const SMALL_PORTRAIT = { width: 360, height: 640 };

describe("orientationOf", () => {
  it("treats a square viewport as portrait (only wider-than-tall is landscape)", () => {
    expect(orientationOf({ width: 500, height: 500 })).toBe("portrait");
    expect(orientationOf(PORTRAIT)).toBe("portrait");
    expect(orientationOf(LANDSCAPE)).toBe("landscape");
  });
});

describe("resolveHudLayout — portrait/landscape blocks", () => {
  it("uses the base block in portrait and layers the landscape block in landscape", () => {
    const p = resolveHudLayout(theme(), PORTRAIT);
    expect(p.orientation).toBe("portrait");
    expect(p.scale).toBe(1);
    expect(p.minimapSizePx).toBe(128);
    expect(p.cluster.buttonRadiusPx).toBe(32);
    expect(p.cluster.arcRadiusPx).toBe(144);

    const l = resolveHudLayout(theme(), LANDSCAPE);
    expect(l.orientation).toBe("landscape");
    expect(l.scale).toBe(0.85);
    // Overridden fields, then scaled by the landscape scale factor.
    expect(l.minimapSizePx).toBeCloseTo(104 * 0.85, 6);
    expect(l.cluster.buttonRadiusPx).toBeCloseTo(28 * 0.85, 6);
    expect(l.cluster.arcRadiusPx).toBeCloseTo(126 * 0.85, 6);
    // Not overridden in the landscape block → inherited from the base block.
    expect(l.cluster.anchor).toBe("bottom-right");
    expect(l.cluster.arcSweepDeg).toBe(-90);
  });

  it("scales control sizes by hud.scale but never the safe-area inset", () => {
    const layout = resolveHudLayout(theme({ scale: 2 }), PORTRAIT);
    expect(layout.cluster.buttonRadiusPx).toBe(64);
    expect(layout.safeAreaInsetPx).toBe(12);
    expect(hudCssVars(layout)["--hud-scale"]).toBe("2");
  });

  it("tolerates but ignores legacy lower-left gauge knobs", () => {
    // `gaugeWidthPx` / `gauges` were dropped from themeSchema once it was clear
    // nothing read them, so they are cast in here as the stray keys an
    // un-migrated theme file would still carry. The layout must ignore them
    // rather than trip over them.
    const legacy = { gaugeWidthPx: 999, gauges: { anchor: "top-right", offsetXPx: 99, offsetYPx: 88 } };
    const layout = resolveHudLayout(theme(legacy as Partial<ThemeConfig["hud"]>), PORTRAIT);
    expect("gauges" in layout).toBe(false);
    expect(Object.keys(hudCssVars(layout)).some((key) => key.includes("gauge"))).toBe(false);
  });

  it("resolves the 3D radar and centre vital arcs with orientation scaling", () => {
    const configured = theme({
      radar: { sizePx: 140, rangeUnits: 125, elevationDeg: 32, altitudeStemMaxPx: 24 },
      vitalArcs: { enabled: true, radiusPx: 150, strokePx: 5, arcDeg: 120, gapPx: 40, opacity: 0.6 },
      landscape: {
        scale: 0.5,
        radar: { sizePx: 100 },
        vitalArcs: { radiusPx: 130 },
      },
    });
    const portrait = resolveHudLayout(configured, PORTRAIT);
    expect(portrait.radar.sizePx).toBe(140);
    expect(portrait.radar.rangeUnits).toBe(125);
    expect(portrait.vitalArcs.enabled).toBe(true);
    expect(portrait.vitalArcs.radiusPx).toBe(150);
    expect(portrait.vitalArcs.gapPx).toBe(40);

    const landscape = resolveHudLayout(configured, LANDSCAPE);
    expect(landscape.radar.sizePx).toBe(50);
    expect(landscape.radar.rangeUnits).toBe(125);
    expect(landscape.vitalArcs.radiusPx).toBe(65);
    expect(landscape.vitalArcs.opacity).toBe(0.6);
    // The gap is geometry: it scales with the orientation, and a landscape block
    // that only re-authors the radius inherits the base gap rather than losing it.
    expect(landscape.vitalArcs.gapPx).toBe(20);
    // The SWEEP is an angle, so it survives scaling untouched in both.
    expect(portrait.vitalArcs.arcDeg).toBe(120);
    expect(landscape.vitalArcs.arcDeg).toBe(120);
    expect(hudCssVars(landscape)["--hud-radar-size"]).toBe("50px");
  });

  it("falls back to the legacy flat moduleButton* fields for pre-5.4 themes", () => {
    const legacy = {
      id: "theme.legacy",
      type: "theme",
      version: 1,
      colors: {},
      hud: { moduleButtonRadiusPx: 40, moduleButtonGapPx: 20 },
    } as ThemeConfig;
    const layout = resolveHudLayout(legacy, PORTRAIT);
    expect(layout.cluster.buttonRadiusPx).toBe(40);
    expect(layout.cluster.gapPx).toBe(20);
  });

  it("survives a missing theme entirely", () => {
    const layout = resolveHudLayout(undefined, PORTRAIT);
    expect(layout.cluster.anchor).toBe("bottom-right");
    expect(layout.scale).toBe(1);
  });
});

describe("rawClusterOffsets — arc geometry", () => {
  it("maps 180° to straight-left of the pivot and 90° to straight-above it", () => {
    const cluster = {
      ...resolveHudLayout(theme(), PORTRAIT).cluster,
      arcRadiusPx: 100,
      arcStartDeg: 180,
      arcSweepDeg: -90,
      offsetXPx: 0,
      offsetYPx: 0,
    };
    const offsets = rawClusterOffsets(3, cluster);
    expect(offsets[0]!.dx).toBeCloseTo(-100, 4);
    expect(offsets[0]!.dy).toBeCloseTo(0, 4);
    expect(offsets[2]!.dx).toBeCloseTo(0, 4);
    expect(offsets[2]!.dy).toBeCloseTo(-100, 4);
  });

  it("fans the shipped cluster up-and-left of a bottom-right anchor, offsets included", () => {
    const cluster = resolveHudLayout(theme(), PORTRAIT).cluster;
    const offsets = rawClusterOffsets(4, cluster);
    expect(offsets).toHaveLength(4);
    // The offsets push every button clear of both anchored edges.
    for (const o of offsets) {
      expect(o.dx).toBeLessThanOrEqual(-cluster.offsetXPx + 1e-9);
      expect(o.dy).toBeLessThanOrEqual(-cluster.offsetYPx + 1e-9);
    }
    // The sweep runs monotonically from "beside the pivot" to "above" it.
    expect(offsets[0]!.dx).toBeLessThan(offsets[3]!.dx);
    expect(offsets[0]!.dy).toBeGreaterThan(offsets[3]!.dy);
  });

  it("keeps adjacent buttons from overlapping at the shipped arc radius", () => {
    const cluster = resolveHudLayout(theme(), PORTRAIT).cluster;
    const offsets = rawClusterOffsets(4, cluster);
    const minGap = 2 * cluster.buttonRadiusPx;
    for (let i = 1; i < offsets.length; i++) {
      const d = Math.hypot(offsets[i]!.dx - offsets[i - 1]!.dx, offsets[i]!.dy - offsets[i - 1]!.dy);
      expect(d).toBeGreaterThanOrEqual(minGap);
    }
  });

  it("mirrors the arc onto whichever corner the theme anchors to", () => {
    const base = resolveHudLayout(theme(), PORTRAIT).cluster;
    const topLeft = rawClusterOffsets(4, { ...base, anchor: "top-left" });
    for (const o of topLeft) {
      expect(o.dx).toBeGreaterThan(0);
      expect(o.dy).toBeGreaterThan(0);
    }
    const bottomLeft = rawClusterOffsets(4, { ...base, anchor: "bottom-left" });
    for (const o of bottomLeft) {
      expect(o.dx).toBeGreaterThan(0);
      expect(o.dy).toBeLessThan(0);
    }
  });

  it("returns nothing for an empty fitting", () => {
    expect(rawClusterOffsets(0, resolveHudLayout(theme(), PORTRAIT).cluster)).toEqual([]);
  });
});

describe("rawClusterOffsets — wrap layout", () => {
  it("packs rows of maxPerRow growing away from the corner", () => {
    const cluster = { ...resolveHudLayout(theme(), PORTRAIT).cluster, layout: "wrap" as const, offsetXPx: 0, offsetYPx: 0 };
    const offsets = rawClusterOffsets(4, cluster);
    const pitch = cluster.buttonRadiusPx * 2 + cluster.gapPx;
    expect(offsets[0]).toEqual({ dx: -cluster.buttonRadiusPx, dy: -cluster.buttonRadiusPx });
    expect(offsets[1]).toEqual({ dx: -(cluster.buttonRadiusPx + pitch), dy: -cluster.buttonRadiusPx });
    expect(offsets[2]).toEqual({ dx: -cluster.buttonRadiusPx, dy: -(cluster.buttonRadiusPx + pitch) });
  });
});

describe("one-thumb reachability clamp (ROADMAP S3)", () => {
  it("leaves the shipped portrait cluster untouched — it already fits the bottom 40%", () => {
    const layout = resolveHudLayout(theme(), SMALL_PORTRAIT);
    expect(thumbZoneFactor(4, layout)).toBe(1);
    // 360x640: bottom 40% starts at y=384; the topmost button must be below it.
    expect(clusterTopPx(4, layout)).toBeGreaterThanOrEqual(SMALL_PORTRAIT.height * 0.6);
  });

  it("shrinks an over-reaching cluster back inside the thumb zone", () => {
    const greedy = theme({
      moduleCluster: {
        anchor: "bottom-right",
        layout: "arc",
        buttonRadiusPx: 32,
        gapPx: 10,
        arcRadiusPx: 420,
        arcStartDeg: 180,
        arcSweepDeg: -90,
        maxPerRow: 2,
        offsetXPx: 34,
        offsetYPx: 34,
      },
    });
    const layout = resolveHudLayout(greedy, SMALL_PORTRAIT);
    expect(thumbZoneFactor(4, layout)).toBeLessThan(1);
    const offsets = clusterOffsets(4, layout);
    const reach = clusterReachPx(offsets, layout.cluster.buttonRadiusPx);
    // Reach + inset must fit inside 40% of the screen height.
    expect(reach + layout.safeAreaInsetPx).toBeLessThanOrEqual(SMALL_PORTRAIT.height * 0.4 + 1e-6);
    expect(clusterTopPx(4, layout)).toBeGreaterThanOrEqual(SMALL_PORTRAIT.height * 0.6 - 1e-6);
  });

  it("does not clamp in landscape — the theme's landscape block owns that case", () => {
    const layout = resolveHudLayout(theme(), LANDSCAPE);
    expect(thumbZoneFactor(4, layout)).toBe(1);
  });

  it("does not clamp a top-anchored cluster (the rule is about thumb reach at the bottom)", () => {
    const base = theme();
    const topAnchored = {
      ...base,
      hud: { ...base.hud, moduleCluster: { ...base.hud?.moduleCluster, anchor: "top-right" as const, arcRadiusPx: 400 } },
    } as ThemeConfig;
    expect(thumbZoneFactor(4, resolveHudLayout(topAnchored, SMALL_PORTRAIT))).toBe(1);
  });
});
