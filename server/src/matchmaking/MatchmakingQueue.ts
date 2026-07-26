export interface MatchmakingJoinOptions {
  shipId?: string;
  fittingId?: string;
}

export interface WaitingEntry {
  playerKey: string;
  displayName: string;
  /** Rating scaffold. All callers currently enqueue at 1000. */
  elo: number;
  /** Opaque queue partition, e.g. "duel-1v1". */
  mode: string;
  enqueuedAt: number;
  joinOptions?: MatchmakingJoinOptions;
}

interface LiveWaitingEntry extends WaitingEntry {
  lastSeenAt: number;
}

export interface SeatReservationPayload {
  sessionId: string;
  room: {
    name: string;
    roomId: string;
    clients: number;
    maxClients: number;
    publicAddress?: string;
    processId?: string;
  };
  devMode?: boolean;
  protocol?: string;
}

export interface MatchFound {
  opponentName: string;
  reservation: SeatReservationPayload;
}

export type QueueStatus =
  | { state: "waiting"; enqueuedAt: number }
  | ({ state: "found" } & MatchFound)
  | { state: "missing" };

export interface ReservedPair {
  first: SeatReservationPayload;
  second: SeatReservationPayload;
}

export type PairReserver = (first: WaitingEntry, second: WaitingEntry) => Promise<ReservedPair>;

export interface MatchmakingQueueOptions {
  ttlMs?: number;
  foundTtlMs?: number;
  baseEloWindow?: number;
  eloExpansionPerSecond?: number;
  now?: () => number;
}

/**
 * Background browser tabs (especially mobile browsers after an app switch)
 * commonly throttle timers to roughly one callback per minute. Keep a queued
 * player alive through that gap while still eventually pruning abandoned tabs.
 */
export const MATCHMAKING_QUEUE_TTL_MS = 90_000;
const DEFAULT_FOUND_TTL_MS = 15_000;
const DEFAULT_ELO_WINDOW = 200;

/**
 * Process-local generalized waiting queue.
 *
 * Mutations are serialized because room reservation is asynchronous. That
 * makes replacing, cancelling, and pairing atomic from the HTTP handlers'
 * perspective without bringing a distributed lock into today's single game
 * server. The entry contract and reserver seam remain ready for a shared store.
 */
export class MatchmakingQueue {
  private readonly waiting: LiveWaitingEntry[] = [];
  private readonly found = new Map<string, MatchFound & { matchedAt: number }>();
  private readonly ttlMs: number;
  private readonly foundTtlMs: number;
  private readonly baseEloWindow: number;
  private readonly eloExpansionPerSecond: number;
  private readonly now: () => number;
  private serial: Promise<void> = Promise.resolve();

  constructor(
    private readonly reservePair: PairReserver,
    options: MatchmakingQueueOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? MATCHMAKING_QUEUE_TTL_MS;
    this.foundTtlMs = options.foundTtlMs ?? DEFAULT_FOUND_TTL_MS;
    this.baseEloWindow = options.baseEloWindow ?? DEFAULT_ELO_WINDOW;
    this.eloExpansionPerSecond = options.eloExpansionPerSecond ?? 0;
    this.now = options.now ?? Date.now;
  }

  enqueue(entry: Omit<WaitingEntry, "enqueuedAt"> & { enqueuedAt?: number }): Promise<QueueStatus> {
    return this.exclusive(async () => {
      const now = this.now();
      this.prune(now);
      this.removeWaiting(entry.playerKey);
      this.found.delete(entry.playerKey);
      this.waiting.push({
        ...entry,
        enqueuedAt: entry.enqueuedAt ?? now,
        lastSeenAt: now,
      });
      await this.pairAvailable(now);
      return this.statusValue(entry.playerKey);
    });
  }

  heartbeat(playerKey: string): Promise<QueueStatus> {
    return this.exclusive(async () => {
      const now = this.now();
      this.prune(now);
      const entry = this.waiting.find((candidate) => candidate.playerKey === playerKey);
      if (entry) entry.lastSeenAt = now;
      await this.pairAvailable(now);
      return this.statusValue(playerKey);
    });
  }

  cancel(playerKey: string): Promise<boolean> {
    return this.exclusive(() => {
      const removed = this.removeWaiting(playerKey) || this.found.delete(playerKey);
      return Promise.resolve(removed);
    });
  }

  /** Test/ops visibility without exposing mutable queue entries. */
  snapshot(): WaitingEntry[] {
    return this.waiting.map(({ lastSeenAt: _lastSeenAt, ...entry }) => ({ ...entry }));
  }

  private eloWindow(entry: LiveWaitingEntry, now: number): number {
    const waitedSeconds = Math.max(0, now - entry.enqueuedAt) / 1000;
    return this.baseEloWindow + waitedSeconds * this.eloExpansionPerSecond;
  }

  private compatible(first: LiveWaitingEntry, second: LiveWaitingEntry, now: number): boolean {
    if (first.mode !== second.mode) return false;
    const window = Math.max(this.eloWindow(first, now), this.eloWindow(second, now));
    return Math.abs(first.elo - second.elo) <= window;
  }

  private async pairAvailable(now: number): Promise<void> {
    while (this.waiting.length >= 2) {
      let pair: [number, number] | null = null;
      for (let i = 0; i < this.waiting.length - 1 && !pair; i++) {
        for (let j = i + 1; j < this.waiting.length; j++) {
          if (this.compatible(this.waiting[i]!, this.waiting[j]!, now)) {
            pair = [i, j];
            break;
          }
        }
      }
      if (!pair) return;

      const [firstIndex, secondIndex] = pair;
      const second = this.waiting.splice(secondIndex, 1)[0]!;
      const first = this.waiting.splice(firstIndex, 1)[0]!;
      try {
        const reservations = await this.reservePair(first, second);
        const matchedAt = this.now();
        this.found.set(first.playerKey, {
          opponentName: second.displayName,
          reservation: reservations.first,
          matchedAt,
        });
        this.found.set(second.playerKey, {
          opponentName: first.displayName,
          reservation: reservations.second,
          matchedAt,
        });
      } catch (error) {
        // Keep FIFO position on an infrastructure failure so a transient room
        // creation problem does not silently discard either player's search.
        this.waiting.unshift(first, second);
        throw error;
      }
    }
  }

  private prune(now: number): void {
    for (let i = this.waiting.length - 1; i >= 0; i--) {
      if (now - this.waiting[i]!.lastSeenAt > this.ttlMs) this.waiting.splice(i, 1);
    }
    for (const [playerKey, result] of this.found) {
      if (now - result.matchedAt > this.foundTtlMs) this.found.delete(playerKey);
    }
  }

  private removeWaiting(playerKey: string): boolean {
    const index = this.waiting.findIndex((entry) => entry.playerKey === playerKey);
    if (index < 0) return false;
    this.waiting.splice(index, 1);
    return true;
  }

  private statusValue(playerKey: string): QueueStatus {
    const result = this.found.get(playerKey);
    if (result) {
      return { state: "found", opponentName: result.opponentName, reservation: result.reservation };
    }
    const entry = this.waiting.find((candidate) => candidate.playerKey === playerKey);
    return entry ? { state: "waiting", enqueuedAt: entry.enqueuedAt } : { state: "missing" };
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.serial.then(operation, operation);
    this.serial = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
