import { describe, expect, it } from "vitest";
import { encodeCenti, encodeFlagState, type ArenaConfig } from "@space-arena/shared";
import { decodeDecoys, decodeFlags, decodeTeamScores, FlagTrailAccumulator } from "./NetGameSession.js";

const arena = {
  flagBases: [{ id: "blue", team: 0, position: { x: -20, y: 3, z: 4 }, radius: 12 }],
} as ArenaConfig;

describe("online objective decoding", () => {
  it("decodes decoys and flags into the local Snapshot shapes", () => {
    expect(decodeDecoys({ 9: {
      entityId: 9, team: 1, x: encodeCenti(1.2), y: encodeCenti(-2), z: encodeCenti(3.5),
      radius: 4, lifeFraction: 0.75,
    } })).toEqual([{ id: 9, team: 1, pos: { x: 1.2, y: -2, z: 3.5 }, radius: 4, lifeFraction: 0.75 }]);

    const flags = decodeFlags({ 17: {
      entityId: 17, team: 0, state: encodeFlagState("carried"), carrierEntityId: 42,
      x: encodeCenti(6), y: encodeCenti(7), z: encodeCenti(8), dropRemaining: 0,
    } }, arena, new FlagTrailAccumulator(), 100);
    expect(flags[0]).toMatchObject({
      id: 17, team: 0, state: "carried", carrierId: 42,
      pos: { x: 6, y: 7, z: 8 }, home: { x: -20, y: 3, z: 4 }, baseRadius: 12,
    });
  });

  it("round-trips captures and accepts legacy numeric scores", () => {
    expect(decodeTeamScores(new Map([["1", { kills: 2, captures: 3 }]]))).toEqual([
      { team: 1, kills: 2, captures: 3 },
    ]);
    expect(decodeTeamScores({ 0: 4 })).toEqual([{ team: 0, kills: 4, captures: 0 }]);
  });

  it("grows a bounded trail while moving and clears it on return home", () => {
    const trails = new FlagTrailAccumulator();
    const wire = (state: "home" | "carried", x: number) => ({ 17: {
      entityId: 17, team: 0, state: encodeFlagState(state), carrierEntityId: state === "carried" ? 42 : -1,
      x: encodeCenti(x), y: 0, z: 0, dropRemaining: 0,
    } });
    expect(decodeFlags(wire("carried", 0), arena, trails, 100)[0]!.trail).toHaveLength(1);
    expect(decodeFlags(wire("carried", 1), arena, trails, 100)[0]!.trail).toHaveLength(2);
    expect(decodeFlags(wire("home", -20), arena, trails, 100)[0]!.trail).toEqual([]);
  });
});
