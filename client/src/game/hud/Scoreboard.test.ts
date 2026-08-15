// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GameSession } from "../GameSession.js";
import { Scoreboard } from "./Scoreboard.js";
import { injectHudStyle } from "./hudStyle.js";
import { teamPerspective, viewerTeam } from "./matchPresentation.js";

function session(playerId = 1): GameSession {
  const lines = new Map([
    [1, { entityId: 1, kills: 4, deaths: 1, assists: 2, flagsTaken: 0, flagsReturned: 0, flagsCaptured: 0 }],
    [2, { entityId: 2, kills: 2, deaths: 3, assists: 1, flagsTaken: 0, flagsReturned: 0, flagsCaptured: 0 }],
  ]);
  return {
    playerId,
    sim: { world: { gamemode: {} } },
    displayNameFor: (id: number) => (id === 1 ? "YOU" : "RIVAL"),
    isBotFor: (id: number) => id === 2,
    matchStats: { forEach: (visit: (line: (typeof lines extends Map<number, infer T> ? T : never)) => void) => lines.forEach(visit), line: (id: number) => lines.get(id)! },
  } as unknown as GameSession;
}

afterEach(() => {
  document.body.replaceChildren();
  document.head.replaceChildren();
});

describe("Scoreboard", () => {
  it("marks only the local player's row for both scoreboard presentations", () => {
    const board = new Scoreboard(document.body, session(), { onPlayAgain: vi.fn(), onMenu: vi.fn() });
    board.update({ ships: [{ id: 1, team: 0 }, { id: 2, team: 0 }] } as never);

    expect(document.querySelector("tr[data-entity-id='1']")?.classList.contains("hud-scoreboard-local-player")).toBe(true);
    expect(document.querySelector("tr[data-entity-id='2']")?.classList.contains("hud-scoreboard-local-player")).toBe(false);
    board.showFinal();
    expect(document.querySelector(".hud-scoreboard.final tr[data-entity-id='1']")?.classList.contains("hud-scoreboard-local-player")).toBe(true);
    board.dispose();
  });

  it("discloses bots beside their replicated player-like name", () => {
    const board = new Scoreboard(document.body, session(), { onPlayAgain: vi.fn(), onMenu: vi.fn() });
    board.update({ ships: [{ id: 1, team: 0 }, { id: 2, team: 1 }] } as never);
    expect(document.querySelector("tr[data-entity-id='1'] td")?.textContent).toBe("YOU");
    expect(document.querySelector("tr[data-entity-id='2'] td")?.textContent).toBe("RIVAL [BOT]");
    board.dispose();
  });

  it("maps teams from the current viewer's ship, with team zero as the spectator fallback", () => {
    const snapshot = { ships: [{ id: 1, team: 1 }, { id: 2, team: 0 }] } as never;
    expect(viewerTeam(snapshot, 1)).toBe(1);
    expect(teamPerspective(1, viewerTeam(snapshot, 1))).toBe("ally");
    expect(teamPerspective(0, viewerTeam(snapshot, 1))).toBe("enemy");
    expect(viewerTeam({ ships: [] } as never, 1)).toBe(0);
  });

  it("uses blue ally and red enemy table classes from the viewer's perspective", () => {
    const board = new Scoreboard(document.body, session(), { onPlayAgain: vi.fn(), onMenu: vi.fn() });
    board.update({ ships: [{ id: 1, team: 1 }, { id: 2, team: 0 }] } as never);

    expect(document.querySelector("table[data-team='1']")?.classList.contains("hud-scoreboard-team--ally")).toBe(true);
    expect(document.querySelector("table[data-team='0']")?.classList.contains("hud-scoreboard-team--enemy")).toBe(true);
    board.update({ ships: [{ id: 1, team: 0 }, { id: 2, team: 1 }] } as never);
    expect(document.querySelector("table[data-team='0']")?.classList.contains("hud-scoreboard-team--ally")).toBe(true);
    expect(document.querySelector("table[data-team='1']")?.classList.contains("hud-scoreboard-team--enemy")).toBe(true);
    expect(document.querySelector("tr[data-entity-id='1']")?.classList.contains("hud-scoreboard-local-player")).toBe(true);
    board.dispose();
  });

  it("switches the score control label and accessible name with the panel", () => {
    const board = new Scoreboard(document.body, session(), { onPlayAgain: vi.fn(), onMenu: vi.fn() });
    const button = document.querySelector<HTMLButtonElement>(".hud-scoreboard-btn")!;
    expect(button.textContent).toBe("SCORE");
    expect(button.getAttribute("aria-label")).toBe("SCORE");
    button.click();
    expect(button.textContent).toBe("CLOSE");
    expect(button.getAttribute("aria-label")).toBe("CLOSE");
    button.click();
    expect(button.textContent).toBe("SCORE");
    expect(button.getAttribute("aria-label")).toBe("SCORE");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    expect(button.textContent).toBe("CLOSE");
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Tab" }));
    expect(button.textContent).toBe("SCORE");
    button.click();
    board.lockForEnd();
    expect(button.textContent).toBe("SCORE");
    expect(button.getAttribute("aria-label")).toBe("SCORE");
    board.dispose();
  });

  // Spectating (or a frame where the viewer's ship is not in the snapshot yet)
  // resolves to team 0, which keeps TEAM 2 as the red block rather than
  // painting both rosters the same colour.
  it("keeps the second team as the enemy block when the viewer has no ship", () => {
    const board = new Scoreboard(document.body, session(99), { onPlayAgain: vi.fn(), onMenu: vi.fn() });
    board.update({ ships: [{ id: 1, team: 0 }, { id: 2, team: 1 }] } as never);

    expect(document.querySelector("table[data-team='0']")?.classList.contains("hud-scoreboard-team--ally")).toBe(true);
    expect(document.querySelector("table[data-team='1']")?.classList.contains("hud-scoreboard-team--enemy")).toBe(true);
    expect(document.querySelector(".hud-scoreboard-local-player")).toBeNull();
    board.dispose();
  });
});

