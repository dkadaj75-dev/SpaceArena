import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigService, STANDARD_COSMETIC_ID, type ApiInventory } from "@space-arena/shared";
import { HangarApiError, type HangarApi } from "./HangarApi.js";
import { clearOwnership, STARTER_SHIP_ID } from "./offlineOwnership.js";
import { createOwnershipStore } from "./ownershipStore.js";

// Same content loader as the other client suites — see `hangarStats.test.ts`.
function findContentDir(start: string): string {
  let dir = start;
  for (let i = 0; i < 6; i++) {
    if (existsSync(path.join(dir, "content", "manifest.json"))) return path.join(dir, "content");
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`content/manifest.json not found by walking up from ${start}`);
}
const CONTENT_DIR = findContentDir(process.cwd());

let configs: ConfigService;
beforeAll(async () => {
  configs = new ConfigService(async (rel) => JSON.parse(await readFile(path.join(CONTENT_DIR, rel), "utf8")));
  const result = await configs.load("manifest.json");
  if (!result.ok) throw new Error("test content failed to load: " + JSON.stringify(result.errors));
});

/** A HangarApi stand-in holding a server-side ledger the store must mirror. */
function fakeApi(): { api: HangarApi; inventory: ApiInventory; credits: { value: number } } {
  const inventory: ApiInventory = {
    ships: [STARTER_SHIP_ID],
    modules: ["module.laser-mk1"],
    cosmetics: [STANDARD_COSMETIC_ID],
    selections: {},
  };
  const credits = { value: 500 };
  const api = {
    inventory: vi.fn(async () => ({
      profile: { userId: "u", displayName: "T", level: 1, xp: 0, credits: credits.value, isGuest: false },
      inventory: JSON.parse(JSON.stringify(inventory)) as ApiInventory,
    })),
    buyShip: vi.fn(async (shipId: string) => {
      if (!inventory.ships.includes(shipId)) inventory.ships.push(shipId);
      return { shipId, credits: credits.value };
    }),
    buyModule: vi.fn(async (moduleId: string) => {
      if (!inventory.modules.includes(moduleId)) inventory.modules.push(moduleId);
      return { moduleId, credits: credits.value };
    }),
    buyCosmetic: vi.fn(async (cosmeticId: string) => {
      if (!inventory.cosmetics.includes(cosmeticId)) inventory.cosmetics.push(cosmeticId);
      return { cosmeticId, credits: credits.value };
    }),
    selectCosmetic: vi.fn(async (shipId: string, cosmeticId: string | null) => {
      if (cosmeticId === null) delete inventory.selections[shipId];
      else inventory.selections[shipId] = cosmeticId;
      return { shipId, cosmeticId };
    }),
  } as unknown as HangarApi;
  return { api, inventory, credits };
}

beforeEach(() => {
  clearOwnership();
});

