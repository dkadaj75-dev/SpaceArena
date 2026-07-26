import { describe, expect, it, vi } from "vitest";
import {
  MatchmakingQueue,
  type ReservedPair,
  type SeatReservationPayload,
  type WaitingEntry,
} from "./MatchmakingQueue.js";

function seat(roomId: string, sessionId: string): SeatReservationPayload {
  return { sessionId, room: { name: "arena", roomId, clients: 0, maxClients: 2 } };
}

function reserver(pairs: Array<[string, string]>) {
  return async (a: WaitingEntry, b: WaitingEntry): Promise<ReservedPair> => {
    pairs.push([a.playerKey, b.playerKey]);
    return { first: seat("room-1", `s-${a.playerKey}`), second: seat("room-1", `s-${b.playerKey}`) };
  };
}

describe("MatchmakingQueue", () => {
  it("pairs FIFO within a mode", async () => {
    const pairs: Array<[string, string]> = [];
    const queue = new MatchmakingQueue(reserver(pairs));
    await queue.enqueue({ playerKey: "a", displayName: "A", elo: 1000, mode: "duel-1v1" });
    await queue.enqueue({ playerKey: "other", displayName: "O", elo: 1000, mode: "other" });
    const status = await queue.enqueue({ playerKey: "b", displayName: "B", elo: 1000, mode: "duel-1v1" });
    expect(pairs).toEqual([["a", "b"]]);
    expect(status).toMatchObject({ state: "found", opponentName: "A" });
    expect(queue.snapshot().map((entry) => entry.playerKey)).toEqual(["other"]);
  });

  it("keeps incompatible ratings waiting behind the ELO-window scaffold", async () => {
    const pairs: Array<[string, string]> = [];
    const queue = new MatchmakingQueue(reserver(pairs), { baseEloWindow: 100 });
    await queue.enqueue({ playerKey: "a", displayName: "A", elo: 1000, mode: "duel-1v1" });
    await queue.enqueue({ playerKey: "b", displayName: "B", elo: 1200, mode: "duel-1v1" });
    expect(pairs).toEqual([]);
    expect(queue.snapshot()).toHaveLength(2);
  });

  it("expires entries whose heartbeat exceeds the TTL", async () => {
    let now = 1000;
    const queue = new MatchmakingQueue(reserver([]), { ttlMs: 5000, now: () => now });
    await queue.enqueue({ playerKey: "a", displayName: "A", elo: 1000, mode: "duel-1v1" });
    now = 6001;
    expect(await queue.heartbeat("a")).toEqual({ state: "missing" });
  });

  it("replaces rather than duplicates a player's queue entry", async () => {
    let now = 1000;
    const queue = new MatchmakingQueue(reserver([]), { now: () => now });
    await queue.enqueue({ playerKey: "a", displayName: "Old", elo: 900, mode: "duel-1v1" });
    now = 2000;
    await queue.enqueue({ playerKey: "a", displayName: "New", elo: 1000, mode: "duel-1v1" });
    expect(queue.snapshot()).toEqual([
      { playerKey: "a", displayName: "New", elo: 1000, mode: "duel-1v1", enqueuedAt: 2000 },
    ]);
  });

  it("cancels a waiting entry", async () => {
    const queue = new MatchmakingQueue(reserver([]));
    await queue.enqueue({ playerKey: "a", displayName: "A", elo: 1000, mode: "duel-1v1" });
    expect(await queue.cancel("a")).toBe(true);
    expect(await queue.heartbeat("a")).toEqual({ state: "missing" });
  });

  it("serializes concurrent enqueues into one reservation", async () => {
    const reserve = vi.fn(reserver([]));
    const queue = new MatchmakingQueue(reserve);
    await Promise.all([
      queue.enqueue({ playerKey: "a", displayName: "A", elo: 1000, mode: "duel-1v1" }),
      queue.enqueue({ playerKey: "b", displayName: "B", elo: 1000, mode: "duel-1v1" }),
    ]);
    expect(reserve).toHaveBeenCalledTimes(1);
  });
});

