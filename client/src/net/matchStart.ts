import type { Snapshot } from "@space-arena/shared";

/**
 * The slice of an online session this wait needs: the newest authoritative
 * state, plus the callback that fires whenever a new one is decoded. Declared
 * structurally so the ordering rules below can be exercised without a socket.
 */
export interface MatchStartWatch {
  readonly rosterSnapshot: Snapshot;
  onSnapshot: ((snapshot: Snapshot) => void) | null;
}

/** Why the launch screen stopped waiting. Only `live` starts the match. */
export type MatchStartOutcome = "live" | "timeout" | "cancelled";

export interface MatchStartOptions {
  /** Called for the state we already hold and for every patch after it. */
  onRoster: (snapshot: Snapshot) => void;
  /**
   * Safety net for a room that never fills (a pack whose gamemode declares no
   * bots, an opponent who never arrives). On expiry the match starts anyway and
   * the in-match lobby overlay takes over the waiting — the pre-2026-08 flow.
   */
  timeoutMs: number;
  /** Resolves when the player backs out of the search. */
  cancelled?: Promise<unknown> | undefined;
}

/**
 * Hold the launch screen until the room reports it is no longer `waiting`,
 * feeding every replicated roster change out on the way.
 *
 * The room's own state is the only signal: a human joining and the server's bot
 * backfill both land as ordinary `players` patches, and the phase flip that ends
 * the wait rides the same patch as the bots that filled the slots — which is why
 * the resolved card (with its minimum-visible hold) is where those bots become
 * readable, rather than being raced off screen.
 */
export function waitForMatchStart(
  session: MatchStartWatch,
  options: MatchStartOptions,
): Promise<MatchStartOutcome> {
  return new Promise<MatchStartOutcome>((resolve) => {
    let settled = false;
    const finish = (outcome: MatchStartOutcome): void => {
      if (settled) return;
      settled = true;
      session.onSnapshot = null;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => finish("timeout"), options.timeoutMs);
    void options.cancelled?.then(() => finish("cancelled"));

    session.onSnapshot = (snapshot) => {
      options.onRoster(snapshot);
      if (snapshot.phase !== "waiting") finish("live");
    };

    // The state that arrived with the join itself: a one-player room that starts
    // immediately (minPlayers 1, or a rejoin) is already live right here, and
    // would otherwise sit on the search card until the next patch.
    const current = session.rosterSnapshot;
    options.onRoster(current);
    if (current.phase !== "waiting") finish("live");
  });
}
