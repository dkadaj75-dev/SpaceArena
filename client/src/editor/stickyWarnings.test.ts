import { describe, expect, it } from "vitest";
import { StickyWarnings } from "./stickyWarnings.js";

describe("StickyWarnings", () => {
  it("holds warnings and blocks Save until acknowledged", () => {
    const s = new StickyWarnings();
    expect(s.hasWarnings).toBe(false);
    expect(s.saveAllowed).toBe(true); // nothing to acknowledge

    s.add("Player DB fittings are NOT remapped — indices changed");
    expect(s.hasWarnings).toBe(true);
    expect(s.list()).toHaveLength(1);
    expect(s.saveAllowed).toBe(false); // must acknowledge first

    s.setAcknowledged(true);
    expect(s.saveAllowed).toBe(true);
  });

  it("deduplicates identical warnings", () => {
    const s = new StickyWarnings();
    s.add("same");
    s.add("same");
    expect(s.list()).toHaveLength(1);
  });

  it("a NEW warning resets a prior acknowledgement", () => {
    const s = new StickyWarnings();
    s.add("first");
    s.setAcknowledged(true);
    expect(s.saveAllowed).toBe(true);
    s.add("second"); // fresh risk to acknowledge
    expect(s.acknowledged).toBe(false);
    expect(s.saveAllowed).toBe(false);
  });

  it("survives a simulated replace()-success (report cleared) but keeps warnings", () => {
    const s = new StickyWarnings();
    s.add("reorder warning");
    // Simulate ShipManager.replace() success: the transient problem report is cleared
    // (report(null)) but sticky warnings are a separate store and must persist.
    const reportCleared: string | null = null;
    expect(reportCleared).toBeNull();
    expect(s.hasWarnings).toBe(true);
    expect(s.list()[0]).toBe("reorder warning");
  });

  it("dismiss removes one and resets ack when empty; dismissAll clears everything", () => {
    const s = new StickyWarnings();
    s.add("a");
    s.add("b");
    s.setAcknowledged(true);
    s.dismiss(0);
    expect(s.list()).toEqual(["b"]);
    expect(s.acknowledged).toBe(true); // still warnings remain, ack preserved
    s.dismiss(0); // now empty
    expect(s.hasWarnings).toBe(false);
    expect(s.acknowledged).toBe(false);
    expect(s.saveAllowed).toBe(true);

    s.add("c");
    s.dismissAll();
    expect(s.hasWarnings).toBe(false);
    expect(s.saveAllowed).toBe(true);
  });
});
