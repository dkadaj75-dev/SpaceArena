/**
 * BUBBLE.md §C — the minimap's third axis, as pure math.
 *
 * The map itself stays a top-down (x, z) projection: it is the one HUD element
 * whose whole value is that it reads instantly, and a 3D minimap reads as
 * nothing at all. What the bubble adds is a short vertical TICK next to each
 * blip carrying that contact's altitude RELATIVE to the player — the only piece
 * of the third axis a pilot actually needs from a map ("the one closing on me is
 * above me").
 */

/**
 * Tick length used when the theme names none. Lives here rather than in
 * `HUD_DEFAULTS` because the minimap resolves its own handful of theme fields
 * (see `Minimap.applySize`) instead of taking the resolved `HudLayout`.
 */
export const DEFAULT_ALTITUDE_TICK_PX = 6;

/**
 * Signed tick length in px for a contact `deltaY` world units above (positive)
 * or below (negative) the player.
 *
 * Scaled by the same `pxPerUnit` the map uses for x/z, so a contact 30 units up
 * draws exactly as far as one 30 units north — the tick is a real projection of
 * the same space, not a decoration on its own scale. Saturates at ±`maxPx` so a
 * contact at the top of the bubble cannot draw a tick across the whole map, and
 * reports 0 below half a pixel, where a line would be invisible anyway and would
 * only cost a canvas path per frame.
 *
 * The SIGN is screen-space: canvas y grows downward, so "above the player"
 * returns a NEGATIVE length and callers can add it to a blip's y directly.
 */
export function altitudeTickPx(deltaY: number, pxPerUnit: number, maxPx: number): number {
  if (!(maxPx > 0) || !(pxPerUnit > 0)) return 0;
  const px = -deltaY * pxPerUnit;
  if (Math.abs(px) < 0.5) return 0;
  return px > maxPx ? maxPx : px < -maxPx ? -maxPx : px;
}
