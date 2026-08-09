import type { z } from "zod";

import { actionSchema, type ActionConfig } from "./action.js";
import { arenaSchema, type ArenaConfig } from "./arena.js";
import { asteroidSchema, type AsteroidConfig } from "./asteroid.js";
import { botprofileSchema, type BotprofileConfig } from "./botprofile.js";
import { cameraSchema, type CameraConfig } from "./camera.js";
import { cosmeticSchema, type CosmeticConfig } from "./cosmetic.js";
import { effectSchema, type EffectConfig } from "./effect.js";
import { eventSchema, type EventConfig } from "./event.js";
import { gamemodeSchema, type GamemodeConfig } from "./gamemode.js";
import { type ManifestConfig } from "./manifest.js";
import { moduleSchema, type ModuleConfig } from "./module.js";
import { notificationSchema, type NotificationConfig } from "./notification.js";
import { progressionSchema, type ProgressionConfig } from "./progression.js";
import { qualitySchema, type QualityConfig } from "./quality.js";
import { hardpointsOf, shipSchema, type ShipConfig } from "./ship.js";
import { themeSchema, type ThemeConfig } from "./theme.js";
import { tutorialSchema, type TutorialConfig } from "./tutorial.js";
import { tuningSchema, type TuningConfig } from "./tuning.js";
import { upgradeSchema, type UpgradeConfig } from "./upgrade.js";

export * from "./base.js";
export * from "./common.js";
export * from "./socket.js";
export * from "./ship.js";
export * from "./module.js";
export * from "./effect.js";
export * from "./upgrade.js";
export * from "./arena.js";
export * from "./asteroid.js";
export * from "./gamemode.js";
export * from "./camera.js";
export * from "./tuning.js";
export * from "./action.js";
export * from "./event.js";
export * from "./notification.js";
export * from "./theme.js";
export * from "./progression.js";
export * from "./quality.js";
export * from "./botprofile.js";
export * from "./cosmetic.js";
export * from "./tutorial.js";
export * from "./manifest.js";

/**
 * Registry of every content schema keyed by its `type` literal.
 * `manifest` is intentionally excluded — it is meta, not a content config, and
 * is validated separately by ConfigService via {@link manifestSchema}.
 */
export const CONFIG_SCHEMAS = {
  ship: shipSchema,
  module: moduleSchema,
  effect: effectSchema,
  upgrade: upgradeSchema,
  arena: arenaSchema,
  asteroid: asteroidSchema,
  gamemode: gamemodeSchema,
  camera: cameraSchema,
  tuning: tuningSchema,
  action: actionSchema,
  event: eventSchema,
  notification: notificationSchema,
  theme: themeSchema,
  progression: progressionSchema,
  botprofile: botprofileSchema,
  quality: qualitySchema,
  cosmetic: cosmeticSchema,
  tutorial: tutorialSchema,
} as const;

export type ConfigType = keyof typeof CONFIG_SCHEMAS;

/** Discriminated union of every parsed content config. */
export type AnyConfig =
  | ShipConfig
  | ModuleConfig
  | EffectConfig
  | UpgradeConfig
  | ArenaConfig
  | AsteroidConfig
  | GamemodeConfig
  | CameraConfig
  | TuningConfig
  | ActionConfig
  | EventConfig
  | NotificationConfig
  | ThemeConfig
  | ProgressionConfig
  | BotprofileConfig
  | QualityConfig
  | CosmeticConfig
  | TutorialConfig;

export type { ManifestConfig };

export const CONFIG_TYPES = Object.keys(CONFIG_SCHEMAS) as ConfigType[];

function isConfigType(value: unknown): value is ConfigType {
  return typeof value === "string" && value in CONFIG_SCHEMAS;
}

export type ValidateResult =
  | { success: true; type: ConfigType; data: AnyConfig }
  | { success: false; type: ConfigType | null; error: z.ZodError | null; message?: string };

/**
 * Validate an unknown JSON value by discriminating on its `type` field and
 * running the matching schema.
 */
