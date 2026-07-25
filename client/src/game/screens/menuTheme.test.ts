import { describe, expect, it } from "vitest";
import type { ThemeConfig } from "@space-arena/shared";
import {
  DEFAULT_MENU_THEME,
  MAX_STARS_PER_TILE,
  menuCssVars,
  menuThemeOf,
  starCountFor,
} from "./menuTheme.js";

function theme(menu: ThemeConfig["menu"], fonts?: ThemeConfig["fonts"]): ThemeConfig {
  return { id: "theme.t", type: "theme", version: 1, colors: {}, ...(fonts ? { fonts } : {}), ...(menu ? { menu } : {}) };
}

describe("menuThemeOf", () => {
  it("falls back to the pre-5.8 palette for a pack with no menu block", () => {
    expect(menuThemeOf(theme(undefined))).toEqual(DEFAULT_MENU_THEME);
    expect(menuThemeOf(undefined)).toEqual(DEFAULT_MENU_THEME);
  });

  it("takes colors from the config", () => {
    const resolved = menuThemeOf(theme({ colors: { primary: "#00ff00", accent: "#ff0000" } }));
    expect(resolved.primary).toBe("#00ff00");
    expect(resolved.accent).toBe("#ff0000");
    expect(resolved.text).toBe(DEFAULT_MENU_THEME.text);
  });

  it("ignores blank strings rather than painting the screen with empty values", () => {
    expect(menuThemeOf(theme({ colors: { primary: "   " } })).primary).toBe(DEFAULT_MENU_THEME.primary);
  });

  it("clamps backdrop numbers into their 0..1 range", () => {
    const resolved = menuThemeOf(theme({ backdrop: { starDensity: 4, vignette: -1, nebulaOpacity: 0.2 } }));
    expect(resolved.starDensity).toBe(1);
    expect(resolved.vignette).toBe(0);
    expect(resolved.nebulaOpacity).toBe(0.2);
  });

  it("honours an explicitly empty subtitle but restores the default when absent", () => {
    expect(menuThemeOf(theme({ title: { subtitle: "" } })).titleSubtitle).toBe("");
    expect(menuThemeOf(theme({ title: { text: "NEBULA WAR" } })).titleSubtitle).toBe(
      DEFAULT_MENU_THEME.titleSubtitle,
    );
    expect(menuThemeOf(theme({ title: { text: "NEBULA WAR" } })).titleText).toBe("NEBULA WAR");
  });

  it("reads the fonts block", () => {
    const resolved = menuThemeOf(theme(undefined, { display: "'Orbitron', sans-serif", body: "Inter" }));
    expect(resolved.displayFont).toBe("'Orbitron', sans-serif");
    expect(resolved.bodyFont).toBe("Inter");
  });
});

describe("menuCssVars", () => {
  it("emits every variable the stylesheet consumes", () => {
    const vars = menuCssVars(DEFAULT_MENU_THEME);
    expect(vars["--sa-menu-primary"]).toBe(DEFAULT_MENU_THEME.primary);
    expect(vars["--sa-menu-title-tracking"]).toBe("0.32em");
    expect(Object.keys(vars).every((k) => k.startsWith("--sa-menu-"))).toBe(true);
  });
});

describe("starCountFor", () => {
  it("scales the star tile with density", () => {
    expect(starCountFor(0)).toBe(0);
    expect(starCountFor(1)).toBe(MAX_STARS_PER_TILE);
    expect(starCountFor(0.5)).toBe(Math.round(MAX_STARS_PER_TILE / 2));
    expect(starCountFor(Number.NaN)).toBe(0);
  });
});
