import { describe, expect, it } from "vitest";
import { APPLICATION_POLICY, applicationNotice } from "./applicationScope.js";

describe("editor application scope", () => {
  it("marks match-structural configs as next-match instead of implying hot reload", () => {
    for (const type of ["ship", "arena", "asteroid", "gamemode", "upgrade"] as const) {
      expect(APPLICATION_POLICY[type].scope).toBe("next-match");
      expect(applicationNotice(type).textContent).toMatch(/next match/i);
    }
  });

  it("documents the partial live guarantees for tuning and quality", () => {
    expect(APPLICATION_POLICY.tuning).toMatchObject({ scope: "partial" });
    expect(APPLICATION_POLICY.quality).toMatchObject({ scope: "partial" });
    expect(applicationNotice("quality").dataset.applyScope).toBe("partial");
  });
});
