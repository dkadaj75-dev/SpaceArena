// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import type { SimEvent } from "@space-arena/shared";
import {
  advanceStreak,
  announcementFor,
  announcementClass,
  flagAnnouncementFor,
  KillAnnouncements,
  MULTI_KILL_WINDOW_MS,
  type KillStreakState,
} from "./KillAnnouncements.js";

const PLAYER = 7;

function kill(entityId: number, killerId: number | null): SimEvent {
  return { type: "entityDestroyed", entityId, killerId, isAsteroid: false };
}

function freshState(): KillStreakState {
  return { count: 0, lastKillMs: Number.NEGATIVE_INFINITY };
}

describe("advanceStreak", () => {
  it("chains frags inside the window and restarts outside it", () => {
    const state = freshState();
    expect(advanceStreak(state, 1000)).toBe(1);
    expect(advanceStreak(state, 1000 + MULTI_KILL_WINDOW_MS)).toBe(2); // exactly at the edge still chains
    expect(advanceStreak(state, 1000 + MULTI_KILL_WINDOW_MS * 3)).toBe(1); // too late — new chain
  });

  it("measures the window from the LAST frag, not the first (a rolling chain)", () => {
    const state = freshState();
    advanceStreak(state, 0);
    advanceStreak(state, 8000);
    // 16 s after the first kill but only 8 s after the second: still chained.
    expect(advanceStreak(state, 16000)).toBe(3);
  });
});

describe("announcementFor", () => {
  it("speaks League: DESTROYED!, then DOUBLE/TRIPLE/QUADRA/PENTA, first blood outranking", () => {
    expect(announcementFor(1, true)).toBe("FIRST BLOOD");
    expect(announcementFor(1, false)).toBe("DESTROYED!");
    expect(announcementFor(2, false)).toBe("DOUBLE KILL");
    expect(announcementFor(3, false)).toBe("TRIPLE KILL");
    expect(announcementFor(4, false)).toBe("QUADRA KILL");
    expect(announcementFor(5, false)).toBe("PENTA KILL");
    expect(announcementFor(9, false)).toBe("PENTA KILL"); // capped
  });

  it("classes match the flavour", () => {
    expect(announcementClass(1, true)).toBe("first-blood");
    expect(announcementClass(1, false)).toBe("plain");
    expect(announcementClass(3, false)).toBe("multi");
  });
});

describe("KillAnnouncements (component)", () => {
  function mount(): { hud: KillAnnouncements; root: HTMLDivElement } {
    const root = document.createElement("div");
    document.body.appendChild(root);
    return { hud: new KillAnnouncements(root, PLAYER), root };
  }

  it("announces FIRST BLOOD only for the match's very first kill — and only when it is the player's", () => {
    const { hud } = mount();
    hud.consumeEvents([kill(30, PLAYER)], 1000);
    expect(hud.currentText).toBe("FIRST BLOOD");
    hud.consumeEvents([kill(31, PLAYER)], 2000);
    expect(hud.currentText).toBe("DOUBLE KILL"); // chained — first blood spent
    hud.dispose();
  });

  it("a bot drawing first blood spends the flag silently; the player's own frag is then DESTROYED!", () => {
    const { hud } = mount();
    hud.consumeEvents([kill(30, 99)], 1000); // bot on bot — no announcement
    expect(hud.currentText).toBe("");
    hud.consumeEvents([kill(31, PLAYER)], 60_000); // long after — plain frag
    expect(hud.currentText).toBe("DESTROYED!");
    hud.dispose();
  });

  it("escalates a chain to PENTA KILL and resets after the window", () => {
    const { hud } = mount();
    hud.consumeEvents([kill(1, 50)], 0); // someone else took first blood
    const names = ["DESTROYED!", "DOUBLE KILL", "TRIPLE KILL", "QUADRA KILL", "PENTA KILL"];
    for (let i = 0; i < names.length; i++) {
      hud.consumeEvents([kill(10 + i, PLAYER)], 1000 + i * 2000);
      expect(hud.currentText).toBe(names[i]);
    }
    // A frag long after the chain restarts at DESTROYED!.
    hud.consumeEvents([kill(20, PLAYER)], 1000 + 5 * 2000 + MULTI_KILL_WINDOW_MS * 2);
    expect(hud.currentText).toBe("DESTROYED!");
    hud.dispose();
  });

  it("ignores asteroid destructions and the player's own death", () => {
    const { hud } = mount();
    hud.consumeEvents(
      [{ type: "entityDestroyed", entityId: 5, killerId: PLAYER, isAsteroid: true } as SimEvent],
      100,
    );
    expect(hud.currentText).toBe("");
    // A mutual kill where the player is the VICTIM must not celebrate.
    hud.consumeEvents([kill(PLAYER, PLAYER)], 200);
    expect(hud.currentText).toBe("");
    hud.dispose();
  });

  it("reset() rearms first blood for a fresh match", () => {
    const { hud } = mount();
    hud.consumeEvents([kill(30, PLAYER)], 1000);
    expect(hud.currentText).toBe("FIRST BLOOD");
    hud.reset();
    hud.consumeEvents([kill(31, PLAYER)], 2000);
    expect(hud.currentText).toBe("FIRST BLOOD");
    hud.dispose();
  });
});

