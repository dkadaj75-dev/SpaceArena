import type { ConfigService } from "../core/ConfigService.js";
import type { BotprofileConfig } from "../schemas/botprofile.js";
import { hardpointsOf, type ModuleConfig, type ShipConfig } from "../schemas/index.js";
import { resolveShipStats } from "../sim/resolveStats.js";

/** Seeded bot fittings use every tier and specialist in the installed pack. */
export const MAX_BOT_MODULE_LEVEL = Infinity;
const MAX_ATTEMPTS = 2_000;
/** Shortest held-trigger burn a rolled bot fitting may have (seconds). */
const MIN_BURN_SEC = 2;

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
 * Conservative combat viability under the per-module heat/energy model
 * (2026-08-07): the rail must be able to online at least one weapon, and every
 * fitted weapon must be able to hold its trigger for a useful stretch —
 * `capacity × (1 - rearmBelow) / (generation - cooling)` seconds — before it
 * locks itself out. A fit may still need discipline in a long brawl; it may not
 * cook itself instantly, and it can no longer hurt its own hull at all.
 */
export function isBotFittingViable(configs: ConfigService, ship: ShipConfig, fitting: readonly (string | null)[]): boolean {
  const modules = fitting.flatMap((id) => id ? [configs.get<ModuleConfig>("module", id)] : []).filter((m): m is ModuleConfig => !!m);
  const weapons = modules.filter((m) => m.fire);
  if (weapons.length === 0) return false;
  const core = resolveShipStats(ship, configs, { fittedModuleIds: fitting });
  const canOnlineWeapon = weapons.some((m) => (m.power?.draw ?? 0) <= core.power.capacity);
  if (!canOnlineWeapon) return false;
  return weapons.every((m) => burnSeconds(m, core.cooling.multiplier, core.efficiency.heatGen, core.heatStore.multiplier) >= MIN_BURN_SEC);
}

/** Seconds of held trigger a weapon gets from cold before it locks out. */
function burnSeconds(mod: ModuleConfig, coolingMult: number, heatGenMult: number, storeMult: number): number {
  const heat = mod.heat;
  if (!heat) return Infinity;
  const perSec =
    (mod.fire?.mode === "continuous"
      ? heat.perSecondActive
      : heat.perSecondActive + heat.perShot / Math.max(1e-6, mod.fire?.cycleTime ?? Infinity)) * heatGenMult;
  const net = perSec - heat.coolingPerSec * coolingMult;
  if (net <= 0) return Infinity;
  return (heat.capacity * storeMult) / net;
}

/** Comparable catalogue-independent fitting quality used for player-relative rolls. */
export function fittingPowerScore(configs: ConfigService, fitting: readonly (string | null)[]): number {
  return fitting.reduce((sum, id) => {
    if (!id) return sum;
    const mod = configs.get<ModuleConfig>("module", id);
    if (!mod) return sum;
    return sum + mod.level * 100 + Math.log2(mod.price + 2) * 12;
  }, 0);
}

/** Full-catalogue, socket-legal, archetype-weighted deterministic fitting roll. */
export function randomBotFitting(
  configs: ConfigService,
  shipId: string,
  rng: () => number,
  profile?: BotprofileConfig,
  playerFitting?: readonly (string | null)[],
): (string | null)[] {
  const ship = configs.get<ShipConfig>("ship", shipId);
  if (!ship) return [];
  const sockets = hardpointsOf(ship);
  const catalogue = configs.getAll<ModuleConfig>("module");
  const playerScore = playerFitting?.length ? fittingPowerScore(configs, playerFitting) : null;
  const spread = profile?.fittingPowerSpread ?? 0.25;
  const target = playerScore === null ? null : playerScore * (1 + (rng() * 2 - 1) * spread);
  let nearest: { fitting: (string | null)[]; gap: number } | null = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const fitting = sockets.map((socket) => {
      const candidates = catalogue.filter((mod) => socket.accepts.includes(mod.family));
      return weightedPick(rng, candidates, (mod) => flavorWeight(profile, mod))?.id ?? null;
    });
    if (!isBotFittingViable(configs, ship, fitting)) continue;
    if (target === null) return fitting;
    const gap = Math.abs(fittingPowerScore(configs, fitting) - target);
    if (!nearest || gap < nearest.gap) nearest = { fitting, gap };
  }
  if (nearest) return nearest.fitting;
  // Authored stock is the deterministic safe fallback for exceptionally
  // restrictive custom packs; shipped content normally succeeds in a few rolls.
  return hardpointsOf(ship).map((_, index) => ship.defaultFitting[index] ?? null);
}
