import { describe, expect, it } from "vitest";
import { authorAsteroidPosition } from "./MapEditor.js";

describe("MapEditor asteroid placement", () => {
  it("authors the selected y altitude while snapping only the picked plane axes", () => {
    expect(authorAsteroidPosition({ x: 12.6, z: -7.4 }, 125, true, 1)).toEqual({
      x: 13,
      y: 125,
      z: -7,
    });
  });
});
