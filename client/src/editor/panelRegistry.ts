import { CONFIG_TYPES, contentPathFor, type AnyConfig, type ConfigType } from "@space-arena/shared";

export interface PanelRegistration { type: ConfigType; label: string; create(source: AnyConfig, id: string): AnyConfig; preview: string }

const LABELS: Partial<Record<ConfigType, string>> = { botprofile: "Bot profiles", gamemode: "Game modes" };

export const PANEL_REGISTRY = Object.fromEntries(CONFIG_TYPES.map((type) => [type, {
  type,
  label: LABELS[type] ?? `${type[0]!.toUpperCase()}${type.slice(1)}`,
  create(source: AnyConfig, id: string): AnyConfig { return { ...structuredClone(source), id, version: 1 } as AnyConfig; },
  preview: ["arena", "asteroid"].includes(type) ? "Draft-only EditorStage rebuild; applies to new matches after publish."
    : type === "theme" ? "Draft tokens republish in this shell immediately and restore on exit/discard."
    : ["ship", "module", "upgrade"].includes(type) ? "Isolated hangar identities use the shared balance math; no live ownership or match is changed."
    : type === "botprofile" ? "Seeded deterministic decision audit; publish affects subsequent bot decisions per policy."
    : type === "cosmetic" ? "Draft-only paint and hull swatch; ownership is never touched."
    : "Draft-only sandbox with the application policy below.",
} satisfies PanelRegistration])) as Record<ConfigType, PanelRegistration>;

export function registeredContentPath(config: AnyConfig): string { return contentPathFor(config); }
