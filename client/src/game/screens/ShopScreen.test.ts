// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConfigService, ConfigType, ModuleConfig } from "@space-arena/shared";
import { FakeOwnershipStore } from "../__fixtures__/ownershipStoreFake.js";
import { shopConfigs } from "../__fixtures__/shopContent.js";
import { ShopScreen, type ShopPilot } from "./ShopScreen.js";

afterEach(() => {
  document.body.replaceChildren();
  document.head.replaceChildren();
});

function mount(store: FakeOwnershipStore, onClose = vi.fn()): ShopScreen {
  const shop = new ShopScreen(document.body, shopConfigs(), store, { onClose });
  shop.show();
  return shop;
}

/**
 * A shop that knows who is buying. The shipped fixture levels every module at
 * 1, so the gate needs one that does not — re-levelled locally, because the
 * fixture is shared with the Hangar's suites.
 */
function mountGated(store: FakeOwnershipStore, pilot: ShopPilot | null, requires: Record<string, number> = {}): ShopScreen {
  const base = shopConfigs();
  const configs = {
    get: () => undefined,
    getAll: (type: ConfigType) =>
      type === "module"
        ? base.getAll<ModuleConfig>("module").map((m) => ({ ...m, requiresLevel: requires[m.id] ?? m.requiresLevel }))
        : base.getAll(type),
  } as unknown as ConfigService;
  const shop = new ShopScreen(document.body, configs, store, { onClose: vi.fn(), pilot: () => pilot });
  shop.show();
  shop.selectTab("modules");
  return shop;
}

const cards = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(".shop-card")];
const card = (id: string): HTMLElement => document.querySelector<HTMLElement>(`.shop-card[data-entry="${id}"]`)!;
const buyButton = (id: string): HTMLButtonElement => card(id).querySelector<HTMLButtonElement>(".shop-buy")!;
const filterBox = (): HTMLInputElement => document.querySelector<HTMLInputElement>("[data-shop-filter]")!;

function type(text: string): void {
  filterBox().value = text;
  filterBox().dispatchEvent(new Event("input", { bubbles: true }));
}

describe("shop tabs", () => {
  it("opens on SHIPS and swaps the grid per tab", () => {
    const shop = mount(new FakeOwnershipStore({ ships: ["ship.interceptor"] }));
    expect(document.querySelector(".shop-grid")!.getAttribute("data-tab")).toBe("ships");
    expect(cards()).toHaveLength(2);

    document.querySelector<HTMLButtonElement>('.sa-tab[data-tab="paints"]')!.click();
    expect(document.querySelector(".shop-grid")!.getAttribute("data-tab")).toBe("paints");
    expect(cards().map((c) => c.dataset["entry"])).toEqual([
      "cosmetic.paint-brawler-standard",
      "cosmetic.paint-interceptor-crimson",
      "cosmetic.paint-interceptor-lance",
      "cosmetic.paint-interceptor-standard",
    ]);
    expect(document.querySelectorAll('.sa-tab[aria-selected="true"]')).toHaveLength(1);

    shop.selectTab("modules");
    // One heading per family, alongside the module cards themselves.
    expect([...document.querySelectorAll(".shop-group-title")].map((h) => h.textContent)).toEqual([
      "kinetic",
      "laser",
    ]);
    shop.dispose();
  });
});

describe("shop states", () => {
  it("renders OWNED as a badge and BUY as a priced button", () => {
    const shop = mount(new FakeOwnershipStore({ ships: ["ship.interceptor"], credits: 40 }));
    expect(card("ship.interceptor").dataset["state"]).toBe("owned");
    expect(card("ship.interceptor").querySelector(".shop-badge")!.textContent).toBe("Owned");
    expect(card("ship.brawler").dataset["state"]).toBe("buy");
    expect(buyButton("ship.brawler").textContent).toBe("Buy · FREE");
    // The chip renders the real value; FREE is only what a zero looks like.
    expect(card("ship.brawler").querySelector(".shop-price")!.textContent).toBe("FREE");
    shop.selectTab("modules");
    expect(card("module.laser-mk2").querySelector(".shop-price")!.textContent).toBe("250 cr");
    expect(document.querySelector(".shop-credits .v")!.textContent).toBe("40 cr");
    shop.dispose();
  });

  it("draws a diagonal split swatch carrying the paint's own colours", () => {
    const shop = mount(new FakeOwnershipStore({ ships: ["ship.interceptor"] }));
    shop.selectTab("paints");
    const swatch = card("cosmetic.paint-interceptor-crimson").querySelector<HTMLElement>(".shop-swatch")!;
    expect(swatch.style.getPropertyValue("--shop-primary")).toBe("#7a1f2b");
    expect(swatch.style.getPropertyValue("--shop-accent")).toBe("#e0546a");
    expect(swatch.dataset["glow"]).toBe("true");
    // No emissive authored: no glow corner rather than an invented colour.
    expect(card("cosmetic.paint-interceptor-lance").querySelector<HTMLElement>(".shop-swatch")!.dataset["glow"]).toBe("false");
    shop.dispose();
  });
});

