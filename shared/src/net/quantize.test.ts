import { describe, expect, it } from "vitest";
import {
  INT16_MAX,
  decodeCenti,
  decodeHeading,
  decodePitch,
  decodeUnit,
  encodeCenti,
  encodeHeading,
  encodePitch,
  encodeUnit,
} from "./quantize.js";

/**
 * The 0..1 wire encoding introduced with the flight netcode (FLIGHT.md §5):
 * `throttle` and `lockProgress` are normalized in the sim snapshot and travel as
 * uint8. The contract the server (encode) and client (decode) both depend on is
 * "clamped, monotonic, and accurate to well under a percent".
 */
describe("encodeUnit / decodeUnit", () => {
  it("maps the endpoints exactly", () => {
    expect(encodeUnit(0)).toBe(0);
    expect(encodeUnit(1)).toBe(255);
    expect(decodeUnit(0)).toBe(0);
    expect(decodeUnit(255)).toBe(1);
  });

  it("round-trips any normalized value inside half a quantization step", () => {
    for (let v = 0; v <= 1.0001; v += 0.01) {
      const value = Math.min(1, v);
      expect(Math.abs(decodeUnit(encodeUnit(value)) - value)).toBeLessThanOrEqual(0.5 / 255);
    }
  });

  it("clamps out-of-range and non-finite input instead of wrapping the byte", () => {
    // A uint8 schema field silently truncates, so a value that escaped the
    // sim's own clamp must not become a *different* legal reading.
    expect(encodeUnit(1.5)).toBe(255);
    expect(encodeUnit(Number.POSITIVE_INFINITY)).toBe(255);
    expect(encodeUnit(-0.2)).toBe(0);
    expect(encodeUnit(Number.NEGATIVE_INFINITY)).toBe(0);
    expect(encodeUnit(Number.NaN)).toBe(0);
  });

  it("is monotonic across the range", () => {
    let last = -1;
    for (let v = 0; v <= 1; v += 1 / 512) {
      const q = encodeUnit(v);
      expect(q).toBeGreaterThanOrEqual(last);
      last = q;
    }
  });
});

/**
 * The bubble's vertical axis (BUBBLE.md §B) shares the centi codec with x/z, so
 * what needs proving is that the SPAN still fits: the arena is a sphere, and a
 * ship at the top of the biggest shipped one (deep-field, r300) plus whatever
 * overshoot a projectile manages before the bounds cull must stay inside the
 * ±327.67 the int16 gives, or the encode clamps and the client renders a ship
 * frozen against an invisible ceiling.
 */
describe("encodeCenti / decodeCenti on the y axis", () => {
  const SPHERE_RADIUS = 300;

  it("round-trips the full vertical extent of the largest shipped arena inside half a centi", () => {
    for (const y of [-SPHERE_RADIUS, -137.42, -0.005, 0, 0.005, 12.345, SPHERE_RADIUS]) {
      expect(Math.abs(decodeCenti(encodeCenti(y)) - y)).toBeLessThanOrEqual(0.005);
    }
  });

  it("leaves headroom above the sphere for projectile overshoot before the codec clamps", () => {
    // 27 units of margin either side of r300 — several ticks of missile flight
    // past the shell at any shipped speed, which is all the bounds cull needs.
    expect(decodeCenti(encodeCenti(SPHERE_RADIUS + 27))).toBeCloseTo(327, 5);
    expect(decodeCenti(encodeCenti(-SPHERE_RADIUS - 27))).toBeCloseTo(-327, 5);
  });

  it("clamps beyond the int16 span instead of wrapping to the opposite pole", () => {
    expect(encodeCenti(1000)).toBe(32767);
    expect(encodeCenti(-1000)).toBe(-32768);
  });
});

/**
 * Pitch does NOT use the heading codec. Heading wraps and `decodeHeading` only
 * ever returns 0..2π; pitch is a clamped SIGNED angle, so a nose-down attitude
 * has to come back negative — see the comment on `encodePitch`.
 */
