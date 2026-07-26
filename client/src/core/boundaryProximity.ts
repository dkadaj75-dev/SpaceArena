/** Clamp without allocating a vector/result object in the render loop. */
function clamp01(value: number): number {
  return value <= 0 ? 0 : value >= 1 ? 1 : value;
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
