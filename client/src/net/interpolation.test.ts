import { describe, expect, it } from "vitest";
import { bracket, decayCorrection, lerpHeading } from "./interpolation.js";
import { decodeCenti, decodeHeading, encodeCenti, encodeHeading } from "@space-arena/shared";

describe("net interpolation", () => {
  it("brackets snapshots and caps extrapolation to one interval", () => { const r = bracket([{ time: 0 }, { time: 50 }], 200)!; expect(r[2]).toBe(1); expect(bracket([{ time: 0 }, { time: 50 }], 25)![2]).toBe(.5); });
  it("takes the short heading arc", () => expect(Math.abs(lerpHeading(6.2, .1, .5) - Math.PI * 2)).toBeLessThan(.2));
  it("decays small corrections and snaps large ones", () => { expect(decayCorrection(1, 1, 10)).toBeLessThan(.001); expect(decayCorrection(4, .1, 10)).toBe(0); });
  it("round trips wire quantization", () => { expect(decodeCenti(encodeCenti(12.345))).toBeCloseTo(12.35); expect(decodeHeading(encodeHeading(-.4))).toBeCloseTo(Math.PI * 2 - .4, 3); });
});
