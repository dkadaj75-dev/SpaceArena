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
