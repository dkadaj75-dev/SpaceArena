import { describe, expect, it } from "vitest";
import { seededBotAudit } from "./previewAdapters.js";
import type { BotprofileConfig } from "@space-arena/shared";

describe("Constellation preview adapters", () => {
  it("returns stable BotDecisionSnapshot-style fields for a seeded mini-audit", () => {
    const profile = { id: "bot.test", type: "botprofile", version: 1, decisionIntervalMs: 100, orderJitterMs: 0, preferredRange: [1, 2], behaviors: { pursue: { baseWeight: 2 }, evade: { baseWeight: 1 } }, moduleDiscipline: { heatShutdownAt: .8, reactivateBelow: .4, energyReserve: .2, shieldOnlyWhenEngaged: true } } as BotprofileConfig;
    expect(seededBotAudit(profile, 73)).toEqual(seededBotAudit(profile, 73));
    expect(seededBotAudit(profile, 73)).toMatchObject({ winner: "pursue", role: "balanced", target: "fixture.enemy.nearest" });
  });
});
