import { describe, expect, it } from "vitest";
import type { BotDecisionSnapshot, LosCircle, Snapshot } from "@space-arena/shared";
import {
  BOT_OVERLAY_EVENT,
  BOT_OVERLAY_STORAGE_KEY,
  botOverlayEnabled,
  collectBlockers,
  setBotOverlayEnabled,
  updateBotOverlayRows,
  type BotOverlayRow,
  type BotOverlaySource,
} from "./botOverlayModel.js";

function snapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    phase: "live",
    countdownRemaining: 0,
    ships: [],
    asteroids: [],
    projectiles: [],
    ...over,
  } as unknown as Snapshot;
}

function ship(id: number, x: number, z: number): Snapshot["ships"][number] {
  return { id, pos: { x, z }, team: id === 1 ? 0 : 1 } as unknown as Snapshot["ships"][number];
}

function decision(over: Partial<BotDecisionSnapshot> = {}): BotDecisionSnapshot {
  return {
    atMs: 100,
    behavior: "engage",
    scores: { engage: 2, kite: 0.5 },
    movePoint: { x: 10, z: 4 },
    plannedMove: { x: 10, z: 4 },
    boost: false,
    targetId: 1,
    engaged: true,
    moduleDecisions: [],
    orders: [],
    ...over,
  };
}

function bot(entityId: number, last: BotDecisionSnapshot | null): BotOverlaySource {
  return { entityId, profile: { id: "bot.aggressive", name: "Aggressive" }, lastDecision: last };
}

describe("botOverlayModel", () => {
  it("maps a decision onto a row with normalised, chosen-flagged score bars", () => {
    const rows: BotOverlayRow[] = [];
    const count = updateBotOverlayRows(rows, [bot(2, decision())], snapshot({ ships: [ship(1, 0, 0), ship(2, 5, 5)] }), []);

    expect(count).toBe(1);
    const row = rows[0]!;
    expect(row.profileName).toBe("Aggressive");
    expect(row.behavior).toBe("engage");
    expect(row.engaged).toBe(true);
    expect(row.alive).toBe(true);
    expect(row.posX).toBe(5);
    expect(row.scoreCount).toBe(2);
    expect(row.scores.slice(0, 2)).toEqual([
      { key: "engage", score: 2, fraction: 1, chosen: true },
      { key: "kite", score: 0.5, fraction: 0.25, chosen: false },
    ]);
    // Chosen move point + target line.
    expect([row.hasMove, row.moveX, row.moveZ]).toEqual([true, 10, 4]);
    expect([row.hasTarget, row.targetX, row.targetZ]).toEqual([true, 0, 0]);
    expect(row.losClear).toBe(true);
  });

  it("flags a blocked line of sight to the target", () => {
    const rows: BotOverlayRow[] = [];
    const blockers: LosCircle[] = [{ pos: { x: 5, z: 0 }, radius: 3 }];
    updateBotOverlayRows(rows, [bot(2, decision())], snapshot({ ships: [ship(1, 0, 0), ship(2, 10, 0)] }), blockers);
    expect(rows[0]!.losClear).toBe(false);
  });

  it("reuses row and score-bar objects across updates (no per-frame allocation)", () => {
    const rows: BotOverlayRow[] = [];
    const snap = snapshot({ ships: [ship(1, 0, 0), ship(2, 5, 5)] });
    updateBotOverlayRows(rows, [bot(2, decision())], snap, []);
    const row = rows[0]!;
    const bar = row.scores[0]!;

    updateBotOverlayRows(rows, [bot(2, decision({ atMs: 500, behavior: "kite", scores: { engage: 1, kite: 4 } }))], snap, []);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toBe(row);
    expect(row.scores[0]).toBe(bar);
    expect(row.behavior).toBe("kite");
    expect(row.scores[1]!.chosen).toBe(true);
  });

  it("draws the planned move point on decisions that re-issued no order, and marks a despawned bot dead", () => {
    const rows: BotOverlayRow[] = [];
    updateBotOverlayRows(rows, [bot(2, decision())], snapshot({ ships: [ship(1, 0, 0), ship(2, 5, 5)] }), []);
    // No order was emitted, but the behaviour still planned a destination.
    updateBotOverlayRows(
      rows,
      [bot(2, decision({ atMs: 700, movePoint: null, plannedMove: { x: 11, z: 5 } }))],
      snapshot({ ships: [ship(1, 0, 0)] }),
      [],
    );
    expect(rows[0]!.hasMove).toBe(true);
    expect(rows[0]!.moveX).toBe(11);
    expect(rows[0]!.alive).toBe(false);

    // Neither point set ⇒ the last known destination is kept rather than jumping.
    updateBotOverlayRows(
      rows,
      [bot(2, decision({ atMs: 900, movePoint: null, plannedMove: null }))],
      snapshot({ ships: [ship(1, 0, 0)] }),
      [],
    );
    expect(rows[0]!.hasMove).toBe(true);
    expect(rows[0]!.moveX).toBe(11);
  });

  it("collects non-destroyed asteroids as LoS blockers, in place", () => {
    const blockers: LosCircle[] = [];
    const asteroids = [
      { pos: { x: 1, z: 1 }, radius: 2, state: "intact" },
      { pos: { x: 4, z: 0 }, radius: 3, state: "destroyed" },
      { pos: { x: 9, z: 2 }, radius: 1, state: "intact" },
    ] as unknown as Snapshot["asteroids"];
    collectBlockers(snapshot({ asteroids }), blockers);
    expect(blockers).toEqual([
      { pos: { x: 1, z: 1 }, radius: 2 },
      { pos: { x: 9, z: 2 }, radius: 1 },
    ]);

    const first = blockers[0]!;
    collectBlockers(snapshot({ asteroids }), blockers);
    expect(blockers[0]).toBe(first);
    expect(blockers).toHaveLength(2);
  });

  it("persists the overlay flag and announces changes on the window", () => {
    localStorage.removeItem(BOT_OVERLAY_STORAGE_KEY);
    expect(botOverlayEnabled()).toBe(false);

    const seen: boolean[] = [];
    const listener = (event: Event): void => void seen.push((event as CustomEvent<boolean>).detail);
    window.addEventListener(BOT_OVERLAY_EVENT, listener);
    setBotOverlayEnabled(true);
    expect(botOverlayEnabled()).toBe(true);
    setBotOverlayEnabled(false);
    window.removeEventListener(BOT_OVERLAY_EVENT, listener);

    expect(seen).toEqual([true, false]);
    expect(botOverlayEnabled()).toBe(false);
  });
});
