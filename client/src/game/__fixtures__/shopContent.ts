import type { ConfigService, ModuleConfig, ShipConfig } from "@space-arena/shared";
import type { CosmeticConfig } from "../cosmetics.js";

/** A minimal shipped-pack stand-in: two hulls, three modules, three paints. */
export const SHIPS = [
  ship("ship.interceptor", "Interceptor", "light", 120, 27, 3, 10),
  ship("ship.brawler", "Brawler", "heavy", 260, 18, 1.6, 16),
] as const;

export const MODULES = [
  weapon("module.laser-mk1", "Pulse Laser Mk I", "laser", 1, 0),
  weapon("module.laser-mk2", "Pulse Laser Mk II", "laser", 2, 250),
  weapon("module.kinetic-mk1", "Autocannon Mk I", "kinetic", 1, 0),
] as const;

export const COSMETICS: CosmeticConfig[] = [
  paint("cosmetic.paint-interceptor-standard", "Standard Issue", "ship.interceptor", { primary: "#2f6fb8", accent: "#57d8ff" }),
  paint("cosmetic.paint-interceptor-crimson", "Crimson Vector", "ship.interceptor", {
    primary: "#7a1f2b", accent: "#e0546a", emissive: "#ff8a3d",
  }),
  paint("cosmetic.paint-brawler-standard", "Standard Issue", "ship.brawler", { primary: "#8a94a6", accent: "#c3ccd8" }),
  paint("cosmetic.paint-interceptor-lance", "Lance Livery", "ship.interceptor", {
    primary: "#1d3f2e", accent: "#8ce0a8",
  }),
];

/** A ConfigService stand-in that answers the three shop registries + the theme. */
export function shopConfigs(cosmetics: CosmeticConfig[] = COSMETICS): ConfigService {
  return {
    get: () => undefined,
    getAll: (type: string) => {
      if (type === "ship") return [...SHIPS];
      if (type === "module") return [...MODULES];
      if (type === "cosmetic") return cosmetics;
      return [];
    },
  } as unknown as ConfigService;
}

function ship(
  id: string,
  name: string,
  cls: string,
  hull: number,
  speed: number,
  turn: number,
  power: number,
): ShipConfig {
  return {
    id,
    type: "ship",
    version: 3,
    name,
    class: cls,
    core: {
      hull: { base: hull, resists: {} },
      engine: { nominalSpeed: speed, accel: 18, turnRate: turn },
      power: { capacity: power },
    },
    sockets: [],
    defaultFitting: [],
    render: { recipe: "procedural.arrowhead" },
  } as unknown as ShipConfig;
}

function weapon(
  id: string,
  name: string,
  family: string,
  level: number,
  price: number,
): ModuleConfig {
  return {
    id,
    type: "module",
    version: 1,
    name,
    family,
    level,
    price,
    requiresLevel: 1,
    power: { draw: 2 },
    fire: { mode: "held", range: 80, cycleTime: 1, damage: 5, damageType: "energy" },
    ui: { icon: family, label: name },
  } as unknown as ModuleConfig;
}

function paint(
  id: string,
  name: string,
  target: CosmeticConfig["target"],
  paintColors: CosmeticConfig["paint"],
): CosmeticConfig {
  return { id, type: "cosmetic", version: 1, name, kind: "paint", price: 0, target, paint: paintColors };
}
