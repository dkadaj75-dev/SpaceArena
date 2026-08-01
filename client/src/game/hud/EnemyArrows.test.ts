import { describe, expect, it } from "vitest";
import { EnemyArrows } from "./EnemyArrows.js";
import { resolveFlightHudLayout } from "./flightHudLayout.js";
import { LockReticle } from "./LockReticle.js";

const LAYOUT = resolveFlightHudLayout(undefined, { width: 800, height: 600 });

describe("EnemyArrows distance labels", () => {
  it("reserves a distinct friendly pennant for an off-screen CTF flag", () => {
    const root = document.createElement("div");
    const arrows = new EnemyArrows(root, LAYOUT);

    arrows.begin();
    expect(arrows.placeFlag({ x: -200, y: 300, behind: false }, 141.6, true)).toBe(true);
    arrows.finish();

    const flag = root.querySelector<HTMLElement>(".hud-enemy-arrow.flag.visible")!;
    expect(flag).not.toBeNull();
    expect(flag.classList).toContain("friendly");
    expect(flag.classList).not.toContain("on-screen-marker");
    expect(flag.querySelector(".hud-enemy-arrow-glyph")).not.toBeNull();
    arrows.dispose();
  });

  it("reuses one label node and only changes its text when rounded metres change", () => {
    const root = document.createElement("div");
    const arrows = new EnemyArrows(root, LAYOUT);
    const point = { x: -200, y: 300, behind: false };

    arrows.begin();
    expect(arrows.place(point, 141.6, false)).toBe(true);
    arrows.finish();
    const label = root.querySelector<HTMLElement>(".hud-enemy-arrow-distance")!;
    expect(label.textContent).toBe("142m");

    arrows.begin();
    arrows.place(point, 142.4, true);
    arrows.finish();
    expect(root.querySelector(".hud-enemy-arrow-distance")).toBe(label);
    expect(label.textContent).toBe("142m");

    arrows.begin();
    arrows.place(point, 142.6, true);
    arrows.finish();
    expect(root.querySelector(".hud-enemy-arrow-distance")).toBe(label);
    expect(label.textContent).toBe("143m");
    expect(root.querySelectorAll(".hud-enemy-arrow:not(.flag) .hud-enemy-arrow-distance")).toHaveLength(
      LAYOUT.enemyArrows.maxCount,
    );
    arrows.dispose();
  });

  it("marks an in-view non-candidate as smaller and fainter, then hands off to the full reticle", () => {
    const root = document.createElement("div");
    const arrows = new EnemyArrows(root, LAYOUT);
    const reticle = new LockReticle(root, LAYOUT);
    const point = { x: 400, y: 300, behind: false };

    arrows.begin();
    expect(arrows.place(point, 180, false)).toBe(true);
    arrows.finish();
    const marker = root.querySelector<HTMLElement>(".hud-enemy-arrow.visible")!;
    expect(marker.classList).toContain("on-screen-marker");
    expect(marker.classList).toContain("out-of-range");
    expect(marker.style.transform).toContain(`scale(${LAYOUT.enemyArrows.outOfRangeScale})`);
    expect(marker.style.opacity).toBe(String(LAYOUT.enemyArrows.outOfRangeOpacity));

    // Crossing the lock-relevance threshold makes LockReticle own today's full
    // bracket; the dim pooled marker disappears instead of doubling it.
    arrows.begin();
    expect(arrows.place(point, 179, true)).toBe(false);
    arrows.finish();
    reticle.update(true, point.x, point.y, 0.4, false, 179);
    expect(root.querySelector(".hud-enemy-arrow.visible")).toBeNull();
    expect(root.querySelector(".hud-reticle-bracket.visible")).not.toBeNull();

    reticle.dispose();
    arrows.dispose();
  });

  it("keeps an in-view enemy at three times lock range at or above the marker floor", () => {
    const root = document.createElement("div");
    const arrows = new EnemyArrows(root, LAYOUT);
    const lockRange = 78;

    arrows.begin();
    expect(arrows.place({ x: 400, y: 300, behind: false }, lockRange * 3, false)).toBe(true);
    arrows.finish();

    const marker = root.querySelector<HTMLElement>(".hud-enemy-arrow.visible.on-screen-marker");
    expect(marker).not.toBeNull();
    expect(Number(marker!.style.opacity)).toBeGreaterThanOrEqual(LAYOUT.enemyArrows.markerMinOpacity);
    const diamond = marker!.querySelector<HTMLElement>(".hud-enemy-marker-glyph")!;
    expect(diamond.style.width).toBe(`${LAYOUT.enemyArrows.markerSizePx}px`);
    arrows.dispose();
  });

  it("does not leak pooled labels across match disposal/remount", () => {
    const root = document.createElement("div");
    const first = new EnemyArrows(root, LAYOUT);
    expect(root.querySelectorAll(".hud-enemy-arrow:not(.flag) .hud-enemy-arrow-distance")).toHaveLength(
      LAYOUT.enemyArrows.maxCount,
    );
    first.dispose();
    expect(root.querySelectorAll(".hud-enemy-arrow-distance")).toHaveLength(0);

    const second = new EnemyArrows(root, LAYOUT);
    const labels = root.querySelectorAll(".hud-enemy-arrow:not(.flag) .hud-enemy-arrow-distance");
    expect(labels).toHaveLength(LAYOUT.enemyArrows.maxCount);
    second.begin();
    second.place({ x: 400, y: 300, behind: false }, 200, false);
    second.finish();
    expect(root.querySelectorAll(".hud-enemy-arrow:not(.flag) .hud-enemy-arrow-distance")).toHaveLength(labels.length);
    second.dispose();
  });
});
