import type {
  HudAnchorName,
  HudOrientationConfig,
  HudStyleConfig,
  ModuleClusterConfig,
  RadarConfig,
  ThemeConfig,
  VitalArcsConfig,
} from "@space-arena/shared";

/**
 * Pure layout math for the DOM HUD (5.4 / 5.5).
 *
 * Everything here is a plain function of `theme.json` + the viewport size, so
 * the portrait/landscape switch, the HUD scale factor and the module-button
 * cluster geometry are unit-testable without a browser — and so *nothing*
 * layout-related has to be hardcoded in CSS or in {@link
 * import("./ModuleButtons.js").ModuleButtons}.
 */

export type Orientation = "portrait" | "landscape";

export interface Viewport {
  width: number;
  height: number;
}

export interface ClusterLayout {
  anchor: HudAnchorName;
  layout: "arc" | "wrap";
  buttonRadiusPx: number;
  gapPx: number;
  arcRadiusPx: number;
  arcStartDeg: number;
  arcSweepDeg: number;
  maxPerRow: number;
  offsetXPx: number;
  offsetYPx: number;
}

export interface HudLayout {
  orientation: Orientation;
  viewport: Viewport;
  scale: number;
  safeAreaInsetPx: number;
  minimapSizePx: number;
  minimapRangeUnits: number | undefined;
  radar: RadarLayout;
  vitalArcs: VitalArcsLayout;
  notificationMaxVisible: number;
  thumbZoneFraction: number;
  cluster: ClusterLayout;
  /** Look-only frame knobs (chamfer / glow / panel fill), shared by every widget. */
  style: HudStyleLayout;
}

export interface RadarLayout {
  sizePx: number;
  rangeUnits: number | undefined;
  elevationDeg: number;
  altitudeScale: number;
  altitudeStemMaxPx: number;
  contactSizePx: number;
  gridOpacity: number;
}

export interface VitalArcsLayout {
  enabled: boolean;
  radiusPx: number;
  strokePx: number;
  arcDeg: number;
  /**
   * Horizontal separation added between the two arcs — each slides half of this
   * away from the viewport centre, so the curvature stays whatever `radiusPx`
   * authored. See `vitalArcsSchema.gapPx` for why this is not folded into the
   * radius.
   */
  gapPx: number;
  offsetYPx: number;
  opacity: number;
  trackOpacity: number;
}

/**
 * Resolved `theme.hud.style`. Purely presentational, and deliberately NOT scaled
 * by `hud.scale`: a chamfer or a glow that grew with the HUD scale would read as
 * a different design rather than the same design at a different size. The one
 * exception is {@link HudStyleLayout.chamferPx}, which IS scaled — it is a
 * corner cut measured against control edges that do scale.
 */
export interface HudStyleLayout {
  chamferPx: number;
  glow: number;
  panelOpacity: number;
  tickOpacity: number;
  blurPx: number;
}

/** One button's centre, in px offsets from the cluster's anchor pivot (x right, y down). */
export interface ButtonOffset {
  dx: number;
  dy: number;
}

/** Fallbacks for a theme that omits a field (or is missing entirely). */
export const HUD_DEFAULTS = {
  scale: 1,
  safeAreaInsetPx: 12,
  minimapSizePx: 128,
  radar: {
    sizePx: 128,
    rangeUnits: undefined,
    elevationDeg: 30,
    altitudeScale: 0.65,
    altitudeStemMaxPx: 20,
    contactSizePx: 3.5,
    gridOpacity: 0.22,
  },
  vitalArcs: {
    enabled: false,
    radiusPx: 142,
    strokePx: 6,
    // A quarter-ish of a circle each, held well apart (owner 2026-08-22). The
    // pair used to be near-semicircles almost touching at the top and bottom of
    // the screen, which read as one closed ring around the ship rather than two
    // separate readouts flanking it.
    arcDeg: 100,
    gapPx: 48,
    offsetYPx: 10,
    opacity: 0.68,
    trackOpacity: 0.16,
  },
  style: {
    chamferPx: 8,
    glow: 0.55,
    panelOpacity: 0.58,
    tickOpacity: 0.34,
    blurPx: 6,
  },
  notificationMaxVisible: 3,
  thumbZoneFraction: 0.4,
  cluster: {
    anchor: "bottom-right",
    layout: "arc",
    buttonRadiusPx: 32,
    gapPx: 10,
    arcRadiusPx: 148,
    arcStartDeg: 180,
    arcSweepDeg: -90,
    maxPerRow: 2,
    offsetXPx: 34,
    offsetYPx: 34,
  },
} as const satisfies Omit<HudLayout, "orientation" | "viewport" | "minimapRangeUnits">;

