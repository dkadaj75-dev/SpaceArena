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
 * Per-orientation overrides layered on top of the base `hud` block. Only the
 * fields a phone actually needs to re-scale between portrait and landscape —
 * anything omitted falls through to the base block.
 */
export const hudOrientationSchema = z.object({
  scale: z.number().positive().optional(),
  safeAreaInsetPx: z.number().nonnegative().optional(),
  minimapSizePx: z.number().positive().optional(),
  gaugeWidthPx: z.number().positive().optional(),
  thumbZoneFraction: z.number().gt(0).max(1).optional(),
  moduleCluster: moduleClusterSchema.optional(),
});
export type HudOrientationConfig = z.infer<typeof hudOrientationSchema>;

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
      /** World-space half-extent shown on the minimap (units from center). */
      minimapRangeUnits: z.number().positive().optional(),
      /** Width of the hull/shield/energy/heat gauge bars. */
      gaugeWidthPx: z.number().positive().optional(),
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
    })
    .optional(),
});

export type ThemeConfig = z.infer<typeof themeSchema>;
