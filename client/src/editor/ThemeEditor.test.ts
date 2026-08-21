import { describe, expect, it, vi } from "vitest";
import { themeSchema, type ConfigService, type ThemeConfig } from "@space-arena/shared";
import { normalizeColorKey, nextThemeId, removeColor, setColor } from "./ThemeEditor.js";
import { SchemaFormGen } from "./SchemaFormGen.js";

describe("ThemeEditor helpers", () => {
  it("picks the first free custom theme id", () => {
    expect(nextThemeId(["theme.default"])).toBe("theme.custom-1");
    expect(nextThemeId(["theme.default", "theme.custom-1", "theme.custom-2"])).toBe("theme.custom-3");
  });

  it("normalises typed color keys into CSS custom properties", () => {
    expect(normalizeColorKey("hud-glow")).toBe("--hud-glow");
    expect(normalizeColorKey("--hud-glow")).toBe("--hud-glow");
    expect(normalizeColorKey("  hud-glow  ")).toBe("--hud-glow");
    expect(normalizeColorKey("")).toBe("");
  });

  it("adds and removes colors without mutating the source record", () => {
    const base = { "--a": "#111111" };
    const added = setColor(base, "--b", "#222222");
    expect(base).toEqual({ "--a": "#111111" });
    expect(added).toEqual({ "--a": "#111111", "--b": "#222222" });
    expect(removeColor(added, "--a")).toEqual({ "--b": "#222222" });
  });
});

describe("themeSchema additions stay backwards compatible", () => {
  it("accepts a pre-5.4 theme with only the legacy hud fields", () => {
    const legacy = {
      id: "theme.legacy",
      type: "theme",
      version: 1,
      colors: { "--hud-primary": "#57d8ff" },
      hud: { scale: 1, moduleButtonRadiusPx: 34, safeAreaInsetPx: 12, moduleButtonGapPx: 14 },
    };
    expect(themeSchema.safeParse(legacy).success).toBe(true);
  });

  it("accepts the new cluster / orientation / haptics blocks", () => {
    const modern = {
      id: "theme.modern",
      type: "theme",
      version: 1,
      colors: {},
      hud: {
        thumbZoneFraction: 0.4,
        moduleCluster: { anchor: "bottom-left", layout: "arc", arcRadiusPx: 120, arcStartDeg: 0, arcSweepDeg: 90 },
        landscape: { scale: 0.85, moduleCluster: { arcRadiusPx: 90 } },
      },
      haptics: { enabled: true, killPattern: [25] },
    };
    expect(themeSchema.safeParse(modern).success).toBe(true);
  });

  it("rejects an out-of-range thumb zone or a negative vibrate step", () => {
    const bad = { id: "theme.bad", type: "theme", version: 1, colors: {}, hud: { thumbZoneFraction: 1.5 } };
    expect(themeSchema.safeParse(bad).success).toBe(false);
    const badHaptics = { id: "theme.bad2", type: "theme", version: 1, colors: {}, haptics: { killPattern: [-1] } };
    expect(themeSchema.safeParse(badHaptics).success).toBe(false);
  });
});

describe("Theme editor generated combat fields", () => {
  it("renders FIRE geometry and the blocked audio cue with no bespoke field renderer", () => {
    const value = {
      id: "theme.test",
      type: "theme",
      version: 1,
      colors: {},
      hud: {
        flight: {
          fire: { anchor: "bottom-right", radiusPx: 34, offsetXPx: 24, offsetYPx: 34, icon: "FIRE" },
        },
      },
      audio: { cues: { fireBlocked: "[SOUND: fire_blocked]" } },
    } as ThemeConfig;
    const configService = {
      getAll: vi.fn(() => []),
      replace: vi.fn(() => ({ ok: true, errors: [] })),
    } as unknown as ConfigService;
    const form = new SchemaFormGen({
      schema: themeSchema,
      value,
      configService,
      fields: {
        colors: () => document.createElement("div"),
      },
    });

    expect(form.element.querySelector('[name="hud.flight.fire.anchor"]')).not.toBeNull();
    expect(form.element.querySelector('[name="hud.flight.fire.radiusPx"]')).not.toBeNull();
    expect(form.element.querySelector('[name="audio.cues.fireBlocked"]')).not.toBeNull();
  });
});
