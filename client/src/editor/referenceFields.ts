import type { ConfigType } from "@space-arena/shared";

/**
 * Every cross-config reference field in the pack, by the dotted path it sits at
 * inside its own config. `*` matches one array index, so a rule covers nested
 * and array-element references (`bots.roster.*.profile`) that a bare
 * property-name lookup could never reach.
 *
 * The authority for what the loader *enforces* is
 * `shared/src/schemas/index.ts#collectReferences`; this table mirrors it and
 * additionally covers the fields that are real references by contract but are
 * not yet collected there (`bots.shipPool`, `bots.roster[].fitting`,
 * `asteroid.states[].onEnter`, `theme.juice.explosions.*`) — a designer should
 * still get a picker for those rather than a free-text box.
 *
 * Deliberately absent: reference-bearing values that live inside a free-form
 * record and so render as the JSON escape hatch, not a field
 * (`action.params.notification`, `progression.unlocks`,
 * `theme.juice.explosions.byShipClass`).
 */
export const REFERENCE_PATHS: Partial<Record<ConfigType, Record<string, ConfigType | readonly ConfigType[]>>> = {
  ship: {
    "upgradeTracks.hull": "upgrade",
    "upgradeTracks.engine": "upgrade",
    "upgradeTracks.energy": "upgrade",
    "upgradeTracks.heat": "upgrade",
    // An empty entry is an intentionally empty slot, so "— none —" is valid here.
    "defaultFitting.*": "module",
    "sockets.*.effect": "effect",
  },
  module: {
    "onFire.*": "action",
    "onOverheat.*": "action",
    "onActivate.*": "action",
    "onDeactivate.*": "action",
  },
  arena: {
    "asteroidPlacements.*.asteroidId": "asteroid",
    "propPlacements.*.propId": "prop",
    "render.boundaryShield.warningNotification": "notification",
  },
  asteroid: {
    "states.*.onEnter.*": "action",
  },
  event: {
    "actions.*": "action",
  },
  notification: {
    triggerEvent: "event",
  },
  gamemode: {
    defaultArena: "arena",
    "bots.defaultProfile": "botprofile",
    "bots.defaultShip": "ship",
    "bots.shipPool.*": "ship",
    "bots.roster.*.profile": "botprofile",
    "bots.roster.*.ship": "ship",
    "bots.roster.*.fitting.*": "module",
  },
  tutorial: {
    gamemode: "gamemode",
    arena: "arena",
    "pilot.ship": "ship",
    "pilot.fitting.*": "module",
    "steps.*.spawn.ship": "ship",
    "steps.*.spawn.profile": "botprofile",
    "steps.*.spawn.fitting.*": "module",
  },
  cosmetic: {
    // Polymorphic by id prefix in the loader — offer both catalogues.
    target: ["ship", "module"],
  },
  theme: {
    "hud.flight.fire.blockedNotification": "notification",
    "hud.portrait.flight.fire.blockedNotification": "notification",
    "hud.landscape.flight.fire.blockedNotification": "notification",
    "juice.explosions.default": "effect",
    "juice.explosions.asteroid": "effect",
  },
};

/** Collapse array indices so one rule covers every element of a list. */
export function referenceKey(path: readonly string[]): string {
  return path.map((segment) => (/^\d+$/.test(segment) ? "*" : segment)).join(".");
}

/**
 * Config types a field at `path` may reference, or null when it is not a
 * reference. `extra` (a path-pattern map) is merged over the built-in table so a
 * caller can describe a shape the table does not know about.
 */
export function referenceTypesFor(
  configType: string | undefined,
  path: readonly string[],
  extra?: Record<string, ConfigType | readonly ConfigType[]>,
): readonly ConfigType[] | null {
  const key = referenceKey(path);
  const table = configType ? REFERENCE_PATHS[configType as ConfigType] : undefined;
  const match = extra?.[key] ?? table?.[key];
  if (!match) return null;
  return typeof match === "string" ? [match] : match;
}
