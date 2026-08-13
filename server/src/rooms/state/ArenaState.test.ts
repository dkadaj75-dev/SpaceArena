import { describe, expect, it } from "vitest";
import { ArenaState, DecoyState, FlagState, PlayerState, TeamScoreState } from "./ArenaState.js";

describe("ArenaState online objectives", () => {
  it("stores flags, heatsink decoys, and capture scores as schema entities", () => {
    const state = new ArenaState();
    const decoy = new DecoyState();
    decoy.entityId = 9;
    state.decoys.set("9", decoy);
    const flag = new FlagState();
    flag.entityId = 17;
    flag.carrierEntityId = 42;
    state.flags.set("17", flag);
    const score = new TeamScoreState();
    score.captures = 2;
    state.teamScores.set("0", score);

    expect(state.decoys.get("9")?.entityId).toBe(9);
    expect(state.flags.get("17")?.carrierEntityId).toBe(42);
    expect(state.teamScores.get("0")?.captures).toBe(2);
    expect(new PlayerState().isBot).toBe(false);
  });
});
