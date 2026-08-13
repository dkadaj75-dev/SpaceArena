import { describe, expect, it } from "vitest";
import { decodeFloat32Array, decodeUint32Array, encodeFloat32Array, encodeUint32Array } from "./base64.js";

describe("collision base64 codec", () => {
  it("round-trips Float32Array bytes in little-endian order", () => {
    const values = new Float32Array([0, -0, 1.25, -99.5, Math.PI, Infinity, -Infinity, NaN]);
    const decoded = decodeFloat32Array(encodeFloat32Array(values));
    expect(new Uint8Array(decoded.buffer)).toEqual(new Uint8Array(values.buffer));
  });

  it("round-trips Uint32Array bytes", () => {
    const values = new Uint32Array([0, 1, 255, 65_535, 0x80000000, 0xffffffff]);
    expect(decodeUint32Array(encodeUint32Array(values))).toEqual(values);
  });

  it("rejects malformed input without host base64 globals", () => {
    for (const bad of ["A", "!!!!", "AA=A", "A===", "AAAA="]) {
      expect(() => decodeFloat32Array(bad)).toThrow();
    }
  });
});
