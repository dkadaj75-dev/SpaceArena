import { describe, expect, it } from "vitest";
import { decodeUnit, encodeUnit } from "./quantize.js";

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
