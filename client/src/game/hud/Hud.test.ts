import { describe, expect, it, vi } from "vitest";
import type { ConfigEvents, ConfigService, EventBus } from "@space-arena/shared";
import type { GameSession } from "../GameSession.js";
import { Hud } from "./Hud.js";

describe("Hud shared root lifecycle", () => {
  it("clears a previous match presentation when mounting and disposing", () => {
    const root = document.createElement("div");
    root.dataset["presentation"] = "outcome";
    document.body.appendChild(root);
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
    );

    expect(root.hasAttribute("data-presentation")).toBe(false);

    root.dataset["presentation"] = "scoreboard";
    hud.dispose();

    expect(root.hasAttribute("data-presentation")).toBe(false);
    expect(root.hasAttribute("data-orientation")).toBe(false);
    canvasContext.mockRestore();
    root.remove();
  });
});
