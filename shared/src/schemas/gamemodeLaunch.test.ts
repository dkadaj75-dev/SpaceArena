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

  it("maps authored 5v5 teams to five seats per side", () => {
    const mode = shippedModes().find((candidate) => candidate.id === "gamemode.practice-bots-5v5")!;
    expect(mode.teams).toBe("5v5");
    expect(teamSizeOf(mode)).toBe(5);
  });
});
