import { describe, expect, it, vi } from "vitest";
import type { ConfigService, ThemeConfig } from "@space-arena/shared";
import { BlockedPullFeedback } from "./BlockedPullFeedback.js";

const BLOCKED_NOTIFICATION_ID = "notification.fire-blocked";

describe("BlockedPullFeedback", () => {
  it("haptics/audio every pull but shows the authored notification only once per match", () => {
    const theme = {
      audio: { cues: { fireBlocked: "[SOUND: fire_blocked]" } },
    } as ThemeConfig;
    const configs = { get: () => theme } as unknown as ConfigService;
    const notifications = { showConfig: vi.fn() };
    const haptics = { fireBlocked: vi.fn() };
    const playSound = vi.fn();
    const feedback = new BlockedPullFeedback(configs, notifications, haptics, playSound);

    feedback.trigger(BLOCKED_NOTIFICATION_ID);
    feedback.trigger(BLOCKED_NOTIFICATION_ID);
    expect(haptics.fireBlocked).toHaveBeenCalledTimes(2);
    expect(playSound).toHaveBeenCalledTimes(2);
    expect(playSound).toHaveBeenCalledWith("fire_blocked");
    expect(notifications.showConfig).toHaveBeenCalledOnce();
    expect(notifications.showConfig).toHaveBeenCalledWith(
      configs,
      BLOCKED_NOTIFICATION_ID,
    );
  });

  it("is silent when the optional audio cue is absent", () => {
    const configs = { get: () => ({}) } as unknown as ConfigService;
    const playSound = vi.fn();
    new BlockedPullFeedback(
      configs,
      { showConfig: vi.fn() },
      { fireBlocked: vi.fn() },
      playSound,
    ).trigger();
    expect(playSound).not.toHaveBeenCalled();
  });

  it("omits the toast when the theme has no blocked notification id", () => {
    const notifications = { showConfig: vi.fn() };
    const feedback = new BlockedPullFeedback(
      { get: () => ({}) } as unknown as ConfigService,
      notifications,
      { fireBlocked: vi.fn() },
      null,
    );
    feedback.trigger();
    expect(notifications.showConfig).not.toHaveBeenCalled();
  });
});
