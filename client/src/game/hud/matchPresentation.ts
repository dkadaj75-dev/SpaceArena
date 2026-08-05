import type { EntityId, MatchStatLine } from "@space-arena/shared";

export type MatchPresentationState = "playing" | "outcome" | "mvp" | "scoreboard" | "left";
export const OUTCOME_DURATION_MS = 3000;

/** Score used by the scoreboard: captures, returns, kills, assists, then deaths. */
export function scoreboardScore(line: Readonly<MatchStatLine>, ctf: boolean): number {
  return line.kills * 100 - line.deaths * 10 + line.assists * 25
    + (ctf ? line.flagsCaptured * 1000 + line.flagsReturned * 100 : 0);
}

/**
 * Shared scoreboard/MVP order. Equal scores break by kills, fewer deaths,
 * assists, captures, returns, then entity id. The final id key makes the result
 * deterministic even when replicated stat lines arrive in a different order.
 */
export function compareMatchStats(
  a: Readonly<MatchStatLine>,
  b: Readonly<MatchStatLine>,
  ctf: boolean,
): number {
  return scoreboardScore(b, ctf) - scoreboardScore(a, ctf)
    || b.kills - a.kills
    || a.deaths - b.deaths
    || b.assists - a.assists
    || b.flagsCaptured - a.flagsCaptured
    || b.flagsReturned - a.flagsReturned
    || a.entityId - b.entityId;
}

export function selectMvp(
  lines: readonly Readonly<MatchStatLine>[],
  ctf: boolean,
): EntityId | null {
  let best: Readonly<MatchStatLine> | null = null;
  for (const line of lines) {
    if (!best || compareMatchStats(line, best, ctf) < 0) best = line;
  }
  return best?.entityId ?? null;
}

/** Small explicit controller so end-screen navigation cannot overlap states. */
export class MatchPresentationFlow {
  private value: MatchPresentationState = "playing";
  private outcomeElapsedMs = 0;
  get state(): MatchPresentationState { return this.value; }
  end(): boolean {
    if (this.value !== "playing") return false;
    this.value = "outcome";
    return true;
  }
  update(dtMs: number): boolean {
    if (this.value !== "outcome") return false;
    this.outcomeElapsedMs += Number.isFinite(dtMs) ? Math.max(0, dtMs) : 0;
    if (this.outcomeElapsedMs < OUTCOME_DURATION_MS) return false;
    this.value = "mvp";
    return true;
  }
  next(): boolean {
    if (this.value !== "mvp") return false;
    this.value = "scoreboard";
    return true;
  }
  leave(): boolean {
    if (this.value === "playing" || this.value === "left") return false;
    this.value = "left";
    return true;
  }
}
