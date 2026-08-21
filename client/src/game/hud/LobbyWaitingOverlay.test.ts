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

  /**
   * `flavorRotationMs` was authored (the shipped theme says 4000) but read by
   * nothing: the line was keyed straight off the countdown second, so the copy
   * flickered once a second no matter what a designer set.
   */
  it("holds each flavor line for the authored rotation, not one per second", () => {
    const lines = ["one", "two", "three"];
    const configs = {
      get: () => ({ menu: { matchmaking: { flavorLines: lines, flavorRotationMs: 4000 } } }),
    } as unknown as ConfigService;
    const overlay = new LobbyWaitingOverlay(document.body, configs);
    const flavorAt = (sec: number): string | null | undefined => {
      overlay.update({ phase: "waiting", lobbyRemainingSec: sec } as Snapshot);
      return document.querySelector(".hud-lobby-waiting-flavor")?.textContent;
    };

    // Seconds 1..3 all fall in the first 4000ms bucket; 4 starts the next.
    expect([flavorAt(1), flavorAt(2), flavorAt(3)]).toEqual(["one", "one", "one"]);
    expect([flavorAt(4), flavorAt(7)]).toEqual(["two", "two"]);
    expect(flavorAt(8)).toBe("three");
    overlay.dispose();
  });

  it("keeps the old one-line-per-second rhythm when the pack authors no rotation", () => {
    const configs = {
      get: () => ({ menu: { matchmaking: { flavorLines: ["a", "b"] } } }),
    } as unknown as ConfigService;
    const overlay = new LobbyWaitingOverlay(document.body, configs);
    const flavorAt = (sec: number): string | null | undefined => {
      overlay.update({ phase: "waiting", lobbyRemainingSec: sec } as Snapshot);
      return document.querySelector(".hud-lobby-waiting-flavor")?.textContent;
    };

    expect([flavorAt(1), flavorAt(2), flavorAt(3)]).toEqual(["b", "a", "b"]);
    overlay.dispose();
  });
});
