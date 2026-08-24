import { afterEach, describe, expect, it } from "vitest";
import { notePresence, onlineCount, resetPresence } from "./presence.js";

afterEach(() => resetPresence());

describe("presence", () => {
  it("counts each id once, however often it heartbeats", () => {
    notePresence("a", 1_000);
    notePresence("a", 2_000);
    notePresence("b", 2_000);
    expect(onlineCount(2_000)).toBe(2);
  });

  it("expires a lease 90s after the last sighting, and a heartbeat renews it", () => {
    notePresence("a", 0);
    notePresence("b", 0);
    notePresence("a", 60_000);
    // 91s after b's only sighting, 31s after a's renewal.
    expect(onlineCount(91_000)).toBe(1);
  });

  it("truncates an oversized id instead of throwing, and ignores an empty one", () => {
    notePresence("x".repeat(500), 0);
    notePresence("x".repeat(400), 0); // same first 64 chars — same client
    notePresence("", 0);
    expect(onlineCount(0)).toBe(1);
  });

  it("drops new ids at the ceiling rather than evicting live ones", () => {
    for (let i = 0; i < 10_000; i++) notePresence(`p${i}`, 0);
    notePresence("straggler", 0);
    expect(onlineCount(0)).toBe(10_000);
    // The ceiling is about live leases: once leases expire, room opens again.
    notePresence("straggler", 100_000);
    expect(onlineCount(100_000)).toBe(1);
  });
});
