import { afterEach, describe, expect, it, vi } from "vitest";
import type { Snapshot } from "@space-arena/shared";
import { waitForMatchStart, type MatchStartWatch } from "./matchStart.js";

function snapshot(phase: Snapshot["phase"], ships: Array<{ id: number; team: number }> = []): Snapshot {
  return { phase, ships } as unknown as Snapshot;
}

/** Stand-in for the online session: a mutable newest state plus its callback. */
function watcher(initial: Snapshot): MatchStartWatch & { push(next: Snapshot): void } {
  const state = {
    rosterSnapshot: initial,
    onSnapshot: null as ((snapshot: Snapshot) => void) | null,
    push(next: Snapshot): void {
      state.rosterSnapshot = next;
      state.onSnapshot?.(next);
    },
  };
  return state;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("waitForMatchStart", () => {
  it("reports every roster patch and resolves when the room leaves its lobby", async () => {
    const session = watcher(snapshot("waiting", [{ id: 1, team: 0 }]));
    const rosters: number[] = [];
    const wait = waitForMatchStart(session, {
      onRoster: (snap) => rosters.push(snap.ships.length),
      timeoutMs: 10_000,
    });

    session.push(snapshot("waiting", [{ id: 1, team: 0 }, { id: 2, team: 1 }]));
    session.push(snapshot("countdown", [{ id: 1, team: 0 }, { id: 2, team: 1 }]));

    await expect(wait).resolves.toBe("live");
    // The state held at join counts too: [1 ship, 2 ships, the live patch].
    expect(rosters).toEqual([1, 2, 2]);
    // Unsubscribed, so a late patch cannot resurrect the launch screen.
    expect(session.onSnapshot).toBeNull();
  });

  it("resolves immediately when the joined room is already live", async () => {
    const session = watcher(snapshot("live"));
    await expect(
      waitForMatchStart(session, { onRoster: () => {}, timeoutMs: 10_000 }),
    ).resolves.toBe("live");
  });

  it("gives up after the timeout so a room that never fills still starts", async () => {
    vi.useFakeTimers();
    const session = watcher(snapshot("waiting"));
    const wait = waitForMatchStart(session, { onRoster: () => {}, timeoutMs: 1_000 });
    vi.advanceTimersByTime(1_000);
    await expect(wait).resolves.toBe("timeout");
    expect(session.onSnapshot).toBeNull();
  });

  it("stops waiting when the player backs out", async () => {
    const session = watcher(snapshot("waiting"));
    let cancel: () => void = () => {};
    const cancelled = new Promise<void>((resolve) => {
      cancel = resolve;
    });
    const wait = waitForMatchStart(session, { onRoster: () => {}, timeoutMs: 10_000, cancelled });
    cancel();
    await expect(wait).resolves.toBe("cancelled");
    expect(session.onSnapshot).toBeNull();
  });
});
