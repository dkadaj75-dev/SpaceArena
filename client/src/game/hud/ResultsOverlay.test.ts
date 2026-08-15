import { afterEach, describe, expect, it, vi } from "vitest";
import type { Snapshot } from "@space-arena/shared";
import type { GameSession } from "../GameSession.js";
import { ResultsOverlay } from "./ResultsOverlay.js";
import { injectHudStyle } from "./hudStyle.js";

const ended = { phase: "ended", winnerTeam: 0 } as Snapshot;

function session(): GameSession {
  return {
    matchStats: {
      all: () => [{
        entityId: 7,
        kills: 9,
        deaths: 1,
        assists: 4,
        flagsTaken: 1,
        flagsDropped: 0,
        flagsReturned: 0,
        flagsCaptured: 2,
      }],
    },
    sim: { world: { gamemode: { ctf: {}, winCondition: { type: "score" } } } },
    displayNameFor: () => "NOVA",
    teamOf: () => 0,
  } as unknown as GameSession;
}

afterEach(() => document.body.replaceChildren());

describe("ResultsOverlay MVP presentation", () => {
  it("builds the badge, pilot name, stat chips, and preserves the next hook", () => {
    const overlay = new ResultsOverlay(document.body, session(), 1, {
      onPlayAgain: vi.fn(),
      onMenu: vi.fn(),
      onMvp: vi.fn(),
    });
    overlay.update(ended);
    overlay.showMvp();

    expect(document.querySelector(".hud-results-mvp-badge")?.textContent).toBe("MVP");
    expect(document.querySelector(".hud-results-title")?.textContent).toBe("NOVA");
    expect(document.querySelectorAll(".hud-results-stat")).toHaveLength(3);
    expect(document.querySelector("[data-results-action='next']")).toBeInstanceOf(HTMLButtonElement);
  });

  it("fast-forwards every chip without blocking the button action", () => {
    const onNext = vi.fn();
    const overlay = new ResultsOverlay(document.body, session(), 1, {
      onPlayAgain: vi.fn(),
      onMenu: vi.fn(),
    });
    overlay.setScoreboardAction(onNext);
    overlay.update(ended);
    overlay.showMvp();

    document.querySelector(".hud-results")?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(document.querySelector(".hud-results")?.classList.contains("hud-results--mvp-skipped")).toBe(true);
    expect([...document.querySelectorAll(".hud-results-stat-value")].map((el) => el.textContent)).toEqual(["9", "4", "2"]);

    (document.querySelector("[data-results-action='next']") as HTMLButtonElement).click();
    expect(onNext).toHaveBeenCalledOnce();
  });
});

/**
 * CSS-content assertions in the style of hudOverflow.test.ts / twoLayerStyle
 * .test.ts: jsdom-class DOMs have no layout engine, so what is pinned here is
 * the *discipline* behind the MVP card — the rules that stopped a real browser
 * from cropping the pilot name and from sizing the card in fixed pixels.
 */
function hudCss(): string {
  document.head.replaceChildren();
  injectHudStyle();
  return document.getElementById("hud-style")?.textContent ?? "";
}

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

describe("MVP card type and boxes", () => {
  // The regression: the name was cropped through the top and bottom of its own
  // glyphs. Three causes, all pinned here — a line box shorter than the font's
  // metrics, a clip on the block axis, and a flex column that shrank the box.
  it("gives the pilot name a line box its glyphs fit in, and clips only the inline axis", () => {
    const title = ruleBody(hudCss(), ".hud-results--mvp .hud-results-title");

    expect(title).not.toMatch(/overflow:\s*hidden/);
    expect(title).toMatch(/overflow-x:\s*clip/);
    expect(title).toMatch(/overflow-y:\s*visible/);
    // A long name shrinks to an ellipsis rather than widening (or clipping) the card.
    expect(title).toMatch(/text-overflow:\s*ellipsis/);
    expect(title).toMatch(/white-space:\s*nowrap/);
    // 1.05 was shorter than the display face's ascender+descender.
    const lineHeight = Number(/line-height:\s*([\d.]+)/.exec(title)?.[1]);
    expect(lineHeight).toBeGreaterThanOrEqual(1.15);
    expect(title).toMatch(/padding-block:/);
    // The glow is a filter so it is applied AFTER that inline clip; a
    // text-shadow was cut into a lit rectangle at the box edge.
    expect(title).toMatch(/filter:\s*drop-shadow/);
    expect(title).not.toMatch(/text-shadow:/);
  });

  it("keeps every card row at its content height so the card scrolls instead of squashing", () => {
    // Default flex-shrink let the capped-height column squeeze its own rows —
    // which is what drove the name's box below its glyphs on a short viewport.
    expect(ruleBody(hudCss(), ".hud-results-panel > *")).toMatch(/flex:\s*0 0 auto/);
    expect(ruleBody(hudCss(), ".hud-results-panel")).toMatch(/overflow-y:\s*auto/);
  });

  it("scales the whole card from one clamp, in both orientations", () => {
    const css = hudCss();
    const panel = ruleBody(css, ".hud-results--mvp .hud-results-panel");
    // Type is viewport-relative with a floor and a ceiling…
    expect(panel).toMatch(/font-size:\s*clamp\([^;]*vw[^;]*\)/);
    // …and bounded by height too, which is what short landscape needs.
    expect(panel).toMatch(/font-size:\s*clamp\([^;]*vh[^;]*\)/);
    // Children ride that one size instead of carrying px of their own.
    expect(panel).toMatch(/gap:\s*[\d.]+em/);
    expect(ruleBody(css, ".hud-results--mvp .hud-results-title")).toMatch(/font-size:\s*clamp\([^;]*em[^;]*\)/);

    // Portrait re-states the same contract at portrait proportions…
    const portrait = css.slice(css.indexOf("@media (orientation:portrait) {\n  .hud-results--mvp .hud-results-panel {"));
    expect(portrait.startsWith("@media"), "no portrait override for the MVP card").toBe(true);
    expect(portrait.slice(0, portrait.indexOf("}"))).toMatch(/font-size:\s*clamp\(/);
    // …and a phone on its side gets a wider card, which is what fits the
    // actions on one 44px row instead of three.
    expect(css).toContain("@media (orientation:landscape) and (max-height:480px) {\n  .hud-results--mvp .hud-results-panel {");
  });

  it("caps the MVP badge against the viewport and keeps its label inside the hex", () => {
    const badge = ruleBody(hudCss(), ".hud-results-mvp-badge");
    // theme.hud.mvp.badgeSizePx stays the cap, not the size.
    expect(badge).toMatch(/--hud-mvp-badge-box:\s*min\(var\(--hud-mvp-badge-size, 112px\)[^;]*vw[^;]*vh[^;]*\)/);
    expect(badge).toMatch(/width:\s*var\(--hud-mvp-badge-box\)/);
    expect(badge).toMatch(/font:[^;]*calc\(var\(--hud-mvp-badge-box\)/);
  });

  it("keeps the 44px tap target while the action row itself scales", () => {
    const css = hudCss();
    expect(ruleBody(css, ".hud-results-btn")).toMatch(/min-height:\s*44px/);
    expect(ruleBody(css, ".hud-results--mvp .hud-results-btn")).toMatch(/min-width:\s*[\d.]+em/);
  });
});
