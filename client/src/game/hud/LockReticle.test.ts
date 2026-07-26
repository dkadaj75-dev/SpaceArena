import { describe, expect, it } from "vitest";
import { resolveFlightHudLayout } from "./flightHudLayout.js";
import { LockReticle } from "./LockReticle.js";

describe("LockReticle distance label", () => {
  it("reuses the label and follows the locked state on the bracket", () => {
    const root = document.createElement("div");
    const reticle = new LockReticle(
      root,
      resolveFlightHudLayout(undefined, { width: 800, height: 600 }),
    );
    reticle.update(true, 400, 300, 0.5, false, 99.5);
    const label = root.querySelector<HTMLElement>(".hud-reticle-distance")!;
    const bracket = root.querySelector(".hud-reticle-bracket")!;
    expect(label.textContent).toBe("100m");
    expect(bracket.classList.contains("locked")).toBe(false);

    reticle.update(true, 400, 300, 1, true, 100.4);
    expect(root.querySelector(".hud-reticle-distance")).toBe(label);
    expect(label.textContent).toBe("100m");
    expect(bracket.classList.contains("locked")).toBe(true);
    reticle.dispose();
  });
});
