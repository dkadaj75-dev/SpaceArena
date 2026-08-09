import { CONFIG_TYPES, contentPathFor, type AnyConfig, type ConfigType } from "@space-arena/shared";

export interface PanelRegistration { type: ConfigType; label: string; create(source: AnyConfig, id: string): AnyConfig; preview: string }

const LABELS: Partial<Record<ConfigType, string>> = { botprofile: "Bot profiles", gamemode: "Game modes" };

export const PANEL_REGISTRY = Object.fromEntries(CONFIG_TYPES.map((type) => [type, {
  type,
  label: LABELS[type] ?? `${type[0]!.toUpperCase()}${type.slice(1)}`,
  create(source: AnyConfig, id: string): AnyConfig { return { ...structuredClone(source), id, version: 1 } as AnyConfig; },
  preview: type === "arena" ? "Isolated arena preview; applies to new matches after publish."
    : type === "theme" ? "Theme fields preview in this Constellation shell; publish affects fresh clients."
    : ["ship", "module"].includes(type) ? "Draft stats are validated across the complete pack; new rooms use the published result."
    : "Draft-only preview with the application policy below.",
} satisfies PanelRegistration])) as Record<ConfigType, PanelRegistration>;

export function registeredContentPath(config: AnyConfig): string { return contentPathFor(config); }
