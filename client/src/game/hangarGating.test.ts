import { describe, expect, it } from "vitest";
import { FakeOwnershipStore } from "./__fixtures__/ownershipStoreFake.js";
import { hullOwned, moduleOwned } from "./hangarGating.js";

describe("hangar gating", () => {
  const store = new FakeOwnershipStore({
    ships: ["ship.interceptor"],
    modules: ["module.laser-mk1"],
  });

  it("leaves an owned hull and an owned module flyable/fittable, store or no store", () => {
    // The regression this pins: routing the Hangar through the shop's ledger
    // must not take away anything the pilot already had.
    expect(hullOwned(null, "ship.interceptor", true)).toBe(true);
    expect(hullOwned(store, "ship.interceptor", true)).toBe(true);
    expect(moduleOwned(null, "module.laser-mk1", true)).toBe(true);
    expect(moduleOwned(store, "module.laser-mk1", true)).toBe(true);
  });

  it("gates what the ledger does not own, whatever the legacy answer was", () => {
    // Pre-shop, an authenticated session called every hull flyable because
    // `/api/ships` had no owned flag. The store is the answer now.
    expect(hullOwned(store, "ship.brawler", true)).toBe(false);
    expect(moduleOwned(store, "module.laser-mk2", true)).toBe(false);
  });

  it("keeps the pre-shop answers for a Hangar wired without a store", () => {
    expect(hullOwned(null, "ship.brawler", true)).toBe(true);
    expect(hullOwned(null, "ship.brawler", false)).toBe(false);
    expect(moduleOwned(null, "module.laser-mk2", false)).toBe(false);
  });
});
