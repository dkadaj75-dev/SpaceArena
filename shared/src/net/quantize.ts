/**
 * Wire quantization helpers shared by the server (encode) and client (decode).
 *
 * Positions/velocities travel as int16 **centi-units**: the float value is
 * multiplied by 100, rounded, and clamped to the signed-16-bit range. This gives
 * 0.01-world-unit precision over a ±327.67-unit span — comfortably larger than
 * any MVP arena (ring-nebula radius 90, spawns at ~78). Values outside the range
 * are clamped (they should never occur for in-bounds entities).
 *
 * Headings travel as uint16 mapping the full 0..2π turn onto 0..65535, i.e.
 * ~0.0096° precision, wrap-around handled by the modulo.
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