export function validateConfig(json: unknown): ValidateResult {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return { success: false, type: null, error: null, message: "config must be a JSON object" };
  }
  const type = (json as { type?: unknown }).type;
  if (!isConfigType(type)) {
    return {
      success: false,
      type: null,
      error: null,
      message: `unknown or missing config type: ${JSON.stringify(type)}`,
    };
  }
  const schema = CONFIG_SCHEMAS[type];
  const result = schema.safeParse(json);
  if (result.success) {
    return { success: true, type, data: result.data as AnyConfig };
  }
  return { success: false, type, error: result.error };
}

/** A cross-reference discovered inside a config: where it is and what it points to. */
export interface ConfigRef {
  /** JSON-ish path within the config, e.g. `defaultFitting[0]`. */
  path: string;
  /** The referenced config id. */
  id: string;
  /**
   * The config type this slot must point at. Resolution checks both existence
   * AND type, so `upgradeTracks.hull: "module.laser-mk1"` is a load error, not
   * a silent runtime `undefined` in resolveShipStats.
   */
  expects: ConfigType;
}

/** A relational (cross-config) problem: a violated constraint needing other configs to detect. */
export interface RelationalError {
  path: string;
  message: string;
}

/**
 * Validate constraints that span multiple configs and therefore can only be
 * checked once the whole pack is staged (mirrors dangling-ref resolution).
 * `resolve` looks a config up by type+id in the staged/registry set.
 *
 * Ship rule (Finding 6): a ship's `defaultFitting` must fit its socket graph —
 * no more entries than hardpoints, and each entry's module family must be
 * accepted by the hardpoint at that index. Dangling module ids are reported by
 * reference resolution, not here.
 */
export function collectRelationalErrors(
  config: AnyConfig,
  resolve: (type: ConfigType, id: string) => AnyConfig | undefined,
): RelationalError[] {
  const errs: RelationalError[] = [];
  if (config.type === "ship") {
    const hardpoints = hardpointsOf(config);
    if (config.defaultFitting.length > hardpoints.length) {
      errs.push({
        path: "defaultFitting",
        message: `defaultFitting has ${config.defaultFitting.length} entries but the ship has only ${hardpoints.length} hardpoint socket(s)`,
      });
    }
    config.defaultFitting.forEach((moduleId, i) => {
      if (!moduleId) return; // empty slot is allowed
      const hp = hardpoints[i];
      if (!hp) return; // out-of-range already reported above
      const mod = resolve("module", moduleId) as ModuleConfig | undefined;
      if (!mod) return; // dangling id handled by collectReferences
      if (!hp.accepts.includes(mod.family)) {
        errs.push({
          path: `defaultFitting[${i}]`,
          message: `module ${moduleId} (family '${mod.family}') is not accepted by hardpoint ${i} (${hp.id} accepts ${hp.accepts.join(", ")})`,
        });
      }
    });
  }
  return errs;
}

/**
 * Extract every by-id cross-reference from a validated config. Reference
 * *resolution* (existence checking, graph building) happens in ConfigService;
 * this only knows the shape of each config type.
 */
