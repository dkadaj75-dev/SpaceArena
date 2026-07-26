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
  constructor(private readonly auth: AuthService) {}

  enqueue(mode: "duel-1v1", options: MatchmakingJoinOptions = {}): Promise<MatchmakingStatus> {
    return this.auth.api<MatchmakingStatus>("POST", "/api/matchmaking/enqueue", { mode, ...options });
  }

  status(): Promise<MatchmakingStatus> {
    return this.auth.api<MatchmakingStatus>("GET", "/api/matchmaking/status");
  }

  async cancel(): Promise<void> {
    await this.auth.api<unknown>("DELETE", "/api/matchmaking");
  }
}

