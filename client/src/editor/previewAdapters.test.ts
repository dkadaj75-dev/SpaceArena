import { describe, expect, it } from "vitest";
import { arenaPreview, seededBotAudit } from "./previewAdapters.js";
import type { ArenaConfig, BotprofileConfig } from "@space-arena/shared";

describe("Constellation preview adapters", () => {
  it("returns stable BotDecisionSnapshot-style fields for a seeded mini-audit", () => {
    const profile = { id: "bot.test", type: "botprofile", version: 1, decisionIntervalMs: 100, orderJitterMs: 0, preferredRange: [1, 2], behaviors: { pursue: { baseWeight: 2 }, evade: { baseWeight: 1 } }, moduleDiscipline: { heatShutdownAt: .8, reactivateBelow: .4, energyReserve: .2, shieldOnlyWhenEngaged: true } } as BotprofileConfig;
    expect(seededBotAudit(profile, 73)).toEqual(seededBotAudit(profile, 73));
    expect(seededBotAudit(profile, 73)).toMatchObject({ winner: "pursue", role: "balanced", target: "fixture.enemy.nearest" });
  });

  it("reports authored arena placement counts", () => {
    const arena = {
      id: "arena.broken-halo", type: "arena", version: 1, name: "Broken Halo",
      bounds: { shape: "sphere", radius: 150 },
      spawnPoints: Array.from({ length: 10 }, (_, i) => ({ id: `spawn-${i}`, team: i % 2, position: { x: 0, z: 0 }, heading: 0 })),
      asteroidPlacements: Array.from({ length: 52 }, () => ({ asteroidId: "asteroid.test", position: { x: 0, z: 0 } })),
      flagBases: Array.from({ length: 2 }, (_, i) => ({ id: `base-${i}`, team: i, position: { x: 0, z: 0 }, radius: 10 })),
    } satisfies ArenaConfig;
    const target = document.createElement("div");

    arenaPreview(target, arena);

    expect(target.textContent).toContain("10 spawns");
    expect(target.textContent).toContain("52 asteroids");
    expect(target.textContent).toContain("0 props");
    expect(target.textContent).toContain("2 flag bases");
    expect(target.textContent).toContain("0 zones");
  });
});
