import { describe, expect, it } from "vitest";
import { drawPaintPattern, type PatternContext } from "./paintPattern.js";

interface Op { kind: string; style: string; alpha: number }

/**
 * A recording 2D context. The point of these tests is not what the stripes look
 * like — it is that a pattern is DETERMINISTIC and paints with both of its
 * colours, because two clients wearing the same skin must agree pixel-for-pixel.
 */
function recorder(): { ctx: PatternContext; ops: Op[] } {
  const ops: Op[] = [];
  const ctx: PatternContext = {
    fillStyle: "",
    globalAlpha: 1,
    fillRect: () => ops.push({ kind: "rect", style: ctx.fillStyle, alpha: ctx.globalAlpha }),
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    quadraticCurveTo: () => {},
    closePath: () => {},
    fill: () => ops.push({ kind: "fill", style: ctx.fillStyle, alpha: ctx.globalAlpha }),
    ellipse: () => {},
  };
  return { ctx, ops };
}

function run(pattern: "zebra" | "tiger" | "rust"): Op[] {
  const { ctx, ops } = recorder();
  drawPaintPattern(ctx, 512, pattern, "#f2f2f0", "#16171b");
  return ops;
}

describe("procedural paint patterns", () => {
  it("lays the base colour down first, then marks in the second colour", () => {
    for (const pattern of ["zebra", "tiger", "rust"] as const) {
      const ops = run(pattern);
      expect(ops[0]).toMatchObject({ kind: "rect", style: "#f2f2f0", alpha: 1 });
      expect(ops.some((op) => op.style === "#16171b")).toBe(true);
    }
  });

  it("draws the same picture every time — a skin cannot drift between clients", () => {
    for (const pattern of ["zebra", "tiger", "rust"] as const) {
      expect(run(pattern)).toEqual(run(pattern));
    }
  });

  it("gives each pattern its own look", () => {
    const [zebra, tiger, rust] = [run("zebra"), run("tiger"), run("rust")];
    expect(zebra).not.toEqual(tiger);
    expect(tiger).not.toEqual(rust);
  });

  it("tiles: zebra and tiger draw every mark three times, one tile either side", () => {
    // A band that runs off the right edge has to reappear on the left or the
    // wrapped hull shows a seam where the stripes stop.
    for (const pattern of ["zebra", "tiger"] as const) {
      const fills = run(pattern).filter((op) => op.kind === "fill").length;
      expect(fills % 3).toBe(0);
    }
  });

  it("lets the plate show through the rust rather than coating it", () => {
    const ops = run("rust");
    expect(ops.some((op) => op.alpha < 1)).toBe(true);
    // Bare metal is painted back over the corrosion in the BASE colour.
    expect(ops.filter((op) => op.style === "#f2f2f0").length).toBeGreaterThan(1);
  });

  it("leaves the context's alpha where it found it", () => {
    const { ctx } = recorder();
    drawPaintPattern(ctx, 64, "rust", "#9a6b4a", "#7a3512");
    expect(ctx.globalAlpha).toBe(1);
  });
});
