/**
 * Ship-swap transition for the hangar carousel (owner 2026-08-01).
 *
 * Clicking the RIGHT arrow sends the hull on screen out to the LEFT and brings
 * the next one in from the right — the content moves opposite to the arrow, the
 * way a carousel has always worked, so the arrow reads as "go that way through
 * the bay" rather than "shove the ship that way".
 *
 * Split into two halves around a hard cut: the outgoing hull slides away and
 * fades, the model is swapped at the midpoint, and the incoming hull slides in
 * from the far side. Nothing here touches Babylon — the Hangar feeds it a clock
 * and applies the offset — so the curve and the timing are testable on their own.
 */

/** How long a full swap takes, in seconds. Short: this is a transition, not a show. */
export const SWAP_DURATION_SEC = 0.42;

/** How far the hull travels along the camera's right axis, in hull radii. */
export const SWAP_DISTANCE_RADII = 2.6;

export interface SwapFrame {
  /**
   * Offset along the camera's right axis, in world units. Positive is
   * screen-right.
   */
  offset: number;
  /** 0..1 opacity for the sliding hull, so it leaves rather than snaps. */
  visibility: number;
  /**
   * True once the animation has passed its midpoint — the moment the Hangar
   * swaps in the NEW hull. The caller latches on the rising edge.
   */
  swapped: boolean;
  /** True when the transition is over and the caller should drop its state. */
  done: boolean;
}

/** Ease-in on the way out, ease-out on the way in: fast in the middle, calm at the ends. */
function easeOutCubic(t: number): number {
  const u = 1 - t;
  return 1 - u * u * u;
}

function easeInCubic(t: number): number {
  return t * t * t;
}

/**
 * The hull's offset and opacity `elapsed` seconds into a swap.
 *
 * `direction` is the arrow's own sense: `+1` for "next" (the right arrow), `-1`
 * for "previous". The hull moves the other way, which is the whole point.
 */
export function swapFrame(
  elapsed: number,
  direction: -1 | 1,
  distance: number,
  duration = SWAP_DURATION_SEC,
): SwapFrame {
  if (!(duration > 0)) return { offset: 0, visibility: 1, swapped: true, done: true };
  const t = Math.max(0, Math.min(1, elapsed / duration));
  const half = t < 0.5;
  // First half: the OUTGOING hull accelerates away opposite the arrow.
  // Second half: the INCOMING hull decelerates in from the far side.
  const phase = half ? t * 2 : (t - 0.5) * 2;
  const travel = half ? easeInCubic(phase) : 1 - easeOutCubic(phase);
  const side = half ? -direction : direction;
  return {
    offset: side * travel * distance,
    // Fade only near the ends, so the hull is solid while it is actually moving.
    visibility: Math.max(0, Math.min(1, 1 - travel * 0.85)),
    swapped: !half,
    done: t >= 1,
  };
}
