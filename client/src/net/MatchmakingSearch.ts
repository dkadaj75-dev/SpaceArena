import {
  MatchmakingClient,
  type MatchmakingJoinOptions,
  type MatchmakingStatus,
} from "./MatchmakingClient.js";

/** The server forgot the entry and the single transparent recovery did not stick. */
export class MatchmakingInterruptedError extends Error {
  constructor(options?: ErrorOptions) {
    super("Search interrupted", options);
    this.name = "MatchmakingInterruptedError";
  }
}

export interface MatchmakingSearchOptions {
  mode: "duel-1v1";
  joinOptions?: MatchmakingJoinOptions;
  pollMs: () => number;
  isActive?: () => boolean;
}

/**
 * Poll until a match is found. A missing queue entry gets exactly one silent
 * re-enqueue; a second missing result (or a failed recovery request) is exposed
 * to the UI instead of pretending the original search is still alive.
 */
export async function searchForMatch(
  client: MatchmakingClient,
  options: MatchmakingSearchOptions,
): Promise<Extract<MatchmakingStatus, { state: "found" }> | null> {
  const active = options.isActive ?? (() => true);
  const joinOptions = options.joinOptions ?? {};
  let recovered = false;
  let status = await client.enqueue(options.mode, joinOptions);

  while (active()) {
    if (status.state === "found") return status;
    if (status.state === "missing") {
      if (recovered) throw new MatchmakingInterruptedError();
      recovered = true;
      try {
        status = await client.enqueue(options.mode, joinOptions);
      } catch (cause) {
        throw new MatchmakingInterruptedError({ cause });
      }
      if (status.state === "missing") throw new MatchmakingInterruptedError();
      continue;
    }

    await client.waitForPoll(options.pollMs());
    if (!active()) return null;
    status = await client.status();
  }
  return null;
}
