// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConfigService } from "@space-arena/shared";
import type { AudioManager } from "../../audio/AudioManager.js";
import { UserSettingsStore } from "../../core/userSettings.js";
import { SettingsScreen } from "./SettingsScreen.js";

/**
 * The in-match variant is a PAUSE menu (match finding 4). Its two exits used to
 * be appended after all seven setting groups — roughly 1900 px down a column in
 * a 412 px viewport — so opening it mid-match showed DISPLAY / GRAPHICS and
 * nothing you could act on, behind a scroll nothing advertised.
 */

function host(): { configs: ConfigService; audio: AudioManager; settings: UserSettingsStore } {
  return {
    configs: { get: () => undefined, getAll: () => [] } as unknown as ConfigService,
    audio: {
      setMasterVolume: vi.fn(),
      setSfxVolume: vi.fn(),
      setMusicVolume: vi.fn(),
    } as unknown as AudioManager,
    // No storage: the defaults are the point, persistence is not.
    settings: new UserSettingsStore(null),
  };
}

afterEach(() => {
  document.body.replaceChildren();
  document.head.replaceChildren();
});

describe("SettingsScreen exits", () => {
  it("leads the in-match sheet with Resume and Quit, not trails it", () => {
    const screen = new SettingsScreen(document.body, host());
    screen.show({ context: "match", onClose: vi.fn(), onQuitToMenu: vi.fn() });

    // Nothing that scrolls comes before them: the row IS the first child.
    const first = document.querySelector<HTMLElement>(".sa-settings-groups > *")!;
    expect(first.dataset["settingsActions"]).toBe("");
    expect([...first.querySelectorAll("button")].map((b) => b.textContent)).toEqual([
      "Resume match",
      "Quit to main menu",
    ]);
    screen.dispose();
  });

  it("keeps BACK at the foot of the menu sheet, which is a settings list", () => {
    const screen = new SettingsScreen(document.body, host());
    screen.show({ context: "menu", onClose: vi.fn() });

    const children = [...document.querySelectorAll<HTMLElement>(".sa-settings-groups > *")];
    expect(document.querySelector(".sa-settings-actions")).toBeNull();
    expect(children.at(-1)!.dataset["settingsClose"]).toBe("");
    expect(children.at(-1)!.textContent).toBe("Back");
    screen.dispose();
  });

  it("still resumes and still quits from the pinned row", () => {
    const onClose = vi.fn();
    const onQuitToMenu = vi.fn();
    const screen = new SettingsScreen(document.body, host());

    screen.show({ context: "match", onClose, onQuitToMenu });
    document.querySelector<HTMLButtonElement>("[data-settings-close]")!.click();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.isOpen).toBe(false);

    screen.show({ context: "match", onClose, onQuitToMenu });
    document.querySelector<HTMLButtonElement>("[data-settings-quit]")!.click();
    expect(onQuitToMenu).toHaveBeenCalledTimes(1);
    // Quitting is not closing: the match teardown owns that cleanup.
    expect(onClose).toHaveBeenCalledTimes(1);
    screen.dispose();
  });
});