describe("shop purchases", () => {
  it("buys through the store and repaints from the ledger, not from the click", async () => {
    const store = new FakeOwnershipStore({ ships: ["ship.interceptor"] });
    const shop = mount(store);
    buyButton("ship.brawler").click();
    await vi.waitFor(() => expect(card("ship.brawler").dataset["state"]).toBe("owned"));
    expect(store.calls).toEqual(["buyShip:ship.brawler"]);
    shop.dispose();
  });

  it("disables every action while one is in flight", async () => {
    const store = new FakeOwnershipStore({ ships: ["ship.interceptor"], manual: true });
    const shop = mount(store);
    buyButton("ship.brawler").click();
    expect(buyButton("ship.brawler").textContent).toBe("Buying…");
    expect(buyButton("ship.brawler").disabled).toBe(true);
    store.settle();
    await vi.waitFor(() => expect(card("ship.brawler").dataset["state"]).toBe("owned"));
    shop.dispose();
  });

  it("surfaces a failed purchase in the notice and re-enables the action", async () => {
    const store = new FakeOwnershipStore({ ships: ["ship.interceptor"], failWith: "no credits" });
    const shop = mount(store);
    buyButton("ship.brawler").click();
    const notice = document.querySelector<HTMLElement>(".shop-notice")!;
    await vi.waitFor(() => expect(notice.classList.contains("visible")).toBe(true));
    expect(notice.textContent).toContain("no credits");
    expect(card("ship.brawler").dataset["state"]).toBe("buy");
    expect(buyButton("ship.brawler").disabled).toBe(false);
    shop.dispose();
  });
});

describe("shop equip flow", () => {
  it("buys and immediately equips a paint when its target hull is owned", async () => {
    const store = new FakeOwnershipStore({ ships: ["ship.interceptor"] });
    const shop = mount(store);
    shop.selectTab("paints");
    buyButton("cosmetic.paint-interceptor-crimson").click();
    await vi.waitFor(() => expect(card("cosmetic.paint-interceptor-crimson").dataset["state"]).toBe("equipped"));
    expect(store.calls).toEqual([
      "buyCosmetic:cosmetic.paint-interceptor-crimson",
      "selectCosmetic:ship.interceptor:cosmetic.paint-interceptor-crimson",
    ]);
    shop.dispose();
  });

  it("equips a bought paint on an owned hull and marks the card EQUIPPED", async () => {
    const store = new FakeOwnershipStore({
      ships: ["ship.interceptor", "ship.brawler"],
      cosmetics: ["cosmetic.paint-interceptor-lance"],
    });
    const shop = mount(store);
    shop.selectTab("paints");
    // The signature paint fits one hull only, so only that hull is offered.
    const row = card("cosmetic.paint-interceptor-lance").querySelectorAll<HTMLButtonElement>(".shop-equip-btn");
    expect([...row].map((b) => b.dataset["ship"])).toEqual(["ship.interceptor"]);
    row[0]!.click();
    await vi.waitFor(() => expect(card("cosmetic.paint-interceptor-lance").dataset["state"]).toBe("equipped"));
    expect(store.calls).toEqual(["selectCosmetic:ship.interceptor:cosmetic.paint-interceptor-lance"]);
    const equipped = card("cosmetic.paint-interceptor-lance").querySelector<HTMLButtonElement>(".shop-equip-btn")!;
    expect(equipped.getAttribute("aria-pressed")).toBe("true");
    expect(equipped.disabled).toBe(true);
    shop.dispose();
  });

  it("equips the hull-scoped base paint by id", async () => {
    const store = new FakeOwnershipStore({
      ships: ["ship.interceptor"],
      selections: { "ship.interceptor": "cosmetic.paint-interceptor-crimson" },
      cosmetics: ["cosmetic.paint-interceptor-standard", "cosmetic.paint-interceptor-crimson"],
    });
    const shop = mount(store);
    shop.selectTab("paints");
    card("cosmetic.paint-interceptor-standard").querySelector<HTMLButtonElement>(".shop-equip-btn")!.click();
    await vi.waitFor(() => expect(store.calls).toEqual(["selectCosmetic:ship.interceptor:cosmetic.paint-interceptor-standard"]));
    expect(store.selectedCosmetic("ship.interceptor")).toBe("cosmetic.paint-interceptor-standard");
    shop.dispose();
  });

  it("explains why an unbought paint has no equip row", () => {
    const store = new FakeOwnershipStore({ ships: ["ship.interceptor"] });
    const shop = mount(store);
    shop.selectTab("paints");
    expect(card("cosmetic.paint-interceptor-crimson").dataset["state"]).toBe("buy");
    expect(card("cosmetic.paint-interceptor-crimson").querySelectorAll(".shop-equip-btn")).toHaveLength(0);
    shop.dispose();
  });
});

/**
 * Findings 43/44/45: with 250 cr I could tap "Buy · 1500 cr" on a module the
 * server gates at level 3, and the only feedback was the 403 that came back.
 * There were zero disabled buy buttons among 58 cards. The server stays the
 * backstop; none of this replaces it.
 */
