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

/** Far-field base opacity ramping to fully visible on contact. */
export function boundaryShieldOpacity(
  distanceToBoundary: number,
  glowStartDistance: number,
  baseOpacity: number,
): number {
  const proximity = boundaryProximityFactor(distanceToBoundary, glowStartDistance);
  return baseOpacity + (1 - baseOpacity) * proximity;
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
