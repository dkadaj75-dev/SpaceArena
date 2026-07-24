import { randomUUID } from "node:crypto";
import type { ConfigService, HardpointMap, ModuleConfig, ProgressionConfig, ShipConfig } from "@space-arena/shared";
import { fittingsRepo, ownedModulesRepo, profilesRepo } from "./repos.js";

/** Resolve the first (canonical) progression config, or a safe default. */
export function getProgression(configs: ConfigService): ProgressionConfig | undefined {
  return (
    configs.get<ProgressionConfig>("progression", "progression.default") ??
    configs.getAll<ProgressionConfig>("progression")[0]
  );
}

/**
 * Seed a brand-new user: profile (with starter credits from progression config),
 * ownership of every `price: 0` starter module, and a default fitting per ship
 * built from that ship's `defaultFitting`. Idempotent per-call is not required —
 * this runs exactly once, right after the user row is inserted.
 */
export function seedNewUser(configs: ConfigService, userId: string, displayName: string): void {
  const progression = getProgression(configs);
  const starterCredits = progression?.starterCredits ?? 0;

  profilesRepo.create({ user_id: userId, display_name: displayName, level: 1, xp: 0, credits: starterCredits });

  // Grant every starter (free) module.
  const owned = new Set<string>();
  for (const mod of configs.getAll<ModuleConfig>("module")) {
    if (mod.price === 0) {
      ownedModulesRepo.grant(userId, mod.id, 1);
      owned.add(mod.id);
    }
  }

  // One default fitting per ship, from defaultFitting (hardpoint order). Only
  // seed modules the user actually owns — a level-gated or priced entry in a
  // ship's defaultFitting is dropped to an empty slot rather than seeded as an
  // illegal (unowned) fit that would fail validation at match join.
  for (const ship of configs.getAll<ShipConfig>("ship")) {
    const hardpointMap: HardpointMap = {};
    ship.defaultFitting.forEach((moduleId, i) => {
      if (moduleId && owned.has(moduleId)) hardpointMap[String(i)] = moduleId;
    });
    fittingsRepo.create({
      id: randomUUID(),
      user_id: userId,
      ship_id: ship.id,
      name: "Default",
      hardpointMap,
    });
  }
}
