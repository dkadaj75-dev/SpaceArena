import { cosmeticsForShip, cosmeticDisplayName, type ConfigService } from "@space-arena/shared";
import type { OwnershipStore } from "./ownershipStore.js";

export interface HangarSkinEntry {
  id: string;
  name: string;
  price: number;
  primary: string;
  accent: string;
  owned: boolean;
  equipped: boolean;
}

export function hangarSkinEntries(
  configs: Pick<ConfigService, "getAll">,
  ownership: Pick<OwnershipStore, "ownedCosmetics" | "selectedCosmetic">,
  shipId: string,
): HangarSkinEntry[] {
  const owned = ownership.ownedCosmetics();
  const selected = ownership.selectedCosmetic(shipId);
  return cosmeticsForShip(configs, shipId).map((cosmetic) => ({
    id: cosmetic.id,
    name: cosmeticDisplayName(cosmetic),
    price: cosmetic.price,
    primary: cosmetic.paint.primary,
    accent: cosmetic.paint.accent,
    owned: owned.has(cosmetic.id),
    equipped: selected === cosmetic.id,
  }));
}

export async function buyAndEquipSkin(
  ownership: Pick<OwnershipStore, "buyCosmetic" | "selectCosmetic">,
  shipId: string,
  cosmeticId: string,
  owned: boolean,
): Promise<void> {
  if (!owned) await ownership.buyCosmetic(cosmeticId);
  await ownership.selectCosmetic(shipId, cosmeticId);
}
