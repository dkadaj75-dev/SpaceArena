import { randomUUID } from "node:crypto";
import type { ConfigService, GamemodeConfig } from "@space-arena/shared";
import { withTransaction } from "../db/index.js";
import { matchResultsRepo, profilesRepo } from "../db/repos.js";
import { getProgression } from "../db/seed.js";

/** One ship that took part in a match (human or dummy/bot). */
export interface Participant {
  /** Authenticated user id, or null for anonymous/dummy ships. */
  userId: string | null;
  team: number;
  frags: number;
  entityId: number;
}

/** Per-user reward summary, mirrored to the client as a `matchRewards` event. */
export interface RewardSummary {
  userId: string;
  credits: number;
  xp: number;
  newLevel: number;
  leveledUp: boolean;
}

export interface MatchRecord {
  mode: string;
  arenaId: string;
  winnerTeam: number | null;
  durationS: number;
  participants: Participant[];
  /**
   * Whether this match grants progression (3a). When false the result is still
   * recorded (with the flag) but no credits/XP are granted — anti-farming for
   * client-overridden trivially-winnable rooms.
   */
  rewardsEligible?: boolean;
  /** Colyseus room id, recorded for telemetry (6.8). */
  roomId?: string;
  /** Humans who joined at any point during the match (6.8). */
  playerCount?: number;
  /** Bots spawned into the match (6.8). */
  botCount?: number;
}

/**
 * Level from cumulative XP against a `xpCurve` (index i = xp needed for level
 * i+1; index 0 is always 0). Level = the count of thresholds the xp meets, min 1,
 * capped at the curve length.
 */
export function levelForXp(xpCurve: readonly number[], xp: number): number {
  let level = 1;
  for (let i = 1; i < xpCurve.length; i++) {
    if (xp >= xpCurve[i]!) level = i + 1;
    else break;
  }
  return level;
}

/**
 * Reward for one participant: `(won ? win : loss) + frags * perKill`. Both
 * credits and XP use this same amount for the MVP.
 */
export function rewardAmount(rewards: GamemodeConfig["rewards"], won: boolean, frags: number): number {
  return (won ? rewards.win : rewards.loss) + frags * rewards.perKill;
}

/**
 * Persist the match result and grant credits + XP to every authenticated human
 * participant, writing profile changes synchronously via the repos. Returns one
 * {@link RewardSummary} per rewarded user (anonymous ships are recorded but not
 * rewarded).
 */
export function finalizeMatch(configs: ConfigService, record: MatchRecord): RewardSummary[] {
  const gamemode = configs.get<GamemodeConfig>("gamemode", record.mode);
  const rewards = gamemode?.rewards ?? { win: 0, loss: 0, perKill: 0 };
  const xpCurve = getProgression(configs)?.xpCurve ?? [0];
  const eligible = record.rewardsEligible !== false;

  // Persist + grant atomically: a partial write (result but no rewards, or vice
  // versa) is never observable.
  return withTransaction(() => {
    matchResultsRepo.create({
      id: randomUUID(),
      mode: record.mode,
      arena_id: record.arenaId,
      participants: record.participants,
      winner_team: record.winnerTeam,
      duration_s: record.durationS,
      rewards_eligible: eligible,
      room_id: record.roomId ?? null,
      player_count: record.playerCount ?? record.participants.filter((p) => p.userId !== null).length,
      bot_count: record.botCount ?? 0,
    });

    if (!eligible) return [];

    const summaries: RewardSummary[] = [];
    const rewarded = new Set<string>(); // dedupe by userId (3c)
    for (const p of record.participants) {
      if (!p.userId || rewarded.has(p.userId)) continue;
      const profile = profilesRepo.byUser(p.userId);
      if (!profile) continue;
      rewarded.add(p.userId);

      const won = record.winnerTeam !== null && record.winnerTeam === p.team;
      const amount = rewardAmount(rewards, won, p.frags);
      const newXp = profile.xp + amount;
      const newCredits = profile.credits + amount;
      const newLevel = levelForXp(xpCurve, newXp);
      profilesRepo.setProgress(p.userId, newLevel, newXp, newCredits);

      summaries.push({
        userId: p.userId,
        credits: amount,
        xp: amount,
        newLevel,
        leveledUp: newLevel > profile.level,
      });
    }
    return summaries;
  });
}
