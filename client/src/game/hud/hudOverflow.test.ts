import { afterEach, describe, expect, it } from "vitest";
import { injectHudStyle } from "./hudStyle.js";

/**
 * Guards the centre-screen / top-centre overlays against running off a narrow
 * portrait viewport. These are CSS-content assertions in the style of
 * twoLayerStyle.test.ts: the rules are unreachable from jsdom layout (no real
 * layout engine, no `env()`), so what is pinned here is the *discipline* —
 * every full-bleed text overlay caps itself against the HUD safe-area insets
 * and never relies on the viewport being wide.
 */

afterEach(() => {
  document.head.replaceChildren();
});

function hudCss(): string {
  injectHudStyle();
  const style = document.getElementById("hud-style");
  expect(style).not.toBeNull();
  return style!.textContent ?? "";
}

/**
 * Every declaration that lands on `selector`, concatenated. A selector can head
 * more than one block (shared contracts like the isolation list, plus a media
 * override), so all of them are folded together rather than only the first.
 */
function ruleBody(css: string, selector: string): string {
  const needle = `\n${selector} {`;
  const bodies: string[] = [];
  for (let at = css.indexOf(needle); at >= 0; at = css.indexOf(needle, at + 1)) {
    const open = css.indexOf("{", at);
    bodies.push(css.slice(open + 1, css.indexOf("}", open)));
  }
  expect(bodies.length, `missing rule ${selector}`).toBeGreaterThan(0);
  return bodies.join("\n");
}

describe("centre-screen announcement sizing", () => {
  it("caps the kill/CTF announcement to the safe area instead of nowrapping past it", () => {
    const body = ruleBody(hudCss(), ".hud-kill-announce");

    // The long CTF calls ("YOU HAVE THE ENEMY FLAG") used to run off both edges
    // of a portrait phone: a fixed 1.9em with `white-space: nowrap` and no cap.
    expect(body).not.toMatch(/white-space:\s*nowrap/);
    expect(body).toMatch(/max-width:/);
    for (const inset of ["--hud-inset-left", "--hud-inset-right"]) {
      expect(body).toContain(inset);
    }
    // Type scales down with the viewport; 1.9em is the cap, not the fixed size.
    expect(body).toMatch(/font-size:\s*clamp\([^)]*vw[^)]*\)/);
  });

  it("budgets the pop-in overshoot into the width cap so the punch never clips", () => {
    const css = hudCss();
    const body = ruleBody(css, ".hud-kill-announce");

    // The box is laid out at scale 1 but painted at the overshoot, so the same
    // variable has to appear in BOTH the width budget and the keyframe.
    expect(body).toMatch(/--hud-announce-pop:\s*1\.5/);
    expect(body).toMatch(/max-width:[\s\S]*var\(--hud-announce-pop\)/);
    expect(css).toMatch(/@keyframes hud-kill-announce[\s\S]*scale\(var\(--hud-announce-pop/);
    // …and it is dialled back where a 1.5x punch could not fit the safe area.
    expect(css).toMatch(/@media \(max-width: 960px\)[\s\S]*--hud-announce-pop:\s*1\.12/);
  });
});

describe("other full-bleed text overlays", () => {
  it("caps the scoreboard to the safe-area height and scrolls only its team rows", () => {
    const css = hudCss();
    const panel = ruleBody(css, ".hud-scoreboard-panel");
    expect(panel).toMatch(/max-height:\s*calc\(100% - var\(--hud-inset-top\) - var\(--hud-inset-bottom\)\)/);
    expect(panel).toMatch(/overflow:\s*hidden/);
    expect(panel).toMatch(/display:\s*flex/);
    const rows = ruleBody(css, ".hud-scoreboard-rows");
    expect(rows).toMatch(/min-height:\s*0/);
    expect(rows).toMatch(/overflow-y:\s*auto/);
  });

  it("keeps toast padding inside the notification stack's safe-area cap", () => {
    const css = hudCss();
    expect(ruleBody(css, ".hud-notifications")).toMatch(
      /max-width:\s*calc\(100vw - var\(--hud-inset-left\) - var\(--hud-inset-right\)\)/,
    );
    // content-box would have put the 30px of horizontal padding OUTSIDE that cap.
    expect(ruleBody(css, ".hud-toast")).toMatch(/box-sizing:\s*border-box/);
  });

  it("lets only the scoreboard's meta line shrink, and ellipsises it", () => {
    const css = hudCss();
    const status = ruleBody(css, ".hud-match-status");
    // The row stays nowrap, so its cap only holds if the children can give.
    expect(status).toMatch(/white-space:\s*nowrap/);
    expect(status).toMatch(/box-sizing:\s*border-box/);

    const meta = ruleBody(css, ".hud-match-status .hud-match-meta");
    expect(meta).toMatch(/min-width:\s*0/);
    expect(meta).toMatch(/text-overflow:\s*ellipsis/);
    // The two scores are the scoreboard; they must not be squeezed.
    expect(ruleBody(css, ".hud-match-status .hud-team-score")).toMatch(/flex:\s*0 0 auto/);
  });

  it("keeps the results panel inside the viewport once padding and insets are added", () => {
    const body = ruleBody(hudCss(), ".hud-results-panel");
    expect(body).toMatch(/box-sizing:\s*border-box/);
    expect(body).toMatch(/max-width:\s*min\(420px, calc\(100% - var\(--hud-inset-left\)/);
    expect(body).toMatch(/max-height:\s*calc\(100% - var\(--hud-inset-top\)/);
  });

  it("budgets outcome tracking inside a responsive title so its glyphs cannot clip", () => {
    const body = ruleBody(hudCss(), ".hud-results-title");
    expect(body).toMatch(/max-width:\s*100%/);
    expect(body).toMatch(/font-size:\s*clamp\([^)]*vw[^)]*\)/);
    expect(body).toMatch(/padding-inline-end:\s*var\(--hud-results-title-tracking\)/);
    expect(body).toMatch(/letter-spacing:\s*var\(--hud-results-title-tracking\)/);
  });

  // The regression this pins: the outcome banner outgrew the 420px results
  // panel, and the panel's `overflow-y:auto` computes overflow-x to `auto`
  // too — clipping VICTORY mid-glyph. In the outcome state the panel must
  // neither cap its width nor clip, and the title must be bounded by the
  // width it actually has rather than raw viewport units.
  it("lets the outcome banner escape the panel's cap and scroll box", () => {
    const panel = ruleBody(hudCss(), ".hud-results--outcome .hud-results-panel");
    expect(panel).toMatch(/overflow:\s*visible/);
    expect(panel).not.toMatch(/max-width:\s*min\(420px/);

    const title = ruleBody(hudCss(), ".hud-results--outcome .hud-results-title");
    // Bounded by available width, and never wrapped mid-word.
    expect(title).toMatch(/font-size:\s*min\(/);
    expect(title).toMatch(/100vw/);
    expect(title).toMatch(/white-space:\s*nowrap/);
    expect(title).toMatch(/letter-spacing:\s*var\(--hud-results-title-tracking\)/);
  });
});
