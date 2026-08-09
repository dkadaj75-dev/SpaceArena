import { describe, expect, it } from "vitest";
import { CONFIG_TYPES } from "@space-arena/shared";
import { APPLICATION_POLICY } from "./applicationScope.js";
import { PANEL_REGISTRY } from "./panelRegistry.js";

describe("Constellation generic registry", () => {
  it("registers every current config type with policy, create strategy and preview scope", () => {
    expect(Object.keys(PANEL_REGISTRY).sort()).toEqual([...CONFIG_TYPES].sort());
    expect(Object.keys(APPLICATION_POLICY).sort()).toEqual([...CONFIG_TYPES].sort());
    for (const type of CONFIG_TYPES) {
      expect(PANEL_REGISTRY[type].preview.length).toBeGreaterThan(10);
      expect(PANEL_REGISTRY[type].create).toBeTypeOf("function");
    }
  });
});