/** A viewport taller than it is wide is portrait; square counts as portrait. */
export function orientationOf(viewport: Viewport): Orientation {
  return viewport.width > viewport.height ? "landscape" : "portrait";
}

/** Which way the cluster grows away from its anchored corner. */
export function anchorSigns(anchor: HudAnchorName): { x: -1 | 1; y: -1 | 1 } {
  return {
    x: anchor === "bottom-left" || anchor === "top-left" ? 1 : -1,
    y: anchor === "top-left" || anchor === "top-right" ? 1 : -1,
  };
}

function mergeCluster(base: ModuleClusterConfig | undefined, over: ModuleClusterConfig | undefined): ModuleClusterConfig {
  return { ...(base ?? {}), ...stripUndefined(over ?? {}) };
}

function mergeRadar(base: RadarConfig | undefined, over: RadarConfig | undefined): RadarConfig {
  return { ...(base ?? {}), ...stripUndefined(over ?? {}) };
}

function mergeVitalArcs(base: VitalArcsConfig | undefined, over: VitalArcsConfig | undefined): VitalArcsConfig {
  return { ...(base ?? {}), ...stripUndefined(over ?? {}) };
}

function stripUndefined<T extends object>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) if (v !== undefined) out[key] = v;
  return out as T;
}

/**
 * Resolves the theme's base `hud` block, layers the matching orientation
 * override on top, then applies `scale` to every control dimension (the root
 * font-size is scaled in CSS by the same factor). Safe-area insets are NOT
 * scaled — they are edge margins, not controls.
 */
export function resolveHudLayout(theme: ThemeConfig | undefined, viewport: Viewport): HudLayout {
  const orientation = orientationOf(viewport);
  const hud = theme?.hud;
  const override: HudOrientationConfig = (orientation === "landscape" ? hud?.landscape : hud?.portrait) ?? {};

  const scale = override.scale ?? hud?.scale ?? HUD_DEFAULTS.scale;
  const rawCluster = mergeCluster(hud?.moduleCluster, override.moduleCluster);
  const rawRadar = mergeRadar(hud?.radar, override.radar);
  const rawVitalArcs = mergeVitalArcs(hud?.vitalArcs, override.vitalArcs);

  // Legacy flat fields stay authoritative when the cluster block omits them, so
  // themes written before 5.4 keep their button size/gap.
  const buttonRadiusPx = rawCluster.buttonRadiusPx ?? hud?.moduleButtonRadiusPx ?? HUD_DEFAULTS.cluster.buttonRadiusPx;
  const gapPx = rawCluster.gapPx ?? hud?.moduleButtonGapPx ?? HUD_DEFAULTS.cluster.gapPx;

  return {
    orientation,
    viewport,
    scale,
    safeAreaInsetPx: override.safeAreaInsetPx ?? hud?.safeAreaInsetPx ?? HUD_DEFAULTS.safeAreaInsetPx,
    minimapSizePx:
      (rawRadar.sizePx ?? override.minimapSizePx ?? hud?.minimapSizePx ?? HUD_DEFAULTS.minimapSizePx) * scale,
    minimapRangeUnits: rawRadar.rangeUnits ?? hud?.minimapRangeUnits,
    radar: {
      sizePx:
        (rawRadar.sizePx ?? override.minimapSizePx ?? hud?.minimapSizePx ?? HUD_DEFAULTS.radar.sizePx) * scale,
      rangeUnits: rawRadar.rangeUnits ?? hud?.minimapRangeUnits,
      elevationDeg: rawRadar.elevationDeg ?? HUD_DEFAULTS.radar.elevationDeg,
      altitudeScale: rawRadar.altitudeScale ?? HUD_DEFAULTS.radar.altitudeScale,
      altitudeStemMaxPx:
        (rawRadar.altitudeStemMaxPx ??
          override.minimapAltitudeTickPx ??
          hud?.minimapAltitudeTickPx ??
          HUD_DEFAULTS.radar.altitudeStemMaxPx) * scale,
      contactSizePx: (rawRadar.contactSizePx ?? HUD_DEFAULTS.radar.contactSizePx) * scale,
      gridOpacity: rawRadar.gridOpacity ?? HUD_DEFAULTS.radar.gridOpacity,
    },
    vitalArcs: {
      enabled: rawVitalArcs.enabled ?? HUD_DEFAULTS.vitalArcs.enabled,
      radiusPx: (rawVitalArcs.radiusPx ?? HUD_DEFAULTS.vitalArcs.radiusPx) * scale,
      strokePx: (rawVitalArcs.strokePx ?? HUD_DEFAULTS.vitalArcs.strokePx) * scale,
      // An angle, so it is NOT scaled — the arcs keep their shape at every HUD
      // scale, only their size changes.
      arcDeg: rawVitalArcs.arcDeg ?? HUD_DEFAULTS.vitalArcs.arcDeg,
      gapPx: (rawVitalArcs.gapPx ?? HUD_DEFAULTS.vitalArcs.gapPx) * scale,
      offsetYPx: (rawVitalArcs.offsetYPx ?? HUD_DEFAULTS.vitalArcs.offsetYPx) * scale,
      opacity: rawVitalArcs.opacity ?? HUD_DEFAULTS.vitalArcs.opacity,
      trackOpacity: rawVitalArcs.trackOpacity ?? HUD_DEFAULTS.vitalArcs.trackOpacity,
    },
    style: resolveHudStyle(hud?.style, scale),
    notificationMaxVisible: hud?.notificationMaxVisible ?? HUD_DEFAULTS.notificationMaxVisible,
    thumbZoneFraction: override.thumbZoneFraction ?? hud?.thumbZoneFraction ?? HUD_DEFAULTS.thumbZoneFraction,
    cluster: {
      anchor: rawCluster.anchor ?? HUD_DEFAULTS.cluster.anchor,
      layout: rawCluster.layout ?? HUD_DEFAULTS.cluster.layout,
      buttonRadiusPx: buttonRadiusPx * scale,
      gapPx: gapPx * scale,
      arcRadiusPx: (rawCluster.arcRadiusPx ?? HUD_DEFAULTS.cluster.arcRadiusPx) * scale,
      arcStartDeg: rawCluster.arcStartDeg ?? HUD_DEFAULTS.cluster.arcStartDeg,
      arcSweepDeg: rawCluster.arcSweepDeg ?? HUD_DEFAULTS.cluster.arcSweepDeg,
      maxPerRow: rawCluster.maxPerRow ?? HUD_DEFAULTS.cluster.maxPerRow,
      offsetXPx: (rawCluster.offsetXPx ?? HUD_DEFAULTS.cluster.offsetXPx) * scale,
      offsetYPx: (rawCluster.offsetYPx ?? HUD_DEFAULTS.cluster.offsetYPx) * scale,
    },
  };
}

