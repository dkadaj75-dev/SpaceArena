/** Clamp without allocating a vector/result object in the render loop. */
function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return value <= 0 ? 0 : value >= 1 ? 1 : value;
}

/** Keep the shader's periodic domain small enough for reliable float32 cell math. */
export const BOUNDARY_HEX_DENSITY_MIN = 1;
export const BOUNDARY_HEX_DENSITY_MAX = 128;

export interface BoundaryShieldRenderParams {
  hexDensity: number;
  opacity: number;
}

/**
 * Last CPU-side guard before authored/live values reach either boundary
 * material. The fragment shader repeats these clamps because uniforms and
 * drivers are independent trust boundaries; the plain fallback uses this
 * result directly.
 */
export function boundaryShieldRenderParams(
  hexDensity: number,
  proximityOpacity: number,
): BoundaryShieldRenderParams {
  const finiteDensity = Number.isFinite(hexDensity) ? hexDensity : BOUNDARY_HEX_DENSITY_MIN;
  return {
    hexDensity: Math.min(BOUNDARY_HEX_DENSITY_MAX, Math.max(BOUNDARY_HEX_DENSITY_MIN, finiteDensity)),
    opacity: clamp01(proximityOpacity),
  };
}

/**
 * Normalized shield response: 0 at/farther than the glow threshold, 1 at the
 * boundary (and outside it). `distanceToBoundary` is positive on the safe side.
 */
export function boundaryProximityFactor(distanceToBoundary: number, glowStartDistance: number): number {
  return clamp01((glowStartDistance - distanceToBoundary) / glowStartDistance);
}

/**
 * Ceiling on the shell's alpha, whatever the arena authors (2026-08-23).
 *
 * The shell is a SPHERE the pilot flies inside, so at contact it is not a wall
 * ahead — it is the whole field of view. Ring Nebula authors `baseOpacity: 1`,
 * and at zero distance that painted the entire viewport flat pink: no wall
 * geometry visible, the HUD unreadable through it, hull draining with nothing
 * on screen to explain why (playtest finding 6). Capped here rather than in
 * content because it is a legibility floor for the HUD, not a look: an arena may
 * still choose to be fainter, never to be opaque. The hex pattern and the
 * blue→red shift carry the warning; the flood only hid it.
 */
export const BOUNDARY_SHIELD_MAX_OPACITY = 0.42;

/**
 * The same ceiling for the LOW tier, which has no hex shader.
 *
 * On the shader tier this alpha is multiplied by the wireframe mask, so it
 * lands on thin lines and the view between them stays clear. The fallback is a
 * plain emissive surface with no mask at all — every pixel gets the full alpha —
 * so it needs a tighter cap to read as the same warning rather than as a filter
 * over the whole screen. LOW is what AUTO picks on a mid phone, which is why the
 * flood is what most players actually saw.
 */
export const BOUNDARY_SHIELD_FLAT_MAX_OPACITY = 0.2;

/** The alpha the plain (no-shader) boundary surface may reach. */
export function boundaryShellFlatAlpha(shellOpacity: number): number {
  return Math.min(BOUNDARY_SHIELD_FLAT_MAX_OPACITY, clamp01(shellOpacity));
}

/**
 * The shell must disappear completely outside its authored proximity range.
 * `baseOpacity` controls its contact intensity, never a far-field floor — and
 * never more than {@link BOUNDARY_SHIELD_MAX_OPACITY}, so the HUD stays
 * readable right up against the wall.
 */
export function boundaryShieldOpacity(
  distanceToBoundary: number,
  glowStartDistance: number,
  baseOpacity: number,
): number {
  const proximity = boundaryProximityFactor(distanceToBoundary, glowStartDistance);
  return Math.min(BOUNDARY_SHIELD_MAX_OPACITY, baseOpacity * proximity);
}

/** Blue-to-red blend, beginning only inside the authored red threshold. */
export function boundaryShieldRedMix(distanceToBoundary: number, redTransitionDistance: number): number {
  return clamp01((redTransitionDistance - distanceToBoundary) / redTransitionDistance);
}

/**
 * Entry-edge warning latch. It fires once on entering the zone and rearms only
 * after leaving it; changing arenas/config resets the latch explicitly.
 */
export class BoundaryWarningLatch {
  private inside = false;

  update(distanceToBoundary: number, warnDistance: number): boolean {
    const nextInside = distanceToBoundary <= warnDistance;
    const fire = nextInside && !this.inside;
    this.inside = nextInside;
    return fire;
  }

  reset(): void {
    this.inside = false;
  }
}
