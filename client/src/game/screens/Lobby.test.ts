// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConfigService, GamemodeConfig } from "@space-arena/shared";
import type { AuthService, AuthState } from "../../core/AuthService.js";
import { ServerHealthState } from "../../core/serverHealth.js";
import { Lobby, OFFLINE_HEALTH_REFRESH_MS } from "./Lobby.js";

const authed = {
  status: "authed",
  profile: { displayName: "Pilot", level: 1, credits: 0, isGuest: false },
} as AuthState;

function configs(): ConfigService {
  const duel = {
    id: "gamemode.duel-1v1",
    type: "gamemode",
    version: 1,
    name: "Duel",
  } as GamemodeConfig;
  return {
    get: () => undefined,
    getAll: (type: string) => (type === "gamemode" ? [duel] : []),
  } as unknown as ConfigService;
}

function auth(): AuthService {
  return {
    getState: () => authed,
    onChange: () => () => undefined,
  } as unknown as AuthService;
}

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
  document.head.replaceChildren();
});

describe("Lobby server health", () => {
  it("refreshes while visible and offline, then clears the badge and enables online play", async () => {
    vi.useFakeTimers();
    const probe = vi
      .fn()
      .mockResolvedValueOnce({ online: false, detail: "not ready" })
      .mockResolvedValueOnce({ online: true, detail: "" });
    const health = new ServerHealthState(probe);
    health.set({ online: false, detail: "boot probe failed" });
    const lobby = new Lobby(
      document.body,
      configs(),
      auth(),
      health,
      {
        onChoose: vi.fn(),
        onLogout: vi.fn(),
        onAccountRequested: vi.fn(),
        onHangarRequested: vi.fn(),
        onSettingsRequested: vi.fn(),
      },
    );
    lobby.hide();
    lobby.show();
    await vi.advanceTimersByTimeAsync(0);

    const badge = document.querySelector<HTMLElement>("[data-server-offline]")!;
    const duel = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent === "Duel",
    )!;
    expect(badge.classList.contains("visible")).toBe(true);
    expect(duel.disabled).toBe(true);

    await vi.advanceTimersByTimeAsync(OFFLINE_HEALTH_REFRESH_MS);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(badge.classList.contains("visible")).toBe(false);
    expect(duel.disabled).toBe(false);
  });
});
