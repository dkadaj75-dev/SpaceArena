import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_DESIGN_TOKENS, designTokenCssVars } from "./themeTokens.js";
import { injectHudStyle } from "./hud/hudStyle.js";
import { injectScreenStyle } from "./screens/screenStyle.js";

afterEach(() => document.head.replaceChildren());

describe("arena design-system token surface", () => {
  it("maps the complete board palette, type scale, lines, and radii", () => {
    const vars = designTokenCssVars(undefined);
    expect(vars).toMatchObject({
      "--sa-blue-500": "#3B82F6", "--sa-red-500": "#EF4444", "--sa-white": "#E6F0FF",
      "--sa-n-900": "#05080D", "--sa-n-800": "#0B1118", "--sa-n-700": "#151E2A",
      "--sa-n-600": "#1E2937", "--sa-n-500": "#334155", "--sa-n-400": "#475569",
      "--sa-line-hairline": "1px", "--sa-line-thin": "2px", "--sa-line-medium": "3px", "--sa-line-strong": "4px",
      "--sa-radius-small": "4px", "--sa-radius-medium": "8px", "--sa-radius-large": "16px",
    });
    expect(Object.keys(vars)).toHaveLength(22);
    expect(DEFAULT_DESIGN_TOKENS.h1).toContain("700 32px/40px 'Orbitron'");
    expect(DEFAULT_DESIGN_TOKENS.data).toContain("400 14px/20px 'Orbitron'");
  });
});

describe("token-only primitive contracts", () => {
  it("ships every screen primitive and all button states", () => {
    injectScreenStyle();
    const css = document.getElementById("sa-screen-style")?.textContent ?? "";
    for (const selector of [
      ".sa-button--primary", ".sa-button--danger", ".sa-button--secondary",
      '[data-state="hover"]', '[data-state="pressed"]', '[data-state="disabled"]',
      ".sa-icon-button", ".sa-toggle-group", ".sa-tab-group", ".sa-check", ".sa-radio",
      ".sa-slider--danger", ".sa-panel--top-accent", ".sa-panel--corner-brackets",
      ".sa-panel--holographic", ".sa-stat__value", ".sa-progress__bar", ".sa-circular-progress",
    ]) expect(css).toContain(selector);
    expect(css).not.toMatch(/#(?:39bfff|ffb35c|ff405c|57d8ff)/i);
  });

  it("reuses the HUD two-plate chamfer and token-driven chrome primitives", () => {
    injectHudStyle();
    const css = document.getElementById("hud-style")?.textContent ?? "";
    expect(css).toContain(".hud-frame::before");
    expect(css).toContain(".hud-frame::after");
    for (const selector of [".hud-button--primary", ".hud-button--danger", ".hud-icon-button", ".hud-panel--solid", ".hud-panel--top-accent", ".hud-panel--corner-brackets", ".hud-panel--holographic", ".hud-stat__value", ".hud-progress__bar", ".hud-circular-progress"]) expect(css).toContain(selector);
    expect(css).not.toMatch(/#(?:39bfff|ffb35c|ff405c|57d8ff)/i);
  });
});

describe("design tokens are document-scoped", () => {
  // The regression this pins: tokens were published onto component roots, so
  // any screen attaching elsewhere (the launch fullscreen prompt) resolved
  // var(--sa-*) to nothing. An unresolved var invalidates the WHOLE
  // declaration, which dropped its text to inherited near-black — a popup you
  // could not read. Tokens belong on :root, once.
  it("publishes every token on the document element", async () => {
    const { designTokenCssVars } = await import("./themeTokens.js");
    for (const [prop, value] of Object.entries(designTokenCssVars(undefined))) {
      document.documentElement.style.setProperty(prop, value);
    }
    const root = getComputedStyle(document.documentElement);
    expect(root.getPropertyValue("--sa-white").trim()).not.toBe("");
    expect(root.getPropertyValue("--sa-blue-500").trim()).not.toBe("");
    expect(root.getPropertyValue("--sa-n-800").trim()).not.toBe("");
  });

  it("never appends a raw alpha suffix to a token reference", async () => {
    // `var(--sa-n-800)ee` is not a colour; it silently voids the declaration.
    const { readFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const dir = path.dirname(fileURLToPath(import.meta.url));
    for (const file of ["screens/FullscreenPrompt.ts", "screens/screenStyle.ts", "hud/hudStyle.ts"]) {
      const css = await readFile(path.join(dir, file), "utf8");
      expect(css, `${file} appends a raw alpha suffix to var()`).not.toMatch(/var\(--[\w-]+\)[0-9a-f]{2}\b/i);
    }
  });
});
