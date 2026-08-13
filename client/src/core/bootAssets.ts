import type { Scene } from "@babylonjs/core";
import { AssetRegistry } from "./AssetRegistry.js";

/** Create the shared cache without warming it: cold boot performs no GLB work. */
export function createBootAssetRegistry(scene: Scene): AssetRegistry {
  return new AssetRegistry(scene);
}
