import { describe, expect, it } from "vitest";
import {
  FULL_VIEWPORT,
  framingRadius,
  isLandscape,
  stageAspect,
  stageViewport,
  STAGE_FRACTION,
} from "./hangarLayout.js";

describe("stageViewport (owner 2026-07-31 split hangar)", () => {
  it("puts the stage in the TOP half in portrait (Babylon's origin is bottom-left)", () => {
    expect(stageViewport(390, 844)).toEqual({ x: 0, y: 0.5, width: 1, height: 0.5 });
  });

  it("puts the stage in the LEFT half in landscape", () => {
    expect(stageViewport(844, 390)).toEqual({ x: 0, y: 0, width: 0.5, height: 1 });
  });

  it("treats a square viewport as portrait — the stacked layout is the safe default", () => {
    expect(isLandscape(500, 500)).toBe(false);
    expect(stageViewport(500, 500).height).toBe(0.5);
  });

  it("honours a custom split fraction and clamps a nonsense one", () => {
    expect(stageViewport(844, 390, 0.6).width).toBeCloseTo(0.6, 9);
    expect(stageViewport(390, 844, 0.6)).toEqual({ x: 0, y: 0.4, width: 1, height: 0.6 });
    expect(stageViewport(844, 390, 5).width).toBe(1);
    expect(stageViewport(844, 390, Number.NaN).width).toBe(STAGE_FRACTION);
  });

  it("gives the docked stats band the BOTTOM of the stage half, in both orientations", () => {
    // Landscape 800x400 with a 40px band: the stage keeps the left half above it.
    expect(stageViewport(800, 400, 0.5, 40)).toEqual({ x: 0, y: 0.1, width: 0.5, height: 0.9 });
    // Portrait 400x800: the stage is the TOP half, so the band eats its lower edge.
    expect(stageViewport(400, 800, 0.5, 80)).toEqual({ x: 0, y: 0.6, width: 1, height: 0.4 });
  });

  it("caps a runaway band so the hull always keeps a stage to be framed in", () => {
    // A band claiming the entire screen may still only take 60% of the half.
    const landscape = stageViewport(800, 400, 0.5, 4000);
    expect(landscape.y).toBeCloseTo(0.6, 9);
    expect(landscape.height).toBeCloseTo(0.4, 9);
    const portrait = stageViewport(400, 800, 0.5, 4000);
    expect(portrait.height).toBeCloseTo(0.5 * 0.4, 9);
  });

  it("ignores a nonsense or absent band — the pre-band split is the default", () => {
    expect(stageViewport(800, 400, 0.5, 0)).toEqual(stageViewport(800, 400));
    expect(stageViewport(800, 400, 0.5, -20)).toEqual(stageViewport(800, 400));
    expect(stageViewport(800, 400, 0.5, Number.NaN)).toEqual(stageViewport(800, 400));
  });

  it("never overlaps the panel half: stage + panel exactly tile the screen", () => {
    for (const [w, h] of [
      [390, 844],
      [844, 390],
      [1280, 800],
    ] as const) {
      const r = stageViewport(w, h);
      const along = isLandscape(w, h) ? r.width : r.height;
      expect(along).toBeCloseTo(STAGE_FRACTION, 9);
      expect(r.x + r.width).toBeLessThanOrEqual(1 + 1e-9);
      expect(r.y + r.height).toBeLessThanOrEqual(1 + 1e-9);
    }
  });
});

describe("stageAspect", () => {
  it("is the aspect of the HALF the stage occupies, not the whole screen", () => {
    // Portrait 390x844: stage is 390 x 422.
    expect(stageAspect(390, 844)).toBeCloseTo(390 / 422, 6);
    // Landscape 844x390: stage is 422 x 390.
    expect(stageAspect(844, 390)).toBeCloseTo(422 / 390, 6);
  });

  it("measures the stage the band left behind, so a tall band cannot crop the hull", () => {
    // 800x400 landscape, 40px band: the viewer is 400 x 360, not 400 x 400.
    expect(stageAspect(800, 400, 0.5, 40)).toBeCloseTo(400 / 360, 6);
    expect(stageAspect(800, 400, 0.5, 40)).toBeGreaterThan(stageAspect(800, 400));
  });
});

describe("framingRadius", () => {
  const FOV = 0.8; // radians, the rig's default ballpark

  it("fits the hull on the VERTICAL axis when the stage is wide", () => {
    // aspect ≥ 1 ⇒ height is the binding constraint ⇒ min(1, aspect) = 1.
    const r = framingRadius(3, FOV, 1.5, 1);
    expect(r).toBeCloseTo(3 / Math.tan(FOV / 2), 6);
  });

  it("pulls back further on a NARROW stage so a wide hull is not cropped", () => {
    const wide = framingRadius(3, FOV, 1.5);
    const narrow = framingRadius(3, FOV, 0.6);
    expect(narrow).toBeGreaterThan(wide);
    expect(narrow).toBeCloseTo(wide / 0.6, 6);
  });

  it("scales linearly with hull size and leaves margin air around it", () => {
    expect(framingRadius(6, FOV, 1)).toBeCloseTo(2 * framingRadius(3, FOV, 1), 9);
    expect(framingRadius(3, FOV, 1)).toBeGreaterThan(framingRadius(3, FOV, 1, 1));
  });

  it("never returns a degenerate distance for a degenerate hull or fov", () => {
    expect(framingRadius(0, FOV, 1)).toBeGreaterThan(0);
    expect(Number.isFinite(framingRadius(3, 0, 1))).toBe(true);
    expect(Number.isFinite(framingRadius(3, FOV, 0))).toBe(true);
  });
});

describe("FULL_VIEWPORT", () => {
  it("is the whole canvas — what the camera is restored to on leaving the Hangar", () => {
    expect(FULL_VIEWPORT).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });
});
