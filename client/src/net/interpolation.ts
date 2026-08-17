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

/** Mutable 3-vector, shape-compatible with snapshot `pos` objects. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** One position sample on the snapshot timeline (`time` in ms, `bracket`'s clock). */
export interface TimedPos {
  readonly time: number;
  readonly pos: { readonly x: number; readonly y: number; readonly z: number };
}

/**
 * C1 position interpolation across a snapshot segment — cubic Hermite with
 * finite-difference (Catmull-Rom style) tangents from the neighbouring samples.
 *
 * Plain lerp between ~20 Hz snapshots is C0: position is continuous but
 * VELOCITY steps at every sample boundary, and at 60 fps that reads as a faint
 * 20 Hz shudder on remote hulls — worst in turns, where the velocity direction
 * changes at every knot, and still there under a perfect playback timeline.
 * A cubic through the same samples whose end tangents are shared with the
 * neighbouring segments removes exactly that: both segments meeting at a knot
 * evaluate the SAME finite-difference tangent there, so the interpolated
 * velocity is continuous through it (C1), not just the position.
 *
 * Tangent choice: `m_k = (p_{k+1} − p_{k−1}) / (t_{k+1} − t_{k−1})` — the
 * non-uniform Catmull-Rom finite difference. It is the gap-weighted average of
 * the two adjacent chord velocities, so its magnitude can never exceed the
 * faster neighbouring chord: a well-behaved bound to build the overshoot
 * guards on. A missing neighbour (fewer than 3 samples around the segment, or
 * a ship that only just spawned) falls back to the segment's own chord slope,
 * which degrades that end to the old lerp exactly — never worse than before.
 *
 * Overshoot guards, because Catmull-Rom is not shape-preserving and a ship
 * that BOUNCES off a rock between two samples must not be drawn inside it:
 *  - a tangent pointing AGAINST the segment's chord (`m · d < 0`) means the
 *    neighbourhood reverses direction here — the cubic would loop outside the
 *    travelled span, so the segment degrades to plain lerp. This deliberately
 *    spends C1 at the knot: around a physical impact the velocity really is
 *    discontinuous, and smoothing through it would be lying about the bounce.
 *  - a tangent LONGER than the chord (a respawn teleport in the neighbour
 *    sample, or a hard brake) is clamped to the chord length, which caps the
 *    curve's deviation from the chord at (4/27)·(|M1|+|M2|) ≤ ~0.3·|chord|.
 *
 * Pure and allocation-free (writes into `out`): the render loop calls this per
 * remote ship per tick, and pure is what keeps the C1/overshoot claims provable
 * in unit tests rather than asserted in a comment.
 */
export function hermitePosition(
  prev: TimedPos | null,
  from: TimedPos,
  to: TimedPos,
  next: TimedPos | null,
  t: number,
  out: Vec3,
): Vec3 {
  const h = to.time - from.time;
  if (!(h > 0)) {
    // Coincident samples (single-snapshot bracket): nothing to interpolate.
    out.x = to.pos.x;
    out.y = to.pos.y;
    out.z = to.pos.z;
    return out;
  }
  const dx = to.pos.x - from.pos.x;
  const dy = to.pos.y - from.pos.y;
  const dz = to.pos.z - from.pos.z;
  // Tangents scaled onto the segment (M = m·h), defaulting to the chord itself,
  // which makes a neighbourless end EXACTLY linear rather than approximately so.
  let m1x = dx, m1y = dy, m1z = dz;
  let m2x = dx, m2y = dy, m2z = dz;
  if (prev && from.time - prev.time > 0) {
    const k = h / (to.time - prev.time);
    m1x = (to.pos.x - prev.pos.x) * k;
    m1y = (to.pos.y - prev.pos.y) * k;
    m1z = (to.pos.z - prev.pos.z) * k;
  }
  if (next && next.time - to.time > 0) {
    const k = h / (next.time - from.time);
    m2x = (next.pos.x - from.pos.x) * k;
    m2y = (next.pos.y - from.pos.y) * k;
    m2z = (next.pos.z - from.pos.z) * k;
  }
  if (m1x * dx + m1y * dy + m1z * dz < 0 || m2x * dx + m2y * dy + m2z * dz < 0) {
    // Direction reversal at a knot (bounce): see the doc comment.
    out.x = from.pos.x + dx * t;
    out.y = from.pos.y + dy * t;
    out.z = from.pos.z + dz * t;
    return out;
  }
  const chord = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const l1 = Math.sqrt(m1x * m1x + m1y * m1y + m1z * m1z);
  if (l1 > chord) {
    const k = chord / l1;
    m1x *= k;
    m1y *= k;
    m1z *= k;
  }
  const l2 = Math.sqrt(m2x * m2x + m2y * m2y + m2z * m2z);
  if (l2 > chord) {
    const k = chord / l2;
    m2x *= k;
    m2y *= k;
    m2z *= k;
  }
  const s2 = t * t;
  const s3 = s2 * t;
  const h00 = 2 * s3 - 3 * s2 + 1;
  const h10 = s3 - 2 * s2 + t;
  const h01 = 3 * s2 - 2 * s3;
  const h11 = s3 - s2;
  out.x = h00 * from.pos.x + h10 * m1x + h01 * to.pos.x + h11 * m2x;
  out.y = h00 * from.pos.y + h10 * m1y + h01 * to.pos.y + h11 * m2y;
  out.z = h00 * from.pos.z + h10 * m1z + h01 * to.pos.z + h11 * m2z;
  return out;
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
 * point and the newest snapshot. BOTH directions are rate-limited, because the
 * delay is not a free variable: `renderTime = now - delay`, so any step in the
 * delay is a step in the playback clock the remote ships live on.
 *
 *  - WIDENING at `WIDEN_MS_PER_SECOND` (fast). The first cut of this widened
 *    INSTANTLY, reasoning that a too-tight delay meant the bracket was already
 *    starving — and the owner immediately reported the ride SLIGHTLY WORSE.
 *    The reasoning missed the common case: the p90 of a live gap ring drifts up
 *    a few ms whenever a fresh burst sample lands, long before any bracket runs
 *    dry, and every instant up-step yanked `renderTime` BACKWARD by that many
 *    milliseconds — remote ships visibly rewound, once per burst sample, a
 *    rhythmic hitch in place of the old freeze-and-lurch. Rate-limited at
 *    120 ms/s, a widening plays the timeline at ~0.88x for a few hundred
 *    milliseconds instead — a sub-perceptual slow-motion, never a step back.
 *  - NARROWING at `NARROW_MS_PER_SECOND` (slow): playback at ~1.015x until the
 *    burst's slack is repaid. Recovery is deliberately much slower than onset —
 *    over-delay merely adds latency, under-delay stutters.
 *
 * `floorMs` is the authored `netRenderDelayMs`, kept as the minimum so a calm
 * network behaves exactly as it always has; `ceilMs` caps what jitter can buy
 * because past ~350 ms of display latency a stale-but-smooth enemy is lying
 * about where it is.
 */
export const RENDER_DELAY_CEIL_MS = 350;
export const WIDEN_MS_PER_SECOND = 120;
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
  const dt = Math.max(0, dtSeconds);
  if (target > currentMs) return Math.min(target, currentMs + WIDEN_MS_PER_SECOND * dt);
  return Math.max(target, currentMs - NARROW_MS_PER_SECOND * dt);
}
