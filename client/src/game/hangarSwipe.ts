/**
 * Swipe-to-change-ship gesture (owner 2026-07-31).
 *
 * The hangar stage shares its pointer with the orbit camera, so the recogniser
 * has to be strict: only a fast, decisively HORIZONTAL drag counts as a ship
 * change. Anything slower, shorter, or with real vertical travel in it is a
 * camera gesture and is left alone — a pilot turning the ship around must never
 * find themselves looking at a different one.
 *
 * Kept pure and separate from the Hangar so the thresholds are testable without
 * a DOM or a Babylon scene.
 */

export interface SwipePoint {
  x: number;
  y: number;
  /** Milliseconds, from any monotonic clock — only differences are used. */
  t: number;
}

export interface SwipeThresholds {
  /** Minimum horizontal travel, in CSS pixels. */
  minDistancePx: number;
  /** |dx| must exceed |dy| by at least this factor. */
  offAxisRatio: number;
  /** A drag slower than this is deliberate camera work, not a flick. */
  maxDurationMs: number;
}

export const SWIPE_THRESHOLDS: SwipeThresholds = {
  minDistancePx: 64,
  offAxisRatio: 1.8,
  maxDurationMs: 700,
};

/**
 * `+1` for "show the next ship", `-1` for the previous, `0` when the gesture
 * was not a swipe.
 *
 * Direction follows the carousel convention: dragging LEFT pulls the next ship
 * in, the way the content itself would move.
 */
export function classifySwipe(
  start: SwipePoint,
  end: SwipePoint,
  thresholds: SwipeThresholds = SWIPE_THRESHOLDS,
): -1 | 0 | 1 {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const dt = end.t - start.t;
  if (dt < 0 || dt > thresholds.maxDurationMs) return 0;
  if (Math.abs(dx) < thresholds.minDistancePx) return 0;
  if (Math.abs(dx) < Math.abs(dy) * thresholds.offAxisRatio) return 0;
  return dx < 0 ? 1 : -1;
}

/** Step `index` by `delta` around a list of `count`, wrapping both ways. */
export function wrapIndex(index: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  return (((index + delta) % count) + count) % count;
}

export interface SwipeWatcherOptions {
  /** Called with -1/+1 when a gesture qualifies. */
  onSwipe: (direction: -1 | 1) => void;
  thresholds?: SwipeThresholds;
  /** Injectable clock so tests need no timers. */
  now?: () => number;
  /**
   * Gate on where the gesture STARTED. The hangar uses it to ignore drags that
   * begin in the info panel — a flick while scrolling the module list is not a
   * request for a different ship.
   */
  shouldTrack?: (ev: PointerEvent) => boolean;
}

/**
 * Watches an element for swipes. Listens in the CAPTURE phase and never calls
 * `preventDefault`, so the orbit camera underneath still receives every event —
 * this observes the gesture, it does not consume it.
 */
export class SwipeWatcher {
  private start: SwipePoint | null = null;
  private readonly now: () => number;
  private readonly thresholds: SwipeThresholds;
  private readonly onDown: (ev: PointerEvent) => void;
  private readonly onUp: (ev: PointerEvent) => void;
  private readonly onCancel: () => void;

  constructor(
    private readonly target: HTMLElement,
    private readonly opts: SwipeWatcherOptions,
  ) {
    this.now = opts.now ?? (() => performance.now());
    this.thresholds = opts.thresholds ?? SWIPE_THRESHOLDS;
    this.onDown = (ev) => {
      // Multi-touch is pinch-zoom; a swipe is one finger.
      const track = ev.isPrimary && (opts.shouldTrack?.(ev) ?? true);
      this.start = track ? { x: ev.clientX, y: ev.clientY, t: this.now() } : null;
    };
    this.onUp = (ev) => {
      const start = this.start;
      this.start = null;
      if (!start || !ev.isPrimary) return;
      const dir = classifySwipe(start, { x: ev.clientX, y: ev.clientY, t: this.now() }, this.thresholds);
      if (dir !== 0) this.opts.onSwipe(dir);
    };
    // A cancelled pointer (the browser took the gesture, a second finger
    // arrived) is not a completed swipe: drop it rather than measuring it.
    this.onCancel = () => {
      this.start = null;
    };
    target.addEventListener("pointerdown", this.onDown, true);
    target.addEventListener("pointerup", this.onUp, true);
    target.addEventListener("pointercancel", this.onCancel, true);
  }

  dispose(): void {
    this.target.removeEventListener("pointerdown", this.onDown, true);
    this.target.removeEventListener("pointerup", this.onUp, true);
    this.target.removeEventListener("pointercancel", this.onCancel, true);
  }
}
