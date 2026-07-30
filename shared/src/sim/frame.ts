import {
  advanceAttitude,
  facingVec,
  headingOf,
  pitchOf,
  wrapAngle,
  type Attitude,
} from "./math.js";

/**
 * Authoritative ship orientation FRAME (docs/HANDOFF-2026-07-30-FLIGHT-FRAME.md).
 *
 * `Transform3D` used to store only `{ heading, pitch }` and every consumer
 * reconstructed the ship's up axis from those two coordinates. That
 * reconstruction is two-to-one at the poles — infinitely many roll orientations
 * share a vertical nose — so integrating body-frame yaw near ±90° pitch selected
 * a DIFFERENT frame each tick and the derived up axis spun ~6.5 rev/s while the
 * nose sat still (the owner's "sudden barrel roll").
 *
 * The fix persists the up axis `U` alongside heading/pitch:
 *
 *  - the nose `N` stays derivable from heading/pitch (`facingVec`), so velocity,
 *    targeting and the wire codecs are untouched;
 *  - `U` carries the roll degree of freedom the two Euler coordinates cannot —
 *    no player roll CONTROL is added, the state just stops being lossy;
 *  - the ship's right-hand flight axis is `W = N × U`, the project's existing
 *    convention (`advanceAttitude`'s docs, bots' body-frame split).
 *
 * One integration tick applies both local rotations to the complete frame
 * ({@link advanceFrame}); heading/pitch are re-DERIVED from the rotated nose for
 * the existing consumers and `U` is persisted — never reconstructed from
 * heading/pitch during normal integration.
 */

/** A mutable 3D vector (the persisted ship-up axis). */
export interface UpVec {
  x: number;
  y: number;
  z: number;
}

/** A full orientation: the legacy heading/pitch spelling plus the persisted up axis. */
export interface FrameAttitude extends Attitude {
  up: UpVec;
}

/** Threshold below which a cross/normalization is treated as degenerate. */
const DEGENERATE_SQ = 1e-12;

/**
 * Name a nose direction as (heading, pitch), choosing between the two spellings
 * (`(h, p)` and `(h + π, π − p)` name the same vector) by consistency with the
 * frame's OWN up: the spelling whose derived roll-less up points the same way
 * as the persisted up. This is a state rule, not a history rule, and that is
 * the point — choosing by "nearest to the previous pitch" fails exactly at a
 * vertical crossing, where both spellings sit within one integration step of
 * the previous value and the wrong one is often nearer, bouncing the pitch
 * coordinate off π/2 instead of wrapping it through.
 *
 * For a roll-less frame the dot is ±1 and the choice is exact; it degrades
 * continuously with roll and only becomes a coin-toss at 90° of roll, where
 * the two spellings are genuinely equally good — ties go to the canonical
 * spelling, deterministically. An upright ship always answers the canonical
 * pair, which preserves the pre-frame behaviour everywhere the old model was
 * correct.
 */
export function spellAttitude(
  nx: number,
  ny: number,
  nz: number,
  up: UpVec,
  out: Attitude,
): Attitude {
  const hc = headingOf(nx, nz);
  const pc = pitchOf(nx, ny, nz);
  // Derived up of the canonical spelling, dotted with the persisted up.
  const sp = Math.sin(pc);
  const agree =
    -Math.cos(hc) * sp * up.x + Math.cos(pc) * up.y + -Math.sin(hc) * sp * up.z;
  if (agree >= 0) {
    out.heading = wrapAngle(hc);
    out.pitch = pc;
    return out;
  }
  out.heading = wrapAngle(hc + Math.PI);
  out.pitch = pc >= 0 ? Math.PI - pc : -Math.PI - pc;
  return out;
}

/**
 * The ship-up axis DERIVED from a heading/pitch pair — the frame a roll-less
 * attitude carries: `U = (−cos h·sin p, cos p, −sin h·sin p)`. This is the ONLY
 * legitimate source of an up vector outside the integrator: spawns seed from it,
 * and degenerate decodes fall back to it. During normal integration the
 * persisted up must be used instead ({@link advanceFrame}).
 */
export function upFromAttitude(heading: number, pitch: number, out: UpVec): UpVec {
  const sp = Math.sin(pitch);
  // `+ 0` folds IEEE −0 into +0 (level flight would otherwise carry −0
  // components that ===-compare equal but fail Object.is fixture equality).
  out.x = -Math.cos(heading) * sp + 0;
  out.y = Math.cos(pitch);
  out.z = -Math.sin(heading) * sp + 0;
  return out;
}

/** Freshly allocated derived up — the spawn-time seed for a transform's frame. */
export function seedUp(heading: number, pitch: number): UpVec {
  return upFromAttitude(heading, pitch, { x: 0, y: 0, z: 0 });
}

/**
 * Gram–Schmidt-correct `up` against the nose named by `heading`/`pitch` and
 * normalize it, in place. Called at CONTROLLED boundaries — spawn-adjacent
 * seeding, wire decode, prediction correction, boundary reflection — never per
 * integration tick, so the deterministic hot loop stays exactly the pure
 * rotations in {@link advanceFrame}. A degenerate input (up parallel to the
 * nose, zero length, non-finite) falls back to the derived up, which is always
 * a legal frame for the given nose.
 */
