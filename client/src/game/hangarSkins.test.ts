import { describe, expect, it } from "vitest";
import { FakeOwnershipStore } from "./__fixtures__/ownershipStoreFake.js";
import { shopConfigs } from "./__fixtures__/shopContent.js";
import { buyAndEquipSkin, hangarSkinEntries } from "./hangarSkins.js";

describe("hangar skins", () => {
  it("shows the staged hull's base skin owned and equipped by default", () => {
    const store = new FakeOwnershipStore({
      ships: ["ship.interceptor"],
      cosmetics: ["cosmetic.paint-interceptor-standard"],
    });
    const entries = hangarSkinEntries(shopConfigs(), store, "ship.interceptor");
    expect(entries.map((entry) => entry.id)).not.toContain("cosmetic.paint-brawler-standard");
    expect(entries.find((entry) => entry.id === "cosmetic.paint-interceptor-standard")).toMatchObject({
      owned: true,
      equipped: true,
    });
  });

  it("buys an unowned skin through the store and equips it on the staged hull", async () => {
    const store = new FakeOwnershipStore({ ships: ["ship.interceptor"] });
    await buyAndEquipSkin(store, "ship.interceptor", "cosmetic.paint-interceptor-crimson", false);
    expect(store.calls).toEqual([
      "buyCosmetic:cosmetic.paint-interceptor-crimson",
      "selectCosmetic:ship.interceptor:cosmetic.paint-interceptor-crimson",
    ]);
  });
});