/**
 * CSS-content assertions in the style of hudOverflow.test.ts: there is no
 * layout engine here, so what is pinned is the contract — the enemy roster is a
 * red *field*, not just a red caption, and both hues come from theme tokens.
 */
function ruleBody(selector: string): string {
  document.head.replaceChildren();
  injectHudStyle();
  const css = document.getElementById("hud-style")?.textContent ?? "";
  const needle = `\n${selector} {`;
  const bodies: string[] = [];
  for (let at = css.indexOf(needle); at >= 0; at = css.indexOf(needle, at + 1)) {
    const open = css.indexOf("{", at);
    bodies.push(css.slice(open + 1, css.indexOf("}", open)));
  }
  expect(bodies.length, `missing rule ${selector}`).toBeGreaterThan(0);
  return bodies.join("\n");
}

describe("scoreboard team fields", () => {
  it("fills the enemy block with the danger token and the viewer's own with the primary", () => {
    const base = ruleBody(".hud-scoreboard table");
    // One derived fill for both blocks — a pack re-hues a roster from tokens.
    expect(base).toMatch(/--hud-scoreboard-team-fill:\s*color-mix\(in srgb,var\(--hud-scoreboard-team\) var\(--hud-scoreboard-team-pct\),transparent\)/);
    expect(base).toMatch(/background:\s*var\(--hud-scoreboard-team-fill\)/);

    const enemy = ruleBody(".hud-scoreboard table.hud-scoreboard-team--enemy");
    expect(enemy).toMatch(/--hud-scoreboard-team:\s*var\(--hud-danger,var\(--sa-red-500\)\)/);
    const ally = ruleBody(".hud-scoreboard table.hud-scoreboard-team--ally");
    expect(ally).toMatch(/--hud-scoreboard-team:\s*var\(--hud-primary,var\(--sa-blue-500\)\)/);
    // No hardcoded hex anywhere in the team palette.
    for (const body of [base, enemy, ally]) expect(body).not.toMatch(/#[0-9a-fA-F]{3,8}/);

    // The enemy field is the louder of the two, which is the whole point.
    const pct = (body: string): number => Number(/--hud-scoreboard-team-pct:\s*([\d.]+)%/.exec(body)?.[1]);
    expect(pct(enemy)).toBeGreaterThan(pct(ally));

    // The caption bar rides the same fill so heading and rows read as one block.
    expect(ruleBody(".hud-scoreboard caption")).toMatch(/background:\s*var\(--hud-scoreboard-team-fill\)/);
  });

  it("keeps the local player's row readable on top of its team field", () => {
    const row = ruleBody(".hud-scoreboard tr.hud-scoreboard-local-player");
    // A heavier wash of the team's own hue plus the white rail — never a
    // third colour, and never so light that the accent text drops out.
    expect(row).toMatch(/background:\s*color-mix\(in srgb,var\(--hud-scoreboard-team\) 30%,transparent\)/);
    expect(row).toMatch(/box-shadow:inset 3px 0 var\(--hud-accent,var\(--sa-white\)\)/);
    expect(ruleBody(".hud-scoreboard tr.hud-scoreboard-local-player td")).toMatch(/color:var\(--hud-accent,var\(--sa-white\)\)/);
  });
});
