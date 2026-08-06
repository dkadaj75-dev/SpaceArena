import type { ThemeConfig } from "@space-arena/shared";

/** Board-authored defaults also keep older content packs visually coherent. */
export const DEFAULT_DESIGN_TOKENS = {
  blue500: "#3B82F6", red500: "#EF4444", white: "#E6F0FF",
  n900: "#05080D", n800: "#0B1118", n700: "#151E2A", n600: "#1E2937", n500: "#334155", n400: "#475569",
  h1: "700 32px/40px 'Orbitron', system-ui, sans-serif",
  h2: "600 20px/28px 'Orbitron', system-ui, sans-serif",
  h3: "600 16px/24px 'Rajdhani', system-ui, sans-serif",
  body: "400 14px/20px 'Rajdhani', system-ui, sans-serif",
  caption: "500 12px/16px 'Rajdhani', system-ui, sans-serif",
  data: "400 14px/20px 'Orbitron', system-ui, sans-serif",
  hairline: "1px", thin: "2px", medium: "3px", strong: "4px",
  radiusSmall: "4px", radiusMedium: "8px", radiusLarge: "16px",
} as const;

/** The sole theme-token-to-CSS mapping, shared by DOM screens and the HUD. */
export function designTokenCssVars(theme: ThemeConfig | undefined): Record<string, string> {
  const p = theme?.tokens?.palette;
  const t = theme?.tokens?.typography;
  const l = theme?.tokens?.lineWeights;
  const r = theme?.tokens?.radii;
  const d = DEFAULT_DESIGN_TOKENS;
  return {
    "--sa-blue-500": p?.blue500 ?? d.blue500, "--sa-red-500": p?.red500 ?? d.red500, "--sa-white": p?.white ?? d.white,
    "--sa-n-900": p?.n900 ?? d.n900, "--sa-n-800": p?.n800 ?? d.n800, "--sa-n-700": p?.n700 ?? d.n700,
    "--sa-n-600": p?.n600 ?? d.n600, "--sa-n-500": p?.n500 ?? d.n500, "--sa-n-400": p?.n400 ?? d.n400,
    "--sa-type-h1": t?.h1 ?? d.h1, "--sa-type-h2": t?.h2 ?? d.h2, "--sa-type-h3": t?.h3 ?? d.h3,
    "--sa-type-body": t?.body ?? d.body, "--sa-type-caption": t?.caption ?? d.caption, "--sa-type-data": t?.data ?? d.data,
    "--sa-line-hairline": l?.hairline ?? d.hairline, "--sa-line-thin": l?.thin ?? d.thin,
    "--sa-line-medium": l?.medium ?? d.medium, "--sa-line-strong": l?.strong ?? d.strong,
    "--sa-radius-small": r?.small ?? d.radiusSmall, "--sa-radius-medium": r?.medium ?? d.radiusMedium, "--sa-radius-large": r?.large ?? d.radiusLarge,
  };
}
