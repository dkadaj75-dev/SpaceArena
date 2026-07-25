import type { ThemeConfig } from "@space-arena/shared";
import { menuCssVars, menuThemeOf, starCountFor, type MenuTheme } from "./menuTheme.js";

const STYLE_ID = "sa-screen-style";

/**
 * Shared stylesheet for the full-screen menus (Auth, Lobby, Settings) — ROADMAP 5.5/5.8.
 *
 * These screens render *before* the HUD exists, so they can't use the `--hud-*`
 * custom properties (scoped to `#hud`); they keep the same dark/cyan palette by
 * hand, exactly as {@link import("./Hangar.js").Hangar} does. What this file
 * adds over the previous inline `cssText` is the responsive contract:
 *
 *  - the screen is a scrollable column, so a tall stack of buttons still works
 *    at 360x640 portrait AND at 812x375 landscape,
 *  - padding respects `env(safe-area-inset-*)` (index.html ships
 *    `viewport-fit=cover`), and
 *  - every control is fluid-width and at least 44px tall, so nothing ever
 *    forces horizontal page scroll or lands under a rounded corner.
 */
export function injectScreenStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

/**
 * Push `theme.menu` onto a menu screen's root as `--sa-menu-*` variables (5.8),
 * including the procedurally generated star tile for `.sa-nebula` backdrops.
 * Safe to call on every theme hot-reload — the tile is cached per density.
 */
export function applyMenuTheme(root: HTMLElement, theme: ThemeConfig | undefined): MenuTheme {
  const menu = menuThemeOf(theme);
  for (const [prop, value] of Object.entries(menuCssVars(menu))) {
    root.style.setProperty(prop, value);
  }
  root.style.setProperty("--sa-menu-stars", starTile(menu.starDensity));
  return menu;
}

/**
 * The nebula backdrop element for a menu screen: base color, two blooms, a
 * tiled starfield and a vignette — four stacked, non-interactive layers driven
 * entirely by the `--sa-menu-*` variables. Append it as the FIRST child of a
 * `.sa-screen` root (it is `position: absolute`, so it stays out of the flex
 * flow and the screen's own centering spacers keep working).
 */
export function createMenuBackdrop(): HTMLDivElement {
  const bg = document.createElement("div");
  bg.className = "sa-menu-bg";
  bg.setAttribute("aria-hidden", "true");
  for (const layer of ["nebula", "stars", "vignette"]) {
    const el = document.createElement("div");
    el.className = `layer ${layer}`;
    bg.append(el);
  }
  return bg;
}

const starTiles = new Map<number, string>();

/**
 * A 256x256 tile of randomly placed stars as a `url(data:...)` value — the
 * cheapest possible starfield: no assets, no DOM nodes, no per-frame work, and
 * the browser tiles one small texture across the whole backdrop. Falls back to
 * `none` wherever a canvas isn't available (tests, exotic embeddings).
 */
function starTile(density: number): string {
  const count = starCountFor(density);
  if (count <= 0) return "none";
  const cached = starTiles.get(count);
  if (cached) return cached;
  try {
    const size = 256;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) return "none";
    for (let i = 0; i < count; i++) {
      const x = Math.random() * size;
      const y = Math.random() * size;
      const r = Math.random() < 0.85 ? 0.6 : 1.2;
      ctx.globalAlpha = 0.25 + Math.random() * 0.6;
      ctx.fillStyle = Math.random() < 0.15 ? "#9fd8ff" : "#ffffff";
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    const value = `url("${canvas.toDataURL("image/png")}")`;
    starTiles.set(count, value);
    return value;
  } catch {
    return "none";
  }
}

