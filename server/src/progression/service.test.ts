import { beforeAll, describe, expect, it } from "vitest";
import { setGlobalLogLevel, type ConfigService } from "@space-arena/shared";
import { loadContent, setConfigService } from "../configService.js";
import { openDatabase, setDb } from "../db/index.js";
import { profilesRepo, usersRepo } from "../db/repos.js";
import { seedNewUser } from "../db/seed.js";
import { finalizeMatch, levelForXp, rewardAmount } from "./service.js";

setGlobalLogLevel("error");

let configs: ConfigService;

beforeAll(async () => {
  configs = await loadContent();
  setConfigService(configs);
  setDb(openDatabase(":memory:"));
});

describe("progression math", () => {
  it("computes level from an xp curve", () => {
    const curve = [0, 100, 250, 500];
    expect(levelForXp(curve, 0)).toBe(1);
    expect(levelForXp(curve, 99)).toBe(1);
    expect(levelForXp(curve, 100)).toBe(2);
    expect(levelForXp(curve, 300)).toBe(3);
    expect(levelForXp(curve, 99999)).toBe(4); // capped at curve length
  });

  it("computes reward = base + frags*perKill", () => {
    const rewards = { win: 100, loss: 25, perKill: 10 };
    expect(rewardAmount(rewards, true, 0)).toBe(100);
    expect(rewardAmount(rewards, false, 3)).toBe(55);
  });
});

describe("finalizeMatch", () => {
  it("writes credits + xp to the winner and persists the match result", () => {
    usersRepo.create({ id: "p-a", email: null, pass_hash: null, guest_token: "g-a" });
    seedNewUser(configs, "p-a", "A");
    const before = profilesRepo.byUser("p-a")!;

    const summaries = finalizeMatch(configs, {
      mode: "gamemode.duel-1v1",
      arenaId: "arena.ring-nebula",
      winnerTeam: 0,
      durationS: 42.5,
      participants: [
        { userId: "p-a", team: 0, frags: 2, entityId: 1 },
        { userId: null, team: 1, frags: 0, entityId: 2 }, // bot — not rewarded
      ],
    });

    // Duel rewards: win 100 + 2*perKill(10) = 120.
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ userId: "p-a", credits: 120, xp: 120 });

    const after = profilesRepo.byUser("p-a")!;
    expect(after.credits).toBe(before.credits + 120);
    expect(after.xp).toBe(before.xp + 120);
  });

  it("grants the loss reward to the losing team", () => {
    usersRepo.create({ id: "p-b", email: null, pass_hash: null, guest_token: "g-b" });
    seedNewUser(configs, "p-b", "B");
    const before = profilesRepo.byUser("p-b")!;

    finalizeMatch(configs, {
      mode: "gamemode.duel-1v1",
      arenaId: "arena.ring-nebula",
      winnerTeam: 1,
      durationS: 10,
      participants: [{ userId: "p-b", team: 0, frags: 0, entityId: 1 }],
    });

    // Lost, no frags → loss reward (25).
    expect(profilesRepo.byUser("p-b")!.credits).toBe(before.credits + 25);
  });

  it("skips rewards but still records the match when rewardsEligible=false (3a)", () => {
    usersRepo.create({ id: "p-c", email: null, pass_hash: null, guest_token: "g-c" });
    seedNewUser(configs, "p-c", "C");
    const before = profilesRepo.byUser("p-c")!;

    const summaries = finalizeMatch(configs, {
      mode: "gamemode.duel-1v1",
      arenaId: "arena.ring-nebula",
      winnerTeam: 0,
      durationS: 5,
      participants: [{ userId: "p-c", team: 0, frags: 5, entityId: 1 }],
      rewardsEligible: false,
    });

    expect(summaries).toHaveLength(0);
    // Credits unchanged; the match_results row was still written (flagged 0).
    expect(profilesRepo.byUser("p-c")!.credits).toBe(before.credits);
  });

  it("dedupes rewards by userId (3c)", () => {
    usersRepo.create({ id: "p-d", email: null, pass_hash: null, guest_token: "g-d" });
    seedNewUser(configs, "p-d", "D");
    const before = profilesRepo.byUser("p-d")!;

    const summaries = finalizeMatch(configs, {
      mode: "gamemode.duel-1v1",
      arenaId: "arena.ring-nebula",
      winnerTeam: 0,
      durationS: 5,
      // Same userId twice — only rewarded once.
      participants: [
        { userId: "p-d", team: 0, frags: 1, entityId: 1 },
        { userId: "p-d", team: 0, frags: 1, entityId: 2 },
      ],
    });

    expect(summaries).toHaveLength(1);
    // win 100 + 1*perKill(10) = 110, granted a single time.
    expect(profilesRepo.byUser("p-d")!.credits).toBe(before.credits + 110);
  });
});
