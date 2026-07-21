import type { z } from "zod";

import { actionSchema, type ActionConfig } from "./action.js";
import { arenaSchema, type ArenaConfig } from "./arena.js";
import { asteroidSchema, type AsteroidConfig } from "./asteroid.js";
import { botprofileSchema, type BotprofileConfig } from "./botprofile.js";
import { cameraSchema, type CameraConfig } from "./camera.js";
import { eventSchema, type EventConfig } from "./event.js";
import { gamemodeSchema, type GamemodeConfig } from "./gamemode.js";
import { type ManifestConfig } from "./manifest.js";
import { moduleSchema, type ModuleConfig } from "./module.js";
import { notificationSchema, type NotificationConfig } from "./notification.js";
import { progressionSchema, type ProgressionConfig } from "./progression.js";
import { shipSchema, type ShipConfig } from "./ship.js";
import { themeSchema, type ThemeConfig } from "./theme.js";
import { tuningSchema, type TuningConfig } from "./tuning.js";
import { upgradeSchema, type UpgradeConfig } from "./upgrade.js";

export * from "./base.js";
export * from "./common.js";
export * from "./ship.js";
export * from "./module.js";
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
export * from "./botprofile.js";
export * from "./manifest.js";

/**
 * Registry of every content schema keyed by its `type` literal.
 * `manifest` is intentionally excluded — it is meta, not a content config, and
 * is validated separately by ConfigService via {@link manifestSchema}.
 */
export const CONFIG_SCHEMAS = {
  ship: shipSchema,
  module: moduleSchema,
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
} as const;

export type ConfigType = keyof typeof CONFIG_SCHEMAS;

/** Discriminated union of every parsed content config. */
export type AnyConfig =
  | ShipConfig
  | ModuleConfig
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
  | BotprofileConfig;

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
      refs.push({ path: "upgradeTracks.hull", id: t.hull });
      refs.push({ path: "upgradeTracks.engine", id: t.engine });
      refs.push({ path: "upgradeTracks.energy", id: t.energy });
      refs.push({ path: "upgradeTracks.heat", id: t.heat });
      config.defaultFitting.forEach((id, i) =>
        refs.push({ path: `defaultFitting[${i}]`, id }),
      );
      break;
    }
    case "module": {
      for (const hook of ["onFire", "onOverheat", "onActivate", "onDeactivate"] as const) {
        (config[hook] ?? []).forEach((id, i) =>
          refs.push({ path: `${hook}[${i}]`, id }),
        );
      }
      break;
    }
    case "arena": {
      config.asteroidPlacements.forEach((p, i) =>
        refs.push({ path: `asteroidPlacements[${i}].asteroidId`, id: p.asteroidId }),
      );
      break;
    }
    case "action": {
      const params = config.params ?? {};
      const notif = params["notification"];
      if (typeof notif === "string") refs.push({ path: "params.notification", id: notif });
      break;
    }
    case "event": {
      config.actions.forEach((id, i) => refs.push({ path: `actions[${i}]`, id }));
      break;
    }
    case "notification": {
      if (config.triggerEvent) refs.push({ path: "triggerEvent", id: config.triggerEvent });
      break;
    }
    default:
      break;
  }
  return refs;
}
