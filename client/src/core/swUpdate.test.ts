import { describe, expect, it } from "vitest";
import { createUpdateGate } from "./swUpdate.js";

describe("createUpdateGate", () => {
  it("ignores the first service-worker controller claim", () => {
    const gate = createUpdateGate({ isMatchLive: () => false });

    expect(gate.noteControllerChange(false)).toBe(false);
    expect(gate.onSafeMoment()).toBe(false);
  });

  it("reloads immediately when an update takes control in a menu", () => {
    const gate = createUpdateGate({ isMatchLive: () => false });

    expect(gate.noteControllerChange(true)).toBe(true);
  });

  it("defers an update during a match and reloads at the next safe moment", () => {
    let matchLive = true;
    const gate = createUpdateGate({ isMatchLive: () => matchLive });

    expect(gate.noteControllerChange(true)).toBe(false);
    expect(gate.onSafeMoment()).toBe(false);

    matchLive = false;
    expect(gate.onSafeMoment()).toBe(true);
  });

  it("requests at most one reload for an update", () => {
    const gate = createUpdateGate({ isMatchLive: () => false });

    expect(gate.noteUpdateReady()).toBe(true);
    expect(gate.noteUpdateReady()).toBe(false);
    expect(gate.onSafeMoment()).toBe(false);
  });
});
