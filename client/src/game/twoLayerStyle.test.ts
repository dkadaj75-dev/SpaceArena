import { afterEach, describe, expect, it } from "vitest";
import { injectHudStyle } from "./hud/hudStyle.js";
import { injectScreenStyle } from "./screens/screenStyle.js";

afterEach(() => {
  document.head.replaceChildren();
  document.body.replaceChildren();
});

function injectedCss(id: string): string {
  const style = document.getElementById(id);
  expect(style).not.toBeNull();
  return style!.textContent ?? "";
}

describe("two-layer chamfer stacking", () => {
  it("isolates every menu plate host and puts fill plates behind bare text", () => {
    injectScreenStyle();
    const css = injectedCss("sa-screen-style");

    for (const host of [
      ".sa-screen-btn",
      // Every menu button — mode card, category, destination, Back — wears
      // `.sa-menu-btn`; the kind class only says what the button does.
      ".sa-menu-btn",
      ".sa-settings-group",
    ]) {
      const escaped = host.replace(".", "\\.");
      expect(css).toMatch(new RegExp(`${escaped}[\\s\\S]*isolation:\\s*isolate`));
      expect(css).toMatch(new RegExp(`${escaped}::before[\\s\\S]*z-index:\\s*-1`));
    }
  });

  it("uses the same isolated negative-plate contract for every HUD frame", () => {
    injectHudStyle();
    const css = injectedCss("hud-style");

    for (const host of [
      ".hud-frame",
      ".hud-module-btn",
      ".hud-throttle-track",
      ".hud-results-panel",
    ]) {
      const escaped = host.replace(".", "\\.");
      expect(css).toMatch(new RegExp(`${escaped}[\\s\\S]*isolation:\\s*isolate`));
      expect(css).toMatch(new RegExp(`${escaped}::before[\\s\\S]*z-index:\\s*-1`));
      expect(css).toMatch(new RegExp(`${escaped}::after[\\s\\S]*z-index:\\s*-1`));
    }
  });
});