/**
 * Resolve the look block. There is no orientation override for it on purpose:
 * the shape language should not change when a phone is rotated, only the sizes
 * around it — and those are already per-orientation.
 */
function resolveHudStyle(style: HudStyleConfig | undefined, scale: number): HudStyleLayout {
  const d = HUD_DEFAULTS.style;
  return {
    chamferPx: (style?.chamferPx ?? d.chamferPx) * scale,
    glow: style?.glow ?? d.glow,
    panelOpacity: style?.panelOpacity ?? d.panelOpacity,
    tickOpacity: style?.tickOpacity ?? d.tickOpacity,
    blurPx: style?.blurPx ?? d.blurPx,
  };
}

/**
 * Raw button centres for `count` buttons, in px from the anchor pivot. Computed
 * in the canonical bottom-right convention (grows left/up) then mirrored onto
 * the configured corner, so a designer can flip corners without re-authoring
 * angles.
 */
export function rawClusterOffsets(count: number, cluster: ClusterLayout): ButtonOffset[] {
  if (count <= 0) return [];
  const { x: sx, y: sy } = anchorSigns(cluster.anchor);
  const out: ButtonOffset[] = [];

  if (cluster.layout === "arc") {
    const step = count > 1 ? cluster.arcSweepDeg / (count - 1) : 0;
    // Canonical convention is the bottom-right corner (signs -1/-1); flipping to
    // another corner mirrors the whole arc rather than folding it, so the
    // circle stays a circle even for angles outside the corner's quadrant.
    const mirrorX = -sx;
    const mirrorY = -sy;
    for (let i = 0; i < count; i++) {
      const rad = ((cluster.arcStartDeg + step * i) * Math.PI) / 180;
      const dx = Math.cos(rad) * cluster.arcRadiusPx;
      const dy = -Math.sin(rad) * cluster.arcRadiusPx;
      out.push({ dx: mirrorX * dx + sx * cluster.offsetXPx, dy: mirrorY * dy + sy * cluster.offsetYPx });
    }
    return out;
  }

  const pitch = cluster.buttonRadiusPx * 2 + cluster.gapPx;
  for (let i = 0; i < count; i++) {
    const col = i % cluster.maxPerRow;
    const row = Math.floor(i / cluster.maxPerRow);
    out.push({
      dx: sx * (cluster.buttonRadiusPx + col * pitch + cluster.offsetXPx),
      dy: sy * (cluster.buttonRadiusPx + row * pitch + cluster.offsetYPx),
    });
  }
  return out;
}

