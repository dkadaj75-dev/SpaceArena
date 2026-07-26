// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConfigService, ThemeConfig } from "@space-arena/shared";
import { MatchmakingScreen } from "./MatchmakingScreen.js";

function configs(lines = ["First", "Second"]): ConfigService {
  const theme = {
    id: "theme.default",
    type: "theme",
    version: 1,
    colors: {},
    menu: { matchmaking: { flavorLines: lines, flavorRotationMs: 4000 } },
  } as ThemeConfig;
  return { get: () => theme } as unknown as ConfigService;
}

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
  document.head.replaceChildren();
});

describe("MatchmakingScreen", () => {
  it("moves searching -> found -> joining", () => {
    const screen = new MatchmakingScreen(document.body, configs(), { onCancel: vi.fn(), onBack: vi.fn() });
    screen.begin(0);
    expect(screen.state).toBe("searching");
    screen.found("Silent Quasar");
    expect(screen.state).toBe("found");
    expect(document.body.textContent).toContain("Opponent found: Silent Quasar");
    screen.joining();
    expect(screen.state).toBe("joining");
  });

  it("offers cancel while searching", () => {
    const onCancel = vi.fn();
    const screen = new MatchmakingScreen(document.body, configs(), { onCancel, onBack: vi.fn() });
    screen.begin(0);
    document.querySelector<HTMLButtonElement>('[data-matchmaking-action="cancel"]')!.click();
    expect(onCancel).toHaveBeenCalledOnce();
    expect(screen.state).toBe("hidden");
  });

  it("shows a server-lost state with a lobby exit", () => {
    const onBack = vi.fn();
    const screen = new MatchmakingScreen(document.body, configs(), { onCancel: vi.fn(), onBack });
    screen.begin(0);
    screen.serverLost();
    expect(screen.state).toBe("server-lost");
    document.querySelector<HTMLButtonElement>('[data-matchmaking-action="back"]')!.click();
    expect(onBack).toHaveBeenCalledOnce();
  });

  it("rotates content-authored flavor lines every four seconds", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const screen = new MatchmakingScreen(document.body, configs(), { onCancel: vi.fn(), onBack: vi.fn() });
    screen.begin();
    expect(document.body.textContent).toContain("First");
    vi.advanceTimersByTime(4000);
    expect(document.body.textContent).toContain("Second");
  });
});
