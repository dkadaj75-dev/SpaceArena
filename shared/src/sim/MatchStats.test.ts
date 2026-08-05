import { describe, expect, it } from "vitest";
import type { SimEvent } from "./events.js";
import { ASSIST_WINDOW_SEC, MatchStatsAccumulator } from "./MatchStats.js";

const teams = new Map([[1, 0], [2, 1], [3, 0], [4, 1]]);
const damage = (sourceId: number, targetId = 2): SimEvent => ({ type: "damage", sourceId, targetId, amount: 1, damageType: "energy", isAsteroid: false });
const death = (killerId: number | null, entityId = 2): SimEvent => ({ type: "entityDestroyed", entityId, killerId, team: teams.get(entityId), isAsteroid: false });

describe("MatchStatsAccumulator", () => {
  it("awards a kill, death, and recent third-party assist", () => {
    const s = new MatchStatsAccumulator((id) => teams.get(id));
    s.consume([damage(3)], 2);
    s.consume([damage(1), death(1)], 2 + ASSIST_WINDOW_SEC);
    expect(s.line(1).kills).toBe(1);
    expect(s.line(2).deaths).toBe(1);
    expect(s.line(3).assists).toBe(1);
  });
  it("expires assists and excludes the killer, victim, and friendly fire", () => {
    const s = new MatchStatsAccumulator((id) => teams.get(id));
    s.consume([damage(3), damage(2), damage(4)], 1);
    s.consume([death(1)], 1 + ASSIST_WINDOW_SEC + 0.001);
    expect(s.line(3).assists).toBe(0);
    expect(s.line(4).assists).toBe(0);
  });
  it("does not credit suicides, environment deaths, or team kills", () => {
    const s = new MatchStatsAccumulator((id) => teams.get(id));
    s.consume([death(2), death(null), death(4)], 1);
    expect(s.line(2).deaths).toBe(3);
    expect(s.line(2).kills).toBe(0);
    expect(s.line(4).kills).toBe(0);
  });
  it("tracks each credited CTF action and ignores timed returns", () => {
    const s = new MatchStatsAccumulator();
    s.consume([
      { type: "flagTaken", flagId: 10, flagTeam: 1, carrierId: 1, carrierTeam: 0 },
      { type: "flagDropped", flagId: 10, flagTeam: 1, carrierId: 1, returnSec: 8 },
      { type: "flagReturned", flagId: 10, flagTeam: 1, byId: 2, timedOut: false },
      { type: "flagReturned", flagId: 10, flagTeam: 1, byId: null, timedOut: true },
      { type: "flagCaptured", flagId: 10, flagTeam: 1, carrierId: 1, scoringTeam: 0, captures: 1 },
    ], 1);
    expect(s.line(1)).toMatchObject({ flagsTaken: 1, flagsDropped: 1, flagsCaptured: 1 });
    expect(s.line(2).flagsReturned).toBe(1);
  });
});
