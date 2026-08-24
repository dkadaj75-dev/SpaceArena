import type { ConfigService, ModuleConfig, ShipConfig } from "@space-arena/shared";
import type { OwnershipStore } from "./ownershipStore.js";
import { moduleStats } from "./moduleSummary.js";
import {
  allCosmetics,
  applicabilityLabel,
  cosmeticSwatch,
  type CosmeticSwatch,
} from "./cosmetics.js";

/**
 * What the shop shows, decided away from the DOM (contract §5).
 *
 * The screen is a dumb renderer over these three builders: every "is it owned",
 * "what does it cost", "which hull is it on" question is answered here, against
 * the {@link OwnershipStore} seam alone — the shop never learns whether it is
 * talking to a server or to the offline ledger.
 *
 * THE BUY STEP IS REAL, ONLY THE COST IS NOT (see `offlineOwnership.ts`): the
 * price chip always renders the authored number and says FREE only because the
 * number is currently zero.
 */

export type ShopTab = "ships" | "modules" | "paints";

export const SHOP_TABS: readonly { tab: ShopTab; label: string }[] = [
  { tab: "ships", label: "Ships" },
  { tab: "modules", label: "Modules" },
  { tab: "paints", label: "Paints" },
];

/** OWNED and EQUIPPED are both "bought"; only BUY offers a purchase. */
export type ShopState = "owned" | "buy" | "equipped";

export interface ShopChip {
  label: string;
  value: string;
}

export interface ShopEntry {
  id: string;
  name: string;
  /** Class/family line under the name. */
  sub: string;
  price: number;
  state: ShopState;
  chips: ShopChip[];
  /**
   * The pilot level the SERVER enforces on this purchase, when it enforces one
   * (`server/src/api/modules.ts`: 403 `level-locked`). Absent means no gate.
   *
   * This is `module.requiresLevel` and nothing else. The card used to print
   * `module.level` — the ladder position inside a family, Mk I before Mk III —
   * next to the family name, which read as a requirement and was not one: a
   * card saying "LV 2" was refused with "requires level 3" (finding 44).
   */
  requiresLevel?: number;
}

export interface ShopGroup {
  title: string;
  entries: ShopEntry[];
}

/** One owned hull a paint may be equipped on — the per-ship equip row. */
export interface PaintTarget {
  shipId: string;
  shipName: string;
  kind: "ship" | "module";
  owned: boolean;
  equipped: boolean;
}

export interface PaintEntry extends ShopEntry {
  paint: CosmeticSwatch;
  target: PaintTarget;
}

/** The read half of the ownership seam — everything the model needs. */
export type ShopOwnership = Pick<
  OwnershipStore,
  "ownedShips" | "ownedModules" | "ownedCosmetics" | "selectedCosmetic"
>;

/** Price chip text. FREE is what a zero reads as, not a special-cased state. */
export function priceLabel(price: number): string {
  return price <= 0 ? "FREE" : `${price} cr`;
}

/**
 * A hull's price. `ShipConfig` carries no price today — contract §1 puts prices
 * on modules and cosmetics — so every hull reads FREE until content authors
 * one, and this picks it up the moment it does.
 */
export function shipPrice(ship: ShipConfig): number {
  const price = (ship as { price?: unknown }).price;
  return typeof price === "number" && price > 0 ? price : 0;
}

export function shipEntries(configs: Pick<ConfigService, "getAll">, owned: ShopOwnership): ShopEntry[] {
  const ownedShips = owned.ownedShips();
  return sortedShips(configs).map((ship) => ({
    id: ship.id,
    name: ship.name ?? ship.id,
    sub: `${ship.class} hull`,
    price: shipPrice(ship),
    state: ownedShips.has(ship.id) ? ("owned" as const) : ("buy" as const),
    chips: shipChips(ship),
  }));
}

function shipChips(ship: ShipConfig): ShopChip[] {
  const core = ship.core;
  return [
    { label: "Hull", value: core.hull.base.toFixed(0) },
    { label: "Speed", value: core.engine.nominalSpeed.toFixed(0) },
    { label: "Turn", value: core.engine.turnRate.toFixed(1) },
    { label: "Power", value: core.power.capacity.toFixed(0) },
  ];
}

/**
 * Modules grouped by family. Level order inside a family, because a family is
 * read as a ladder — Mk I before Mk III — not as an alphabet.
 */
