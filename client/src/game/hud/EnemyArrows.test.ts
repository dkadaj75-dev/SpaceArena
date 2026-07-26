import { describe, expect, it } from "vitest";
import { EnemyArrows } from "./EnemyArrows.js";
import { resolveFlightHudLayout } from "./flightHudLayout.js";

const LAYOUT = resolveFlightHudLayout(undefined, { width: 800, height: 600 });

describe("EnemyArrows distance labels", () => {
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
    expect(root.querySelectorAll(".hud-enemy-arrow-distance")).toHaveLength(
      LAYOUT.enemyArrows.maxCount,
    );
    arrows.dispose();
  });
});
