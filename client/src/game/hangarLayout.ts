/**
 * Hangar split-screen geometry (owner 2026-07-31). The screen is halved: the
 * ship's 3D stage on one side, its info/module panel on the other — stacked in
 * PORTRAIT (stage on top) and side by side in LANDSCAPE (stage on the left).
 *
 * The stage is not a second canvas: the main Babylon camera is confined to the
 * stage half with a camera VIEWPORT, so the ship centres itself inside that
 * rectangle and the projection uses the rectangle's own aspect ratio. Keeping
 * that arithmetic here (rather than inline in {@link
 * import("./screens/Hangar.js").Hangar}) is what makes it testable without an
 * engine.
 */

/** Fraction of the screen the 3D stage occupies — "split in 2". */
export const STAGE_FRACTION = 0.5;

/** A Babylon viewport rectangle: normalised 0..1, origin at the BOTTOM-left. */
export interface ViewportRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The whole canvas — what the camera uses outside the Hangar. */
export const FULL_VIEWPORT: ViewportRect = { x: 0, y: 0, width: 1, height: 1 };

/**
 * Where the 3D stage sits for a viewport of `width` x `height`.
 *
 * Portrait keeps the stage in the TOP half, which in Babylon's bottom-left
 * origin means `y = 1 - fraction`; landscape keeps it in the LEFT half, which
 * starts at x = 0. Both mirror the CSS in `Hangar.ts` — the panel takes the
 * remainder, and the two must agree or the ship renders behind the panel.
 */
export function stageViewport(width: number, height: number, fraction = STAGE_FRACTION): ViewportRect {
  const f = clamp01(fraction);
  return isLandscape(width, height)
    ? { x: 0, y: 0, width: f, height: 1 }
    : { x: 0, y: 1 - f, width: 1, height: f };
}

/** Landscape when it is wider than it is tall — the CSS media query's rule. */
export function isLandscape(width: number, height: number): boolean {
  return width > height;
}

/** Pixel aspect ratio of the stage half, for the camera's projection fit. */
export function stageAspect(width: number, height: number, fraction = STAGE_FRACTION): number {
  const rect = stageViewport(width, height, fraction);
  const w = Math.max(1, width * rect.width);
  const h = Math.max(1, height * rect.height);
  return w / h;
}

/**
 * Orbit distance that frames a ship of bounding radius `boundingRadius` inside
 * the stage, for a camera of vertical field of view `fovRad`.
 *
 * A sphere of radius R fits vertically at `R / tan(fov/2)` and horizontally at
 * `R / (tan(fov/2) * aspect)`; the binding constraint is whichever is larger,
 * hence `min(1, aspect)`. `margin` leaves air around the hull (1.0 = the hull
 * exactly touches the shorter edge) — a portrait stage is the narrow case, so
 * this is what stops a wide hull from being cropped on a phone.
 */
export function framingRadius(boundingRadius: number, fovRad: number, aspect: number, margin = 1.35): number {
  const halfFov = Math.max(1e-3, fovRad / 2);
  const fit = Math.tan(halfFov) * Math.min(1, Math.max(1e-3, aspect));
  return (Math.max(1e-3, boundingRadius) / fit) * margin;
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : STAGE_FRACTION;
}
