// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import type { ConfigService, Snapshot } from "@space-arena/shared";
import { LobbyWaitingOverlay } from "./LobbyWaitingOverlay.js";

afterEach(() => document.body.replaceChildren());

describe("LobbyWaitingOverlay", () => {
  it("shows replicated lobby seconds and hides for the sim countdown", () => {
    const configs = {
      get: () => ({ menu: { matchmaking: { flavorLines: ["Scanning sectors..."] } } }),
    } as unknown as ConfigService;
    const overlay = new LobbyWaitingOverlay(document.body, configs);
    overlay.update({ phase: "waiting", lobbyRemainingSec: 8.1 } as Snapshot);
    expect(document.querySelector(".hud-lobby-waiting-title")?.textContent).toBe("Looking for players… 9s");
    expect(document.querySelector(".hud-lobby-waiting")?.classList.contains("visible")).toBe(true);

    overlay.update({ phase: "countdown", countdownRemaining: 3 } as Snapshot);
    expect(document.querySelector(".hud-lobby-waiting")?.classList.contains("visible")).toBe(false);
    overlay.dispose();
  });
});
