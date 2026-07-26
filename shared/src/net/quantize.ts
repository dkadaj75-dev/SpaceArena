/**
 * Wire quantization helpers shared by the server (encode) and client (decode).
 *
 * Positions/velocities travel as int16 **centi-units**: the float value is
 * multiplied by 100, rounded, and clamped to the signed-16-bit range. This gives
 * 0.01-world-unit precision over a ±327.67-unit span — comfortably larger than
 * any shipped arena (deep-field is a radius-300 bubble, and BUBBLE.md §B keeps
 * the same codec for the new `y` axis: the vertical extent is the same sphere
 * radius, plus a little projectile overshoot before the bounds cull, which the
 * ±327 headroom absorbs). Values outside the range are clamped (they should
 * never occur for in-bounds entities).
 *
 * Headings travel as uint16 mapping the full 0..2π turn onto 0..65535, i.e.
 * ~0.0096° precision, wrap-around handled by the modulo. Pitch is a clamped,
 * SIGNED angle and gets its own int16 codec — see {@link encodePitch}.
 */

export const INT16_MIN = -32768;
export const INT16_MAX = 32767;

/** Quantize a world coordinate/velocity component to int16 centi-units. */
export function encodeCenti(value: number): number {
  const q = Math.round(value * 100);
  if (q < INT16_MIN) return INT16_MIN;
  if (q > INT16_MAX) return INT16_MAX;
  return q;
}

/** Restore a world coordinate/velocity component from int16 centi-units. */
export function decodeCenti(q: number): number {
  return q / 100;
}

/**
 * Quantize a NORMALIZED 0..1 scalar (throttle, lock progress) to uint8.
 * 1/255 ≈ 0.4% precision — finer than any HUD readout or engine-trail curve
 * reads, and a whole byte cheaper per field than the float32 the sim carries.
 * Out-of-range inputs clamp (a normalized value should never leave 0..1).
 */
export function encodeUnit(value: number): number {
  if (!(value > 0)) return 0; // also catches NaN
  if (value >= 1) return 255;
  return Math.round(value * 255);
}

/** Restore a normalized 0..1 scalar from uint8. */
export function decodeUnit(q: number): number {
  return q / 255;
}

const TWO_PI = Math.PI * 2;

/** Quantize a heading (radians) to uint16 (0..65535 == 0..2π). */
export function encodeHeading(radians: number): number {
  let h = radians % TWO_PI;
  if (h < 0) h += TWO_PI;
  return Math.round((h / TWO_PI) * 65536) & 0xffff;
}

/** Restore a heading (radians, 0..2π) from uint16. */
export function decodeHeading(q: number): number {
  return (q / 65536) * TWO_PI;
}

/**
 * Pitch (BUBBLE.md §A) gets its own SIGNED codec rather than riding the heading
 * one, because the two angles have opposite semantics. Heading wraps: its codec
 * folds the value into 0..2π and `decodeHeading` never returns a negative
 * number. Pitch does NOT wrap — it is clamped to ±`tuning.maxPitchRad` so world
 * -up can never flip — and a nose-down −0.5 rad coming back as +5.78 rad would
 * be a different, legal-looking attitude: outside the sim's clamp, wrong for
 * `EntityView`'s mesh orientation and the chase camera's beta, and catastrophic
 * for the client's LINEAR pitch interpolation, which would sweep the long way
 * round between two samples straddling zero.
 *
 * So: int16 mapping ±π onto ±32767 (INT16_MIN is left unused to keep the
 * mapping symmetric — encode(−x) === −encode(x) exactly). That is ~9.6e-5 rad
 * (0.0055°) of precision, finer than the heading codec, over a domain twice as
 * large as any legal clamp. Values outside ±π clamp and NaN encodes level, as
 * with the other codecs here; neither should ever occur.
 */
const PITCH_SCALE = INT16_MAX / Math.PI;

/** Quantize a clamped, signed pitch (radians, ±π) to int16. */
export function encodePitch(radians: number): number {
  if (Number.isNaN(radians)) return 0; // level, not a wrapped garbage attitude
  const q = Math.round(radians * PITCH_SCALE);
  if (q < -INT16_MAX) return -INT16_MAX;
  if (q > INT16_MAX) return INT16_MAX;
  return q;
}

/** Restore a signed pitch (radians, ±π) from int16. */
export function decodePitch(q: number): number {
  return q / PITCH_SCALE;
}
