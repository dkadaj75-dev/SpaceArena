import type { ConfigService, ModuleConfig, ShipConfig } from "@space-arena/shared";
import type { OwnershipStore } from "./ownershipStore.js";
import { moduleStats } from "./moduleSummary.js";
import {
  allCosmetics,
  appliesToShip,
  applicabilityLabel,
  STANDARD_COSMETIC_ID,
  type CosmeticConfig,
  type CosmeticPaint,
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
}

export interface ShopGroup {
  title: string;
  entries: ShopEntry[];
}

/** One owned hull a paint may be equipped on — the per-ship equip row. */
export interface PaintTarget {
  shipId: string;
  shipName: string;
  equipped: boolean;
}

export interface PaintEntry extends ShopEntry {
  paint: CosmeticPaint;
  targets: PaintTarget[];
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
      sub: `${mod.family} · Lv ${mod.level}`,
      price: mod.price,
      state: ownedModules.has(mod.id) ? "owned" : "buy",
      // Four chips is what one row fits; moduleSummary already orders them by
      // what matters for the family.
      chips: moduleStats(mod).slice(0, 4),
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

  return allCosmetics(configs).map((cosmetic) => {
    const targets: PaintTarget[] = ships
      .filter((ship) => ownedShips.has(ship.id) && appliesToShip(cosmetic, ship.id))
      .map((ship) => ({
        shipId: ship.id,
        shipName: ship.name ?? ship.id,
        // Resolved, not raw: a hull with no selection is wearing STANDARD, and
        // the standard card has to say so rather than offer to equip what is
        // already on the hull.
        equipped: selectedCosmeticId(owned, ship.id) === cosmetic.id,
      }));
    const isOwned = ownedCosmetics.has(cosmetic.id) || cosmetic.id === STANDARD_COSMETIC_ID;
    return {
      id: cosmetic.id,
      name: cosmetic.name ?? cosmetic.id,
      sub: applicabilityLabel(cosmetic, shipName),
      price: cosmetic.price,
      state: targets.some((t) => t.equipped) ? "equipped" : isOwned ? "owned" : "buy",
      chips: [],
      paint: cosmetic.paint,
      targets,
    } satisfies PaintEntry;
  });
}

/**
 * The cosmetic a hull is wearing, with ABSENT resolved to the standard paint —
 * contract §1: standard is a real row in the shop but never a stored selection.
 */
export function selectedCosmeticId(owned: ShopOwnership, shipId: string): string {
  return owned.selectedCosmetic(shipId) ?? STANDARD_COSMETIC_ID;
}

/**
 * What {@link OwnershipStore.selectCosmetic} is given for a shop row. The
 * standard paint is stored as "no selection" so a re-authored default look
 * never strands a pilot on a stale id.
 */
export function selectionValueFor(cosmeticId: string): string | null {
  return cosmeticId === STANDARD_COSMETIC_ID ? null : cosmeticId;
}

/** Whether the paint can be equipped anywhere yet — drives the equip row's hint. */
export function equipHint(entry: PaintEntry, cosmetic?: CosmeticConfig): string {
  if (entry.state === "buy") return "";
  if (entry.targets.length > 0) return "";
  return cosmetic && cosmetic.appliesTo !== "any" ? "No owned hull wears this paint." : "Buy a hull to wear this.";
}

function sortedShips(configs: Pick<ConfigService, "getAll">): ShipConfig[] {
  return [...configs.getAll<ShipConfig>("ship")].sort((a, b) => a.id.localeCompare(b.id));
}
