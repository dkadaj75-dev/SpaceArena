import { describe, expect, it } from "vitest";
import { generateGuestPilotName } from "./guestNames.js";

describe("generateGuestPilotName", () => {
  it("builds a space-flavored adjective+noun callsign", () => {
    expect(generateGuestPilotName(() => false, () => 0)).toBe("Crimson Vector");
  });

  it("adds a short numeric suffix when the base name collides", () => {
    const used = new Set(["Crimson Vector"]);
    expect(generateGuestPilotName((name) => used.has(name), () => 0)).toBe("Crimson Vector-100");
  });
});

