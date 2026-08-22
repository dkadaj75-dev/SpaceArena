import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_DESIGN_TOKENS, designTokenCssVars } from "./themeTokens.js";
import { injectHudStyle } from "./hud/hudStyle.js";
import { injectScreenStyle } from "./screens/screenStyle.js";
import { injectShopStyle } from "./screens/shopStyle.js";

afterEach(() => document.head.replaceChildren());

describe("arena design-system token surface", () => {
  it("maps the complete board palette, type scale, lines, and radii", () => {
    const vars = designTokenCssVars(undefined);
    expect(vars).toMatchObject({
      "--sa-blue-500": "#3B82F6", "--sa-red-500": "#EF4444",
      // The one HELPFUL colour (2026-08-22) — the repair field's family colour
      // and the hue its heal numbers float in.
      "--sa-green-500": "#34D399", "--sa-white": "#E6F0FF",
      "--sa-n-900": "#05080D", "--sa-n-800": "#0B1118", "--sa-n-700": "#151E2A",
      "--sa-n-600": "#1E2937", "--sa-n-500": "#334155", "--sa-n-400": "#475569",
      "--sa-line-hairline": "1px", "--sa-line-thin": "2px", "--sa-line-medium": "3px", "--sa-line-strong": "4px",
      "--sa-radius-small": "4px", "--sa-radius-medium": "8px", "--sa-radius-large": "16px",
    });
    expect(Object.keys(vars)).toHaveLength(23);
    expect(DEFAULT_DESIGN_TOKENS.h1).toContain("700 32px/40px 'Orbitron'");
    expect(DEFAULT_DESIGN_TOKENS.data).toContain("400 14px/20px 'Orbitron'");
  });
});

/*
 * ============================================================================
 * Why the primitive contract runs BACKWARDS
 * ============================================================================
 *
 * This block used to read `expect(css).toContain(".sa-check")` over a
 * hand-written list of selectors. That direction cannot fail for the reason you
 * want it to: it only certifies that a RULE EXISTS. A rule that no component
 * ever applies satisfies it forever, so the list quietly became a preservation
 * order for dead CSS — 15 of the 25 selectors it pinned were applied nowhere in
 * client/src, and deleting them broke the test that was supposed to protect the
 * design system.
 *
 * So the contract is inverted. The selectors are read OUT of the stylesheets we
 * actually inject, and each one must be applied by some source file under
 * client/src. Shipping a rule for a component that does not exist now FAILS.
 *
 * Scanning rules, and why each is what it is:
 *
 *  - Scope is the namespaced tokens only (`hud-` / `sa-` / `shop-` / `state-`).
 *    Roughly 80 of the class tokens in these sheets are BARE compound modifiers
 *    that only ever appear as the second class in a compound selector
 *    (`.hud-toast.critical`, `.hud-vital-arc.track`, `.sa-menu-bg .layer.nebula`).
 *    A whole-word search for `active`, `value`, `label` or `ring` collides with
 *    ordinary prose and identifiers all over the codebase, so asserting on them
 *    would report green while proving nothing. They are deliberately unchecked
 *    rather than checked badly.
 *
 *  - A token counts as APPLIED only where it is written without a leading `.`,
 *    `#` or `-`. That is what separates `el.className = "hud-frame"` (an
 *    application) from `.hud-frame {` in some other file's own injected
 *    stylesheet, from `#hud`, and from `var(--hud-progress-color)`. Several
 *    components (EnemyArrows, LockReticle, SpeedReadout, TutorialOverlay) ship
 *    their own <style> blocks, and without this rule their CSS text would vouch
 *    for these sheets' selectors.
 *
 *  - Every .ts/.html under client/src is scanned, INCLUDING *Style.ts. Style
 *    files apply classes too — `createMenuBackdrop()` in screens/screenStyle.ts
 *    sets `sa-menu-bg` — so skipping them invents false deads. The leading-dot
 *    rule above already keeps their own rule text from counting.
 *
 *  - This file is the one exclusion: naming a selector here must not be what
 *    keeps it alive. That circularity is exactly the failure being repaired.
 */

const CLIENT_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "game/designSystemContract.test.ts";

/** Design-system namespaces. Bare compound modifiers are out of scope — see above. */
const NAMESPACED = /^(?:hud|sa|shop|state)-/;

const SHEETS = [
  { id: "sa-screen-style", source: "game/screens/screenStyle.ts", inject: injectScreenStyle },
  { id: "hud-style", source: "game/hud/hudStyle.ts", inject: injectHudStyle },
  { id: "sa-shop-style", source: "game/screens/shopStyle.ts", inject: injectShopStyle },
] as const;

/**
 * Tokens no source file can spell, because they are assembled from a template
 * literal at runtime. WITHOUT this list the inverted test fails on day one
 * against live CSS: the strings `hud-button--primary` and `state-deploying`
 * appear nowhere in the codebase, yet both are on real elements in a real match.
 *
 * Each entry is the composition site that produces it, so the list stays
 * auditable — this is a record of *where to look*, not a blanket exemption. It
 * is deliberately exact rather than prefix-shaped (`hud-button--*` would also
 * have re-licensed `.hud-button--danger`, which that site can never emit, and
 * which was one of the dead rules this change removed).
 *
 * Verified as literally applied and therefore NOT listed here: `sa-button--*`
 * (composed in Lobby/ShopScreen but also written out in AuthScreen, Hangar,
 * SettingsScreen, MatchLoadingScreen), `hud-scoreboard-team--ally`/`--enemy`
 * (literal classList.toggle in hud/Scoreboard.ts), `hud-enemy-arrow`
 * (hud/EnemyArrows.ts), `hud-toast` (hud/Notifications.ts) and
 * `hud-damage-number` (hud/FloatingDamageText.ts) — the last two vary only in
 * their bare modifier, which is out of scope anyway.
 */
