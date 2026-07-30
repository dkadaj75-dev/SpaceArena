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
 * World delta -> player ship frame, in the REPLICATED authoritative frame
 * (flight-frame handoff): the nose from raw full-loop heading/pitch plus the
 * persisted up axis. Canonicalising pitch here would flip an inverted pilot's
 * radar for half of every loop, and reconstructing the up from heading/pitch
 * would spin the whole display near vertical — the display right is `U × N`,
 * which for a roll-less frame is the historical `(sin h, 0, −cos h)`.
 */
export function radarLocalPoint(
  dx: number,
  dy: number,
  dz: number,
  heading: number,
  pitch: number,
  up: { x: number; y: number; z: number },
  out: RadarLocalPoint,
): RadarLocalPoint {
  const cosP = Math.cos(pitch);
  const nx = cosP * Math.cos(heading);
  const ny = Math.sin(pitch);
  const nz = cosP * Math.sin(heading);
  // Display right R = U × N.
  const rx = up.y * nz - up.z * ny;
  const ry = up.z * nx - up.x * nz;
  const rz = up.x * ny - up.y * nx;

  out.right = dx * rx + dy * ry + dz * rz;
  out.up = dx * up.x + dy * up.y + dz * up.z;
  out.forward = dx * nx + dy * ny + dz * nz;
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