export function moduleGroups(configs: Pick<ConfigService, "getAll">, owned: ShopOwnership): ShopGroup[] {
  const ownedModules = owned.ownedModules();
  const byFamily = new Map<string, ShopEntry[]>();
  const modules = [...configs.getAll<ModuleConfig>("module")].sort(
    (a, b) => a.level - b.level || (a.name ?? a.id).localeCompare(b.name ?? b.id),
  );
  for (const mod of modules) {
    const entry: ShopEntry = {
      id: mod.id,
      name: mod.name ?? mod.id,
      sub: moduleSubLine(mod),
      price: mod.price,
      state: ownedModules.has(mod.id) ? "owned" : "buy",
      // Four chips is what one row fits; moduleSummary already orders them by
      // what matters for the family.
      chips: moduleStats(mod).slice(0, 4),
      ...(mod.requiresLevel > 1 ? { requiresLevel: mod.requiresLevel } : {}),
    };
    const list = byFamily.get(mod.family);
    if (list) list.push(entry);
    else byFamily.set(mod.family, [entry]);
  }
  return [...byFamily.entries()]
    .map(([family, entries]) => ({ title: family, entries }))
    .sort((a, b) => a.title.localeCompare(b.title));
}

/**
 * The line under a module's name: its family, and the ONLY number on the card
 * that a purchase is actually judged against.
 *
 * `module.level` is a ladder position, not a permission, and printing it as
 * "Lv 2" beside the family made it read as one — the card said LV 2 and the
 * server refused with "requires level 3" (finding 44). A gate of 1 is no gate,
 * so it says nothing rather than "Lv 1 required".
 */
function moduleSubLine(mod: ModuleConfig): string {
  return mod.requiresLevel > 1 ? `${mod.family} · Requires Lv ${mod.requiresLevel}` : mod.family;
}

/**
 * Does this row survive the shop's text filter?
 *
 * The catalogue is 58 module cards over ~12 screens with group headings as its
 * only navigation (finding 46). Name AND family line, because "kinetic" is as
 * likely a search as "Autocannon"; the sub carries the family (and, where there
 * is one, the level requirement).
 */
export function matchesShopFilter(entry: ShopEntry, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return `${entry.name} ${entry.sub}`.toLowerCase().includes(needle);
}

/**
 * Paints, each with the owned hulls it may be worn by. EQUIPPED wins over
 * OWNED: a paint on a hull is a stronger fact than a paint in the locker.
 */
export function paintEntries(
  configs: Pick<ConfigService, "getAll">,
  owned: ShopOwnership,
): PaintEntry[] {
  const ships = sortedShips(configs);
  const shipName = (id: string): string => ships.find((s) => s.id === id)?.name ?? id;
  const ownedCosmetics = owned.ownedCosmetics();
  const ownedShips = owned.ownedShips();
  const ownedModules = owned.ownedModules();

  return allCosmetics(configs).map((cosmetic) => {
    const targetShip = ships.find((ship) => ship.id === cosmetic.target);
    const targetKind = cosmetic.target.startsWith("ship.") ? "ship" : "module";
    const target: PaintTarget = {
      shipId: cosmetic.target,
      shipName: targetShip?.name ?? cosmetic.target,
      kind: targetKind,
      owned: targetKind === "ship" ? ownedShips.has(cosmetic.target) : ownedModules.has(cosmetic.target),
      equipped: targetShip ? selectedCosmeticId(owned, targetShip.id) === cosmetic.id : false,
    };
    const isOwned = ownedCosmetics.has(cosmetic.id);
    return {
      id: cosmetic.id,
      name: cosmetic.name ?? cosmetic.id,
      sub: applicabilityLabel(cosmetic, shipName),
      price: cosmetic.price,
      state: target.equipped ? "equipped" : isOwned ? "owned" : "buy",
      chips: [],
      paint: cosmeticSwatch(cosmetic),
      target,
    } satisfies PaintEntry;
  });
}

/**
 * The cosmetic a hull is wearing, with ABSENT resolved to the standard paint —
 * contract §1: standard is a real row in the shop but never a stored selection.
 */
export function selectedCosmeticId(owned: ShopOwnership, shipId: string): string {
  return owned.selectedCosmetic(shipId);
}

/**
 * What {@link OwnershipStore.selectCosmetic} is given for a shop row. The
 * standard paint is stored as "no selection" so a re-authored default look
 * never strands a pilot on a stale id.
 */
export function selectionValueFor(cosmeticId: string): string {
  return cosmeticId;
}

/** Whether the paint can be equipped anywhere yet — drives the equip row's hint. */
export function equipHint(entry: PaintEntry): string {
  if (entry.state === "buy") return "";
  if (entry.target.kind === "module") return "Owned module skins are stored now; module mesh rendering is forthcoming.";
  if (entry.target.owned) return "";
  return `Target hull not owned: ${entry.target.shipName}.`;
}

function sortedShips(configs: Pick<ConfigService, "getAll">): ShipConfig[] {
  return [...configs.getAll<ShipConfig>("ship")].sort((a, b) => a.id.localeCompare(b.id));
}
