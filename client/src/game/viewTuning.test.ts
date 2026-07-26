import { describe, expect, it, vi } from "vitest";
import type { ConfigService, TuningConfig } from "@space-arena/shared";
import { beamFadeMsOf } from "./EntityView.js";

describe("ViewManager tuning hot reload", () => {
  it("re-reads beam fade tuning for newly fired beams", () => {
    let beamFadeMs = 90;
    const configs = {
      getAll: vi.fn(() => [{ beamFadeMs }] as TuningConfig[]),
    } as unknown as Pick<ConfigService, "getAll">;

    expect(beamFadeMsOf(configs)).toBe(90);
    beamFadeMs = 240;
    expect(beamFadeMsOf(configs)).toBe(240);
  });
});
