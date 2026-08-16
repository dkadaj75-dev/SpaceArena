import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { teamSizeOf } from "../bots/roster.js";
import { gamemodeSchema, type GamemodeConfig } from "./gamemode.js";

const MODES_DIR = fileURLToPath(new URL("../../../content/gamemodes/", import.meta.url));

function shippedModes(): GamemodeConfig[] {
  return readdirSync(MODES_DIR)
    .filter((name) => name.endsWith(".json"))
    .map((name) => gamemodeSchema.parse(JSON.parse(readFileSync(`${MODES_DIR}${name}`, "utf8"))));
}

describe("shipped gamemode launch policy", () => {
  it("keeps Tutorial as the only offline mode", () => {
    const modes = shippedModes();
    expect(modes.filter((mode) => mode.launch === "offline").map((mode) => mode.id)).toEqual(["gamemode.tutorial"]);
    expect(modes.filter((mode) => mode.launch === "online")).toHaveLength(modes.length - 1);
  });

  it("gives every online mode a ten-second usable bot backfill policy", () => {
    for (const mode of shippedModes().filter((candidate) => candidate.launch === "online")) {
      expect(mode.bots?.backfillWaitMs, mode.id).toBe(10_000);
      expect(mode.bots?.defaultProfile, mode.id).toBeTruthy();
      expect(Boolean(mode.bots?.shipPool?.length || mode.bots?.roster?.length), mode.id).toBe(true);
    }
  });

  /**
   * The Play menu is generated from this list (Lobby.buildSections), so the
   * shipped catalogue IS the menu. Owner 2026-08-16: one 1v1 and it is called
   * Duel; the rest name their team size and their rules. The two remaining 1v1
   * configs stay in the pack as fixtures — `hidden` is what keeps them off the
   * menu.
   */
  it("offers exactly one mode per team size, named the way the menu reads", () => {
    const offered = shippedModes().filter((mode) => mode.launch === "online" && !mode.hidden);
    // Sorted: the menu's own order is the manifest's, not the directory's.
    expect(offered.map((mode) => mode.name).sort()).toEqual([
      "2v2 Team Deathmatch",
      "5v5 Capture the Flag",
      "5v5 Team Deathmatch",
      "Duel",
    ]);
    expect(offered.filter((mode) => mode.teams === "1v1")).toHaveLength(1);
  });

  it("maps authored 5v5 teams to five seats per side", () => {
    const mode = shippedModes().find((candidate) => candidate.id === "gamemode.practice-bots-5v5")!;
    expect(mode.teams).toBe("5v5");
    expect(teamSizeOf(mode)).toBe(5);
  });
});
