import { describe, expect, it, vi } from "vitest";
import type { MatchmakingClient, MatchmakingStatus } from "./MatchmakingClient.js";
import {
  MatchmakingInterruptedError,
  searchForMatch,
} from "./MatchmakingSearch.js";

function client(overrides: Partial<MatchmakingClient>): MatchmakingClient {
  return overrides as MatchmakingClient;
}

describe("searchForMatch", () => {
  it("silently re-enqueues once when the server reports an expired entry", async () => {
    const found: MatchmakingStatus = {
      state: "found",
      opponentName: "Nova",
      reservation: {} as Extract<MatchmakingStatus, { state: "found" }>["reservation"],
    };
    const enqueue = vi
      .fn()
      .mockResolvedValueOnce({ state: "waiting", enqueuedAt: 1 })
      .mockResolvedValueOnce({ state: "waiting", enqueuedAt: 2 });
    const status = vi.fn().mockResolvedValueOnce({ state: "missing" }).mockResolvedValueOnce(found);
    const result = await searchForMatch(
      client({ enqueue, status, waitForPoll: vi.fn().mockResolvedValue(undefined) }),
      { mode: "duel-1v1", pollMs: () => 2000 },
    );
    expect(result).toBe(found);
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it("surfaces an interrupted search when the one recovery enqueue fails", async () => {
    const enqueue = vi
      .fn()
      .mockResolvedValueOnce({ state: "waiting", enqueuedAt: 1 })
      .mockRejectedValueOnce(new Error("offline"));
    const promise = searchForMatch(
      client({
        enqueue,
        status: vi.fn().mockResolvedValue({ state: "missing" }),
        waitForPoll: vi.fn().mockResolvedValue(undefined),
      }),
      { mode: "duel-1v1", pollMs: () => 2000 },
    );
    await expect(promise).rejects.toBeInstanceOf(MatchmakingInterruptedError);
    expect(enqueue).toHaveBeenCalledTimes(2);
  });
});
