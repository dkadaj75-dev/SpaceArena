import { describe, expect, it } from "vitest";
import type { Snapshot } from "@space-arena/shared";
import { CountdownOverlay } from "./CountdownOverlay.js";

function snapshot(phase: Snapshot["phase"], countdownRemaining: number): Snapshot {
  return {
    tick: 0,
    elapsed: 0,
    phase,
    teamScores: [],
    countdownRemaining,
    winnerTeam: null,
    ships: [],
    asteroids: [],
    projectiles: [],
    decoys: [],
  };
}

function mount(): { overlay: CountdownOverlay; el: HTMLElement; root: HTMLElement } {
  const root = document.createElement("div");
  const overlay = new CountdownOverlay(root);
  return { overlay, el: root.querySelector<HTMLElement>(".hud-countdown")!, root };
}

describe("CountdownOverlay (match start)", () => {
  it("is hidden in a live match and never blocks pointer input", () => {
    const { overlay, el } = mount();
    overlay.update(snapshot("live", 0), 16);
    expect(el.classList.contains("visible")).toBe(false);
    expect(el.textContent).toBe("");
    expect(overlay.currentText).toBeNull();
    overlay.dispose();
  });

  /**
   * Ceil, not round: 2.4 s left is still "3" on screen, so each numeral gets a
   * full second and "1" does not vanish early.
   */
  it("ceils the replicated remaining seconds so each numeral holds a full second", () => {
    const { overlay, el } = mount();
    for (const [remaining, expected] of [
      [3, "3"],
      [2.99, "3"],
      [2.01, "3"],
      [2, "2"],
      [1.5, "2"],
      [1, "1"],
      [0.01, "1"],
    ] as const) {
      overlay.update(snapshot("countdown", remaining), 16);
      expect(el.textContent).toBe(expected);
      expect(el.classList.contains("visible")).toBe(true);
      expect(el.classList.contains("go")).toBe(false);
    }
    overlay.dispose();
  });

  it("flashes GO when the clock reaches zero, then clears itself", () => {
    const { overlay, el } = mount();
    overlay.update(snapshot("countdown", 1), 16);
    expect(el.textContent).toBe("1");

    overlay.update(snapshot("live", 0), 16);
    expect(el.textContent).toBe("GO");
    expect(el.classList.contains("go")).toBe(true);

    // The flash is time-boxed, not sticky: it must not sit over the fight.
    overlay.update(snapshot("live", 0), 1000);
    expect(overlay.currentText).toBeNull();
    expect(el.classList.contains("visible")).toBe(false);
    overlay.dispose();
  });

  it("never flashes GO for a match that had no countdown at all", () => {
    // `tuning.matchCountdownSec: 0` (test/e2e fixtures) and any HUD mounted into
    // an already-live match must both start silent.
    const { overlay, el } = mount();
    for (let i = 0; i < 10; i++) overlay.update(snapshot("live", 0), 16);
    expect(overlay.currentText).toBeNull();
    expect(el.textContent).toBe("");
    overlay.dispose();
  });

  it("stays quiet once the match has ended", () => {
    const { overlay } = mount();
    overlay.update(snapshot("ended", 0), 16);
    expect(overlay.currentText).toBeNull();
    overlay.dispose();
  });

  it("re-arms for a rematch — a second countdown plays its own GO", () => {
    const { overlay, el } = mount();
    overlay.update(snapshot("countdown", 1), 16);
    overlay.update(snapshot("live", 0), 16);
    overlay.update(snapshot("live", 0), 1000);
    expect(overlay.currentText).toBeNull();

    overlay.update(snapshot("countdown", 3), 16);
    expect(el.textContent).toBe("3");
    overlay.update(snapshot("live", 0), 16);
    expect(el.textContent).toBe("GO");
    overlay.dispose();
  });

  it("writes to the DOM only when the displayed value changes", () => {
    const { overlay, el } = mount();
    let writes = 0;
    const node = el as HTMLElement & { textContent: string | null };
    const proto = Object.getOwnPropertyDescriptor(Node.prototype, "textContent")!;
    Object.defineProperty(node, "textContent", {
      configurable: true,
      get: () => proto.get!.call(node),
      set: (value: string) => {
        writes++;
        proto.set!.call(node, value);
      },
    });

    // Eight frames inside the same whole second: one write, not eight.
    for (let i = 0; i < 8; i++) overlay.update(snapshot("countdown", 2.9 - i * 0.01), 16);
    expect(writes).toBe(1);
    overlay.dispose();
  });

  it("removes its node on dispose", () => {
    const { overlay, root } = mount();
    overlay.dispose();
    expect(root.querySelector(".hud-countdown")).toBeNull();
  });
});