describe("shop refuses before the server has to", () => {
  it("disables a level-locked buy and prints the level that is actually enforced", () => {
    const shop = mountGated(new FakeOwnershipStore({ credits: 9999 }), { level: 1 }, { "module.laser-mk2": 3 });
    const btn = buyButton("module.laser-mk2");
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toBe("Requires Lv 3");
    expect(card("module.laser-mk2").dataset["blocked"]).toBe("level");
    expect(card("module.laser-mk2").querySelector(".shop-card-sub")!.textContent).toBe("laser · Requires Lv 3");
    expect(card("module.laser-mk2").querySelector(".shop-card-blocked")!.textContent).toBe("Unlocks at level 3.");
    shop.dispose();
  });

  it("opens the same card once the pilot has the level", () => {
    const shop = mountGated(new FakeOwnershipStore({ credits: 9999 }), { level: 3 }, { "module.laser-mk2": 3 });
    expect(buyButton("module.laser-mk2").disabled).toBe(false);
    expect(buyButton("module.laser-mk2").textContent).toBe("Buy · 250 cr");
    shop.dispose();
  });

  it("disables an unaffordable buy and turns its price bad", () => {
    const shop = mountGated(new FakeOwnershipStore({ credits: 40 }), { level: 9 });
    const priced = card("module.laser-mk2");
    expect(buyButton("module.laser-mk2").disabled).toBe(true);
    expect(priced.querySelector<HTMLElement>(".shop-price")!.dataset["afford"]).toBe("false");
    expect(priced.querySelector(".shop-card-blocked")!.textContent).toBe("Costs 250 cr — you have 40 cr.");
    // A free module is affordable at any balance.
    expect(buyButton("module.laser-mk1").disabled).toBe(false);
    expect(card("module.laser-mk1").querySelector<HTMLElement>(".shop-price")!.dataset["afford"]).toBe("true");
    shop.dispose();
  });

  it("gates nothing without an account — the offline ledger has no level and no wallet", () => {
    // Its credits are permanently 0 by construction (ownershipStore.ts), so a
    // naive affordability check would lock a shop where every buy is free.
    const shop = mountGated(new FakeOwnershipStore({ credits: 0 }), null, { "module.laser-mk2": 3 });
    expect(cards().every((c) => c.dataset["blocked"] === undefined)).toBe(true);
    expect(buyButton("module.laser-mk2").disabled).toBe(false);
    shop.dispose();
  });

  it("stays silent for a caller that never passed a pilot", () => {
    const shop = mount(new FakeOwnershipStore({ credits: 0 }));
    shop.selectTab("modules");
    expect(buyButton("module.laser-mk2").disabled).toBe(false);
    shop.dispose();
  });
});

/** Finding 46: 58 modules over ~12 screens, group headings the only navigation. */
describe("shop filter", () => {
  it("narrows the list by name or family, and drops the headings it emptied", () => {
    const shop = mount(new FakeOwnershipStore());
    shop.selectTab("modules");
    expect(cards()).toHaveLength(3);

    type("kinetic");
    expect(cards().map((c) => c.dataset["entry"])).toEqual(["module.kinetic-mk1"]);
    expect([...document.querySelectorAll(".shop-group-title")].map((h) => h.textContent)).toEqual(["kinetic"]);

    type("");
    expect(cards()).toHaveLength(3);
    shop.dispose();
  });

  it("says so when nothing matches, instead of showing an empty grid", () => {
    const shop = mount(new FakeOwnershipStore());
    shop.selectTab("paints");
    type("torpedo");
    expect(cards()).toHaveLength(0);
    expect(document.querySelector(".shop-empty")!.textContent).toContain("No paints match");
    shop.dispose();
  });

  it("is not offered on the two-hull ships tab, and never survives a tab change", () => {
    const shop = mount(new FakeOwnershipStore());
    expect(document.querySelector<HTMLElement>(".shop-filter")!.hidden).toBe(true);

    shop.selectTab("modules");
    expect(document.querySelector<HTMLElement>(".shop-filter")!.hidden).toBe(false);
    type("kinetic");
    // A query typed against modules would silently hide most of the paints.
    shop.selectTab("paints");
    expect(filterBox().value).toBe("");
    expect(cards().length).toBeGreaterThan(1);
    shop.dispose();
  });
});

describe("shop lifecycle", () => {
  it("re-reads ownership on entry and unsubscribes on dispose", () => {
    const store = new FakeOwnershipStore({ ships: ["ship.interceptor"] });
    const shop = mount(store);
    expect(store.refreshes).toBe(1);
    shop.dispose();
    expect(document.querySelector(".shop-overlay")).toBeNull();
  });

  it("closes back to the caller", () => {
    const onClose = vi.fn();
    const shop = mount(new FakeOwnershipStore(), onClose);
    document.querySelector<HTMLButtonElement>(".shop-close")!.click();
    expect(onClose).toHaveBeenCalledTimes(1);
    shop.dispose();
  });
});
