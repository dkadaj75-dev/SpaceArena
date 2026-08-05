import { describe, expect, it } from "vitest";
import type { MatchStatLine } from "@space-arena/shared";
import { MatchPresentationFlow, OUTCOME_DURATION_MS, selectMvp } from "./matchPresentation.js";

const line = (entityId: number, values: Partial<MatchStatLine> = {}): MatchStatLine => ({
  entityId, kills: 0, deaths: 0, assists: 0, flagsTaken: 0, flagsDropped: 0,
  flagsReturned: 0, flagsCaptured: 0, ...values,
});

describe("match-end MVP", () => {
  it("uses the scoreboard score, including CTF weighting", () => {
    expect(selectMvp([line(1, { kills: 4 }), line(2, { flagsCaptured: 1 })], true)).toBe(2);
    expect(selectMvp([line(1, { kills: 4 }), line(2, { flagsCaptured: 1 })], false)).toBe(1);
  });
  it("breaks equal scores by kills, fewer deaths, assists, then stable entity id", () => {
    expect(selectMvp([line(8, { kills: 1 }), line(3, { kills: 2, deaths: 10 })], false)).toBe(3);
    expect(selectMvp([line(8, { kills: 2, deaths: 1 }), line(3, { kills: 2, deaths: 1 })], false)).toBe(3);
  });
});

describe("match presentation flow", () => {
  it("allows only end → timed outcome → MVP → scoreboard → action", () => {
    const flow = new MatchPresentationFlow();
    expect(flow.next()).toBe(false);
    expect(flow.end()).toBe(true);
    expect(flow.state).toBe("outcome");
    expect(flow.end()).toBe(false);
    expect(flow.update(OUTCOME_DURATION_MS - 1)).toBe(false);
    expect(flow.state).toBe("outcome");
    expect(flow.update(1)).toBe(true);
    expect(flow.state).toBe("mvp");
    expect(flow.next()).toBe(true);
    expect(flow.state).toBe("scoreboard");
    expect(flow.leave()).toBe(true);
    expect(flow.state).toBe("left");
  });
});
