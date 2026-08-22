import { loadoutFittingId, type ConfigService, type HardpointMap, type ModuleConfig, type ProgressionConfig, type ShipConfig } from "@space-arena/shared";
import { fittingsRepo, ownedModulesRepo, profilesRepo } from "./repos.js";

/** Resolve the first (canonical) progression config, or a safe default. */
export function getProgression(configs: ConfigService): ProgressionConfig | undefined {
  return (
    configs.get<ProgressionConfig>("progression", "progression.default") ??
    configs.getAll<ProgressionConfig>("progression")[0]
  );
}

/**
 * Idempotent starter-kit top-up: grant any `price: 0` module the user doesn't
 * own yet. Runs on every auth so accounts created before a content change
 * (e.g. a module becoming part of the free starter kit) are repaired and can
 * still join with default fittings.
 */
export function ensureStarterKit(configs: ConfigService, userId: string): void {
  for (const mod of configs.getAll<ModuleConfig>("module")) {
    if (mod.price === 0 && !ownedModulesRepo.owns(userId, mod.id)) {
      ownedModulesRepo.grant(userId, mod.id, 1);
    }
  }
}

/**
 * Everything an EXISTING account has to be brought up to date on before it is
 * handed a token. One entry point rather than a growing list of `ensure*` calls
 * repeated at five auth sites, where the next repair would inevitably be added
 * to four of them.
 */
export function ensureAccountUpToDate(configs: ConfigService, userId: string): void {
  ensureStarterKit(configs, userId);
  ensureImplicitLoadouts(configs, userId);
}

/**
 * The hull's stock fit, minus anything this user does not own — a level-gated or
 * priced entry in a ship's `defaultFitting` becomes an empty slot rather than an
 * illegal fit that would fail validation at match join (Finding 1).
 */
function stockLoadout(ship: ShipConfig, owned: ReadonlySet<string>): HardpointMap {
  const hardpointMap: HardpointMap = {};
  ship.defaultFitting.forEach((moduleId, i) => {
    if (moduleId && owned.has(moduleId)) hardpointMap[String(i)] = moduleId;
  });
  return hardpointMap;
}

/**
 * Give every hull its ONE implicit loadout, and fold away whatever named
 * fittings the account still carries (owner 2026-08-22: "when a player fits its
 * ship, it becomes the fitting the ship is going to use").
 *
 * Idempotent, and runs on every auth beside {@link ensureStarterKit}, which
 * makes it the migration as well as the seeder — there is no separate SQL step
 * and no flag day. For each hull:
 *
 *  - if the well-known row (`loadoutFittingId`) already exists, it is left
 *    exactly as it is. This is the steady state and costs one indexed read;
 *  - otherwise the pilot's MOST RECENT named fitting for that hull becomes the
 *    implicit loadout. The server cannot know which one the client had
 *    *selected* (that lived in the browser's `localStorage`), and the most
 *    recent save is the closest honest guess at "the one they were flying";
 *  - with nothing to inherit — a new account, or a hull added to the pack after
 *    the account was made — the loadout starts as the hull's stock fit, because
 *    a ship with no guns is not a loadout.
 *
 * Every OTHER row for that hull is then deleted. They are unreachable the moment
 * the UI stops naming fittings, and leaving them would mean `GET /api/fittings`
 * kept serving a list the client can only ignore, one row of which would quietly
 * shadow the real loadout in any code that took "the first row for this ship".
 *
 * Stale CONTENT inside an inherited map is deliberately not repaired here: the
 * hardpoint pass already left saved fittings addressing mounts that moved, and
 * `ArenaRoom.resolveFitting` prunes those at spawn. Re-validating here would
 * only move the same forgiveness earlier and risk emptying a loadout the pack
 * might yet restore.
 */
export function ensureImplicitLoadouts(configs: ConfigService, userId: string): void {
  const owned = new Set(ownedModulesRepo.byUser(userId).map((r) => r.module_id));
  for (const ship of configs.getAll<ShipConfig>("ship")) {
    const id = loadoutFittingId(userId, ship.id);
    const rows = fittingsRepo.byUserShip(userId, ship.id); // newest first
    if (!rows.some((row) => row.id === id)) {
      fittingsRepo.upsert({
        id,
        user_id: userId,
        ship_id: ship.id,
        hardpointMap: rows[0]?.hardpointMap ?? stockLoadout(ship, owned),
      });
    }
    for (const row of rows) if (row.id !== id) fittingsRepo.delete(row.id);
  }
}

/**
 * Seed a brand-new user: profile (with starter credits from progression config),
 * ownership of every `price: 0` starter module, and one implicit loadout per
 * ship built from that ship's `defaultFitting`.
 */
export function seedNewUser(configs: ConfigService, userId: string, displayName: string): void {
  const progression = getProgression(configs);
  const starterCredits = progression?.starterCredits ?? 0;

  profilesRepo.create({ user_id: userId, display_name: displayName, level: 1, xp: 0, credits: starterCredits });

  // Grant every starter (free) module.
  for (const mod of configs.getAll<ModuleConfig>("module")) {
    if (mod.price === 0) ownedModulesRepo.grant(userId, mod.id, 1);
  }

  // …and then the same call every later auth makes, so a fresh account and a
  // repaired one go down one code path rather than two that can drift.
  ensureImplicitLoadouts(configs, userId);
}
