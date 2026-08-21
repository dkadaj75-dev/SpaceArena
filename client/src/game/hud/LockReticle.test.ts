import { describe, expect, it, vi } from "vitest";
import type { ConfigEvents, ConfigService, EventBus } from "@space-arena/shared";
import type { GameSession } from "../GameSession.js";
import { resolveFlightHudLayout } from "./flightHudLayout.js";
import { Hud } from "./Hud.js";
import { LOCKED_TEXT, LOCKING_TEXT, LockReticle } from "./LockReticle.js";

describe("LockReticle distance label", () => {
  it("renders no scene-sized ring when the HUD has no target", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const inputSurface = document.createElement("canvas");
    const canvasContext = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue({ setTransform: vi.fn() } as unknown as CanvasRenderingContext2D);
    const hud = new Hud(
      root,
      {
        get: (type: string) =>
          type === "theme"
            ? { id: "theme.default", type: "theme", version: 1, colors: {} }
            : type === "arena"
              ? { bounds: { shape: "sphere", radius: 100 } }
              : undefined,
        getAll: () => [],
      } as unknown as ConfigService,
      { on: () => () => {} } as unknown as EventBus<ConfigEvents>,
      {
        arenaId: "arena.test",
        order: vi.fn(),
        sim: { world: { gamemode: {} } },
      } as unknown as GameSession,
      1,
      { onPlayAgain: vi.fn(), onHangar: vi.fn(), onMenu: vi.fn() },
      {
        flight: {
          inputSurface,
          project: () => false,
          cameraView: (out) => {
            out.fovRad = 1.05;
            out.betaRad = Math.PI / 2;
          },
        },
      },
    );
    const zone = root.querySelector<HTMLElement>(".hud-reticle-zone")!;
    expect(zone.classList).not.toContain("visible");
    expect(getComputedStyle(zone).display).toBe("none");
    expect(root.querySelector(".hud-reticle-bracket.visible")).toBeNull();
    expect(root.querySelector(".hud-enemy-arrow.visible")).toBeNull();
    expect(root.querySelector(".hud-gauges")).toBeNull();
    expect(root.textContent).not.toContain("ENERGY");
    expect(root.textContent).not.toContain("HEAT");
    hud.dispose();
    canvasContext.mockRestore();
    root.remove();
  });

  it("reuses the label and follows the locked state on the bracket", () => {
    const root = document.createElement("div");
    const reticle = new LockReticle(
      root,
      resolveFlightHudLayout(undefined, { width: 800, height: 600 }),
    );
    reticle.update(true, 400, 300, 0.5, false, 99.5);
    const label = root.querySelector<HTMLElement>(".hud-reticle-distance")!;
    const status = root.querySelector<HTMLElement>(".hud-reticle-status")!;
    const bracket = root.querySelector(".hud-reticle-bracket")!;
    expect(label.textContent).toBe("100m");
    // Status and range are ONE line beside the bracket (owner HUD pass): the
    // separator is CSS content, so the two spans stay independently written.
    expect(status.parentElement).toBe(label.parentElement);
    expect(status.parentElement!.className).toBe("hud-reticle-readout");
    expect(status.textContent).toBe(LOCKING_TEXT);
    expect(bracket.classList.contains("locked")).toBe(false);

    reticle.update(true, 400, 300, 1, true, 100.4, "Crimson Vector");
    expect(root.querySelector(".hud-reticle-distance")).toBe(label);
    expect(label.textContent).toBe("100m");
    expect(status.textContent).toBe(LOCKED_TEXT);
    expect(bracket.classList.contains("locked")).toBe(true);
    expect(root.querySelector(".hud-reticle-target-name")?.textContent).toBe("CRIMSON VECTOR");
    reticle.update(true, 400, 300, 1, true, 100.4);
    expect(root.querySelector(".hud-reticle-target-name")?.textContent).toBe("UNKNOWN");
    reticle.dispose();
  });

  it("uses the resolved blocked text and flash duration", () => {
    const root = document.createElement("div");
    const layout = resolveFlightHudLayout(
      {
        hud: { flight: { reticle: { blockedText: "LOCK REQUIRED", blockedFlashMs: 100 } } },
      } as never,
      { width: 800, height: 600 },
    );
    const reticle = new LockReticle(
      root,
      layout,
    );
    const blocked = root.querySelector(".hud-reticle-blocked")!;
    reticle.flashNoLock();
    expect(blocked.textContent).toBe("LOCK REQUIRED");
    expect(blocked.classList.contains("visible")).toBe(true);
    reticle.updateFeedback(101);
    expect(blocked.classList.contains("visible")).toBe(false);
    reticle.dispose();
  });

  it("defaults blocked feedback to NO LOCK for 650 ms", () => {
    const root = document.createElement("div");
    const reticle = new LockReticle(
      root,
      resolveFlightHudLayout(undefined, { width: 800, height: 600 }),
    );
    const blocked = root.querySelector(".hud-reticle-blocked")!;
    reticle.flashNoLock();
    expect(blocked.textContent).toBe("NO LOCK");
    reticle.updateFeedback(649);
    expect(blocked.classList).toContain("visible");
    reticle.updateFeedback(2);
    expect(blocked.classList).not.toContain("visible");
  });

  it("can hide the full cone circle without hiding the target bracket", () => {
    const root = document.createElement("div");
    const reticle = new LockReticle(
      root,
      resolveFlightHudLayout(
        { hud: { flight: { reticle: { showZone: false } } } } as never,
        { width: 800, height: 600 },
      ),
    );
    reticle.update(true, 400, 300, 0.4, false, 20);
    expect(root.querySelector(".hud-reticle-zone")!.classList).not.toContain("visible");
    expect(root.querySelector(".hud-reticle-bracket")!.classList).toContain("visible");
    reticle.dispose();
  });
});
