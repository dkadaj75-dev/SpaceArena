import type { ThemeConfig } from "@space-arena/shared";

/**
 * ROADMAP §10 5.8 — `theme.menu` → the `--sa-menu-*` custom properties the
 * shared menu stylesheet (`screenStyle.ts`) consumes.
 *
 * Pure and DOM-free so the whole "which config field drives which variable"
 * mapping is unit-testable, and so a content pack that ships no `menu` block
 * still gets the board-authored design-system palette.
 */

export interface MenuTheme {
  base: string;
  panel: string;
  primary: string;
  accent: string;
  text: string;
  muted: string;
  border: string;
  nebulaPrimary: string;
  nebulaAccent: string;
  nebulaOpacity: number;
  starDensity: number;
  vignette: number;
  titleText: string;
  titleSubtitle: string;
  titleLetterSpacingEm: number;
  titleGlow: number;
  /** `theme.menu.style.chamferPx` — corner cut on panels and buttons. */
  panelChamferPx: number;
  /** `theme.menu.style.glow` — outer-glow strength on panel rims / primary buttons. */
  panelGlow: number;
  /** `theme.menu.style.panelOpacity` — panel fill opacity over the nebula. */
  panelOpacity: number;
  /** `theme.fonts.display` — the title wordmark face. */
  displayFont: string;
  /** `theme.fonts.body`. */
  bodyFont: string;
}

/** Board defaults for packs with no `menu` block. */
export const DEFAULT_MENU_THEME: MenuTheme = {
  base: "#05080D",
  panel: "#0B1118",
  primary: "#3B82F6",
  accent: "#E6F0FF",
  text: "#E6F0FF",
  muted: "#475569",
  border: "#1E2937",
  nebulaPrimary: "#151E2A",
  nebulaAccent: "#1E2937",
  nebulaOpacity: 0.55,
  starDensity: 0.5,
  vignette: 0.55,
  titleText: "ORION'S ARM",
  titleSubtitle: "TACTICAL SHIP COMBAT",
  titleLetterSpacingEm: 0.32,
  titleGlow: 0.5,
  panelChamferPx: 12,
  panelGlow: 0.5,
  panelOpacity: 0.72,
  displayFont: "'Orbitron', system-ui, sans-serif",
  bodyFont: "'Rajdhani', system-ui, sans-serif",
};

function str(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? fallback : trimmed;
}

function num(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** Resolve a theme's `menu`/`fonts` blocks into fully-defaulted menu values. */
export function menuThemeOf(theme: ThemeConfig | undefined): MenuTheme {
  const menu = theme?.menu;
  const colors = menu?.colors;
  const backdrop = menu?.backdrop;
  const title = menu?.title;
  const style = menu?.style;
  const d = DEFAULT_MENU_THEME;
  return {
    base: str(colors?.base, d.base),
    panel: str(colors?.panel, d.panel),
    primary: str(colors?.primary, d.primary),
    accent: str(colors?.accent, d.accent),
    text: str(colors?.text, d.text),
    muted: str(colors?.muted, d.muted),
    border: str(colors?.border, d.border),
    nebulaPrimary: str(backdrop?.nebulaPrimary, d.nebulaPrimary),
    nebulaAccent: str(backdrop?.nebulaAccent, d.nebulaAccent),
    nebulaOpacity: num(backdrop?.nebulaOpacity, d.nebulaOpacity, 0, 1),
    starDensity: num(backdrop?.starDensity, d.starDensity, 0, 1),
    vignette: num(backdrop?.vignette, d.vignette, 0, 1),
    titleText: str(title?.text, d.titleText),
    // A deliberately empty subtitle hides the tagline — `str()` would restore
    // the default, so the empty string is honoured explicitly here.
    titleSubtitle: title?.subtitle === undefined ? d.titleSubtitle : title.subtitle.trim(),
    titleLetterSpacingEm: num(title?.letterSpacingEm, d.titleLetterSpacingEm, 0, 2),
    titleGlow: num(title?.glow, d.titleGlow, 0, 1),
    // 64px is a generous ceiling, not a design suggestion: it keeps a typo like
    // `chamferPx: 1200` from clipping a panel out of existence.
    panelChamferPx: num(style?.chamferPx, d.panelChamferPx, 0, 64),
    panelGlow: num(style?.glow, d.panelGlow, 0, 1),
    panelOpacity: num(style?.panelOpacity, d.panelOpacity, 0, 1),
    displayFont: str(theme?.fonts?.display, d.displayFont),
    bodyFont: str(theme?.fonts?.body, d.bodyFont),
  };
}

/** The CSS custom properties `screenStyle.ts` reads, ready for `style.setProperty`. */
export function menuCssVars(menu: MenuTheme): Record<string, string> {
  return {
    "--sa-menu-base": menu.base,
    "--sa-menu-panel": menu.panel,
    "--sa-menu-primary": menu.primary,
    "--sa-menu-accent": menu.accent,
    "--sa-menu-text": menu.text,
    "--sa-menu-muted": menu.muted,
    "--sa-menu-border": menu.border,
    "--sa-menu-nebula-1": menu.nebulaPrimary,
    "--sa-menu-nebula-2": menu.nebulaAccent,
    "--sa-menu-nebula-opacity": String(menu.nebulaOpacity),
    "--sa-menu-vignette": String(menu.vignette),
    "--sa-menu-title-tracking": `${menu.titleLetterSpacingEm}em`,
    "--sa-menu-title-glow": String(menu.titleGlow),
    "--sa-menu-chamfer": `${menu.panelChamferPx}px`,
    "--sa-menu-glow": String(menu.panelGlow),
    // Pre-formatted percentage: `color-mix()` wants a <percentage> and not every
    // engine accepts a calc() in that slot.
    "--sa-menu-panel-pct": `${Math.round(menu.panelOpacity * 1000) / 10}%`,
    "--sa-menu-font-display": menu.displayFont,
    "--sa-menu-font-body": menu.bodyFont,
  };
}

/** Stars drawn on one 256x256 tile at `starDensity` = 1. */
export const MAX_STARS_PER_TILE = 90;

/** Star count for a density, 0..{@link MAX_STARS_PER_TILE}. */
export function starCountFor(density: number): number {
  return Math.round(num(density, 0, 0, 1) * MAX_STARS_PER_TILE);
}