export function orthonormalizeUp(heading: number, pitch: number, up: UpVec): UpVec {
  const cp = Math.cos(pitch);
  const nx = cp * Math.cos(heading);
  const ny = Math.sin(pitch);
  const nz = cp * Math.sin(heading);
  const dot = up.x * nx + up.y * ny + up.z * nz;
  const ux = up.x - dot * nx;
  const uy = up.y - dot * ny;
  const uz = up.z - dot * nz;
  const lenSq = ux * ux + uy * uy + uz * uz;
  if (!(lenSq > DEGENERATE_SQ)) return upFromAttitude(heading, pitch, up);
  const inv = 1 / Math.sqrt(lenSq);
  up.x = ux * inv;
  up.y = uy * inv;
  up.z = uz * inv;
  return up;
}

/**
 * One tick of the full orientation frame — body yaw about the persisted up,
 * then body pitch about the already-yawed right axis:
 *
 *     N1 = N·cos ψ + W·sin ψ        W1 = W·cos ψ − N·sin ψ        U1 = U
 *     N2 = N1·cos δ + U1·sin δ      U2 = U1·cos δ − N1·sin δ      W2 = W1
 *
 * Heading/pitch are re-derived from `N2` (spelled continuously with the pitch we
 * came from, {@link attitudeNear}) and `U2` is persisted verbatim. Per-tick
 * angular motion is therefore bounded by `|ψ| + |δ|` at EVERY attitude — the
 * near-pole heading-spin attractor the nose-only integration produced cannot
 * exist, because nothing here ever reconstructs the frame from the two Euler
 * coordinates.
 *
 * With the LEGACY `maxPitchRad` clamp authored, the pre-loop contract still
 * holds ("a clamped hull can never roll or invert"), so that path delegates to
 * the original nose-only {@link advanceAttitude} bit-for-bit and re-derives the
 * up axis — the clamp keeps the nose far from the poles, where the derivation
 * is single-valued and safe.
 *
 * Level flight is bit-identical to the old model: with `U = (0, 1, 0)` the yaw
 * expressions collapse to exactly the arithmetic `advanceAttitude` ran.
 *
 * Both integrators — `flightStep` and `NavigationSystem` — call THIS, so the
 * sim and the client predictor cannot drift apart. Allocation-free; callers
 * pass a reusable `out`.
 */
export function advanceFrame(
  heading: number,
  pitch: number,
  up: UpVec,
  yawDelta: number,
  pitchDelta: number,
  maxPitchRad: number | null,
  out: FrameAttitude,
): FrameAttitude {
  if (maxPitchRad !== null) {
    advanceAttitude(heading, pitch, yawDelta, pitchDelta, maxPitchRad, out);
    upFromAttitude(out.heading, out.pitch, out.up);
    return out;
  }
  if (yawDelta === 0 && pitchDelta === 0) {
    out.heading = wrapAngle(heading);
    out.pitch = wrapAngle(pitch);
    out.up.x = up.x;
    out.up.y = up.y;
    out.up.z = up.z;
    return out;
  }

  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const ch = Math.cos(heading);
  const sh = Math.sin(heading);
  let nx = cp * ch;
  let ny = sp;
  let nz = cp * sh;
  let ux = up.x;
  let uy = up.y;
  let uz = up.z;
  // W = N × U — the ship's right-hand flight axis.
  let wx = ny * uz - nz * uy;
  let wy = nz * ux - nx * uz;
  let wz = nx * uy - ny * ux;

  if (yawDelta !== 0) {
    const cy = Math.cos(yawDelta);
    const sy = Math.sin(yawDelta);
    const n1x = nx * cy + wx * sy;
    const n1y = ny * cy + wy * sy;
    const n1z = nz * cy + wz * sy;
    const w1x = wx * cy - nx * sy;
    const w1y = wy * cy - ny * sy;
    const w1z = wz * cy - nz * sy;
    nx = n1x;
    ny = n1y;
    nz = n1z;
    wx = w1x;
    wy = w1y;
    wz = w1z;
  }

  if (pitchDelta !== 0) {
    const cd = Math.cos(pitchDelta);
    const sd = Math.sin(pitchDelta);
    const n2x = nx * cd + ux * sd;
    const n2y = ny * cd + uy * sd;
    const n2z = nz * cd + uz * sd;
    const u2x = ux * cd - nx * sd;
    const u2y = uy * cd - ny * sd;
    const u2z = uz * cd - nz * sd;
    nx = n2x;
    ny = n2y;
    nz = n2z;
    ux = u2x;
    uy = u2y;
    uz = u2z;
  }

  out.up.x = ux;
  out.up.y = uy;
  out.up.z = uz;
  spellAttitude(nx, ny, nz, out.up, out);
  return out;
}