const COMPOSED_AT_RUNTIME: ReadonlyMap<string, string> = new Map([
  // hud/ResultsOverlay.ts button(): `hud-button--${variant === "primary" ? "primary" : "secondary"}`
  // followed by `${variant ? ` hud-results-btn--${variant}` : ""}`. Callers pass "primary" or "".
  ["hud-button--primary", "game/hud/ResultsOverlay.ts button()"],
  ["hud-results-btn--primary", "game/hud/ResultsOverlay.ts button()"],
  // screens/Lobby.ts addButton(): `sa-screen-btn--${variant}` for variant?: "primary" | "accent".
  // `--primary` is also written out in FullscreenPrompt/SettingsScreen; `--accent` never is.
  ["sa-screen-btn--accent", "game/screens/Lobby.ts addButton()"],
  // hud/ModuleButtons.ts: classList.add(`state-${m.state}`) over the six-value
  // ModuleState union in shared/src/sim/components.ts. Three of the six also occur
  // literally, but only inside ModuleButtons.test.ts — a fixture is not an application.
  ["state-retracted", "game/hud/ModuleButtons.ts (ModuleState)"],
  ["state-deploying", "game/hud/ModuleButtons.ts (ModuleState)"],
  ["state-active", "game/hud/ModuleButtons.ts (ModuleState)"],
  ["state-retracting", "game/hud/ModuleButtons.ts (ModuleState)"],
  ["state-reloading", "game/hud/ModuleButtons.ts (ModuleState)"],
]);

/** The namespaced class selectors a stylesheet ships, taken from its selector text. */
function shippedClasses(css: string): Set<string> {
  const selectorText = css
    .replace(/\/\*[\s\S]*?\*\//g, " ") // comments (they cite filenames: `hudStyle.ts` reads as `.ts`)
    .replace(/\{[^{}]*\}/g, "{}"); // innermost braces are declarations; what is left is selectors
  const shipped = new Set<string>();
  for (const [, token] of selectorText.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)) {
    if (token !== undefined && NAMESPACED.test(token)) shipped.add(token);
  }
  return shipped;
}

/** Every namespaced token any client source writes as a class name (see the header note). */
async function appliedClasses(): Promise<Set<string>> {
  const applied = new Set<string>();
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
        continue;
      }
      if (!/\.(?:ts|html)$/.test(entry.name)) continue;
      if (path.relative(CLIENT_SRC, abs).split(path.sep).join("/") === SELF) continue;
      const src = await readFile(abs, "utf8");
      for (const [token] of src.matchAll(/(?<![\w.#-])(?:hud|sa|shop|state)-[\w-]*/g)) applied.add(token);
    }
  };
  await walk(CLIENT_SRC);
  return applied;
}

describe("every primitive the stylesheets ship is a primitive we apply", () => {
  let applied: Set<string>;
  beforeAll(async () => {
    applied = await appliedClasses();
  });

  for (const sheet of SHEETS) {
    it(`${sheet.id} ships no class rule that nothing applies`, () => {
      sheet.inject();
      const css = document.getElementById(sheet.id)?.textContent ?? "";
      expect(css, `${sheet.id} was not injected`).not.toBe("");

      const unused = [...shippedClasses(css)]
        .filter((token) => !applied.has(token) && !COMPOSED_AT_RUNTIME.has(token))
        .sort();
      expect(
        unused,
        `${sheet.source} styles classes that no client/src file applies. Either apply them, ` +
          `delete the rules, or — if they are assembled from a template literal — add them to ` +
          `COMPOSED_AT_RUNTIME with the composition site.`,
      ).toEqual([]);
    });
  }

  it("keeps the runtime-composition allow-list honest", () => {
    // The allow-list can rot in the other direction: an entry whose rule has
    // since been deleted silently licenses a class that no longer has styling.
    const shipped = new Set<string>();
    for (const sheet of SHEETS) {
      sheet.inject();
      for (const token of shippedClasses(document.getElementById(sheet.id)?.textContent ?? "")) shipped.add(token);
    }
    const orphaned = [...COMPOSED_AT_RUNTIME.keys()].filter((token) => !shipped.has(token));
    expect(orphaned, "allow-listed classes with no rule in any injected stylesheet").toEqual([]);
  });
});

describe("token-only primitive contracts", () => {
  it("reuses the HUD two-plate chamfer instead of drawing a second bevel", () => {
    injectHudStyle();
    const css = document.getElementById("hud-style")?.textContent ?? "";
    expect(css).toContain(".hud-frame::before");
    expect(css).toContain(".hud-frame::after");
  });

  it("paints from the token palette, never the retired hard-coded one", () => {
    for (const sheet of SHEETS) {
      sheet.inject();
      const css = document.getElementById(sheet.id)?.textContent ?? "";
      expect(css, `${sheet.source} reintroduces a pre-token hex colour`).not.toMatch(
        /#(?:39bfff|ffb35c|ff405c|57d8ff)/i,
      );
    }
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
    for (const file of ["screens/FullscreenPrompt.ts", "screens/screenStyle.ts", "hud/hudStyle.ts"]) {
      const css = await readFile(path.join(CLIENT_SRC, "game", file), "utf8");
      expect(css, `${file} appends a raw alpha suffix to var()`).not.toMatch(/var\(--[\w-]+\)[0-9a-f]{2}\b/i);
    }
  });
});