describe("flagAnnouncementFor — phrased from the viewer's side (2026-07-31)", () => {
  const BLUE = 0;
  const RED = 1;
  const taken = (carrierId: number, carrierTeam: number, flagTeam: number): SimEvent => ({
    type: "flagTaken",
    flagId: 90,
    flagTeam,
    carrierId,
    carrierTeam,
  });

  it("says YOU when the viewer is the one holding it", () => {
    expect(flagAnnouncementFor(taken(PLAYER, BLUE, RED), PLAYER, BLUE)?.text).toBe("YOU HAVE THE ENEMY FLAG");
  });

  it("distinguishes an ally's grab from an enemy stealing yours", () => {
    expect(flagAnnouncementFor(taken(8, BLUE, RED), PLAYER, BLUE)?.text).toBe("ENEMY FLAG TAKEN");
    expect(flagAnnouncementFor(taken(9, RED, BLUE), PLAYER, BLUE)?.text).toBe("ENEMY HAS YOUR FLAG");
  });

  it("reads the SAME event the opposite way for the opposite team", () => {
    const ev = taken(9, RED, BLUE);
    expect(flagAnnouncementFor(ev, PLAYER, BLUE)?.text).toBe("ENEMY HAS YOUR FLAG");
    expect(flagAnnouncementFor(ev, PLAYER, RED)?.text).toBe("ENEMY FLAG TAKEN");
  });

  it("colours good news and bad news differently", () => {
    const capture: SimEvent = { type: "flagCaptured", flagId: 90, flagTeam: RED, carrierId: PLAYER, scoringTeam: BLUE, captures: 1 };
    expect(flagAnnouncementFor(capture, PLAYER, BLUE)).toEqual({ text: "FLAG CAPTURED!", flavour: "flag-good" });
    expect(flagAnnouncementFor(capture, PLAYER, RED)).toEqual({ text: "ENEMY SCORES", flavour: "flag-bad" });
  });

  it("calls drops and returns for whichever flag it was", () => {
    const dropped: SimEvent = { type: "flagDropped", flagId: 90, flagTeam: BLUE, carrierId: 9, returnSec: 10 };
    expect(flagAnnouncementFor(dropped, PLAYER, BLUE)?.text).toBe("YOUR FLAG DROPPED");
    expect(flagAnnouncementFor(dropped, PLAYER, RED)?.text).toBe("ENEMY FLAG DROPPED");
    const returned: SimEvent = { type: "flagReturned", flagId: 90, flagTeam: BLUE, byId: null, timedOut: true };
    expect(flagAnnouncementFor(returned, PLAYER, BLUE)?.text).toBe("YOUR FLAG IS BACK");
    expect(flagAnnouncementFor(returned, PLAYER, RED)?.text).toBe("ENEMY FLAG RETURNED");
  });

  it("stays silent for non-flag events and before the viewer's team is known", () => {
    expect(flagAnnouncementFor(kill(3, PLAYER), PLAYER, BLUE)).toBeNull();
    expect(flagAnnouncementFor(taken(PLAYER, BLUE, RED), PLAYER, null)).toBeNull();
  });
});

describe("flag calls on the live announcer", () => {
  function mount(): { hud: KillAnnouncements } {
    const root = document.createElement("div");
    document.body.appendChild(root);
    return { hud: new KillAnnouncements(root, PLAYER) };
  }

  it("announces once the viewer's team is known, and not before", () => {
    const { hud } = mount();
    const ev: SimEvent = { type: "flagCaptured", flagId: 90, flagTeam: 1, carrierId: PLAYER, scoringTeam: 0, captures: 1 };
    hud.consumeEvents([ev], 100);
    expect(hud.currentText).toBe("");
    hud.setPlayerTeam(0);
    hud.consumeEvents([ev], 200);
    expect(hud.currentText).toBe("FLAG CAPTURED!");
    hud.dispose();
  });

  it("does not spend a kill streak on a flag call", () => {
    const { hud } = mount();
    hud.setPlayerTeam(0);
    hud.consumeEvents([kill(30, PLAYER)], 1000); // FIRST BLOOD
    hud.consumeEvents(
      [{ type: "flagTaken", flagId: 90, flagTeam: 1, carrierId: PLAYER, carrierTeam: 0 } as SimEvent],
      1100,
    );
    expect(hud.currentText).toBe("YOU HAVE THE ENEMY FLAG");
    hud.consumeEvents([kill(31, PLAYER)], 1200);
    // Still a chain of two — the flag call did not reset or advance it.
    expect(hud.currentText).toBe("DOUBLE KILL");
    hud.dispose();
  });
});