describe("ownership store — offline backing", () => {
  it("serves the derived starter set and zero credits", async () => {
    const store = createOwnershipStore({ api: null, configs });
    await store.refresh();
    expect([...store.ownedShips()]).toEqual([STARTER_SHIP_ID]);
    expect(store.ownedModules().has("module.laser-mk1")).toBe(true);
    expect([...store.ownedCosmetics()]).toEqual([STANDARD_COSMETIC_ID]);
    expect(store.selectedCosmetic(STARTER_SHIP_ID)).toBeNull();
    expect(store.credits()).toBe(0);
  });

  it("buys, equips and notifies — a read right after an awaited buy sees it", async () => {
    const store = createOwnershipStore({ api: null, configs });
    await store.refresh();
    const changes = vi.fn();
    const off = store.onChange(changes);

    await store.buyShip("ship.brawler");
    await store.buyModule("module.laser-mk2");
    await store.buyCosmetic("cosmetic.paint-crimson");
    expect(store.ownedShips().has("ship.brawler")).toBe(true);
    expect(store.ownedModules().has("module.laser-mk2")).toBe(true);
    expect(store.ownedCosmetics().has("cosmetic.paint-crimson")).toBe(true);

    await store.selectCosmetic(STARTER_SHIP_ID, "cosmetic.paint-crimson");
    expect(store.selectedCosmetic(STARTER_SHIP_ID)).toBe("cosmetic.paint-crimson");
    expect(changes).toHaveBeenCalledTimes(4);

    off();
    await store.buyCosmetic("cosmetic.paint-jade");
    expect(changes).toHaveBeenCalledTimes(4); // unsubscribed
  });

  it("refuses to equip a paint that does not apply to the hull", async () => {
    const store = createOwnershipStore({ api: null, configs });
    await store.refresh();
    await store.buyCosmetic("cosmetic.paint-ironclad"); // authored for ship.brawler
    await expect(store.selectCosmetic(STARTER_SHIP_ID, "cosmetic.paint-ironclad")).rejects.toThrow();
    expect(store.selectedCosmetic(STARTER_SHIP_ID)).toBeNull();
  });

  it("treats the standard paint as no selection", async () => {
    const store = createOwnershipStore({ api: null, configs });
    await store.refresh();
    await store.buyCosmetic("cosmetic.paint-void");
    await store.selectCosmetic(STARTER_SHIP_ID, "cosmetic.paint-void");
    await store.selectCosmetic(STARTER_SHIP_ID, STANDARD_COSMETIC_ID);
    expect(store.selectedCosmetic(STARTER_SHIP_ID)).toBeNull();
  });
});

describe("ownership store — authenticated backing", () => {
  it("mirrors the server ledger, credits included, from ONE read per refresh", async () => {
    const { api } = fakeApi();
    const store = createOwnershipStore({ api, configs });
    await store.refresh();
    expect(store.credits()).toBe(500);
    expect([...store.ownedShips()]).toEqual([STARTER_SHIP_ID]);
    expect(api.inventory).toHaveBeenCalledTimes(1);

    await store.buyShip("ship.support");
    expect(store.ownedShips().has("ship.support")).toBe(true);

    await store.buyCosmetic("cosmetic.paint-solar");
    await store.selectCosmetic("ship.support", "cosmetic.paint-solar");
    expect(store.selectedCosmetic("ship.support")).toBe("cosmetic.paint-solar");
  });

  it("does not touch the local ledger while signed in", async () => {
    const { api } = fakeApi();
    const store = createOwnershipStore({ api, configs });
    await store.refresh();
    await store.buyShip("ship.brawler");
    expect(localStorage.getItem("hangar.owned")).toBeNull();
  });

  it("treats the legacy already-owned module 409 as a successful no-op", async () => {
    const { api } = fakeApi();
    (api.buyModule as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new HangarApiError("already-owned", "you already own this module", 409),
    );
    const store = createOwnershipStore({ api, configs });
    await store.refresh();
    await expect(store.buyModule("module.laser-mk1")).resolves.toBeUndefined();
  });

  it("surfaces every other API failure to the caller", async () => {
    const { api } = fakeApi();
    (api.buyCosmetic as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new HangarApiError("insufficient-credits", "need 500 credits", 409),
    );
    const store = createOwnershipStore({ api, configs });
    await store.refresh();
    await expect(store.buyCosmetic("cosmetic.paint-violet")).rejects.toThrow(HangarApiError);
  });

  it("ignores a stale server selection the pilot no longer owns or may not wear", async () => {
    const { api, inventory } = fakeApi();
    inventory.selections["ship.interceptor"] = "cosmetic.paint-crimson"; // never bought
    const store = createOwnershipStore({ api, configs });
    await store.refresh();
    expect(store.selectedCosmetic("ship.interceptor")).toBeNull();

    inventory.cosmetics.push("cosmetic.paint-ironclad");
    inventory.selections["ship.interceptor"] = "cosmetic.paint-ironclad"; // wrong hull
    await store.refresh();
    expect(store.selectedCosmetic("ship.interceptor")).toBeNull();
  });
});