/**
 * Rotate `up` by the MINIMAL rotation that carries the nose `from` onto the nose
 * `to` (both unit vectors) — how a boundary reflection transports the frame
 * instead of silently resetting roll. Rodrigues about `from × to`; the two
 * degenerate cases are exact: parallel noses need no rotation, and antiparallel
 * noses rotate π about `up` itself, which flips the nose and leaves `up` fixed —
 * the deterministic choice for an axis-free half-turn.
 */
export function transportUp(
  from: { x: number; y: number; z: number },
  to: { x: number; y: number; z: number },
  up: UpVec,
): UpVec {
  const kx = from.y * to.z - from.z * to.y;
  const ky = from.z * to.x - from.x * to.z;
  const kz = from.x * to.y - from.y * to.x;
  const sinSq = kx * kx + ky * ky + kz * kz;
  if (!(sinSq > DEGENERATE_SQ)) return up; // parallel or antiparallel: up unchanged
  const sin = Math.sqrt(sinSq);
  const cos = from.x * to.x + from.y * to.y + from.z * to.z;
  const ix = kx / sin;
  const iy = ky / sin;
  const iz = kz / sin;
  const cx = iy * up.z - iz * up.y;
  const cy = iz * up.x - ix * up.z;
  const cz = ix * up.y - iy * up.x;
  const d = (ix * up.x + iy * up.y + iz * up.z) * (1 - cos);
  const x = up.x * cos + cx * sin + ix * d;
  const y = up.y * cos + cy * sin + iy * d;
  const z = up.z * cos + cz * sin + iz * d;
  up.x = x;
  up.y = y;
  up.z = z;
  return up;
}

/** Scratch nose vectors for {@link interpolateFrame}/{@link bodyYawDelta} — no per-call alloc. */
const noseA = { x: 0, y: 0, z: 0 };
const noseB = { x: 0, y: 0, z: 0 };

/**
 * Interpolate between two full orientation frames — the replacement for lerping
 * heading and pitch as independent coordinates, which sweeps the hull through a
 * rotation it never made whenever two samples straddle a pole (heading's scale
 * is unbounded there). Noses and ups are nlerp'd as vectors, the up is
 * re-orthonormalized against the blended nose, and the heading/pitch spelling
 * follows the blended up ({@link spellAttitude}) so consumers that still read
 * the coordinates see no seam at ±π or at a vertical crossing.
 *
 * Degenerate blends (antipodal noses at `t ≈ 0.5`) fall back to the `b` nose —
 * a 180° flip between two 20 Hz samples is not a real manoeuvre, and any answer
 * is defensible; this one is deterministic.
 */
export function interpolateFrame(
  aHeading: number,
  aPitch: number,
  aUp: UpVec,
  bHeading: number,
  bPitch: number,
  bUp: UpVec,
  t: number,
  out: FrameAttitude,
): FrameAttitude {
  facingVec(aHeading, aPitch, noseA);
  facingVec(bHeading, bPitch, noseB);
  let nx = noseA.x + (noseB.x - noseA.x) * t;
  let ny = noseA.y + (noseB.y - noseA.y) * t;
  let nz = noseA.z + (noseB.z - noseA.z) * t;
  const nLenSq = nx * nx + ny * ny + nz * nz;
  if (!(nLenSq > DEGENERATE_SQ)) {
    nx = noseB.x;
    ny = noseB.y;
    nz = noseB.z;
  }
  out.up.x = aUp.x + (bUp.x - aUp.x) * t;
  out.up.y = aUp.y + (bUp.y - aUp.y) * t;
  out.up.z = aUp.z + (bUp.z - aUp.z) * t;
  spellAttitude(nx, ny, nz, out.up, out);
  orthonormalizeUp(out.heading, out.pitch, out.up);
  return out;
}

/**
 * Signed BODY yaw between two consecutive orientations of one ship — the
 * rotation about the previous frame's up that carries the old nose toward the
 * new one: `atan2(N₂·W₁, N₂·N₁)` with `W₁ = N₁ × U₁`.
 *
 * This is what the cosmetic hull bank must be derived from. The raw heading
 * COORDINATE rate it used to read is `ψ / cos p` — unbounded near the poles —
 * so the bank saturated and reversed across vertical for turns the ship never
 * flew. Body yaw equals heading rate exactly at level flight and stays bounded
 * by the commanded yaw at every attitude.
 */
export function bodyYawDelta(
  prevHeading: number,
  prevPitch: number,
  prevUp: UpVec,
  curHeading: number,
  curPitch: number,
): number {
  facingVec(prevHeading, prevPitch, noseA);
  facingVec(curHeading, curPitch, noseB);
  const wx = noseA.y * prevUp.z - noseA.z * prevUp.y;
  const wy = noseA.z * prevUp.x - noseA.x * prevUp.z;
  const wz = noseA.x * prevUp.y - noseA.y * prevUp.x;
  const along = noseB.x * noseA.x + noseB.y * noseA.y + noseB.z * noseA.z;
  const across = noseB.x * wx + noseB.y * wy + noseB.z * wz;
  if (across === 0 && along === 0) return 0;
  return Math.atan2(across, along);
}