/** Max width of a menu control; below this it shrinks with the viewport. */
const CSS = `
.sa-screen {
  position: fixed;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-start;
  gap: 12px;
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
  padding:
    calc(env(safe-area-inset-top, 0px) + 64px)
    calc(env(safe-area-inset-right, 0px) + 16px)
    calc(env(safe-area-inset-bottom, 0px) + 24px)
    calc(env(safe-area-inset-left, 0px) + 16px);
  color: var(--sa-menu-text, #e8f1ff);
  font-family: var(--sa-menu-font-body, system-ui, sans-serif);
  box-sizing: border-box;
}
/* Center the stack whenever it fits; scroll from the top when it doesn't. */
.sa-screen > * { flex: 0 0 auto; }
.sa-screen::before,
.sa-screen::after { content: ""; flex: 1 1 auto; min-height: 0; }

.sa-screen-title {
  letter-spacing: var(--sa-menu-title-tracking, .3em);
  font-weight: 300;
  color: var(--sa-menu-primary, #57d8ff);
  margin: 0 0 8px;
  font-size: clamp(20px, 7vw, 34px);
  text-align: center;
}

.sa-screen-header {
  position: absolute;
  top: calc(env(safe-area-inset-top, 0px) + 12px);
  right: calc(env(safe-area-inset-right, 0px) + 12px);
  left: calc(env(safe-area-inset-left, 0px) + 12px);
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 10px;
  font-size: 13px;
  color: #9fb4d0;
  text-align: right;
}

.sa-screen-btn {
  width: min(320px, 100%);
  min-height: 48px;
  padding: 12px 20px;
  font-size: clamp(14px, 4vw, 16px);
  background: #12203a;
  color: #e8f1ff;
  border: 1px solid #2f6fb8;
  border-radius: 8px;
  cursor: pointer;
  touch-action: manipulation;
}
.sa-screen-btn:disabled { opacity: .5; cursor: default; }

.sa-screen-link {
  color: #57d8ff;
  text-decoration: underline;
  cursor: pointer;
  font-size: 13px;
  padding: 6px 2px;
  touch-action: manipulation;
}
.sa-screen-link.muted { color: #6f84a0; font-size: 12px; }

.sa-screen-status { min-height: 1.4em; color: #9fb4d0; text-align: center; max-width: min(320px, 100%); }
.sa-screen-error { min-height: 1.4em; color: #ff8080; font-size: 13px; max-width: min(320px, 100%); text-align: center; }

.sa-screen-forms {
  display: none;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  width: min(320px, 100%);
}
.sa-screen-forms.open { display: flex; }
.sa-screen-tabs { display: flex; gap: 8px; width: 100%; }
.sa-screen-panel { display: flex; flex-direction: column; gap: 8px; width: 100%; }
.sa-screen-input {
  width: 100%;
  min-height: 44px;
  padding: 10px 12px;
  font-size: 16px; /* < 16px makes iOS Safari zoom the page on focus */
  background: #0c1526;
  color: #e8f1ff;
  border: 1px solid #2f6fb8;
  border-radius: 6px;
  box-sizing: border-box;
}
.sa-screen-formbtn {
  min-height: 44px;
  padding: 10px;
  font-size: 14px;
  background: #57d8ff;
  color: #04101f;
  font-weight: 600;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  touch-action: manipulation;
}
.sa-screen-formbtn:disabled { opacity: .5; cursor: default; }
.sa-screen-tab {
  flex: 1;
  min-height: 40px;
  padding: 6px;
  font-size: 12px;
  letter-spacing: .04em;
  text-transform: uppercase;
  background: #0c1526;
  color: #9fb4d0;
  border: 1px solid #2f6fb8;
  border-radius: 6px;
  cursor: pointer;
  touch-action: manipulation;
}
.sa-screen-tab.active { background: #1c3a5e; color: #e8f1ff; }
.sa-screen-chip {
  padding: 6px 12px;
  min-height: 32px;
  font-size: 12px;
  background: transparent;
  color: #e8f1ff;
  border: 1px solid #2f6fb8;
  border-radius: 6px;
  cursor: pointer;
  touch-action: manipulation;
}

/* ============================================================
   5.8 — dark nebula backdrop, menu sections, settings controls
   Colors come from theme.menu via the --sa-menu-* variables that
   applyMenuTheme() writes onto the screen root; every rule keeps the
   pre-5.8 literal as its fallback so a pack without a menu block is
   pixel-identical to before.
   ============================================================ */

/* Backdrop: base color + two nebula blooms + a tiled star texture + vignette.
   An absolutely-positioned child (not ::before) because .sa-screen already
   uses both pseudo-elements as the flex centering spacers. */
.sa-menu-bg {
  /* Fixed, not absolute: the screen is a scroll container, and an absolute
     backdrop would scroll away and expose the page background under a tall
     menu (seen at 812x375 landscape). The screen root is itself fixed/inset:0,
     so this covers exactly the same box and never moves. */
  position: fixed;
  inset: 0;
  /* Negative z-index inside the screen's own stacking context (the roots set an
     explicit z-index) paints the backdrop behind every sibling WITHOUT having to
     restyle them — restyling them would clobber the header's absolute pinning. */
  z-index: -1;
  pointer-events: none;
  background-color: var(--sa-menu-base, #04070f);
  overflow: hidden;
}
.sa-menu-bg .layer { position: absolute; inset: 0; }
.sa-menu-bg .nebula {
  opacity: var(--sa-menu-nebula-opacity, .55);
  background:
    radial-gradient(60% 45% at 18% 22%, var(--sa-menu-nebula-1, #0f4f7a) 0%, transparent 70%),
    radial-gradient(55% 40% at 82% 78%, var(--sa-menu-nebula-2, #7a3a12) 0%, transparent 72%),
    radial-gradient(90% 70% at 50% 50%, rgba(20, 40, 80, .55) 0%, transparent 80%);
  filter: blur(6px);
}
.sa-menu-bg .stars {
  background-image: var(--sa-menu-stars, none);
  background-repeat: repeat;
  background-size: 256px 256px;
  opacity: .75;
}
.sa-menu-bg .vignette {
  background: radial-gradient(ellipse at center, transparent 45%, rgba(0, 0, 0, var(--sa-menu-vignette, .55)) 100%);
}

/* --- Title treatment --- */
.sa-menu-titlewrap { display: flex; flex-direction: column; align-items: center; gap: 2px; margin-bottom: 4px; }
.sa-menu-titlewrap .sa-screen-title {
  font-family: var(--sa-menu-font-display, system-ui, sans-serif);
  font-weight: 500;
  margin: 0;
  text-shadow:
    0 0 calc(18px * var(--sa-menu-title-glow, .5)) var(--sa-menu-primary, #57d8ff),
    0 0 calc(46px * var(--sa-menu-title-glow, .5)) rgba(87, 216, 255, .35);
}
.sa-menu-subtitle {
  font-size: clamp(9px, 2.6vw, 11px);
  letter-spacing: .42em;
  text-transform: uppercase;
  color: var(--sa-menu-muted, #8ba3c4);
  text-align: center;
  padding-left: .42em; /* optical: tracking adds a trailing gap */
}
.sa-menu-subtitle:empty { display: none; }
/* Thin accent rule under the wordmark — cyan → orange, the project reference. */
.sa-menu-rule {
  width: min(320px, 70%);
  height: 1px;
  margin: 8px 0 4px;
  background: linear-gradient(90deg, transparent, var(--sa-menu-primary, #57d8ff), var(--sa-menu-accent, #ff8c42), transparent);
  opacity: .8;
}

/* --- Grouped play sections --- */
.sa-menu-sections { display: flex; flex-direction: column; gap: 14px; width: min(340px, 100%); }
.sa-menu-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--sa-menu-border, #1d3a5e);
  border-radius: 10px;
  background: color-mix(in srgb, var(--sa-menu-panel, #0b1424) 82%, transparent);
}
.sa-menu-section-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 10px;
  letter-spacing: .28em;
  text-transform: uppercase;
  color: var(--sa-menu-muted, #8ba3c4);
}
.sa-menu-section-title::before {
  content: "";
  width: 14px;
  height: 2px;
  border-radius: 1px;
  background: var(--sa-menu-primary, #57d8ff);
}
.sa-menu-section[data-accent="accent"] .sa-menu-section-title::before { background: var(--sa-menu-accent, #ff8c42); }
.sa-menu-section .sa-screen-btn { width: 100%; }

/* --- Button hierarchy --- */
.sa-screen-btn {
  background: color-mix(in srgb, var(--sa-menu-panel, #12203a) 88%, transparent);
  border-color: var(--sa-menu-border, #2f6fb8);
  color: var(--sa-menu-text, #e8f1ff);
  font-weight: 500;
  letter-spacing: .04em;
  transition: border-color .12s linear, background-color .12s linear, box-shadow .12s linear;
}
.sa-screen-btn:hover:not(:disabled) { border-color: var(--sa-menu-primary, #57d8ff); }
.sa-screen-btn--primary {
  background: var(--sa-menu-primary, #57d8ff);
  border-color: var(--sa-menu-primary, #57d8ff);
  color: var(--sa-menu-base, #04101f);
  font-weight: 700;
  letter-spacing: .08em;
  text-transform: uppercase;
  box-shadow: 0 0 18px rgba(87, 216, 255, .28);
}
.sa-screen-btn--accent {
  border-color: var(--sa-menu-accent, #ff8c42);
  color: var(--sa-menu-accent, #ff8c42);
}
.sa-screen-btn--accent:hover:not(:disabled) { border-color: var(--sa-menu-accent, #ff8c42); }

/* Gear affordance in the account header. */
.sa-screen-icon-btn {
  min-width: 36px;
  min-height: 36px;
  padding: 0 8px;
  font-size: 16px;
  line-height: 1;
  background: transparent;
  color: var(--sa-menu-text, #e8f1ff);
  border: 1px solid var(--sa-menu-border, #2f6fb8);
  border-radius: 8px;
  cursor: pointer;
  touch-action: manipulation;
}
.sa-screen-icon-btn:hover { border-color: var(--sa-menu-primary, #57d8ff); }

/* Account header identity chip. */
.sa-menu-account {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px;
  border: 1px solid var(--sa-menu-border, #1d3a5e);
  border-radius: 999px;
  background: color-mix(in srgb, var(--sa-menu-panel, #0b1424) 70%, transparent);
  color: var(--sa-menu-text, #e8f1ff);
  font-size: 12px;
}
.sa-menu-account .name { font-weight: 600; letter-spacing: .02em; }
.sa-menu-account .sep { opacity: .35; }
.sa-menu-account .level { color: var(--sa-menu-primary, #57d8ff); }
.sa-menu-account .credits { color: var(--sa-menu-accent, #ff8c42); }
.sa-menu-account.offline .name { color: var(--sa-menu-muted, #8ba3c4); font-weight: 500; }

/* --- Settings screen --- */
.sa-settings-groups { display: flex; flex-direction: column; gap: 12px; width: min(380px, 100%); }
.sa-settings-group {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px;
  border: 1px solid var(--sa-menu-border, #1d3a5e);
  border-radius: 10px;
  background: color-mix(in srgb, var(--sa-menu-panel, #0b1424) 88%, transparent);
}
.sa-settings-group > h2 {
  margin: 0;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: .26em;
  text-transform: uppercase;
  color: var(--sa-menu-primary, #57d8ff);
}
.sa-settings-row { display: flex; flex-direction: column; gap: 6px; }
.sa-settings-row > .label {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  font-size: 13px;
}
.sa-settings-row .value { color: var(--sa-menu-muted, #8ba3c4); font-variant-numeric: tabular-nums; font-size: 12px; }
.sa-settings-note { font-size: 11px; line-height: 1.45; color: var(--sa-menu-muted, #8ba3c4); }
.sa-settings-note code { font-family: ui-monospace, monospace; font-size: 11px; color: var(--sa-menu-text, #e8f1ff); }

/* Segmented choice (quality tiers, renderer). */
.sa-seg { display: flex; gap: 6px; width: 100%; }
.sa-seg-btn {
  flex: 1 1 0;
  min-height: 40px;
  padding: 6px 4px;
  font-size: 12px;
  letter-spacing: .06em;
  text-transform: uppercase;
  background: color-mix(in srgb, var(--sa-menu-base, #0c1526) 70%, transparent);
  color: var(--sa-menu-muted, #9fb4d0);
  border: 1px solid var(--sa-menu-border, #2f6fb8);
  border-radius: 8px;
  cursor: pointer;
  touch-action: manipulation;
}
.sa-seg-btn[aria-pressed="true"] {
  background: color-mix(in srgb, var(--sa-menu-primary, #57d8ff) 22%, transparent);
  border-color: var(--sa-menu-primary, #57d8ff);
  color: var(--sa-menu-text, #e8f1ff);
  font-weight: 600;
}

/* Slider (volumes, pan sensitivity). 44px hit target on touch. */
.sa-slider {
  width: 100%;
  height: 32px;
  margin: 0;
  accent-color: var(--sa-menu-primary, #57d8ff);
  touch-action: manipulation;
  cursor: pointer;
}

/* Toggle (haptics, camera shake). */
.sa-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-height: 44px;
  width: 100%;
  padding: 6px 10px;
  font-size: 13px;
  text-align: left;
  background: color-mix(in srgb, var(--sa-menu-base, #0c1526) 70%, transparent);
  color: var(--sa-menu-text, #e8f1ff);
  border: 1px solid var(--sa-menu-border, #2f6fb8);
  border-radius: 8px;
  cursor: pointer;
  touch-action: manipulation;
}
.sa-toggle:disabled { opacity: .5; cursor: default; }
.sa-toggle .pill {
  flex: 0 0 auto;
  min-width: 42px;
  padding: 3px 8px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: .08em;
  text-align: center;
  border-radius: 999px;
  border: 1px solid var(--sa-menu-border, #2f6fb8);
  color: var(--sa-menu-muted, #8ba3c4);
}
.sa-toggle[aria-pressed="true"] .pill {
  background: color-mix(in srgb, var(--sa-menu-primary, #57d8ff) 24%, transparent);
  border-color: var(--sa-menu-primary, #57d8ff);
  color: var(--sa-menu-text, #e8f1ff);
}

/* Read-only control tunables (they live in tuning.json — players don't edit them in MVP). */
.sa-settings-readonly { display: flex; flex-direction: column; gap: 4px; }
.sa-settings-readonly .kv {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: 12px;
  color: var(--sa-menu-muted, #8ba3c4);
}
.sa-settings-readonly .kv b { color: var(--sa-menu-text, #e8f1ff); font-variant-numeric: tabular-nums; font-weight: 600; }

/* Landscape phones: the header would collide with a top-anchored stack, and
   vertical room is scarce — tighten the paddings and the gaps. */
@media (orientation: landscape) and (max-height: 480px) {
  .sa-screen { gap: 8px; padding-top: calc(env(safe-area-inset-top, 0px) + 48px); }
  .sa-screen-title { margin-bottom: 2px; }
  .sa-screen-btn { min-height: 40px; padding: 8px 16px; }
  .sa-menu-sections { width: min(460px, 100%); }
  .sa-menu-section { padding: 10px; gap: 6px; }
  .sa-menu-rule { margin: 4px 0 0; }
}
`;
