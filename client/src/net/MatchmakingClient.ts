import type { SeatReservation } from "colyseus.js";
import type { AuthService } from "../core/AuthService.js";

export type MatchmakingStatus =
  | { state: "waiting"; enqueuedAt: number }
  | { state: "found"; opponentName: string; reservation: SeatReservation }
  | { state: "missing" };

export interface MatchmakingJoinOptions {
  shipId?: string;
  fittingId?: string;
}

/** Small REST transport; AuthService supplies bearer auth and token refresh. */
export class MatchmakingClient {
  constructor(
    private readonly auth: AuthService,
    private readonly doc: Document | undefined = globalThis.document,
  ) {}

  enqueue(mode: "duel-1v1", options: MatchmakingJoinOptions = {}): Promise<MatchmakingStatus> {
    return this.auth.api<MatchmakingStatus>("POST", "/api/matchmaking/enqueue", { mode, ...options });
  }

  status(): Promise<MatchmakingStatus> {
    return this.auth.api<MatchmakingStatus>("GET", "/api/matchmaking/status");
  }

  async cancel(): Promise<void> {
    await this.auth.api<unknown>("DELETE", "/api/matchmaking");
  }

  /**
   * Wait for the normal heartbeat interval, but wake immediately when a
   * throttled background tab returns to the foreground.
   */
  waitForPoll(intervalMs: number): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.doc?.removeEventListener("visibilitychange", onVisibilityChange);
        resolve();
      };
      const onVisibilityChange = (): void => {
        if (this.doc?.visibilityState === "visible") finish();
      };
      const timer = setTimeout(finish, intervalMs);
      this.doc?.addEventListener("visibilitychange", onVisibilityChange);
    });
  }
}
