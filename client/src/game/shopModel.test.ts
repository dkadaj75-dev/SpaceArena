import { describe, expect, it } from "vitest";
import { FakeOwnershipStore } from "./__fixtures__/ownershipStoreFake.js";
import { shopConfigs } from "./__fixtures__/shopContent.js";
import {
  moduleGroups,
  paintEntries,
  priceLabel,
  selectedCosmeticId,
  selectionValueFor,
  shipEntries,
} from "./shopModel.js";

const configs = shopConfigs();

describe("shop price chips", () => {
  it("renders the authored value and says FREE only at zero", () => {
    // The buy step is real, only the cost is not: FREE is what a 0 reads as,
    // never a state the shop invents.
    expect(priceLabel(0)).toBe("FREE");
    expect(priceLabel(-5)).toBe("FREE");
    expect(priceLabel(250)).toBe("250 cr");
  });
});

describe("shop ships tab", () => {
  it("marks the owned hull OWNED and the rest BUY, with key stat chips", () => {
    const store = new FakeOwnershipStore({ ships: ["ship.interceptor"] });
    const entries = shipEntries(configs, store);
    expect(entries.map((e) => [e.id, e.state])).toEqual([
      ["ship.brawler", "buy"],
      ["ship.interceptor", "owned"],
    ]);
    const interceptor = entries.find((e) => e.id === "ship.interceptor")!;
    expect(interceptor.sub).toBe("light hull");
    expect(interceptor.price).toBe(0);
    expect(interceptor.chips).toEqual([
      { label: "Hull", value: "120" },
      { label: "Speed", value: "27" },
      { label: "Turn", value: "3.0" },
      { label: "Power", value: "10" },
    ]);
  });
});

describe("shop modules tab", () => {
  it("groups by family, ladders by level, and carries the authored price", () => {
    const store = new FakeOwnershipStore({ modules: ["module.laser-mk1"] });
    const groups = moduleGroups(configs, store);
    expect(groups.map((g) => g.title)).toEqual(["kinetic", "laser"]);
    const laser = groups.find((g) => g.title === "laser")!;
    expect(laser.entries.map((e) => [e.name, e.state, e.price])).toEqual([
      ["Pulse Laser Mk I", "owned", 0],
      ["Pulse Laser Mk II", "buy", 250],
    ]);
    // Chips come from moduleSummary so the shop and the Hangar picker agree.
    expect(laser.entries[0]!.chips[0]).toEqual({ label: "DPS", value: "5" });
  });
});

describe("shop paints tab", () => {
  it("exposes exactly one ownership-aware target hull", () => {
    const store = new FakeOwnershipStore({
      ships: ["ship.interceptor", "ship.brawler"],
      cosmetics: ["cosmetic.paint-interceptor-crimson", "cosmetic.paint-interceptor-lance"],
    });
    const entries = paintEntries(configs, store);
    const crimson = entries.find((e) => e.id === "cosmetic.paint-interceptor-crimson")!;
    const lance = entries.find((e) => e.id === "cosmetic.paint-interceptor-lance")!;
    expect(crimson.sub).toBe("Fits Interceptor");
    expect(crimson.target).toMatchObject({ shipId: "ship.interceptor", owned: true });
    expect(lance.sub).toBe("Fits Interceptor");
    expect(lance.target.shipId).toBe("ship.interceptor");
  });

  it("hides hulls the pilot does not own", () => {
    const store = new FakeOwnershipStore({ ships: ["ship.interceptor"] });
    const base = paintEntries(configs, store).find((e) => e.id === "cosmetic.paint-brawler-standard")!;
    expect(base.target).toMatchObject({ shipId: "ship.brawler", owned: false });
  });

  it("states are BUY unbought, OWNED bought, EQUIPPED once worn", () => {
    const store = new FakeOwnershipStore({
      ships: ["ship.interceptor"],
      cosmetics: ["cosmetic.paint-interceptor-standard", "cosmetic.paint-interceptor-crimson"],
      selections: { "ship.interceptor": "cosmetic.paint-interceptor-crimson" },
    });
    const byId = new Map(paintEntries(configs, store).map((e) => [e.id, e]));
    expect(byId.get("cosmetic.paint-interceptor-crimson")!.state).toBe("equipped");
    expect(byId.get("cosmetic.paint-interceptor-lance")!.state).toBe("buy");
    // Standard is owned by everyone — it is the authored look, not a purchase.
    expect(byId.get("cosmetic.paint-interceptor-standard")!.state).toBe("owned");
    expect(byId.get("cosmetic.paint-interceptor-crimson")!.target.equipped).toBe(true);
  });

  it("an absent selection reads as the hull-scoped base id", () => {
    const store = new FakeOwnershipStore({ ships: ["ship.interceptor"] });
    expect(selectedCosmeticId(store, "ship.interceptor")).toBe("cosmetic.paint-interceptor-standard");
    expect(selectionValueFor("cosmetic.paint-interceptor-standard")).toBe("cosmetic.paint-interceptor-standard");
  });

  it("a pack with no cosmetics yields an empty tab rather than throwing", () => {
    const store = new FakeOwnershipStore({ ships: ["ship.interceptor"] });
    expect(paintEntries(shopConfigs([]), store)).toEqual([]);
  });
});
