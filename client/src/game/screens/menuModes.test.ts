import { describe, expect, it } from "vitest";
import type { GamemodeConfig } from "@space-arena/shared";
import { menuGroups, UNGROUPED } from "./menuModes.js";

function mode(id: string, over: Record<string, unknown> = {}): GamemodeConfig {
  return { id, type: "gamemode", version: 2, teams: "5v5", launch: "online", ...over } as unknown as GamemodeConfig;
}

describe("menu grouping", () => {
  it("files modes under their authored group, groups in first-appearance order", () => {
    const groups = menuGroups([
      mode("gamemode.duel", { name: "Duel", menu: { group: "Deathmatch", label: "Duel" } }),
      mode("gamemode.tdm-2", { menu: { group: "Team Deathmatch", label: "2v2" } }),
      mode("gamemode.tdm-5", { menu: { group: "Team Deathmatch", label: "5v5" } }),
      mode("gamemode.ctf", { menu: { group: "Capture the Flag", label: "5v5" } }),
    ]);
    expect(groups.map((g) => g.title)).toEqual(["Deathmatch", "Team Deathmatch", "Capture the Flag"]);
    expect(groups[1]!.modes.map((m) => m.label)).toEqual(["2v2", "5v5"]);
  });

  it("orders inside a group by the authored order, pack order as the tie-break", () => {
    const groups = menuGroups([
      mode("gamemode.c", { menu: { group: "G", label: "C", order: 2 } }),
      mode("gamemode.a", { menu: { group: "G", label: "A", order: 1 } }),
      // No order: ties with C at 0? No — absent is 0, so these sort FIRST, and
      // between themselves they keep the order the pack lists them in.
      mode("gamemode.d", { menu: { group: "G", label: "D" } }),
      mode("gamemode.b", { menu: { group: "G", label: "B" } }),
    ]);
    expect(groups[0]!.modes.map((m) => m.label)).toEqual(["D", "B", "A", "C"]);
  });

  it("falls back to the mode's own name when no short label is authored", () => {
    const groups = menuGroups([mode("gamemode.x", { name: "Ring Duel", menu: { group: "Deathmatch" } })]);
    expect(groups[0]!.modes[0]).toMatchObject({ label: "Ring Duel", blurb: "" });
  });

  it("puts an ungrouped mode under the catch-all heading rather than dropping it", () => {
    // A pack that adds a mode and forgets the menu block still gets a button.
    const groups = menuGroups([mode("gamemode.new", { name: "Brawl" })]);
    expect(groups).toEqual([{ title: UNGROUPED, modes: [expect.objectContaining({ label: "Brawl" })] }]);
  });

  it("leaves out hidden modes and offline ones", () => {
    // Hidden modes are test fixtures; the offline mode is the tutorial, which
    // gets its own destination rather than a match card.
    const groups = menuGroups([
      mode("gamemode.hidden", { name: "Audit", hidden: true }),
      mode("gamemode.tutorial", { name: "Flight School", launch: "offline" }),
      mode("gamemode.real", { name: "Duel", menu: { group: "Deathmatch" } }),
    ]);
    expect(groups.flatMap((g) => g.modes).map((m) => m.id)).toEqual(["gamemode.real"]);
  });

  it("carries the team shape through, so an icon can show the real headcount", () => {
    const groups = menuGroups([mode("gamemode.tdm", { teams: "2v2", menu: { group: "T", label: "2v2", icon: "team" } })]);
    expect(groups[0]!.modes[0]).toMatchObject({ teams: "2v2", icon: "team" });
  });

  it("returns nothing for a pack with no playable modes", () => {
    expect(menuGroups([])).toEqual([]);
  });
});
