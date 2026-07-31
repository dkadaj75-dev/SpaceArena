/**
 * Flag-wake geometry (owner 2026-07-31).
 *
 * The sim hands out a variable number of breadcrumbs; Babylon's updatable line
 * meshes need a FIXED vertex count (an updated line must have exactly as many
 * points as the one it replaces, or the vertex buffer has to be rebuilt every
 * frame). So the wake is resampled onto a constant ladder of points before it
 * ever reaches the renderer, and the fade is applied per vertex.
 *
 * Pure and separate from the scene so both halves are testable without Babylon.
 */

/** Points in every rendered wake, whatever the sim's breadcrumb count. */
export const TRAIL_POINTS = 24;

export interface TrailPoint {
  x: number;
  y: number;
  z: number;
}

const dist = (a: TrailPoint, b: TrailPoint): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/**
 * Resample `trail` (oldest first) onto exactly `count` points spaced evenly ALONG
 * ITS PATH, writing into `out`. Even spacing along arc length rather than by
 * index is what keeps the fade honest: breadcrumbs are laid down at a minimum
 * step, so a flag that slowed down would otherwise crowd the ribbon's bright end
 * with points it barely travelled.
 *
 * An empty trail produces nothing (returns false and leaves `out` untouched);
 * a single point produces `count` copies of itself, which renders as nothing
 * visible and needs no special case downstream.
 */
export function resampleTrail(
  trail: readonly TrailPoint[],
  out: TrailPoint[],
  count = TRAIL_POINTS,
): boolean {
  if (trail.length === 0 || count <= 0) return false;
  while (out.length < count) out.push({ x: 0, y: 0, z: 0 });
  out.length = count;

  if (trail.length === 1) {
    for (const p of out) {
      p.x = trail[0]!.x;
      p.y = trail[0]!.y;
      p.z = trail[0]!.z;
    }
    return true;
  }

  // Cumulative arc length, so the walk below is a single pass.
  let total = 0;
  const cumulative: number[] = [0];
  for (let i = 1; i < trail.length; i++) {
    total += dist(trail[i - 1]!, trail[i]!);
    cumulative.push(total);
  }
  // A zero-length path (every breadcrumb identical) has no direction to sample.
  if (total <= 0) {
    for (const p of out) {
      p.x = trail[0]!.x;
      p.y = trail[0]!.y;
      p.z = trail[0]!.z;
    }
    return true;
  }

  let segment = 1;
  for (let i = 0; i < count; i++) {
    const target = (total * i) / (count - 1 || 1);
    while (segment < cumulative.length - 1 && cumulative[segment]! < target) segment++;
    const from = trail[segment - 1]!;
    const to = trail[segment]!;
    const span = cumulative[segment]! - cumulative[segment - 1]!;
    const t = span > 0 ? (target - cumulative[segment - 1]!) / span : 0;
    const p = out[i]!;
    p.x = from.x + (to.x - from.x) * t;
    p.y = from.y + (to.y - from.y) * t;
    p.z = from.z + (to.z - from.z) * t;
  }
  return true;
}

/**
 * Per-vertex alpha down the ribbon: 0 at the oldest end, `head` at the newest.
 * The gradient IS the direction indicator — a solid line would say where a flag
 * has been but not which way it is going.
 */
export function trailAlphas(count = TRAIL_POINTS, head = 0.85): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push((i / Math.max(1, count - 1)) * head);
  return out;
}