export function collectReferences(config: AnyConfig): ConfigRef[] {
  const refs: ConfigRef[] = [];
  switch (config.type) {
    case "ship": {
      const t = config.upgradeTracks;
      refs.push({ path: "upgradeTracks.hull", id: t.hull, expects: "upgrade" });
      refs.push({ path: "upgradeTracks.engine", id: t.engine, expects: "upgrade" });
      refs.push({ path: "upgradeTracks.energy", id: t.energy, expects: "upgrade" });
      refs.push({ path: "upgradeTracks.heat", id: t.heat, expects: "upgrade" });
      config.defaultFitting.forEach((id, i) =>
        refs.push({ path: `defaultFitting[${i}]`, id, expects: "module" }),
      );
      // Emitter sockets reference an effect (`fx.*`) config by id.
      config.sockets.forEach((s, i) => {
        if (s.kind === "emitter") refs.push({ path: `sockets[${i}].effect`, id: s.effect, expects: "effect" });
      });
      break;
    }
    case "module": {
      for (const hook of ["onFire", "onOverheat", "onActivate", "onDeactivate"] as const) {
        (config[hook] ?? []).forEach((id, i) =>
          refs.push({ path: `${hook}[${i}]`, id, expects: "action" }),
        );
      }
      break;
    }
    case "arena": {
      config.asteroidPlacements.forEach((p, i) =>
        refs.push({ path: `asteroidPlacements[${i}].asteroidId`, id: p.asteroidId, expects: "asteroid" }),
      );
      const warning = config.render?.boundaryShield.warningNotification;
      if (warning) {
        refs.push({
          path: "render.boundaryShield.warningNotification",
          id: warning,
          expects: "notification",
        });
      }
      break;
    }
    case "action": {
      const params = config.params ?? {};
      const notif = params["notification"];
      if (typeof notif === "string") refs.push({ path: "params.notification", id: notif, expects: "notification" });
      break;
    }
    case "event": {
      config.actions.forEach((id, i) => refs.push({ path: `actions[${i}]`, id, expects: "action" }));
      break;
    }
    case "notification": {
      if (config.triggerEvent) refs.push({ path: "triggerEvent", id: config.triggerEvent, expects: "event" });
      break;
    }
    case "gamemode": {
      if (config.defaultArena) refs.push({ path: "defaultArena", id: config.defaultArena, expects: "arena" });
      if (config.bots) {
        refs.push({ path: "bots.defaultProfile", id: config.bots.defaultProfile, expects: "botprofile" });
        if (config.bots.defaultShip) refs.push({ path: "bots.defaultShip", id: config.bots.defaultShip, expects: "ship" });
        (config.bots.roster ?? []).forEach((slot, i) => {
          refs.push({ path: `bots.roster[${i}].profile`, id: slot.profile, expects: "botprofile" });
          if (slot.ship) refs.push({ path: `bots.roster[${i}].ship`, id: slot.ship, expects: "ship" });
        });
      }
      break;
    }
    case "tutorial": {
      // The onboarding flow points at half the pack — the mode it plays in, the
      // hull it puts the student in, every module it promises is fitted, and the
      // hulk and the drone it spawns. All of it resolved, because a tutorial
      // that dies at step 5 on a renamed module is worse than no tutorial.
      refs.push({ path: "gamemode", id: config.gamemode, expects: "gamemode" });
      if (config.arena) refs.push({ path: "arena", id: config.arena, expects: "arena" });
      refs.push({ path: "pilot.ship", id: config.pilot.ship, expects: "ship" });
      config.pilot.fitting.forEach((id, i) => {
        if (id) refs.push({ path: `pilot.fitting[${i}]`, id, expects: "module" });
      });
      config.steps.forEach((step, i) => {
        const spawn = step.spawn;
        if (!spawn) return;
        refs.push({ path: `steps[${i}].spawn.ship`, id: spawn.ship, expects: "ship" });
        if (spawn.profile) {
          refs.push({ path: `steps[${i}].spawn.profile`, id: spawn.profile, expects: "botprofile" });
        }
        (spawn.fitting ?? []).forEach((id, j) => {
          if (id) refs.push({ path: `steps[${i}].spawn.fitting[${j}]`, id, expects: "module" });
        });
      });
      break;
    }
    case "cosmetic": {
      const expects = config.target.startsWith("ship.") ? "ship" : "module";
      refs.push({ path: "target", id: config.target, expects });
      break;
    }
    case "theme": {
      for (const [path, blocked] of [
        ["hud.flight.fire.blockedNotification", config.hud?.flight?.fire?.blockedNotification],
        ["hud.portrait.flight.fire.blockedNotification", config.hud?.portrait?.flight?.fire?.blockedNotification],
        ["hud.landscape.flight.fire.blockedNotification", config.hud?.landscape?.flight?.fire?.blockedNotification],
      ] as const) {
        if (blocked) refs.push({ path, id: blocked, expects: "notification" });
      }
      break;
    }
    default:
      break;
  }
  return refs;
}