/** How far the cluster reaches from the pivot toward the far edge, button rim included. */
export function clusterReachPx(offsets: readonly ButtonOffset[], buttonRadiusPx: number): number {
  let reach = 0;
  for (const o of offsets) reach = Math.max(reach, Math.abs(o.dy) + buttonRadiusPx);
  return reach;
}

/**
 * Shrinks a bottom-anchored cluster until every button sits inside the bottom
 * `thumbZoneFraction` of a PORTRAIT screen (ROADMAP S3 "entire match played
 * with one thumb"). Returns the factor applied to the arc radius / gap /
 * offsets — 1 when the configured layout already fits.
 *
 * Landscape is exempt: the short axis makes a 40 % band meaningless there, and
 * the theme's `landscape` block is the knob for that case.
 */
export function thumbZoneFactor(count: number, layout: HudLayout): number {
  if (layout.orientation !== "portrait") return 1;
  if (!layout.cluster.anchor.startsWith("bottom")) return 1;
  const allowed = layout.viewport.height * layout.thumbZoneFraction - layout.safeAreaInsetPx;
  if (allowed <= 0) return 1;
  const reach = clusterReachPx(rawClusterOffsets(count, layout.cluster), layout.cluster.buttonRadiusPx);
  if (reach <= allowed) return 1;
  // The button radius itself is a floor — nothing can shrink past a single button.
  const shrinkable = reach - layout.cluster.buttonRadiusPx;
  if (shrinkable <= 0) return 1;
  return Math.max(0, (allowed - layout.cluster.buttonRadiusPx) / shrinkable);
}

/**
 * Final button centres: {@link rawClusterOffsets} with the one-thumb clamp
 * applied. This is what {@link import("./ModuleButtons.js").ModuleButtons}
 * writes into the DOM.
 */
export function clusterOffsets(count: number, layout: HudLayout): ButtonOffset[] {
  const factor = thumbZoneFactor(count, layout);
  if (factor >= 1) return rawClusterOffsets(count, layout.cluster);
  return rawClusterOffsets(count, {
    ...layout.cluster,
    arcRadiusPx: layout.cluster.arcRadiusPx * factor,
    gapPx: layout.cluster.gapPx * factor,
    offsetXPx: layout.cluster.offsetXPx * factor,
    offsetYPx: layout.cluster.offsetYPx * factor,
  });
}

/**
 * Top edge (px from the top of the viewport) of the highest button in a
 * bottom-anchored cluster — the number the one-thumb audit checks.
 */
export function clusterTopPx(count: number, layout: HudLayout): number {
  const offsets = clusterOffsets(count, layout);
  const reach = clusterReachPx(offsets, layout.cluster.buttonRadiusPx);
  const pivotY = layout.cluster.anchor.startsWith("bottom")
    ? layout.viewport.height - layout.safeAreaInsetPx
    : layout.safeAreaInsetPx;
  return layout.cluster.anchor.startsWith("bottom") ? pivotY - reach : pivotY;
}

/** CSS custom properties the HUD root carries for the current layout. */
export function hudCssVars(layout: HudLayout): Record<string, string> {
  return {
    "--hud-scale": String(layout.scale),
    "--hud-safe-inset": `${layout.safeAreaInsetPx}px`,
    "--hud-minimap-size": `${layout.minimapSizePx}px`,
    "--hud-radar-size": `${layout.radar.sizePx}px`,
    "--hud-module-btn-radius": `${layout.cluster.buttonRadiusPx}px`,
    "--hud-module-gap": `${layout.cluster.gapPx}px`,
    "--hud-chamfer": `${layout.style.chamferPx}px`,
    "--hud-glow": String(layout.style.glow),
    // Emitted as a ready-made percentage as well as a number: `color-mix()`
    // wants a <percentage> and not every engine accepts a calc() there, so the
    // panel-fill mix reads the pre-formatted one.
    "--hud-panel-opacity": String(layout.style.panelOpacity),
    "--hud-panel-pct": `${Math.round(layout.style.panelOpacity * 1000) / 10}%`,
    "--hud-tick-opacity": String(layout.style.tickOpacity),
    "--hud-blur": `${layout.style.blurPx}px`,
  };
}
