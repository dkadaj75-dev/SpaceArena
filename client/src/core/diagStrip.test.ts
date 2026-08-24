import { afterEach, describe, expect, it, vi } from "vitest";
import { diagEnabled, DIAG_STORAGE_KEY, mountDiagStrip } from "./diagStrip.js";

function sources(overrides: Partial<Parameters<typeof mountDiagStrip>[0]> = {}) {
  const canvas = document.createElement("canvas");
  canvas.width = 1280;
  canvas.height = 800;
  return {
    engine: {
      getClassName: () => "Engine",
      getRenderWidth: () => 1280,
      getRenderHeight: () => 800,
      getHardwareScalingLevel: () => 1,
      getFps: () => 60,
      webGLVersion: 2,
    },
    canvas,
    requestedRenderer: "webgl",
    actualRenderer: "webgl",
    gpu: "NVIDIA GeForce RTX 4070",
    frames: () => 4812,
    scene: () => ({ meshes: 120, active: 87 }),
    guard: () => "armed",
    ...overrides,
  };
}

afterEach(() => {
  document.querySelectorAll("#sa-diag").forEach((el) => el.remove());
  localStorage.clear();
});

describe("diagEnabled", () => {
  it("is off by default, dev builds included (owner 2026-08-23: the band is clutter on a healthy screen)", () => {
    expect(diagEnabled("")).toBe(false);
  });

  it("turns on for ?diag=1 and remembers it, so a URL is enough to talk a player through it", () => {
    expect(diagEnabled("?diag=1")).toBe(true);
    expect(localStorage.getItem(DIAG_STORAGE_KEY)).toBe("1");
    expect(diagEnabled("")).toBe(true);
  });

  it("turns back off for ?diag=0 and forgets the opt-in", () => {
    expect(diagEnabled("?diag=1")).toBe(true);
    expect(diagEnabled("?diag=0")).toBe(false);
    expect(localStorage.getItem(DIAG_STORAGE_KEY)).toBe(null);
    expect(diagEnabled("")).toBe(false);
  });
});

describe("diagnostic strip", () => {
  it("puts the numbers that split the hypothesis space on one line", () => {
    const strip = mountDiagStrip(sources());
    const line = strip.line();
    expect(line).toContain("BUILD ");
    expect(line).toContain("Engine gl2 req=webgl act=webgl");
    expect(line).toContain("cvs 1280x800");
    expect(line).toContain("rt 1280x800");
    // The frame counter is the point: "still black" versus "still black AND
    // frame 0" versus "still black AT frame 4,812" are three different bugs.
    expect(line).toContain("f 4812");
    expect(line).toContain("mesh 120/87");
    expect(line).toContain("guard armed");
    strip.dispose();
  });

  it("carries the occlusion channel no pixel probe can see", () => {
    // `drawImage`/`readPixels` both read the DRAWING BUFFER, upstream of the
    // compositor, so neither can see an opaque element stacked on the canvas —
    // which is what an opaque `.hangar-stage` turned out to be.
    const cover = document.createElement("div");
    cover.className = "hangar-stage";
    const s = sources();
    vi.spyOn(s.canvas, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 800,
      height: 600,
    } as DOMRect);
    const point = vi.spyOn(document, "elementFromPoint").mockReturnValue(cover);
    const strip = mountDiagStrip(s);
    expect(strip.line()).toContain("hit=div.hangar-stage");
    point.mockReturnValue(s.canvas);
    strip.refresh();
    expect(strip.line()).toContain("hit=canvas");
    point.mockRestore();
    strip.dispose();
  });

  it("mounts inert and above everything, and cleans up after itself", () => {
    const strip = mountDiagStrip(sources());
    const el = document.getElementById("sa-diag");
    expect(el).not.toBeNull();
    // Never eat an input, never be hidden under an overlay.
    expect(el?.style.pointerEvents).toBe("none");
    expect(el?.style.zIndex).toBe("2147483647");
    strip.dispose();
    expect(document.getElementById("sa-diag")).toBeNull();
  });

  it("survives a scene that does not exist yet", () => {
    const strip = mountDiagStrip(sources({ scene: () => null, frames: () => 0 }));
    expect(strip.line()).toContain("mesh -");
    expect(strip.line()).toContain("f 0");
    strip.dispose();
  });

  it("survives storage being blocked entirely", () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const strip = mountDiagStrip(sources());
    expect(strip.line()).toContain("renderer=-");
    getItem.mockRestore();
    strip.dispose();
  });
});
