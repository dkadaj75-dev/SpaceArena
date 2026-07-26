import { z } from "zod";
import { baseShape } from "./base.js";

/**
 * Render quality tiers, cheapest first. The array order **is** the ranking used
 * by tier selection and by the auto-tier promote/demote step — there is no
 * separate `rank` field to keep in sync.
 */
export const QUALITY_TIERS = ["low", "med", "high"] as const;
export type QualityTier = (typeof QUALITY_TIERS)[number];

/** Rank of a tier (0 = cheapest). Used for ordering/comparison. */
export function qualityTierRank(tier: QualityTier): number {
  return QUALITY_TIERS.indexOf(tier);
}

/**
 * ROADMAP §10 5.6 — one render-quality tier, entirely data-driven. Every field
 * here is consumed by a specific renderer site; nothing is decorative:
 *
 * - `probe`     → initial tier pick from the device capabilities probe
 * - `autoTier`  → first-seconds FPS measurement that may demote/promote once
 * - `render`    → `Engine.setHardwareScalingLevel` + DPR cap + static freezing
 * - `glow`      → the arena `GlowLayer` (measured at ~half of all draw calls)
 * - `particles` → `ShipSocketRig` emitter capacity/rate budget
 * - `asteroids` → asteroid master `addLODLevel` distances + instancing mode
 * - `projectiles` → projectile pool instancing mode
 * - `scene`     → optional static decoration (starfield density, spawn markers)
 */
export const qualitySchema = z.object({
  ...baseShape("quality"),
  /** Which tier this config *is*. Exactly one config per tier is expected. */
  tier: z.enum(QUALITY_TIERS),

  /**
   * Minimum device capabilities for this tier to be picked automatically.
   * Selection walks tiers best-first and takes the first whose probe passes,
   * falling back to the cheapest tier when none does.
   */
  probe: z.object({
    /** Minimum `navigator.hardwareConcurrency` (0 = no requirement). */
    minCores: z.number().int().nonnegative(),
    /** Minimum `navigator.deviceMemory` in GB (0 = no requirement). */
    minMemoryGb: z.number().nonnegative(),
    /** May this tier be auto-selected on a device the UA reports as mobile? */
    allowMobile: z.boolean(),
  }),

  /**
   * First-seconds FPS check (once per match, with hysteresis). Measured over
   * `sampleWindowMs` starting `sampleAfterMs` into the match; below
   * `demoteBelowFps` steps down one tier, above `promoteAboveFps` steps up one.
   * The gap between the two thresholds *is* the hysteresis band.
   */
  autoTier: z.object({
    /** Warm-up before sampling starts (shader compilation, first spawns). */
    sampleAfterMs: z.number().nonnegative(),
    /** Length of the FPS averaging window. */
    sampleWindowMs: z.number().positive(),
    /** Average FPS below this demotes one tier. Use 0 to never demote. */
    demoteBelowFps: z.number().nonnegative(),
    /** Average FPS above this promotes one tier. Use 0 to never promote. */
    promoteAboveFps: z.number().nonnegative(),
  }),

  render: z.object({
    /**
     * Babylon hardware scaling **multiplier** applied on top of the capped
     * device pixel ratio. 1 = native (capped) resolution, 1.33 = render at 75%
     * of it. Larger = fewer pixels = faster.
     */
    hardwareScalingMultiplier: z.number().min(0.5).max(4),
    /** Device-pixel-ratio ceiling before the multiplier is applied. */
    maxDevicePixelRatio: z.number().min(0.5).max(4),
    /**
     * Freeze world matrices + materials on the static arena meshes. Correctly
     * unfrozen on rebuild and while the dev editor hides the arena.
     */
    freezeStatics: z.boolean(),
  }),

  glow: z.object({
    /** The arena `GlowLayer`. Off is the single biggest measured draw-call win. */
    enabled: z.boolean(),
    intensity: z.number().nonnegative(),
    /** Optional blur kernel override; Babylon's default is used when omitted. */
    blurKernelSize: z.number().positive().optional(),
  }),

  particles: z.object({
    /** Build emitter particle systems at all. */
    enabled: z.boolean(),
    /** Scales every emitter's capacity *and* emit rate (0..1). */
    budgetMultiplier: z.number().min(0).max(1),
    /** Hard ceiling on one emitter's Babylon capacity, before the multiplier. */
    maxEmitterCapacity: z.number().int().nonnegative(),
  }),

  asteroids: z.object({
    /**
     * `addLODLevel` distances on the asteroid masters, in world units, measured
     * from the CAMERA. The in-match rig is the chase camera (FLIGHT.md §3): orbit
     * radius ~12-20 at a low tilt, which is a much longer sightline than the old
     * 30-90 top-down orbit — a rock 200 units down the lane is on screen and near
     * the horizon, where a swap to the low-poly LOD is invisible but a cull is
     * not. Retune these together with `camera.chase`. `0` disables that level.
     */
    lodMediumDistance: z.number().nonnegative(),
    lodLowDistance: z.number().nonnegative(),
    /** Distance past which asteroids stop drawing entirely (0 = never cull). */
    lodCullDistance: z.number().nonnegative(),
    /**
     * Ignore `render.model` on asteroid configs and draw the procedural recipe
     * instead. The escape hatch for the cheapest tier: the authored rocks are
     * 3.2k-7.7k tris each and a dense belt puts ~360k of them in frustum, which
     * is comfortable on a mid GPU and not on a budget phone. Optional so an
     * already-published pack stays valid; omitted = use the models.
     */
    proceduralOnly: z.boolean().optional(),
    /**
     * Render asteroids as thin instances instead of hardware `InstancedMesh`.
     * Measured on the practice arena: 10 asteroids across 2 masters already
     * batch to 2 draw calls as InstancedMesh, so this buys ~0 there — kept as
     * data so denser arenas can turn it on without a code change.
     */
    thinInstances: z.boolean(),
  }),

  projectiles: z.object({
    /**
     * Draw pooled projectiles as `InstancedMesh` (one draw call per kind)
     * instead of individual cloned meshes. Measured: each cloned mesh costs 2
     * draw calls (base + glow), so 48 in flight cost +96.
     */
    useInstances: z.boolean(),
  }),

  scene: z.object({
    /** Starfield point count in the skybox `PointsCloudSystem`. */
    starfieldPoints: z.number().int().nonnegative(),
    /**
     * Draw the latitude/longitude wire rings on the arena's bounds shell.
     *
     * Renamed from `groundGrid` in BUBBLE.md §C: the arena floor is gone —
     * ships fly through the whole bubble, so a disc at y=0 was a lie about the
     * play space. The spatial reference it used to provide moved onto the
     * bounds SHELL, and this switch moved with it. The cost profile is the
     * same (a pile of thin extra line geometry), which is why the cheapest
     * tier still turns it off.
     */
    boundsGrid: z.boolean(),
    /** Draw the colored team spawn-point gizmos. */
    spawnMarkers: z.boolean(),
  }),
});

export type QualityConfig = z.infer<typeof qualitySchema>;
