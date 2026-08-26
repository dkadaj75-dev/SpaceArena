/** Pure snapshot timing/correction helpers (kept socket-free for tests). */
import {
  facingVec,
  interpolateFrame,
  orthonormalizeUp,
  spellAttitude,
  type FrameAttitude,
} from "@space-arena/shared";

export function lerpHeading(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

/**
 * Phase of `renderTime` inside the segment `[a, b]`, clamped to 0..1.
 *
 * A ZERO-LENGTH segment answers 1 (the newer sample) rather than dividing. The
 * playback timeline is no longer the strictly-increasing local receive clock
 * (see {@link stampSnapshot}), so two samples CAN share an instant — a server
 * that missed a sim tick republishes the same `matchTimer` — and a naive divide
 * there produces NaN, which propagates straight into every mesh position.
 */
function phase(aTime: number, bTime: number, renderTime: number): number {
  const span = bTime - aTime;
  if (!(span > 0)) return 1;
  return Math.max(0, Math.min(1, (renderTime - aTime) / span));
}

/**
 * Ceiling on bounded dead reckoning past the newest sample.
 *
 * 100 ms is a burst-length budget, not a patch-count one — it was one patch gap
 * plus jitter at the old 15 Hz cadence and is ~6 gaps at the 60 Hz one, but the
 * quantity it bounds is how long a Wi-Fi power-save burst or a dropped packet
 * plausibly lasts, which is a property of networks, not of the room's cadence.
 * Within it the ship is overwhelmingly likely to still be doing what it was
 * doing, and straight-line extrapolation is a better guess than a freeze. Past
 * it the guess stops being cheap — a ship at cruise covers ~10 units per
 * 100 ms, and a hull drawn a second of travel from where it actually is
 * misleads the pilot aiming at it far more than a stalled one does. So the
 * lead SATURATES here rather than growing: a long outage degrades to the old
 * freeze behaviour, just 100 ms further along.
 */
export const MAX_EXTRAPOLATION_MS = 100;

/**
 * The two samples `renderTime` falls between, the phase within them, and the
 * bounded EXTRAPOLATION LEAD in milliseconds.
 *
 * `leadMs` is 0 on every healthy frame — `[a, b, t]` destructuring stays exactly
 * correct and is what most callers want. It is non-zero only on a dry bracket,
 * where it reports how far past the newest sample the render point has reached,
 * saturated at {@link MAX_EXTRAPOLATION_MS}. See {@link ExtrapolationBlender}
 * for what may safely be done with it.
 */
export type Bracket<T> = [T, T, number, number];

export function bracket<T extends { time: number }>(items: readonly T[], renderTime: number): Bracket<T> | null {
  if (!items.length) return null;
  if (items.length === 1 || renderTime <= items[0]!.time) return [items[0]!, items[0]!, 0, 0];
  for (let i = 1; i < items.length; i++) {
    const b = items[i]!;
    const a = items[i - 1]!;
    if (renderTime <= b.time) return [a, b, phase(a.time, b.time, renderTime), 0];
  }
  // DRY BRACKET: the render point has overrun the newest sample. The pair and
  // the phase still clamp to that sample (t = 1) — never a phase measured from
  // the wrong end, and above all never a REWIND.
  //
  // This branch used to answer `(renderTime − last.time) / interval` clamped to
  // 0..1, which is the phase measured from the WRONG end of the pair it returns.
  // One frame before the overrun the loop above answers ≈1 and the ship is drawn
  // at `last`; one frame after, this line answers ≈0 and the ship is drawn at
  // `prev` — a teleport BACKWARD by a whole segment (33–67 ms of travel, ~4 units
  // at cruise), followed by a real-time replay of the segment it had already
  // flown. Every momentary starve therefore cost a visible rewind-and-repeat
  // rather than the freeze the buffer is supposed to degrade to. Clamping is the
  // honest failure, and it is still what this returns.
  //
  // What is NEW is the fourth element: the overrun itself, so a caller holding a
  // replicated velocity can carry the ship FORWARD along its last known heading
  // instead of parking it. That is strictly additive — the clamped pair is
  // unchanged, the lead is bounded, and the blend back is the blender's job.
  const last = items[items.length - 1]!;
  const prev = items[items.length - 2]!;
  return [prev, last, 1, Math.min(renderTime - last.time, MAX_EXTRAPOLATION_MS)];
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
  /**
   * The sample's REPLICATED velocity in world units per SECOND, when it has one.
   * Absent for a sample that carries none — a pre-velocity server, a ship that
   * decoded an all-zero triple — which routes that end of the curve back to the
   * finite-difference tangent it always used.
   */
  readonly vel?: { readonly x: number; readonly y: number; readonly z: number } | undefined;
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
 * Tangent choice, best first — each end of the segment is decided independently,
 * so a segment can mix them:
 *
 *  1. The sample's own REPLICATED VELOCITY, scaled onto the segment
 *     (`M = v · h`). This is the tangent the curve actually wants: the true
 *     instantaneous derivative at the knot, straight off the server, rather than
 *     an estimate reconstructed from where the hull happened to be sampled
 *     nearby. Two things follow that finite differences cannot give. The knot
 *     tangent no longer depends on a NEIGHBOUR sample, so the newest segment in
 *     the buffer — the one being drawn, which by construction has no `next` — is
 *     as accurate as any interior one instead of degrading to a chord. And the
 *     curve now describes motion BETWEEN samples that the samples do not show:
 *     a hull that swung out and back inside one 66.7 ms patch gap reads as the
 *     swing, where a finite difference reads it as a straight line.
 *  2. `m_k = (p_{k+1} − p_{k−1}) / (t_{k+1} − t_{k−1})` — the non-uniform
 *     Catmull-Rom finite difference, used when the sample carries no velocity
 *     (a pre-velocity server; a decoded all-zero triple). It is the gap-weighted
 *     average of the two adjacent chord velocities, so its magnitude can never
 *     exceed the faster neighbouring chord.
 *  3. The segment's own chord slope, when there is no velocity AND no
 *     neighbour (fewer than 3 samples around the segment, or a ship that only
 *     just spawned). That degrades the end to the old lerp exactly — never
 *     worse than before.
 *
 * Overshoot guards, because Catmull-Rom is not shape-preserving and a ship
 * that BOUNCES off a rock between two samples must not be drawn inside it:
 *  - a tangent pointing AGAINST the segment's chord (`m · d < 0`) means the
 *    neighbourhood reverses direction here — the cubic would loop outside the
 *    travelled span, so the segment degrades to plain lerp. This deliberately
 *    spends C1 at the knot: around a physical impact the velocity really is
 *    discontinuous, and smoothing through it would be lying about the bounce.
 *  - a tangent that is too LONG for the chord it spans (a respawn teleport in
 *    the neighbour sample, a hard brake, a stale velocity) is clamped, which
 *    bounds the curve's deviation from the chord at (4/27)·(|M1|+|M2|).
 *
 * ## Why the length bound differs by tangent source
 *
 * The bound is `|M| ≤ chord` for a finite-difference tangent and
 * `|M| ≤ {@link VELOCITY_TANGENT_CHORD_LIMIT}·chord` for a replicated-velocity
 * one, and that is not a loosening for its own sake — it is the same guard
 * applied to two quantities with different natural sizes.
 *
 * A Catmull-Rom finite difference is the gap-weighted average of the two
 * adjacent chord velocities, so it can never exceed the faster neighbour. On any
 * ordinary flight path it is already at or under the chord, and `|M| > chord`
 * means something is wrong with the SAMPLES — a teleport, a respawn. 1x is
 * therefore free there, fires only on pathology, and is left exactly as it was.
 *
 * A true velocity is not bounded that way. The chord is the AVERAGE velocity
 * over the segment; the endpoint velocities straddle it whenever the ship is
 * accelerating, so `|M| > chord` at the faster end is the NORMAL state of a hull
 * under thrust. (Curvature does it too: on a circle the ratio is
 * `(ωh/2)/sin(ωh/2)`, though at the shipped cadence that is only 1.0001.)
 * Clamping those at 1x would discard the acceleration information that
 * replicating velocity was meant to deliver, at exactly the moments it is worth
 * having, and would do it silently — the curve would look like a slightly worse
 * finite difference. So the velocity bound is 3x, which is the Fritsch-Carlson
 * monotonicity limit for cubic Hermite: the largest tangent that still cannot
 * make the interpolant reverse direction inside a monotone segment. It admits
 * every physically-reachable acceleration (a ship would have to change speed by
 * more than 2x the segment's average within one 66.7 ms patch gap to reach it)
 * while still bounding the excursion, at (4/27)·3 ≈ 0.44·|chord| per tangent
 * rather than 0.15·|chord|, and it still catches the pathology the guard exists
 * for: a 300 u/s velocity reported across a segment that travelled one unit is
 * clamped just as hard as a teleported neighbour is.
 *
 * Pure and allocation-free (writes into `out`): the render loop calls this per
 * remote ship per tick, and pure is what keeps the C1/overshoot claims provable
 * in unit tests rather than asserted in a comment.
 */
/**
 * Length bound on a REPLICATED-VELOCITY tangent, as a multiple of the segment's
 * chord — the Fritsch-Carlson monotonicity limit. See {@link hermitePosition}
 * for why a true velocity needs a different bound than a finite difference.
 */
export const VELOCITY_TANGENT_CHORD_LIMIT = 3;

/**
 * Chord length (squared, world units) below which a position segment is drawn
 * as a straight lerp instead of a Hermite curve — 1.5x the wire's 0.1-unit
 * position quantization step, so a segment whose shape is mostly codec noise
 * never feeds that noise into the tangent guards. Passed into
 * {@link hermitePosition} by the PRODUCTION caller (`interpolate`), not baked
 * into the pure function: the threshold is a property of the wire codec, and
 * the curve math itself is scale-agnostic.
 */
export const STATIONARY_CHORD_SQ = 0.15 * 0.15;

export function hermitePosition(
  prev: TimedPos | null,
  from: TimedPos,
  to: TimedPos,
  next: TimedPos | null,
  t: number,
  out: Vec3,
  stationaryChordSq = 0,
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
  // SUB-QUANTIZATION SEGMENT (production passes {@link STATIONARY_CHORD_SQ};
  // the default 0 keeps the pure curve math scale-agnostic): at the 16.7 ms
  // patch cadence a slow ship's per-patch travel drops under the wire's
  // 0.1-unit position step, so the chord's DIRECTION is mostly quantization
  // noise. Every guard below compares a tangent against that direction, so on
  // noise-dominated segments the reversal guard flaps between curve and lerp
  // frame to frame — a visible shimmer on near-stationary hulls. Nothing a
  // cubic could add survives at this scale (the whole segment is under two
  // quantization steps), so draw it straight.
  if (stationaryChordSq > 0 && dx * dx + dy * dy + dz * dz < stationaryChordSq) {
    out.x = from.pos.x + dx * t;
    out.y = from.pos.y + dy * t;
    out.z = from.pos.z + dz * t;
    return out;
  }
  // Tangents scaled onto the segment (M = m·h), defaulting to the chord itself,
  // which makes a neighbourless end EXACTLY linear rather than approximately so.
  let m1x = dx, m1y = dy, m1z = dz;
  let m2x = dx, m2y = dy, m2z = dz;
  // Replicated velocity is in units per SECOND and `h` is in milliseconds, so
  // the scale onto the segment is h/1000 — getting this wrong by 1000x would
  // trip the magnitude clamp on every frame and silently look like plain lerp.
  const hSec = h / 1000;
  let limit1 = 1;
  let limit2 = 1;
  if (from.vel) {
    m1x = from.vel.x * hSec;
    m1y = from.vel.y * hSec;
    m1z = from.vel.z * hSec;
    limit1 = VELOCITY_TANGENT_CHORD_LIMIT;
  } else if (prev && from.time - prev.time > 0) {
    const k = h / (to.time - prev.time);
    m1x = (to.pos.x - prev.pos.x) * k;
    m1y = (to.pos.y - prev.pos.y) * k;
    m1z = (to.pos.z - prev.pos.z) * k;
  }
  if (to.vel) {
    m2x = to.vel.x * hSec;
    m2y = to.vel.y * hSec;
    m2z = to.vel.z * hSec;
    limit2 = VELOCITY_TANGENT_CHORD_LIMIT;
  } else if (next && next.time - to.time > 0) {
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
  const cap1 = chord * limit1;
  const l1 = Math.sqrt(m1x * m1x + m1y * m1y + m1z * m1z);
  if (l1 > cap1) {
    const k = cap1 / l1;
    m1x *= k;
    m1y *= k;
    m1z *= k;
  }
  const cap2 = chord * limit2;
  const l2 = Math.sqrt(m2x * m2x + m2y * m2y + m2z * m2z);
  if (l2 > cap2) {
    const k = cap2 / l2;
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

/* ------------------------------------------------------------------------- *
 * Orientation: the same curve, applied to the rotation axis
 * ------------------------------------------------------------------------- */

/** One ORIENTATION sample on the snapshot timeline (`time` in ms). */
export interface TimedFrame {
  readonly time: number;
  readonly heading: number;
  readonly pitch: number;
  readonly up: { readonly x: number; readonly y: number; readonly z: number };
}

/** Scratch nose/up vectors for {@link hermiteFrame} — the render loop is hot. */
const fPrevNose = { x: 0, y: 0, z: 0 };
const fFromNose = { x: 0, y: 0, z: 0 };
const fToNose = { x: 0, y: 0, z: 0 };
const fNextNose = { x: 0, y: 0, z: 0 };
const fNose = { x: 0, y: 0, z: 0 };

/**
 * C1 ORIENTATION interpolation across a snapshot segment — {@link hermitePosition}'s
 * argument, applied to the axis the hull rotates about.
 *
 * ## Why position alone was not enough
 *
 * Remote hull positions have ridden a C1 cubic since velocity replication
 * landed, while their ORIENTATION stayed on `interpolateFrame` — an nlerp of the
 * nose and up vectors, i.e. exactly the C0 blend the position path was moved off
 * for being visibly steppy. The two are not equally forgiving, and the
 * orientation half is arguably the worse offender in a fight:
 *
 *  - Position error at 15 Hz is a fraction of a hull length and reads as
 *    softness. Angular-velocity error reads as the nose CHANGING RATE at every
 *    knot — a 15 Hz rotational tick that the eye locks onto because the hull
 *    silhouette is what a pilot tracks while aiming.
 *  - It is worst in exactly the situation that matters. A ship flying straight
 *    has no angular velocity to be discontinuous; a ship in a hard turn — the
 *    only thing anyone is ever shooting at — changes its rotation axis at every
 *    single sample, so every knot steps.
 *
 * The construction is the position curve's, on the nose and up vectors, and the
 * reasoning transfers wholesale: both segments meeting at a knot evaluate the
 * SAME finite-difference tangent there, so the interpolated ANGULAR velocity is
 * continuous through it. The blended pair is then re-spelled through
 * {@link spellAttitude} and re-orthonormalized, which is what keeps the result a
 * legal frame — a Hermite of two orthonormal pairs is neither unit nor
 * orthogonal in between, and the renormalization is what projects it back.
 *
 * ## Why finite differences and not the replicated velocity
 *
 * There is no replicated ANGULAR velocity and this deliberately does not add
 * one. The wire already carries `up` (3 int16s) on top of heading and pitch, and
 * a turn rate is recoverable from the samples the client already holds to within
 * the accuracy this curve needs — where a LINEAR velocity was worth its three
 * fields because the position curve's newest segment has no `next` neighbour at
 * all and would otherwise degrade to a chord on the very segment being drawn.
 * The orientation curve has the same hole, and it costs the newest segment a
 * finite-difference tangent at one end — which is precisely what
 * {@link hermitePosition} did before velocity replication, i.e. strictly better
 * than the nlerp this replaces, at zero bandwidth.
 *
 * ## Guards
 *
 * Identical in spirit to the position curve, and for the same reasons:
 *  - a tangent opposing the segment's own rotation (the hull reversed its turn
 *    at this knot — a collision, a stick reversal) degrades the segment to the
 *    plain nlerp `interpolateFrame` performs, rather than swinging the nose
 *    through an arc it never flew;
 *  - a tangent longer than {@link VELOCITY_TANGENT_CHORD_LIMIT}·chord is clamped,
 *    which bounds the excursion at (4/27)·(|M1|+|M2|).
 *
 * That second bound is the Fritsch-Carlson limit rather than the flat 1x
 * {@link hermitePosition} applies to ITS finite differences, and the difference
 * is not a loosening for its own sake. A Catmull-Rom tangent cannot exceed the
 * faster NEIGHBOURING chord, but it can easily exceed the segment's OWN — that
 * is precisely what an accelerating turn is, and a stick being fed in produces
 * one on every knot. Clamping at 1x there does not guard against anything; it
 * silently discards the tangent on exactly the manoeuvres this curve exists to
 * smooth, and measurably restores most of the nlerp's angular-velocity step.
 * 3x is the largest tangent that still cannot make the interpolant reverse
 * inside a monotone segment, it admits every turn a ship can fly, and it still
 * catches the pathology the guard is for: a respawn in the neighbour sample
 * reports a rotation many times the segment's own and is clamped just as hard.
 *
 * With NO neighbours on either side both tangents ARE the chord, and cubic
 * Hermite with chord tangents is algebraically exact lerp — so a segment at the
 * edge of the buffer, or a ship that just spawned, reproduces the old nlerp
 * bit for bit. The change can only ever act where there is real neighbour
 * information to act on.
 */
export function hermiteFrame(
  prev: TimedFrame | null,
  from: TimedFrame,
  to: TimedFrame,
  next: TimedFrame | null,
  t: number,
  out: FrameAttitude,
): FrameAttitude {
  const h = to.time - from.time;
  const usePrev = prev !== null && from.time - prev.time > 0;
  const useNext = next !== null && next.time - to.time > 0;
  if (!(h > 0) || (!usePrev && !useNext)) {
    // Nothing to curve through: this is exactly the old blend.
    return interpolateFrame(from.heading, from.pitch, from.up, to.heading, to.pitch, to.up, t, out);
  }
  facingVec(from.heading, from.pitch, fFromNose);
  facingVec(to.heading, to.pitch, fToNose);
  if (usePrev) facingVec(prev!.heading, prev!.pitch, fPrevNose);
  if (useNext) facingVec(next!.heading, next!.pitch, fNextNose);
  const kPrev = usePrev ? h / (to.time - prev!.time) : 0;
  const kNext = useNext ? h / (next!.time - from.time) : 0;

  const nose = hermiteAxis(
    fFromNose,
    fToNose,
    usePrev ? fPrevNose : null,
    useNext ? fNextNose : null,
    kPrev,
    kNext,
    t,
    fNose,
  );
  const up = hermiteAxis(
    from.up,
    to.up,
    usePrev ? prev!.up : null,
    useNext ? next!.up : null,
    kPrev,
    kNext,
    t,
    out.up,
  );
  if (nose === null || up === null) {
    return interpolateFrame(from.heading, from.pitch, from.up, to.heading, to.pitch, to.up, t, out);
  }
  spellAttitude(fNose.x, fNose.y, fNose.z, out.up, out);
  orthonormalizeUp(out.heading, out.pitch, out.up);
  return out;
}

/** A frame axis whose Hermite blend degenerated — caller falls back to nlerp. */
const DEGENERATE_AXIS_SQ = 1e-12;

/**
 * One axis of {@link hermiteFrame}'s blend: cubic Hermite between `from` and
 * `to` with Catmull-Rom tangents, or `null` when the guards say this segment
 * must degrade to a plain lerp (see {@link hermiteFrame}).
 */
function hermiteAxis(
  from: { readonly x: number; readonly y: number; readonly z: number },
  to: { readonly x: number; readonly y: number; readonly z: number },
  prev: { readonly x: number; readonly y: number; readonly z: number } | null,
  next: { readonly x: number; readonly y: number; readonly z: number } | null,
  kPrev: number,
  kNext: number,
  t: number,
  out: Vec3,
): Vec3 | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  let m1x = dx, m1y = dy, m1z = dz;
  let m2x = dx, m2y = dy, m2z = dz;
  if (prev) {
    m1x = (to.x - prev.x) * kPrev;
    m1y = (to.y - prev.y) * kPrev;
    m1z = (to.z - prev.z) * kPrev;
  }
  if (next) {
    m2x = (next.x - from.x) * kNext;
    m2y = (next.y - from.y) * kNext;
    m2z = (next.z - from.z) * kNext;
  }
  if (m1x * dx + m1y * dy + m1z * dz < 0 || m2x * dx + m2y * dy + m2z * dz < 0) return null;
  const cap = Math.sqrt(dx * dx + dy * dy + dz * dz) * VELOCITY_TANGENT_CHORD_LIMIT;
  const l1 = Math.sqrt(m1x * m1x + m1y * m1y + m1z * m1z);
  if (l1 > cap) {
    const k = cap / l1;
    m1x *= k;
    m1y *= k;
    m1z *= k;
  }
  const l2 = Math.sqrt(m2x * m2x + m2y * m2y + m2z * m2z);
  if (l2 > cap) {
    const k = cap / l2;
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
  out.x = h00 * from.x + h10 * m1x + h01 * to.x + h11 * m2x;
  out.y = h00 * from.y + h10 * m1y + h01 * to.y + h11 * m2y;
  out.z = h00 * from.z + h10 * m1z + h01 * to.z + h11 * m2z;
  return out.x * out.x + out.y * out.y + out.z * out.z > DEGENERATE_AXIS_SQ ? out : null;
}

/* ------------------------------------------------------------------------- *
 * Small-rotation algebra for the orientation half of the extrapolation blender
 * ------------------------------------------------------------------------- */

/**
 * The ROTATION VECTOR (axis · angle, radians) carrying frame `(aNose, aUp)` onto
 * `(bNose, bUp)`.
 *
 * Built from the three axis cross products rather than through a quaternion:
 * `½·(n_a×n_b + u_a×u_b + w_a×w_b)` is the standard attitude-error vector, it
 * needs no square roots per axis and no shortest-path sign fix (an axis pair is
 * not a quaternion, so there is no double cover to disambiguate — the answer is
 * the short arc by construction). Its magnitude is `sinθ` rather than `θ`, which
 * this corrects with an `asin`, so a single-axis rotation comes back EXACT and
 * the handback continuity below is exact with it. Angles past 90° are not
 * representable this way and are reported saturated; every caller here snaps
 * long before that (see {@link FRAME_RESIDUAL_SNAP_RAD}).
 */
export function frameDelta(
  aNose: { readonly x: number; readonly y: number; readonly z: number },
  aUp: { readonly x: number; readonly y: number; readonly z: number },
  bNose: { readonly x: number; readonly y: number; readonly z: number },
  bUp: { readonly x: number; readonly y: number; readonly z: number },
  out: Vec3,
): Vec3 {
  const awx = aNose.y * aUp.z - aNose.z * aUp.y;
  const awy = aNose.z * aUp.x - aNose.x * aUp.z;
  const awz = aNose.x * aUp.y - aNose.y * aUp.x;
  const bwx = bNose.y * bUp.z - bNose.z * bUp.y;
  const bwy = bNose.z * bUp.x - bNose.x * bUp.z;
  const bwz = bNose.x * bUp.y - bNose.y * bUp.x;
  let x = 0.5 * (aNose.y * bNose.z - aNose.z * bNose.y + (aUp.y * bUp.z - aUp.z * bUp.y) + (awy * bwz - awz * bwy));
  let y = 0.5 * (aNose.z * bNose.x - aNose.x * bNose.z + (aUp.z * bUp.x - aUp.x * bUp.z) + (awz * bwx - awx * bwz));
  let z = 0.5 * (aNose.x * bNose.y - aNose.y * bNose.x + (aUp.x * bUp.y - aUp.y * bUp.x) + (awx * bwy - awy * bwx));
  const sin = Math.sqrt(x * x + y * y + z * z);
  if (sin > 1e-9) {
    const k = Math.asin(Math.min(1, sin)) / sin;
    x *= k;
    y *= k;
    z *= k;
  }
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

/** Scratch noses for {@link angularVelocity}. */
const avFromNose = { x: 0, y: 0, z: 0 };
const avToNose = { x: 0, y: 0, z: 0 };

/**
 * Angular velocity implied by two authoritative orientation samples, as a
 * rotation vector in rad/SECOND — the rotational counterpart of
 * `sampledVelocity`, and what {@link ExtrapolationBlender.resolveFrame}
 * dead-reckons along when the buffer starves.
 *
 * `undefined` when the samples are not separated in time, which is the honest
 * answer and the safe one: a zero divide here would spin a hull to NaN.
 */
export function angularVelocity(
  from: { readonly heading: number; readonly pitch: number; readonly up: { readonly x: number; readonly y: number; readonly z: number } },
  to: { readonly heading: number; readonly pitch: number; readonly up: { readonly x: number; readonly y: number; readonly z: number } },
  dtSeconds: number,
  out: Vec3,
): Vec3 | undefined {
  if (!(dtSeconds > 0)) return undefined;
  facingVec(from.heading, from.pitch, avFromNose);
  facingVec(to.heading, to.pitch, avToNose);
  frameDelta(avFromNose, from.up, avToNose, to.up, out);
  out.x /= dtSeconds;
  out.y /= dtSeconds;
  out.z /= dtSeconds;
  return out;
}

/** Rotate `v` by the rotation vector `r` (axis · angle) — Rodrigues, in place. */
export function rotateByVector(
  v: { readonly x: number; readonly y: number; readonly z: number },
  r: { readonly x: number; readonly y: number; readonly z: number },
  out: Vec3,
): Vec3 {
  const angle = Math.sqrt(r.x * r.x + r.y * r.y + r.z * r.z);
  if (!(angle > 1e-9)) {
    out.x = v.x;
    out.y = v.y;
    out.z = v.z;
    return out;
  }
  const kx = r.x / angle;
  const ky = r.y / angle;
  const kz = r.z / angle;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const cx = ky * v.z - kz * v.y;
  const cy = kz * v.x - kx * v.z;
  const cz = kx * v.y - ky * v.x;
  const d = (kx * v.x + ky * v.y + kz * v.z) * (1 - cos);
  out.x = v.x * cos + cx * sin + kx * d;
  out.y = v.y * cos + cy * sin + ky * d;
  out.z = v.z * cos + cz * sin + kz * d;
  return out;
}

/**
 * How fast a post-extrapolation residual is repaid, per second, as an
 * exponential rate. At 8/s a 1-unit residual is under 5 cm after 375 ms — inside
 * half a second of ordinary flight, and slow enough that the repayment velocity
 * (`|residual| · rate`, ≤ 8 u/s for the residuals this can produce) never
 * outruns the hull it is riding on and so can never read as a stutter.
 */
const RESIDUAL_DECAY_PER_SEC = 8;
/** Residual below which the ship is simply released back onto the curve. */
const RESIDUAL_EPSILON = 0.001;
/**
 * A residual this large is not a mispredicted 100 ms of flight, it is a
 * different position: a respawn, a bounce off a rock the extrapolation flew
 * straight through, a teleport. Blending across it would drag the hull through
 * the arena for half a second, so it is dropped outright and the ship appears
 * where the server says it is — the same judgement `decayCorrection` makes with
 * its `snapDistance`, and for the same reason.
 */
const RESIDUAL_SNAP_DISTANCE = 12;

/**
 * Repayment rate for an ORIENTATION residual, per second.
 *
 * Faster than the positional 8/s because the quantity is bounded far tighter: a
 * rotational guess is capped at {@link MAX_ANGULAR_EXTRAPOLATION_RAD}, so the
 * residual it can leave behind is a fifth of a radian, and `|r|·rate` — the
 * angular speed the repayment itself adds to the hull — peaks at ~2 rad/s. That
 * is the ship's own turn rate: fast enough to clear inside ~300 ms, and still
 * incapable of rotating the hull faster than a hull can physically rotate, which
 * is the property that keeps a repayment from reading as a snap.
 */
const FRAME_RESIDUAL_DECAY_PER_SEC = 10;
/** Residual angle (rad) below which the orientation is released onto the curve. */
const FRAME_RESIDUAL_EPSILON = 1e-4;
/**
 * An orientation residual this large (~29°) is not a mispredicted 100 ms of
 * turning — a bounded guess cannot produce one — it is a different attitude: a
 * respawn, a collision that spun the hull, a decode gap. Blending across it
 * would sweep the nose through an arc the ship never flew, so it is dropped and
 * the hull appears pointing where the server says it points. Same judgement, and
 * same reason, as {@link RESIDUAL_SNAP_DISTANCE}.
 */
const FRAME_RESIDUAL_SNAP_RAD = 0.5;
/**
 * Ceiling on a single frame's dead-reckoned ROTATION.
 *
 * The angular velocity is estimated from the bracketed sample pair, and unlike a
 * replicated linear velocity that estimate can be nonsense: a respawn or a
 * collision between those two samples reports a rotation of most of a turn
 * across 67 ms, i.e. tens of radians per second. Extrapolating that for a
 * starved 100 ms would spin the hull like a top. 0.2 rad is what a real ship
 * covers in {@link MAX_EXTRAPOLATION_MS} at ~2 rad/s, so this admits every
 * honest turn and truncates only the pathological ones.
 */
export const MAX_ANGULAR_EXTRAPOLATION_RAD = 0.2;

/**
 * Bounded dead reckoning past the newest sample, and the seamless way back.
 *
 * ## The problem this solves
 *
 * {@link bracket}'s dry branch clamps to the newest sample, so a remote hull
 * FREEZES the moment the render point overruns the buffer and then lurches when
 * the next patch lands. {@link adaptiveRenderDelay} exists to make that rare, but
 * it cannot make it never: a Wi-Fi power-save burst, one dropped patch, a GC
 * pause on the host. A freeze is the honest failure for a client that knows only
 * where the ship WAS — but with a replicated velocity it also knows where the
 * ship is GOING, and a hull continuing straight for one patch gap is a far
 * better picture of a live match than a hull parked in space.
 *
 * ## Why it needs state at all
 *
 * Because the way BACK is the hard half, and the repo has scar tissue about it.
 * Extrapolation is a guess; when the fresh patch lands, the true path is
 * somewhere else. Snapping onto it is a teleport, and if the guess ran ahead of
 * reality — which is exactly what happens when the ship was decelerating or
 * turning — that teleport is BACKWARD. Backward teleports on remote hulls are
 * the specific regression that {@link bracket}'s dry branch and
 * {@link adaptiveRenderDelay}'s widening rate limit were both written to kill;
 * re-introducing one here in the name of smoothness would trade a freeze for the
 * worse artefact.
 *
 * So the transition is made EXACT rather than approximately smooth. On the first
 * wet frame after a dry spell the blender records the residual — where it drew
 * the ship last frame, minus where the curve now says it is — and returns
 * `curve + residual`, which is precisely last frame's position. Zero
 * discontinuity, by construction, whatever the guess did. That residual then
 * decays exponentially to nothing, so the hull slides onto its true path over a
 * few hundred milliseconds while always moving forward along it.
 *
 * While dry the residual is FROZEN rather than decayed, and the fresh
 * extrapolation is added on top of it. That keeps the other direction continuous
 * too: a starve that begins during a repayment does not step, it just stops
 * repaying until the buffer recovers.
 *
 * State is per entity id and is dropped by {@link retain}, the same shape as
 * `FlagTrailAccumulator` in shared's decoders.
 */
export class ExtrapolationBlender {
  private readonly residuals = new Map<number, Vec3>();
  /** Last position this blender DREW for an id — the anchor for re-entry. */
  private readonly drawn = new Map<number, Vec3>();
  private readonly dry = new Set<number>();
  /** Outstanding orientation residual per id, as a rotation vector (rad). */
  private readonly frameResiduals = new Map<number, Vec3>();
  /** Last ORIENTATION drawn per id — the anchor for a rotational re-entry. */
  private readonly drawnFrames = new Map<number, DrawnFrame>();
  private readonly dryFrames = new Set<number>();

  /**
   * Resolve one ship's displayed position for this frame.
   *
   * @param id         entity id, the key for this ship's carried residual.
   * @param base       the interpolated position `bracket`/`hermitePosition` gave.
   * @param vel        the newest sample's replicated velocity, if it has one.
   * @param leadMs     `bracket`'s bounded overrun; 0 on a healthy frame.
   * @param dtSeconds  frame delta, for the residual decay.
   * @param out        written in place and returned (the render loop is hot).
   */
  resolve(
    id: number,
    base: { readonly x: number; readonly y: number; readonly z: number },
    vel: { readonly x: number; readonly y: number; readonly z: number } | undefined,
    leadMs: number,
    dtSeconds: number,
    out: Vec3,
  ): Vec3 {
    const extrapolating = leadMs > 0 && vel !== undefined;
    let residual = this.residuals.get(id);

    if (extrapolating) {
      // Dry: hold the residual where it is and dead-reckon on top of it. The
      // lead grows continuously from 0 as the bracket runs out, so entering this
      // branch is itself smooth — there is nothing to blend on the way IN.
      const lead = leadMs / 1000;
      out.x = base.x + (residual?.x ?? 0) + vel.x * lead;
      out.y = base.y + (residual?.y ?? 0) + vel.y * lead;
      out.z = base.z + (residual?.z ?? 0) + vel.z * lead;
    } else {
      if (this.dry.has(id)) {
        // First wet frame after a dry spell: re-anchor on what was DRAWN, so the
        // displayed position is continuous rather than snapping onto the curve.
        // See the class doc — this is the no-rewind guarantee.
        //
        // The anchor is `drawn + v·dt`, not `drawn`: continuity of VELOCITY, not
        // just of position. Anchoring on `drawn` alone is what a naive reading
        // suggests, and it is subtly wrong — it makes the handback frame draw
        // ZERO motion, because it pins the hull to exactly where it was last
        // frame. Meanwhile `base` has advanced by a frame of render time (~1.6
        // units at cruise), so the effect is a one-frame stall followed by a
        // catch-up: the freeze this class exists to remove, moved to the moment
        // of recovery and made harder to see. Carrying the last known velocity
        // across the seam costs nothing (the ship was already moving at it) and
        // makes the residual very nearly zero on a straight course, which is
        // why the repayment below is usually imperceptible.
        const last = this.drawn.get(id);
        residual = last
          ? {
              x: last.x + (vel?.x ?? 0) * dtSeconds - base.x,
              y: last.y + (vel?.y ?? 0) * dtSeconds - base.y,
              z: last.z + (vel?.z ?? 0) * dtSeconds - base.z,
            }
          : undefined;
        if (residual && Math.hypot(residual.x, residual.y, residual.z) > RESIDUAL_SNAP_DISTANCE) {
          residual = undefined; // too far to blend: show the truth at once
        }
        if (residual) this.residuals.set(id, residual);
        else this.residuals.delete(id);
      } else if (residual) {
        const k = Math.exp(-RESIDUAL_DECAY_PER_SEC * Math.max(0, dtSeconds));
        residual.x *= k;
        residual.y *= k;
        residual.z *= k;
        if (Math.abs(residual.x) + Math.abs(residual.y) + Math.abs(residual.z) < RESIDUAL_EPSILON) {
          this.residuals.delete(id);
          residual = undefined;
        }
      }
      out.x = base.x + (residual?.x ?? 0);
      out.y = base.y + (residual?.y ?? 0);
      out.z = base.z + (residual?.z ?? 0);
    }

    if (extrapolating) this.dry.add(id);
    else this.dry.delete(id);
    const drawn = this.drawn.get(id);
    if (drawn) {
      drawn.x = out.x;
      drawn.y = out.y;
      drawn.z = out.z;
    } else {
      this.drawn.set(id, { x: out.x, y: out.y, z: out.z });
    }
    return out;
  }

  /**
   * The ORIENTATION half of {@link resolve} — same contract, same guarantees,
   * applied to the hull's rotation instead of its position.
   *
   * Without this a starved buffer produced a hull that KEPT FLYING (position
   * dead-reckons) while its nose stood still, then snapped to a new attitude
   * when the patch landed. That is a worse artefact than the freeze it was
   * introduced to fix: a hull sliding sideways with a frozen nose does not read
   * as "the network hiccuped", it reads as the ship having stopped steering, and
   * a pilot leads their shot accordingly.
   *
   * The angular velocity is the caller's estimate from the bracketed sample
   * pair (there is no replicated one — see {@link hermiteFrame}), which is why
   * the guess is capped at {@link MAX_ANGULAR_EXTRAPOLATION_RAD} where the
   * positional guess trusts its velocity for the full lead.
   *
   * @param id      entity id, the key for this ship's carried residual.
   * @param nose    the interpolated nose direction (unit) for this frame.
   * @param up      the interpolated up axis (unit, ⊥ nose) for this frame.
   * @param omega   angular velocity as a rotation vector in rad/SECOND, if known.
   * @param leadMs  `bracket`'s bounded overrun; 0 on a healthy frame.
   * @param dtSeconds frame delta, for the residual decay.
   * @param out     written in place (`out.nose`, `out.up`).
   */
  resolveFrame(
    id: number,
    nose: { readonly x: number; readonly y: number; readonly z: number },
    up: { readonly x: number; readonly y: number; readonly z: number },
    omega: { readonly x: number; readonly y: number; readonly z: number } | undefined,
    leadMs: number,
    dtSeconds: number,
    out: { nose: Vec3; up: Vec3 },
  ): void {
    const extrapolating = leadMs > 0 && omega !== undefined;
    let residual = this.frameResiduals.get(id);

    if (extrapolating) {
      // Residual and lead are SUMMED as rotation vectors rather than composed as
      // rotations. They do not commute exactly, but both are bounded well under
      // half a radian here, where the composition error is third order — far
      // below the quantization the attitude already travels under.
      clampRotation(omega.x * (leadMs / 1000), omega.y * (leadMs / 1000), omega.z * (leadMs / 1000), scratchRot);
      scratchRot.x += residual?.x ?? 0;
      scratchRot.y += residual?.y ?? 0;
      scratchRot.z += residual?.z ?? 0;
      rotateByVector(nose, scratchRot, out.nose);
      rotateByVector(up, scratchRot, out.up);
    } else if (this.dryFrames.has(id)) {
      // First wet frame after a dry spell: re-anchor on the orientation DRAWN
      // last frame, carried one frame further along the last known turn rate —
      // continuity of angular velocity, not merely of attitude, for exactly the
      // reason the positional handback carries `v·dt` (see {@link resolve}).
      const last = this.drawnFrames.get(id);
      residual = undefined;
      if (last) {
        if (omega) {
          scratchRot.x = omega.x * dtSeconds;
          scratchRot.y = omega.y * dtSeconds;
          scratchRot.z = omega.z * dtSeconds;
          rotateByVector(last.nose, scratchRot, scratchNose);
          rotateByVector(last.up, scratchRot, scratchUp);
        } else {
          scratchNose.x = last.nose.x; scratchNose.y = last.nose.y; scratchNose.z = last.nose.z;
          scratchUp.x = last.up.x; scratchUp.y = last.up.y; scratchUp.z = last.up.z;
        }
        frameDelta(nose, up, scratchNose, scratchUp, scratchRot);
        if (Math.hypot(scratchRot.x, scratchRot.y, scratchRot.z) <= FRAME_RESIDUAL_SNAP_RAD) {
          residual = { x: scratchRot.x, y: scratchRot.y, z: scratchRot.z };
        }
      }
      if (residual) this.frameResiduals.set(id, residual);
      else this.frameResiduals.delete(id);
      applyFrameResidual(nose, up, residual, out);
    } else {
      if (residual) {
        const k = Math.exp(-FRAME_RESIDUAL_DECAY_PER_SEC * Math.max(0, dtSeconds));
        residual.x *= k;
        residual.y *= k;
        residual.z *= k;
        if (Math.abs(residual.x) + Math.abs(residual.y) + Math.abs(residual.z) < FRAME_RESIDUAL_EPSILON) {
          this.frameResiduals.delete(id);
          residual = undefined;
        }
      }
      applyFrameResidual(nose, up, residual, out);
    }

    if (extrapolating) this.dryFrames.add(id);
    else this.dryFrames.delete(id);
    const drawn = this.drawnFrames.get(id);
    if (drawn) {
      drawn.nose.x = out.nose.x; drawn.nose.y = out.nose.y; drawn.nose.z = out.nose.z;
      drawn.up.x = out.up.x; drawn.up.y = out.up.y; drawn.up.z = out.up.z;
    } else {
      this.drawnFrames.set(id, {
        nose: { x: out.nose.x, y: out.nose.y, z: out.nose.z },
        up: { x: out.up.x, y: out.up.y, z: out.up.z },
      });
    }
  }

  /** Forget every ship not in `ids` (left the match, died, was culled). */
  retain(ids: ReadonlySet<number>): void {
    for (const id of this.drawn.keys()) {
      if (ids.has(id)) continue;
      this.drawn.delete(id);
      this.residuals.delete(id);
      this.dry.delete(id);
    }
    for (const id of this.drawnFrames.keys()) {
      if (ids.has(id)) continue;
      this.drawnFrames.delete(id);
      this.frameResiduals.delete(id);
      this.dryFrames.delete(id);
    }
  }

  /** Drop everything — a reconnect, a rematch, a snapshot-clock reset. */
  clear(): void {
    this.residuals.clear();
    this.drawn.clear();
    this.dry.clear();
    this.frameResiduals.clear();
    this.drawnFrames.clear();
    this.dryFrames.clear();
  }

  /** Test/telemetry probe: the residual this id is currently carrying. */
  residualOf(id: number): Vec3 | undefined {
    const r = this.residuals.get(id);
    return r ? { x: r.x, y: r.y, z: r.z } : undefined;
  }

  /** Test/telemetry probe: the ORIENTATION residual this id is carrying (rad). */
  frameResidualOf(id: number): Vec3 | undefined {
    const r = this.frameResiduals.get(id);
    return r ? { x: r.x, y: r.y, z: r.z } : undefined;
  }
}

/** Last orientation drawn for one id (see {@link ExtrapolationBlender.resolveFrame}). */
interface DrawnFrame {
  nose: Vec3;
  up: Vec3;
}

const scratchRot: Vec3 = { x: 0, y: 0, z: 0 };
const scratchNose: Vec3 = { x: 0, y: 0, z: 0 };
const scratchUp: Vec3 = { x: 0, y: 0, z: 0 };

/** `out = R(residual) · (nose, up)`, or a straight copy when there is none. */
function applyFrameResidual(
  nose: { readonly x: number; readonly y: number; readonly z: number },
  up: { readonly x: number; readonly y: number; readonly z: number },
  residual: Vec3 | undefined,
  out: { nose: Vec3; up: Vec3 },
): void {
  if (residual) {
    rotateByVector(nose, residual, out.nose);
    rotateByVector(up, residual, out.up);
    return;
  }
  out.nose.x = nose.x; out.nose.y = nose.y; out.nose.z = nose.z;
  out.up.x = up.x; out.up.y = up.y; out.up.z = up.z;
}

/** Rotation vector, truncated to {@link MAX_ANGULAR_EXTRAPOLATION_RAD}. */
function clampRotation(x: number, y: number, z: number, out: Vec3): Vec3 {
  const angle = Math.sqrt(x * x + y * y + z * z);
  const k = angle > MAX_ANGULAR_EXTRAPOLATION_RAD ? MAX_ANGULAR_EXTRAPOLATION_RAD / angle : 1;
  out.x = x * k;
  out.y = y * k;
  out.z = z * k;
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
 * localhost — the best case there is — patches nominally 50 ms apart arrived at
 * a median of ~62 ms with bursts past 95 ms, so a fixed 100 ms delay left the
 * render time ahead of the newest snapshot on ~16% of frames. A dry bracket
 * clamps to the newest snapshot, so the remote ship FREEZES there and then
 * lurches when the next patch lands — precisely the "ships jump between server
 * updates" the interpolation buffer exists to hide. On phone Wi-Fi, whose
 * power-save batches receives into 100-300 ms bursts, it is the normal state.
 *
 * (The nominal gap is 66.7 ms since the room's patch phase lock; the measurement
 * above is left as taken, because what it establishes — that arrival jitter is a
 * large fraction of the nominal gap and bursts well past it — is a property of
 * the network, not of the cadence. `HEADROOM_PATCHES` multiplies the OBSERVED
 * p90, so the target scales with whatever the room is actually sending and
 * needed no retuning. {@link MAX_EXTRAPOLATION_MS} is the second line of defence
 * for the frames that starve anyway.)
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

/**
 * p90 of the observed patch-arrival gaps, or null with fewer than 4
 * observations (too little to estimate anything).
 *
 * Split out of {@link adaptiveRenderDelay} because the two change at different
 * rates: the p90 can only change when a PATCH lands, but the delay is advanced
 * every RENDERED frame — and sorting a copied ring per drawn frame was a pure
 * hot-path allocation for a value that had not moved. The session computes this
 * once per patch and hands the cached number to every frame in between.
 */
export function p90ArrivalGap(arrivalGapsMs: readonly number[]): number | null {
  if (arrivalGapsMs.length < 4) return null;
  const sorted = [...arrivalGapsMs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))]!;
}

/**
 * `shortfallMs` closes the loop. The p90 target above is OPEN loop: it predicts
 * the delay the arrival cadence should need. `shortfallMs` is the delay the last
 * frame actually MISSED BY — how far `now − delay` overran the newest playback
 * timestamp — measured on the very quantity the buffer exists to protect. Any
 * frame that starved raises the target by exactly its own shortfall, so a
 * cadence the p90 estimate does not describe (a duplicated `matchTimer`, a
 * server tick lost to GC, a burst the ring has already forgotten) still widens
 * the delay instead of waiting for the estimator to notice. Zero on a healthy
 * frame, which leaves the tuned open-loop behaviour untouched.
 */
export function adaptiveRenderDelay(
  currentMs: number,
  p90GapMs: number | null,
  floorMs: number,
  dtSeconds: number,
  ceilMs = RENDER_DELAY_CEIL_MS,
  shortfallMs = 0,
): number {
  let target = floorMs;
  if (p90GapMs !== null) {
    target = Math.max(floorMs, p90GapMs * HEADROOM_PATCHES);
  }
  if (shortfallMs > 0) target = Math.max(target, currentMs + shortfallMs);
  target = Math.min(ceilMs, Math.max(floorMs, target));
  const dt = Math.max(0, dtSeconds);
  if (target > currentMs) return Math.min(target, currentMs + WIDEN_MS_PER_SECOND * dt);
  return Math.max(target, currentMs - NARROW_MS_PER_SECOND * dt);
}

/* ------------------------------------------------------------------------- *
 * Snapshot playback clock
 * ------------------------------------------------------------------------- */

/**
 * State of the map from SERVER time to the local playback timeline. Plain data
 * and mutated in place: it is touched once per patch (20 Hz), and keeping it
 * inspectable is what lets the drift control be tested rather than described.
 */
export interface SnapshotClockState {
  /** `playback = serverMs + offsetMs`. Slewed, never stepped. */
  offsetMs: number;
  /** Recent `arrival − serverMs` observations; the MINIMUM is the honest offset. */
  readonly instants: number[];
  lastServerMs: number;
  lastPlaybackMs: number;
  seeded: boolean;
}

export interface SnapshotStamp {
  /** Timestamp to file this snapshot under on the interpolation timeline. */
  timeMs: number;
  /** True when the mapping was (re)seeded — buffered samples are now stale. */
  reset: boolean;
}

/**
 * How many `arrival − server` observations the offset estimate looks back over.
 * Sized in PATCHES, so it must scale with the patch cadence: at the 60 Hz
 * cadence 128 observations is ~2.1 s of history — the same horizon the original
 * 32 gave at 15 Hz. A shorter window is not a harmless tightening: the offset
 * is the window MINIMUM, and if one congestion episode outlives the window, the
 * minimum ratchets up by the whole queueing delay and can clear
 * {@link SNAPSHOT_CLOCK_RESET_MS} — a spurious full clock reset (buffer dump,
 * delay re-floor) on exactly the burst the system exists to ride out.
 */
const CLOCK_WINDOW = 128;
/**
 * Offset error that stops being drift and starts being a different clock: a
 * match going live (`matchTimer` leaves 0 after a lobby of any length), a
 * reconnect, a server restart. Chosen just above {@link RENDER_DELAY_CEIL_MS} —
 * an error the render delay could still absorb is one worth slewing out rather
 * than resetting for, and anything larger cannot be absorbed at all.
 */
export const SNAPSHOT_CLOCK_RESET_MS = 400;
/**
 * Ceiling on how much of a segment the drift correction may eat, as a fraction
 * of that segment. The correction is applied by moving one sample's timestamp,
 * which stretches or squeezes the segment ending there — i.e. it IS a playback
 * speed error, the exact artefact this clock exists to remove. At 3% of a 50 ms
 * segment that is 1.5 ms per patch, ~30 ms/s of authority: comfortably more than
 * the ~1-2% by which a fixed-`dt` server sim clock drifts against wall time, and
 * far below the ~10% speed error an eye starts to resolve on a moving hull.
 */
const CLOCK_SLEW_FRACTION = 0.03;
/** Minimum spacing forced between two playback timestamps (see {@link phase}). */
const MIN_SEGMENT_MS = 1;

export function createSnapshotClock(): SnapshotClockState {
  return { offsetMs: 0, instants: [], lastServerMs: 0, lastPlaybackMs: 0, seeded: false };
}

/**
 * Place one snapshot on the interpolation timeline, using the SERVER's own clock
 * for its spacing and the local clock only for its alignment.
 *
 * ## Why arrival time is the wrong timeline
 *
 * `ArenaRoom` used to step the sim at 30 Hz (`SIM_TICK_RATE`) and broadcast
 * patches from an INDEPENDENT 20 Hz timer. Nothing synchronised the two, so a
 * patch carried whichever sim tick was the most recent when it fired:
 * consecutive patches ONE tick apart (33.3 ms of simulated travel) and then TWO
 * (66.7 ms), alternating, forever, on a perfect network.
 *
 * Stamping those samples with their local ARRIVAL time — uniform 50 ms — played
 * 66.7 ms of travel back over 50 ms and then 33.3 ms of travel over 50 ms. Every
 * remote hull therefore rendered at 1.33x its true speed, then 0.67x, ten times a
 * second, on LAN, on localhost, at any frame rate, with a perfectly full buffer.
 * A 2:1 sawtooth in velocity is exactly what "janky" describes, and no amount of
 * buffer depth, C1 curve fitting or render-delay adaptation could remove it,
 * because all three faithfully interpolate a timeline that is itself wrong.
 * (`renderPacing.test.ts` could not see it either: it modelled the server as
 * sampling the world every 50 ms, which is the assumption at fault.)
 *
 * `snapshot.elapsed` is `matchTimer`, already on the wire, already frozen into
 * the field contract — the sim's own accumulated time, advancing by exactly one
 * `FIXED_DT` per tick. Spacing samples by THAT restores true playback speed.
 *
 * The room has since been fixed at the source as well: it broadcasts from the
 * sim loop, phase-locked, every 2 ticks (`PATCH_EVERY_TICKS`), so the alternating
 * cadence is gone and every patch carries a fresh tick. **This function is not
 * redundant now, and must not be reverted to arrival stamping.** It is what
 * keeps playback honest for everything the room cannot control — a host whose
 * timers slip, a tick starved by GC, a duplicated `matchTimer`, and the network
 * jitter that is the whole reason a buffer exists. The phase lock removed the
 * SYSTEMATIC error; this removes the rest.
 *
 * ## Why the offset has to be controlled rather than measured once
 *
 * `offsetMs` aligns the two clocks; it cannot simply be latched at join. The
 * server advances `elapsed` by a fixed `1/30` per tick while its timer fires on
 * a real, slightly-off interval, so the sim clock runs 1-2% away from wall time
 * in whichever direction the host's timers land. Left alone, that ratio walks
 * the whole buffer out of the render window inside a minute — dry every frame if
 * the server clock runs slow, seconds of added latency if it runs fast.
 *
 * The estimate is the MINIMUM of `arrival − serverMs` over the recent window:
 * the least-delayed patch is the one that saw the least queueing, so it is the
 * closest thing to the true offset the client can observe, and a min over a
 * moving window follows drift for free while ignoring every late arrival (which
 * is the render delay's job, not this one's). Convergence onto that estimate is
 * rate-limited to {@link CLOCK_SLEW_FRACTION} of a segment, because a STEP in
 * the offset is a step in the playback clock — the same mistake the first cut of
 * {@link adaptiveRenderDelay} made, and one the owner could see.
 */
export function stampSnapshot(clock: SnapshotClockState, serverMs: number, arrivalMs: number): SnapshotStamp {
  const instant = arrivalMs - serverMs;
  if (!clock.seeded) return seedSnapshotClock(clock, serverMs, arrivalMs);
  if (!Number.isFinite(instant)) {
    // No usable server clock on this patch (a peer whose `matchTimer` decoded to
    // nothing). Fall back to arrival stamping for this one sample rather than
    // resetting: a reset would discard the buffer, and one unusable timestamp is
    // not evidence that the mapping is wrong.
    const fallback = Math.max(arrivalMs, clock.lastPlaybackMs + MIN_SEGMENT_MS);
    clock.lastPlaybackMs = fallback;
    return { timeMs: fallback, reset: false };
  }

  const serverStep = serverMs - clock.lastServerMs;
  // The server clock RAN BACKWARD. Within one match that cannot happen — a
  // room's `matchTimer` only ever accumulates — so this is a different match on
  // the same socket (a restart replaying from 0). Reset at once rather than wait
  // for the observation window to notice: until the mapping is repaired, every
  // buffered timestamp is a minute in the past and the bracket is dry on every
  // single frame.
  if (serverStep < 0) return seedSnapshotClock(clock, serverMs, arrivalMs);
  if (serverStep === 0) {
    // The server clock is FROZEN: a lobby or the start countdown, where the sim
    // is not stepped at all (`ArenaSimulation.tick` returns before `elapsed +=`),
    // or a single sim tick starved on the host. Nothing in the world moved, so
    // there is nothing to time — hold the mapping and only stay monotonic.
    //
    // The observation window is DROPPED because these arrivals measure how long
    // the clock has been frozen, not how long the network took: keeping them
    // would drag the offset estimate up by the whole lobby, and clearing them is
    // also what lets the very first moving patch be recognised as the clock jump
    // it is (GO, after a lobby of arbitrary length).
    clock.instants.length = 0;
    const held = clock.lastPlaybackMs + MIN_SEGMENT_MS;
    clock.lastPlaybackMs = held;
    return { timeMs: held, reset: false };
  }

  clock.instants.push(instant);
  if (clock.instants.length > CLOCK_WINDOW) clock.instants.shift();
  let target = Infinity;
  for (const v of clock.instants) if (v < target) target = v;
  // Even the BEST patch in the whole window is far off the current mapping, so
  // the server clock moved rather than drifted (a match going live after a
  // lobby; a route change that added a fixed leg of latency). Slewing across
  // that at 30 ms/s would leave the buffer unusable for the whole crossing.
  if (Math.abs(target - clock.offsetMs) > SNAPSHOT_CLOCK_RESET_MS) {
    return seedSnapshotClock(clock, serverMs, arrivalMs);
  }

  const budget = serverStep * CLOCK_SLEW_FRACTION;
  clock.offsetMs += Math.max(-budget, Math.min(budget, target - clock.offsetMs));
  clock.lastServerMs = serverMs;
  // The `max` is the monotonicity backstop for a server clock that stalled: a
  // room whose sim tick was starved republishes the same `matchTimer`, and a
  // buffer whose timestamps do not increase is a divide by zero in `bracket`.
  const timeMs = Math.max(serverMs + clock.offsetMs, clock.lastPlaybackMs + MIN_SEGMENT_MS);
  clock.lastPlaybackMs = timeMs;
  return { timeMs, reset: false };
}

function seedSnapshotClock(clock: SnapshotClockState, serverMs: number, arrivalMs: number): SnapshotStamp {
  const offset = Number.isFinite(arrivalMs - serverMs) ? arrivalMs - serverMs : 0;
  clock.seeded = true;
  clock.offsetMs = offset;
  clock.instants.length = 0;
  clock.instants.push(offset);
  clock.lastServerMs = serverMs;
  // Seeding lands the sample on its own arrival instant, which is where the old
  // arrival-time stamping would have put it — so the first frame after a reset
  // is never worse than the behaviour this replaced.
  clock.lastPlaybackMs = arrivalMs;
  return { timeMs: arrivalMs, reset: true };
}
