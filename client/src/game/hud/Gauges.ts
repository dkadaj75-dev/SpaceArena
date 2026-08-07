import type { ShipSnapshot } from "@space-arena/shared";

/**
 * Rack-derived heat seam retained for notification/toast consumers. There is
 * deliberately no ship-wide heat DOM: each weapon renders its own ring.
 */
export function heatGaugeModel(ship: ShipSnapshot): {
  value: number;
  capacity: number;
  fraction: number;
  overheated: boolean;
} {
  let value = 0;
  let capacity = 0;
  let overheated = false;
  for (const module of ship.modules) {
    value += module.heat;
    capacity += module.heatCapacity;
    if (module.state === "overheated") overheated = true;
  }
  return {
    value,
    capacity,
    fraction: capacity > 0 ? value / capacity : 0,
    overheated,
  };
}
