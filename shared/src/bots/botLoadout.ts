import type { ConfigService } from "../core/ConfigService.js";
import type { BotprofileConfig } from "../schemas/botprofile.js";
import { hardpointsOf, type ModuleConfig, type ShipConfig } from "../schemas/index.js";
import { resolveShipStats } from "../sim/resolveStats.js";

/** Seeded bot fittings use every tier and specialist in the installed pack. */
export const MAX_BOT_MODULE_LEVEL = Infinity;
const MAX_ATTEMPTS = 400;
const SUSTAIN_WINDOW_SEC = 3;

function pick<T>(rng: () => number, list: readonly T[]): T | undefined {
  if (list.length === 0) return undefined;
  return list[Math.min(list.length - 1, Math.max(0, Math.floor(rng() * list.length)))];
}

function weightedPick(rng: () => number, modules: readonly ModuleConfig[], weight: (m: ModuleConfig) => number): ModuleConfig | undefined {
  let total = 0;
  for (const mod of modules) total += Math.max(0, weight(mod));
  if (!(total > 0)) return pick(rng, modules);
  let roll = rng() * total;
  for (const mod of modules) {
    roll -= Math.max(0, weight(mod));
    if (roll <= 0) return mod;
  }
  return modules[modules.length - 1];
}

export function pickBotShip(configs: ConfigService, rng: () => number, fallback: string, pool?: readonly string[]): string {
  const candidates = (pool ?? configs.getAll<ShipConfig>("ship").map((s) => s.id)).filter((id) => configs.get<ShipConfig>("ship", id));
  return pick(rng, candidates) ?? fallback;
}

function flavorWeight(profile: BotprofileConfig | undefined, mod: ModuleConfig): number {
  const flavor = profile?.fittingArchetype ?? "balanced";
  const weapon = mod.fire !== undefined;
  const tank = mod.mitigation !== undefined || mod.family === "heatsink" || mod.family === "generator";
  if (flavor === "aggressive") return weapon ? 4 : tank ? 0.75 : 1.5;
  if (flavor === "cautious") return tank ? 4 : weapon ? 1.2 : 2;
  return weapon || tank ? 2 : 1.5;
}

/**
 * Conservative combat viability: the resolved capacitor/thermal system must
 * sustain every fitted module active for a useful exchange, and the rail must
 * be able to online at least one weapon. Fits may still need discipline during
 * an extended brawl; they cannot brown out or cook instantly.
 */
export function isBotFittingViable(configs: ConfigService, ship: ShipConfig, fitting: readonly (string | null)[]): boolean {
  const modules = fitting.flatMap((id) => id ? [configs.get<ModuleConfig>("module", id)] : []).filter((m): m is ModuleConfig => !!m);
  const weapons = modules.filter((m) => m.fire);
  if (weapons.length === 0) return false;
  const core = resolveShipStats(ship, configs, { fittedModuleIds: fitting });
  const energyDraw = modules.reduce((sum, m) => sum + m.energy.drawActive, 0) * core.efficiency.energyDraw;
  const heatGen = modules.reduce((sum, m) => sum + m.heat.perSecondActive + ((m.fire?.heatPerShot ?? 0) / (m.fire?.cycleTime ?? Infinity)), 0) * core.efficiency.heatGen;
  const energyBudget = core.capacitor.regen + core.capacitor.max / SUSTAIN_WINDOW_SEC;
  const heatBudget = core.heat.dissipation + core.heat.capacity / SUSTAIN_WINDOW_SEC;
  const canOnlineWeapon = weapons.some((m) => (m.power?.draw ?? 0) <= core.power.capacity);
  return energyDraw <= energyBudget && heatGen <= heatBudget && canOnlineWeapon;
}

/** Full-catalogue, socket-legal, archetype-weighted deterministic fitting roll. */
export function randomBotFitting(
  configs: ConfigService,
  shipId: string,
  rng: () => number,
  profile?: BotprofileConfig,
): (string | null)[] {
  const ship = configs.get<ShipConfig>("ship", shipId);
  if (!ship) return [];
  const sockets = hardpointsOf(ship);
  const catalogue = configs.getAll<ModuleConfig>("module");
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const fitting = sockets.map((socket) => {
      const candidates = catalogue.filter((mod) => socket.accepts.includes(mod.family));
      return weightedPick(rng, candidates, (mod) => flavorWeight(profile, mod))?.id ?? null;
    });
    if (isBotFittingViable(configs, ship, fitting)) return fitting;
  }
  // Authored stock is the deterministic safe fallback for exceptionally
  // restrictive custom packs; shipped content normally succeeds in a few rolls.
  return hardpointsOf(ship).map((_, index) => ship.defaultFitting[index] ?? null);
}
