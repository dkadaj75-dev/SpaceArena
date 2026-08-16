/** Pure snapshot timing/correction helpers (kept socket-free for tests). */
export function lerpHeading(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

export function bracket<T extends { time: number }>(items: readonly T[], renderTime: number): [T, T, number] | null {
  if (!items.length) return null;
  if (items.length === 1 || renderTime <= items[0]!.time) return [items[0]!, items[0]!, 0];
  for (let i = 1; i < items.length; i++) {
    const b = items[i]!;
    const a = items[i - 1]!;
    if (renderTime <= b.time) return [a, b, Math.max(0, Math.min(1, (renderTime - a.time) / (b.time - a.time)))];
  }
  const last = items[items.length - 1]!;
  const prev = items[items.length - 2]!;
  return [prev, last, Math.min(1, Math.max(0, (renderTime - last.time) / (last.time - prev.time)))];
}

export function decayCorrection(offset: number, dtSeconds: number, rate: number, snapDistance = 3): number {
  return Math.abs(offset) > snapDistance ? 0 : offset * Math.exp(-rate * dtSeconds);
}

/**
 * Convert a legacy per-frame pull authored at `referenceHz` into a dt-stable
 * exponential fraction. At 60 Hz, 0.15 remains exactly 0.15.
 */
export function timeBasedPull(referencePull: number, dtSeconds: number, referenceHz = 60): number {
  return 1 - Math.pow(1 - referencePull, dtSeconds * referenceHz);
}

/**
 * How far behind `now` remote entities are rendered, adapted to the patch
 * cadence the network is actually delivering.
 *
 * A FIXED delay is only correct on the network it was tuned for. Measured on
 * localhost — the best case there is — patches nominally 50 ms apart arrive at
 * a median of ~62 ms with bursts past 95 ms, so a fixed 100 ms delay left the
 * render time ahead of the newest snapshot on ~16% of frames. A dry bracket
 * clamps to the newest snapshot, so the remote ship FREEZES there and then
 * lurches when the next patch lands — precisely the "ships jump between server
 * updates" the interpolation buffer exists to hide. On phone Wi-Fi, whose
 * power-save batches receives into 100-300 ms bursts, it is the normal state.
 *
 * The target keeps `headroomPatches` of the p90 arrival gap between the render
 * point and the newest snapshot. Asymmetric on purpose:
 *
 *  - WIDENING is instant. By the time the gaps say the delay is too tight the
 *    bracket is already starving, and easing toward safety would just ration
 *    out the stutter over the next several seconds.
 *  - NARROWING is slow (`NARROW_MS_PER_SECOND`). The render point sits inside
 *    the interpolation timeline, so lowering the delay plays the timeline
 *    faster than real time until it catches up — done abruptly that is itself
 *    a visible speed-up. 15 ms/s recovers a Wi-Fi burst in a couple of
 *    seconds without a watchable warp.
 *
 * `floorMs` is the authored `netRenderDelayMs`, kept as the minimum so a calm
 * network behaves exactly as it always has; `ceilMs` caps what jitter can buy
 * because past ~350 ms of display latency a stale-but-smooth enemy is lying
 * about where it is.
 */
export const RENDER_DELAY_CEIL_MS = 350;
const NARROW_MS_PER_SECOND = 15;
const HEADROOM_PATCHES = 2;

export function adaptiveRenderDelay(
  currentMs: number,
  arrivalGapsMs: readonly number[],
  floorMs: number,
  dtSeconds: number,
  ceilMs = RENDER_DELAY_CEIL_MS,
): number {
  let target = floorMs;
  if (arrivalGapsMs.length >= 4) {
    const sorted = [...arrivalGapsMs].sort((a, b) => a - b);
    const p90 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))]!;
    target = Math.min(ceilMs, Math.max(floorMs, p90 * HEADROOM_PATCHES));
  }
  if (target >= currentMs) return target;
  return Math.max(target, currentMs - NARROW_MS_PER_SECOND * Math.max(0, dtSeconds));
}
