// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import type { AuthService } from "../core/AuthService.js";
import { MatchmakingClient } from "./MatchmakingClient.js";

describe("MatchmakingClient polling", () => {
  it("wakes a pending poll immediately when the tab returns to the foreground", async () => {
    vi.useFakeTimers();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    const client = new MatchmakingClient({} as AuthService, document);
    let resolved = false;
    const waiting = client.waitForPoll(2000).then(() => {
      resolved = true;
    });

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    await waiting;

    expect(resolved).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
});
