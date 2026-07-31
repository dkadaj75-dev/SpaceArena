import type { ConfigService } from "../core/ConfigService.js";
import { hardpointsOf, isInternalFamily, type ModuleConfig, type ShipConfig } from "../schemas/index.js";

/**
 * Randomised bot loadouts (owner 2026-07-31) — bots fly different hulls and
 * different fittings so a practice match stops looking like a mirror match.
 *
 * "Not too strong for now" is the brief, so the randomiser is deliberately
 * bounded: it only ever swaps the WEAPON hardpoints, only ever picks from the
 * entry tier ({@link MAX_BOT_MODULE_LEVEL}), and leaves the ship's internal bay
 * on its stock systems. A bot therefore varies in *shape* — what it shoots with,
 * how many racks it carries — without gaining a statistical edge from a
 * top-tier engine or generator.
 *
 * Deterministic: every choice comes from a caller-supplied RNG, so the same
 * seed fields the same opposition.
 */

/** Bots never fit above this module level. */
export const MAX_BOT_MODULE_LEVEL = 1;

function pick<T>(rng: () => number, list: readonly T[]): T | undefined {
  if (list.length === 0) return undefined;
  return list[Math.min(list.length - 1, Math.max(0, Math.floor(rng() * list.length)))];
}

/**
 * A ship id for a bot, drawn from `pool` (or every ship in the pack when no
 * pool is authored). Unknown ids are dropped; if nothing survives, returns
 * `fallback` so a content gap can never stop a bot spawning.
 */
export function pickBotShip(
  configs: ConfigService,
  rng: () => number,
  fallback: string,
  pool?: readonly string[],
): string {
  const candidates = (pool ?? configs.getAll<ShipConfig>("ship").map((s) => s.id)).filter((id) =>
    configs.get<ShipConfig>("ship", id),
  );
  return pick(rng, candidates) ?? fallback;
}

/**
 * A fitting for `shipId`: the hull's default loadout with each WEAPON hardpoint
 * re-rolled from the entry-tier modules that socket accepts. Internals keep the
 * hull's stock systems.
 *
 * An empty roll is possible and intended — a bot with one gun instead of three
 * is part of the variety, and the sanitiser downstream treats a null slot as an
 * empty hardpoint rather than an error.
 */
export function randomBotFitting(
  configs: ConfigService,
  shipId: string,
  rng: () => number,
): (string | null)[] {
  const ship = configs.get<ShipConfig>("ship", shipId);
  if (!ship) return [];
  const sockets = hardpointsOf(ship);
  const modules = configs.getAll<ModuleConfig>("module");

  return sockets.map((socket, index) => {
    const stock = ship.defaultFitting[index] ?? null;
    // Internals are the ship's own systems: leave them exactly as authored.
    if (socket.kind === "internal") return stock;

    const candidates = modules.filter(
      (m) =>
        m.level <= MAX_BOT_MODULE_LEVEL &&
        !isInternalFamily(m.family) &&
        socket.accepts.includes(m.family),
    );
    return pick(rng, candidates)?.id ?? stock;
  });
}
