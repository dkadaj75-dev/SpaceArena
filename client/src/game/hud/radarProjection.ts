export interface RadarLocalPoint {
  right: number;
  up: number;
  forward: number;
}

export interface RadarProjectedPoint {
  x: number;
  baseY: number;
  tipY: number;
  outOfRange: boolean;
}

export interface RadarProjectionGeometry {
  centreX: number;
  centreY: number;
  radiusX: number;
  radiusY: number;
  rangeUnits: number;
  elevationRad: number;
  altitudeScale: number;
  altitudeStemMaxPx: number;
}

/**
 * World delta -> player ship frame, using raw full-loop attitude. Canonicalising
 * pitch here would flip an inverted pilot's radar for half of every loop.
 */
export function radarLocalPoint(
  dx: number,
  dy: number,
  dz: number,
  heading: number,
  pitch: number,
  out: RadarLocalPoint,
): RadarLocalPoint {
  const sinH = Math.sin(heading);
  const cosH = Math.cos(heading);
  const sinP = Math.sin(pitch);
  const cosP = Math.cos(pitch);

  // R=(sin h,0,-cos h), U=(-cos h sin p,cos p,-sin h sin p),
  // N=(cos p cos h,sin p,cos p sin h).
  out.right = dx * sinH - dz * cosH;
  out.up = dx * (-cosH * sinP) + dy * cosP + dz * (-sinH * sinP);
  out.forward = dx * (cosP * cosH) + dy * sinP + dz * (cosP * sinH);
  return out;
}

/** Ship-frame point -> tilted radar ellipse with a clamped vertical stem. */
export function projectRadarPoint(
  local: RadarLocalPoint,
  geometry: RadarProjectionGeometry,
  out: RadarProjectedPoint,
): RadarProjectedPoint {
  const range = Math.max(1e-6, geometry.rangeUnits);
  const planeDistance = Math.hypot(local.right, local.forward);
  const clamp = planeDistance > range && planeDistance > 0 ? range / planeDistance : 1;
  const right = local.right * clamp;
  const forward = local.forward * clamp;
  const up = local.up * clamp;

  out.x = geometry.centreX + (right / range) * geometry.radiusX;
  out.baseY = geometry.centreY - (forward / range) * geometry.radiusY;
  const rawStem =
    -(up / range) * geometry.radiusX * Math.cos(geometry.elevationRad) * geometry.altitudeScale;
  const stem = Math.max(-geometry.altitudeStemMaxPx, Math.min(geometry.altitudeStemMaxPx, rawStem));
  out.tipY = out.baseY + stem;
  out.outOfRange = planeDistance > range;
  return out;
}