describe("encodePitch / decodePitch", () => {
  /** A representative legacy-clamp attitude; the codec itself spans all of ±PI. */
  const MAX = 1.4;

  it("preserves sign, which is exactly what the heading codec cannot do", () => {
    expect(decodePitch(encodePitch(-MAX))).toBeLessThan(0);
    // The bug this codec exists to prevent: the same angle through the heading
    // pair comes back as a steep CLIMB instead of a dive.
    expect(decodeHeading(encodeHeading(-MAX))).toBeCloseTo(Math.PI * 2 - MAX, 3);
  });

  it("round-trips both clamp extremes to well under a tenth of a degree", () => {
    const tolerance = Math.PI / INT16_MAX; // one quantization step
    for (const pitch of [-MAX, MAX]) {
      expect(Math.abs(decodePitch(encodePitch(pitch)) - pitch)).toBeLessThanOrEqual(tolerance);
    }
    expect(tolerance).toBeLessThan(0.0001); // < 0.006°
  });

  it("round-trips the whole legal band monotonically", () => {
    let last = -Infinity;
    for (let pitch = -MAX; pitch <= MAX; pitch += MAX / 64) {
      const q = encodePitch(pitch);
      expect(q).toBeGreaterThan(last);
      expect(Math.abs(decodePitch(q) - pitch)).toBeLessThanOrEqual(Math.PI / INT16_MAX);
      last = q;
    }
  });

  it("maps zero and the ±π domain edges exactly and symmetrically", () => {
    expect(encodePitch(0)).toBe(0);
    expect(encodePitch(Math.PI)).toBe(INT16_MAX);
    expect(encodePitch(-Math.PI)).toBe(-INT16_MAX);
    expect(decodePitch(INT16_MAX)).toBeCloseTo(Math.PI, 12);
    // Symmetric by construction: INT16_MIN is deliberately left unused so that
    // a mirrored attitude quantizes to a mirrored code, with no off-by-one bias.
    for (const pitch of [0.3, 1.1, MAX]) expect(encodePitch(-pitch)).toBe(-encodePitch(pitch));
  });

  it("round-trips the wrap boundary EXACTLY, in both spellings", () => {
    // Free pitch (BUBBLE.md §A) makes ±PI a reachable attitude every loop, not a
    // theoretical domain edge, and it is the one value where a quantization error
    // would flip the sign of the decoded angle — a nose that arrives at -PI
    // instead of +PI reads as the same direction but takes the client's attitude
    // interpolation the long way round the circle. The mapping is exact here by
    // construction (PI * (INT16_MAX/PI) lands on the integer), so assert it as an
    // identity rather than a tolerance.
    expect(decodePitch(encodePitch(Math.PI))).toBe(Math.PI);
    expect(decodePitch(encodePitch(-Math.PI))).toBe(-Math.PI);
  });

  it("covers the whole free-pitch circle, monotonically and past vertical", () => {
    // The sim wraps pitch into (-PI, PI], so the codec's domain has to be that
    // whole interval — including the inverted band |pitch| > PI/2, which simply
    // did not exist while the clamp was mandatory.
    let last = -Infinity;
    const step = Math.PI / 64;
    for (let pitch = -Math.PI + step; pitch <= Math.PI; pitch += step) {
      const q = encodePitch(pitch);
      expect(q).toBeGreaterThan(last);
      expect(q).toBeGreaterThanOrEqual(-INT16_MAX);
      expect(q).toBeLessThanOrEqual(INT16_MAX);
      expect(Math.abs(decodePitch(q) - pitch)).toBeLessThanOrEqual(Math.PI / INT16_MAX);
      last = q;
    }
    // Inverted attitudes survive the round trip as inverted ones: the sign of
    // cos(pitch) is what flips the nose's horizontal component, so losing it
    // would replicate a looping ship as one flying the opposite way.
    for (const pitch of [2.5, -2.5, Math.PI / 2 + 0.01]) {
      expect(Math.cos(decodePitch(encodePitch(pitch)))).toBeLessThan(0);
    }
  });

  it("clamps past the domain and refuses non-finite input rather than wrapping the int16", () => {
    expect(encodePitch(4)).toBe(INT16_MAX);
    expect(encodePitch(-4)).toBe(-INT16_MAX);
    expect(encodePitch(Number.POSITIVE_INFINITY)).toBe(INT16_MAX);
    expect(encodePitch(Number.NEGATIVE_INFINITY)).toBe(-INT16_MAX);
    expect(encodePitch(Number.NaN)).toBe(0);
  });
});
