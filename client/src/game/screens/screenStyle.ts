import type { ThemeConfig } from "@space-arena/shared";
import { menuCssVars, menuThemeOf, starCountFor, type MenuTheme } from "./menuTheme.js";
import { designTokenCssVars } from "../themeTokens.js";
import { DEFAULT_DESIGN_TOKENS } from "../themeTokens.js";

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
 *
 * ## Shape language
 *
 * The panels and buttons wear the same chamfered, luminous-rim look as the
 * in-match HUD (`client/src/game/hud/hudStyle.ts`), driven by
 * `theme.menu.style` through `--sa-menu-chamfer` / `--sa-menu-glow` /
 * `--sa-menu-panel-pct`. The rim is built as *element background = rim colour*
 * plus a `::before` fill plate inset by the rim width, both clipped to the same
 * polygon: a plain `border` would have its corners cut off by `clip-path` and
 * leave the bevel unlined. The host isolates a stacking context and the fill
 * plate sits at z=-1: bare text nodes cannot be positioned, so a non-negative
 * pseudo-element would otherwise paint over opaque button labels. Glow is
 * `filter: drop-shadow()`, never
 * `box-shadow`, because `clip-path` clips an outer box-shadow away entirely.
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
  for (const [prop, value] of Object.entries(designTokenCssVars(theme))) root.style.setProperty(prop, value);
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
  for (const layer of ["nebula", "stars", "grid", "vignette"]) {
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
      ctx.fillStyle = Math.random() < 0.15 ? DEFAULT_DESIGN_TOKENS.blue500 : DEFAULT_DESIGN_TOKENS.white;
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
  color: var(--sa-menu-text, var(--sa-white));
  font-family: var(--sa-menu-font-body, system-ui, sans-serif);
  box-sizing: border-box;

  /* --- Shape-language primitives (theme.menu.style) --- */
  --sa-menu-chamfer: 12px;
  --sa-menu-glow: 0.5;
  --sa-menu-panel-pct: 72%;
  --sa-rim: 1px;
  /* Octagonal chamfer for panels. */
  --sa-clip: polygon(
    var(--sa-menu-chamfer) 0%,
    calc(100% - var(--sa-menu-chamfer)) 0%,
    100% var(--sa-menu-chamfer),
    100% calc(100% - var(--sa-menu-chamfer)),
    calc(100% - var(--sa-menu-chamfer)) 100%,
    var(--sa-menu-chamfer) 100%,
    0% calc(100% - var(--sa-menu-chamfer)),
    0% var(--sa-menu-chamfer)
  );
  /* Two-corner bevel for controls — reads as a tab rather than a plate. */
  --sa-clip-btn: polygon(10px 0%, 100% 0%, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0% 100%, 0% 10px);
  --sa-clip-btn-sm: polygon(7px 0%, 100% 0%, 100% calc(100% - 7px), calc(100% - 7px) 100%, 0% 100%, 0% 7px);
  --sa-panel-fill: color-mix(in srgb, var(--sa-menu-panel, var(--sa-n-800)) var(--sa-menu-panel-pct), transparent);
  --sa-rim-color: color-mix(in srgb, var(--sa-menu-primary, var(--sa-blue-500)) 34%, transparent);
}
/* Center the stack whenever it fits; scroll from the top when it doesn't. */
.sa-screen > * { flex: 0 0 auto; }
.sa-screen::before,
.sa-screen::after { content: ""; flex: 1 1 auto; min-height: 0; }

.sa-screen-title {
  letter-spacing: var(--sa-menu-title-tracking, .3em);
  font-weight: 300;
  color: var(--sa-menu-primary, var(--sa-blue-500));
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
  color: var(--sa-menu-muted, var(--sa-n-400));
  text-align: right;
}

/* ---- Buttons: rim colour on the element, fill on ::before, text above both ---- */
.sa-screen-btn {
  position: relative;
  width: min(320px, 100%);
  min-height: 48px;
  padding: 12px 20px;
  font-size: clamp(14px, 4vw, 16px);
  background: var(--sa-rim-color);
  color: var(--sa-menu-text, var(--sa-white));
  border: 0;
  clip-path: var(--sa-clip-btn);
  cursor: pointer;
  touch-action: manipulation;
  box-sizing: border-box;
}
.sa-screen-btn::before {
  content: "";
  position: absolute;
  inset: var(--sa-rim);
  clip-path: var(--sa-clip-btn);
  background: var(--sa-panel-fill);
  transition: background-color .12s linear;
}

/*
 * Two-layer chamfer contract. Isolation keeps the negative plate above its
 * host's background rim but below all in-flow content, including bare text
 * nodes (which cannot receive position/z-index).
 */
.sa-screen-btn,
.sa-menu-btn,
.sa-settings-group {
  isolation: isolate;
}
.sa-screen-btn::before,
.sa-menu-btn::before,
.sa-settings-group::before {
  z-index: -1;
}
.sa-screen-btn:disabled { opacity: .45; cursor: default; }

.sa-screen-link {
  color: var(--sa-menu-primary, var(--sa-blue-500));
  text-decoration: underline;
  cursor: pointer;
  font-size: 13px;
  padding: 6px 2px;
  touch-action: manipulation;
}
.sa-screen-link.muted { color: var(--sa-menu-muted, var(--sa-n-400)); font-size: 12px; }

.sa-screen-status { min-height: 1.4em; color: var(--sa-menu-muted, var(--sa-n-400)); text-align: center; max-width: min(340px, 100%); }
.sa-screen-error { min-height: 1.4em; color: var(--sa-red-500); font-size: 13px; max-width: min(340px, 100%); text-align: center; }

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
  background: color-mix(in srgb, var(--sa-menu-base, var(--sa-n-800)) 78%, transparent);
  color: var(--sa-menu-text, var(--sa-white));
  border: var(--sa-rim) solid var(--sa-menu-border, var(--sa-n-600));
  clip-path: var(--sa-clip-btn-sm);
  box-sizing: border-box;
}
.sa-screen-input:focus {
  outline: none;
  border-color: var(--sa-menu-primary, var(--sa-blue-500));
}
.sa-screen-formbtn {
  min-height: 44px;
  padding: 10px;
  font-size: 14px;
  letter-spacing: .08em;
  text-transform: uppercase;
  background: var(--sa-menu-primary, var(--sa-blue-500));
  color: var(--sa-menu-base, var(--sa-n-900));
  font-weight: 700;
  border: none;
  clip-path: var(--sa-clip-btn-sm);
  cursor: pointer;
  touch-action: manipulation;
  filter: drop-shadow(0 0 calc(14px * var(--sa-menu-glow)) color-mix(in srgb, var(--sa-menu-primary, var(--sa-blue-500)) 45%, transparent));
}
.sa-screen-formbtn:disabled { opacity: .5; cursor: default; filter: none; }
.sa-screen-tab {
  flex: 1;
  min-height: 40px;
  padding: 6px;
  font-size: 12px;
  letter-spacing: .1em;
  text-transform: uppercase;
  background: color-mix(in srgb, var(--sa-menu-base, var(--sa-n-800)) 78%, transparent);
  color: var(--sa-menu-muted, var(--sa-n-400));
  border: var(--sa-rim) solid var(--sa-menu-border, var(--sa-n-600));
  clip-path: var(--sa-clip-btn-sm);
  cursor: pointer;
  touch-action: manipulation;
}
.sa-screen-tab.active {
  background: color-mix(in srgb, var(--sa-menu-primary, var(--sa-blue-500)) 20%, transparent);
  border-color: var(--sa-menu-primary, var(--sa-blue-500));
  color: var(--sa-menu-text, var(--sa-white));
}
.sa-screen-chip {
  padding: 6px 12px;
  min-height: 32px;
  font-size: 12px;
  letter-spacing: .06em;
  background: transparent;
  color: var(--sa-menu-text, var(--sa-white));
  border: var(--sa-rim) solid var(--sa-menu-border, var(--sa-n-600));
  clip-path: var(--sa-clip-btn-sm);
  cursor: pointer;
  touch-action: manipulation;
}
.sa-screen-chip:hover { border-color: var(--sa-menu-primary, var(--sa-blue-500)); }

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
     restyle them — restyling them would clobber the header's absolute pinning.
     Load-bearing, not decorative: a fixed element at z-index auto paints in the
     positioned layer, i.e. OVER the static title, subtitle and tabs, which is
     exactly what swallowed the wordmark. */
  z-index: -1;
  pointer-events: none;
  background-color: var(--sa-menu-base, var(--sa-n-900));
  overflow: hidden;
}
.sa-menu-bg .layer { position: absolute; inset: 0; }
.sa-menu-bg .nebula {
  opacity: var(--sa-menu-nebula-opacity, .55);
  background:
    radial-gradient(60% 45% at 18% 22%, var(--sa-menu-nebula-1, var(--sa-n-700)) 0%, transparent 70%),
    radial-gradient(55% 40% at 82% 78%, var(--sa-menu-nebula-2, var(--sa-n-600)) 0%, transparent 72%),
    radial-gradient(90% 70% at 50% 50%, rgba(20, 40, 80, .55) 0%, transparent 80%);
  filter: blur(6px);
}
.sa-menu-bg .stars {
  background-image: var(--sa-menu-stars, none);
  background-repeat: repeat;
  background-size: 256px 256px;
  opacity: .75;
}
/* Faint holographic survey grid — two 1px gradients, fading out toward the
   middle so it frames the content instead of sitting behind the text. */
.sa-menu-bg .grid {
  opacity: .16;
  background-image:
    repeating-linear-gradient(90deg, var(--sa-menu-primary, var(--sa-blue-500)) 0 1px, transparent 1px 64px),
    repeating-linear-gradient(180deg, var(--sa-menu-primary, var(--sa-blue-500)) 0 1px, transparent 1px 64px);
  -webkit-mask: radial-gradient(ellipse 70% 60% at 50% 50%, transparent 20%, #000 100%);
  mask: radial-gradient(ellipse 70% 60% at 50% 50%, transparent 20%, #000 100%);
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
    0 0 calc(18px * var(--sa-menu-title-glow, .5)) var(--sa-menu-primary, var(--sa-blue-500)),
    0 0 calc(46px * var(--sa-menu-title-glow, .5)) rgba(87, 216, 255, .35);
}
.sa-menu-subtitle {
  font-size: clamp(9px, 2.6vw, 11px);
  letter-spacing: .42em;
  text-transform: uppercase;
  color: var(--sa-menu-muted, var(--sa-n-400));
  text-align: center;
  padding-left: .42em; /* optical: tracking adds a trailing gap */
}
.sa-menu-subtitle:empty { display: none; }
/* Thin accent rule under the wordmark — cyan → orange, the project reference,
   with a bracket tick at each end so the wordmark reads as a framed plate. */
.sa-menu-rule {
  position: relative;
  width: min(320px, 70%);
  height: 1px;
  margin: 10px 0 4px;
  background: linear-gradient(90deg, transparent, var(--sa-menu-primary, var(--sa-blue-500)), var(--sa-menu-accent, var(--sa-white)), transparent);
  opacity: .85;
}
.sa-menu-rule::before,
.sa-menu-rule::after {
  content: "";
  position: absolute;
  top: -3px;
  width: 1px;
  height: 7px;
  background: var(--sa-menu-primary, var(--sa-blue-500));
  opacity: .7;
}
.sa-menu-rule::before { left: 12%; }
.sa-menu-rule::after { right: 12%; background: var(--sa-menu-accent, var(--sa-white)); }

/* ============================================================ MAIN MENU
   The menu sits over a live 3D diorama (the pilot's hull on lunar regolith,
   Earth on the horizon), so it is a SCRIM, not a panel: a gradient anchored to
   the bottom that keeps the type legible while leaving the Earth and the top of
   the ship in clear frame. A solid card here would simply hide what it is
   standing on.
   ==================================================================== */
.sa-screen.sa-menu[data-diorama="on"] {
  padding-bottom: calc(env(safe-area-inset-bottom, 0px) + 28px);
  background:
    linear-gradient(to top, rgba(3, 6, 11, .93) 0%, rgba(3, 6, 11, .78) 26%, rgba(3, 6, 11, .30) 52%, rgba(3, 6, 11, 0) 74%);
}
/* .sa-screen centres its stack with a pair of flexible ::before/::after
   spacers, and those absorb free space whatever justify-content says — which
   is why setting flex-end here does nothing on its own. Collapsing the trailing
   spacer is what actually bottom-anchors the grid, and leaving the leading one
   flexible keeps it scrolling from the top once the content stops fitting. */
.sa-menu[data-diorama="on"]::after { flex: 0 0 0; }

/* The wordmark leaves the flow and pins to the top-left, so the diorama's
   centre stays clear and the menu reads as a HUD over a place. */
.sa-menu[data-diorama="on"] .sa-menu-titlewrap {
  position: absolute;
  top: calc(env(safe-area-inset-top, 0px) + 18px);
  left: max(env(safe-area-inset-left, 0px), 26px);
  align-items: flex-start;
  margin: 0;
  text-align: left;
}
.sa-menu[data-diorama="on"] .sa-menu-titlewrap .sa-menu-rule { align-self: stretch; }
/* The account chip and gear pin to the top RIGHT, opposite the wordmark.
   Left in the flow they land on top of it, because the wordmark is out of the
   flow and the header is the first thing in it. */
.sa-menu[data-diorama="on"] .sa-screen-header {
  position: absolute;
  top: calc(env(safe-area-inset-top, 0px) + 16px);
  right: max(env(safe-area-inset-right, 0px), 22px);
  left: auto;
  width: auto;
  justify-content: flex-end;
  margin: 0;
}
/* Nothing else may claim vertical space: the grid is bottom-anchored, and an
   empty status line pushing it up leaves the menu floating mid-screen. */
.sa-menu[data-diorama="on"] .sa-screen-status:empty { display: none; }
.sa-menu[data-diorama="on"] .sa-menu-sections {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  width: 100%;
}
.sa-menu[data-diorama="on"] .sa-menu-rule::before,
.sa-menu[data-diorama="on"] .sa-menu-rule::after { display: none; }

/* --- Play grid: one column per group, side by side while there is room --- */
.sa-menu-play {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: center;
  gap: 18px 30px;
  width: 100%;
  max-width: 1080px;
}
.sa-menu-group { display: flex; flex-direction: column; gap: 9px; }
.sa-menu-group-title {
  margin: 0;
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: .26em;
  text-transform: uppercase;
  color: var(--sa-menu-muted, var(--sa-n-400));
  /* A rule that stops at the text rather than spanning the column: the group
     heading labels its own cards, and a full-width rule implies it labels the
     row. */
  display: flex;
  align-items: center;
  gap: 9px;
}
.sa-menu-group-title::after {
  content: "";
  flex: 1;
  height: 1px;
  background: linear-gradient(90deg, var(--sa-menu-border, var(--sa-n-700)), transparent);
}
.sa-menu-cards { display: flex; flex-wrap: wrap; gap: 9px; }

/* --- Menu buttons ---
   .sa-menu-btn is the shared plate; the kind class says what it DOES:
   .sa-menu-card starts a match, .sa-menu-category opens that kind's drawer,
   .sa-menu-destination goes somewhere, .sa-menu-back comes out. */
.sa-menu-btn {
  position: relative;
  display: flex;
  align-items: center;
  gap: 11px;
  min-height: 58px;
  padding: 10px 16px 10px 13px;
  color: var(--sa-white);
  background: var(--sa-rim-color);
  border: 0;
  text-align: left;
  cursor: pointer;
  clip-path: var(--sa-clip);
  transition: transform 140ms ease-out, background 140ms ease-out;
  touch-action: manipulation;
}
.sa-menu-card, .sa-menu-category { min-width: 152px; }
.sa-menu-btn::before {
  content: "";
  position: absolute;
  inset: var(--sa-rim);
  clip-path: var(--sa-clip);
  background: var(--sa-panel-fill);
  backdrop-filter: blur(7px);
  -webkit-backdrop-filter: blur(7px);
  transition: background 140ms ease-out;
}
.sa-menu-btn:hover:not(:disabled),
.sa-menu-btn:focus-visible {
  background: var(--sa-menu-primary, var(--sa-blue-500));
  transform: translateY(-2px);
}
.sa-menu-btn:hover:not(:disabled)::before,
.sa-menu-btn:focus-visible::before {
  background: color-mix(in srgb, var(--sa-menu-primary, var(--sa-blue-500)) 24%, rgba(6, 11, 18, .92));
}
.sa-menu-btn:active:not(:disabled) { transform: translateY(0); }
.sa-menu-btn:disabled { opacity: .45; cursor: default; }

.sa-menu-icon { display: flex; flex: 0 0 auto; color: var(--sa-menu-primary, var(--sa-blue-400)); }
.sa-menu-icon svg { width: 26px; height: 26px; display: block; }
.sa-menu-btn:hover:not(:disabled) .sa-menu-icon,
.sa-menu-btn:focus-visible .sa-menu-icon { color: var(--sa-white); }

.sa-menu-card-text { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.sa-menu-card-label {
  font-size: 15px;
  font-weight: 700;
  letter-spacing: .08em;
  text-transform: uppercase;
  line-height: 1.15;
}
.sa-menu-card-blurb {
  font-size: 10.5px;
  letter-spacing: .04em;
  color: var(--sa-menu-muted, var(--sa-n-400));
  line-height: 1.3;
}
.sa-menu-btn:hover:not(:disabled) .sa-menu-card-blurb,
.sa-menu-btn:focus-visible .sa-menu-card-blurb { color: rgba(255, 255, 255, .82); }

/* --- Places you go: wider, quieter, and visibly not a match --- */
.sa-menu-destinations {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 9px;
  width: 100%;
  max-width: 1080px;
  margin-top: 4px;
}
.sa-menu-destinations[hidden] { display: none; }
.sa-menu-destination { min-width: 186px; }
.sa-menu-destination .sa-menu-icon { color: var(--sa-menu-accent, var(--sa-n-300)); }

/* --- Mode drawer: one group's matches, opened from a category button ---
   Every group's panel is BUILT ONCE and hidden, not created on entry: the
   online/busy gating walks a fixed list of buttons, and a panel that only
   exists while it is open would drop out of that list. */
.sa-menu-modes { display: contents; }
.sa-menu-play[hidden] { display: none; }
.sa-menu-group[hidden] { display: none; }
.sa-menu-back {
  align-self: flex-start;
  margin-top: 2px;
  min-height: 34px;
  padding: 6px 14px 6px 10px;
  gap: 7px;
}
.sa-menu-back .sa-menu-icon svg { width: 17px; height: 17px; }
.sa-menu-back .sa-menu-card-label { font-size: 11.5px; letter-spacing: .18em; }

/* --- Places you go: wider, quieter, and visibly not a match --- */
.sa-menu-destinations {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 9px;
  width: 100%;
  max-width: 1080px;
  margin-top: 4px;
}
.sa-menu-destination { min-width: 186px; }
.sa-menu-destination .sa-menu-icon { color: var(--sa-menu-accent, var(--sa-n-300)); }

/* --- Press flash: the only "I heard you" a touch player gets ---
   Driven by an ANIMATION rather than :active, because the tap that opens a
   drawer also swaps the button out from under the finger — :active would be
   torn off mid-press and never paint. The rim and the fill flash together so
   the cue survives whatever the button sits on: the rim carries it on the
   nebula, the fill carries it against the diorama. */
/* The peak is HELD for the first third: an ease-out from full brightness is
   most of the way back to normal within two frames, which is exactly the
   window a player's eye is still moving. */
@keyframes sa-menu-press-rim {
  0%, 32% { background: var(--sa-menu-accent, var(--sa-white)); }
  100% { background: var(--sa-rim-color); }
}
@keyframes sa-menu-press-fill {
  0%, 32% { background: color-mix(in srgb, var(--sa-menu-accent, var(--sa-white)) 78%, transparent); }
  100% { background: var(--sa-panel-fill); }
}
@keyframes sa-menu-press-push {
  0%, 32% { transform: scale(.955); }
  100% { transform: none; }
}
.sa-menu-btn.sa-pressed,
.sa-screen-chip.sa-pressed,
.sa-screen-icon-btn.sa-pressed,
.sa-screen-link.sa-pressed {
  animation:
    sa-menu-press-rim var(--sa-menu-click-ms, 220ms) ease-out,
    sa-menu-press-push var(--sa-menu-click-ms, 220ms) ease-out;
}
.sa-menu-btn.sa-pressed::before {
  animation: sa-menu-press-fill var(--sa-menu-click-ms, 220ms) ease-out;
}
/* A link has no rim to flash: give it the accent outright. */
.sa-screen-link.sa-pressed { animation-name: sa-menu-press-push; color: var(--sa-menu-accent, var(--sa-white)); }

@media (prefers-reduced-motion: reduce) {
  .sa-menu-btn { transition: background 140ms ease-out; }
  .sa-menu-btn:hover:not(:disabled) { transform: none; }
  /* The flash stays — it is feedback, not decoration — but stops moving. */
  .sa-menu-btn.sa-pressed,
  .sa-screen-chip.sa-pressed,
  .sa-screen-icon-btn.sa-pressed,
  .sa-screen-link.sa-pressed { animation-name: sa-menu-press-rim; }
}

@media (max-width: 720px) {
  .sa-menu-play { gap: 14px 18px; }
  .sa-menu-card { min-width: 128px; flex: 1 1 128px; }
  .sa-menu-destination { min-width: 0; flex: 1 1 150px; }
  .sa-menu[data-diorama="on"] .sa-menu-titlewrap { top: calc(env(safe-area-inset-top, 0px) + 12px); left: 16px; }
}

/* The sections column. In diorama mode this is overridden above to run
   full-width and bottom-anchored; this is the fallback for a pack that ships
   no 3D backdrop. */
.sa-menu-sections { display: flex; flex-direction: column; align-items: center; gap: 14px; width: min(560px, 100%); }

/* Persistent "the game server did not answer" mark on the online section.
   Deliberately a banner inside the section rather than a toast: an offline
   server is a STATE, and a toast that has faded cannot explain a disabled
   button five seconds later. */
.sa-menu-offline-badge {
  display: none;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: .12em;
  text-transform: uppercase;
  color: var(--sa-menu-accent, var(--sa-white));
  background: color-mix(in srgb, var(--sa-menu-accent, var(--sa-white)) 12%, transparent);
  box-shadow: inset 3px 0 0 0 var(--sa-menu-accent, var(--sa-white));
  clip-path: polygon(7px 0%, 100% 0%, calc(100% - 7px) 100%, 0% 100%);
}
.sa-menu-offline-badge.visible { display: flex; }
/* Its own line above the grid, and never wider than the grid it explains. */
.sa-menu-sections > .sa-menu-offline-badge { align-self: center; max-width: min(1080px, 100%); }
.sa-menu-offline-badge .dot {
  flex: 0 0 auto;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--sa-menu-accent, var(--sa-white));
  animation: sa-offline-pulse 1.6s ease-in-out infinite;
}
.sa-menu-offline-badge .detail {
  font-weight: 500;
  letter-spacing: .04em;
  text-transform: none;
  color: var(--sa-menu-muted, var(--sa-n-400));
}
@keyframes sa-offline-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: .3; }
}

/* --- Button hierarchy --- */
.sa-screen-btn {
  font-weight: 500;
  letter-spacing: .06em;
  transition: background-color .12s linear, color .12s linear;
}
.sa-screen-btn:hover:not(:disabled) { background: var(--sa-menu-primary, var(--sa-blue-500)); }
.sa-screen-btn:hover:not(:disabled)::before {
  background: color-mix(in srgb, var(--sa-menu-primary, var(--sa-blue-500)) 22%, var(--sa-panel-fill));
}
.sa-screen-btn--primary {
  background: var(--sa-menu-primary, var(--sa-blue-500));
  color: var(--sa-menu-base, var(--sa-n-900));
  font-weight: 700;
  letter-spacing: .1em;
  text-transform: uppercase;
  filter: drop-shadow(0 0 calc(20px * var(--sa-menu-glow)) color-mix(in srgb, var(--sa-menu-primary, var(--sa-blue-500)) 45%, transparent));
}
.sa-screen-btn--primary::before { background: var(--sa-menu-primary, var(--sa-blue-500)); }
.sa-screen-btn--primary:hover:not(:disabled)::before {
  background: color-mix(in srgb, var(--sa-menu-primary, var(--sa-blue-500)) 84%, var(--sa-white));
}
.sa-screen-btn--primary:disabled { filter: none; }
.sa-screen-btn--accent {
  background: color-mix(in srgb, var(--sa-menu-accent, var(--sa-white)) 55%, transparent);
  color: var(--sa-menu-accent, var(--sa-white));
}
.sa-screen-btn--accent:hover:not(:disabled) { background: var(--sa-menu-accent, var(--sa-white)); }
.sa-screen-btn--accent:hover:not(:disabled)::before {
  background: color-mix(in srgb, var(--sa-menu-accent, var(--sa-white)) 20%, var(--sa-panel-fill));
}

/* Gear affordance in the account header. */
.sa-screen-icon-btn {
  min-width: 40px;
  min-height: 40px;
  padding: 0 8px;
  font-size: 16px;
  line-height: 1;
  background: color-mix(in srgb, var(--sa-menu-panel, var(--sa-n-800)) 70%, transparent);
  color: var(--sa-menu-text, var(--sa-white));
  border: var(--sa-rim) solid var(--sa-menu-border, var(--sa-n-600));
  clip-path: var(--sa-clip-btn-sm);
  cursor: pointer;
  touch-action: manipulation;
}
.sa-screen-icon-btn:hover { border-color: var(--sa-menu-primary, var(--sa-blue-500)); }

/* Account header identity chip. */
.sa-menu-account {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border: var(--sa-rim) solid var(--sa-menu-border, var(--sa-n-600));
  clip-path: var(--sa-clip-btn-sm);
  background: color-mix(in srgb, var(--sa-menu-panel, var(--sa-n-800)) 70%, transparent);
  color: var(--sa-menu-text, var(--sa-white));
  font-size: 12px;
}
.sa-menu-account .name { font-weight: 600; letter-spacing: .02em; }
.sa-menu-account .sep { opacity: .35; }
.sa-menu-account .level { color: var(--sa-menu-primary, var(--sa-blue-500)); }
.sa-menu-account .credits { color: var(--sa-menu-accent, var(--sa-white)); }
.sa-menu-account.offline .name { color: var(--sa-menu-muted, var(--sa-n-400)); font-weight: 500; }

/* --- Settings screen --- */
.sa-settings-groups { display: flex; flex-direction: column; gap: 12px; width: min(380px, 100%); }
.sa-settings-group {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 16px;
  border: 0;
  background: var(--sa-rim-color);
  clip-path: var(--sa-clip);
}
.sa-settings-group::before {
  content: "";
  position: absolute;
  inset: var(--sa-rim);
  clip-path: var(--sa-clip);
  background: var(--sa-panel-fill);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
}
.sa-settings-group > h2 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: .26em;
  text-transform: uppercase;
  color: var(--sa-menu-primary, var(--sa-blue-500));
}
/* Same bracket accent as the lobby's section headings. */
.sa-settings-group > h2::before {
  content: "";
  width: 9px;
  height: 9px;
  flex: 0 0 auto;
  border-left: 2px solid var(--sa-menu-primary, var(--sa-blue-500));
  border-top: 2px solid var(--sa-menu-primary, var(--sa-blue-500));
}
.sa-settings-group > h2::after {
  content: "";
  flex: 1 1 auto;
  height: 1px;
  background: linear-gradient(90deg, var(--sa-menu-border, var(--sa-n-600)), transparent);
}
.sa-settings-row { display: flex; flex-direction: column; gap: 6px; }
.sa-settings-row > .label {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  font-size: 13px;
}
.sa-settings-row .value { color: var(--sa-menu-primary, var(--sa-blue-500)); font-variant-numeric: tabular-nums; font-size: 12px; }
.sa-settings-note { font-size: 11px; line-height: 1.45; color: var(--sa-menu-muted, var(--sa-n-400)); }
.sa-settings-note code { font-family: ui-monospace, monospace; font-size: 11px; color: var(--sa-menu-text, var(--sa-white)); }

/* Segmented choice (quality tiers, renderer). */
.sa-seg { display: flex; gap: 6px; width: 100%; }
.sa-seg-btn {
  flex: 1 1 0;
  min-height: 40px;
  padding: 6px 4px;
  font-size: 12px;
  letter-spacing: .1em;
  text-transform: uppercase;
  background: color-mix(in srgb, var(--sa-menu-base, var(--sa-n-800)) 72%, transparent);
  color: var(--sa-menu-muted, var(--sa-n-400));
  border: var(--sa-rim) solid var(--sa-menu-border, var(--sa-n-600));
  clip-path: var(--sa-clip-btn-sm);
  cursor: pointer;
  touch-action: manipulation;
}
.sa-seg-btn[aria-pressed="true"] {
  background: color-mix(in srgb, var(--sa-menu-primary, var(--sa-blue-500)) 22%, transparent);
  border-color: var(--sa-menu-primary, var(--sa-blue-500));
  color: var(--sa-menu-text, var(--sa-white));
  font-weight: 600;
}

/* Slider (volumes, pan sensitivity). See the coarse-pointer block for the
   44px touch minimum — a mouse does not need the extra row height. */
.sa-slider {
  width: 100%;
  height: 32px;
  margin: 0;
  accent-color: var(--sa-menu-primary, var(--sa-blue-500));
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
  padding: 6px 12px;
  font-size: 13px;
  text-align: left;
  background: color-mix(in srgb, var(--sa-menu-base, var(--sa-n-800)) 72%, transparent);
  color: var(--sa-menu-text, var(--sa-white));
  border: var(--sa-rim) solid var(--sa-menu-border, var(--sa-n-600));
  clip-path: var(--sa-clip-btn-sm);
  cursor: pointer;
  touch-action: manipulation;
  box-sizing: border-box;
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
  border: var(--sa-rim) solid var(--sa-menu-border, var(--sa-n-600));
  color: var(--sa-menu-muted, var(--sa-n-400));
}
.sa-toggle[aria-pressed="true"] .pill {
  background: color-mix(in srgb, var(--sa-menu-primary, var(--sa-blue-500)) 24%, transparent);
  border-color: var(--sa-menu-primary, var(--sa-blue-500));
  color: var(--sa-menu-text, var(--sa-white));
}

/* Read-only control tunables (they live in tuning.json — players don't edit them in MVP). */
.sa-settings-readonly { display: flex; flex-direction: column; gap: 4px; }
.sa-settings-readonly .kv {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: 12px;
  color: var(--sa-menu-muted, var(--sa-n-400));
}
.sa-settings-readonly .kv b { color: var(--sa-menu-text, var(--sa-white)); font-variant-numeric: tabular-nums; font-weight: 600; }

/* Landscape phones: the header would collide with a top-anchored stack, and
   vertical room is scarce — tighten the paddings and the gaps. */
@media (orientation: landscape) and (max-height: 480px) {
  .sa-screen { gap: 8px; padding-top: calc(env(safe-area-inset-top, 0px) + 48px); }
  .sa-screen-title { margin-bottom: 2px; }
  .sa-screen-btn { min-height: 44px; padding: 9px 16px; }
  .sa-menu-sections { width: min(460px, 100%); }
  .sa-menu-rule { margin: 4px 0 0; }
  .sa-menu-bg .grid { opacity: .1; }
}

/* Coarse pointers get the touch minimum on every control, including the ones a
   mouse can afford to make smaller. */
@media (pointer: coarse) {
  .sa-screen-chip,
  .sa-screen-icon-btn,
  .sa-seg-btn,
  .sa-screen-tab { min-height: 44px; }
  .sa-slider { height: 44px; }
}

@media (prefers-reduced-motion: reduce) {
  .sa-menu-offline-badge .dot { animation: none; }
}

/* Design-system primitives. State attributes make every board state testable
   without synthesising pointer events; native pseudo-classes remain canonical. */
.sa-button, .sa-icon-button, .sa-toggle, .sa-tab {
  box-sizing:border-box; border:var(--sa-line-hairline) solid var(--sa-primary, var(--sa-blue-500));
  border-radius:var(--sa-radius-small); color:var(--sa-white); background:transparent;
  font:var(--sa-type-caption); letter-spacing:.08em; transition:background-color 150ms, border-color 150ms, transform 100ms, opacity 150ms;
}
.sa-button { min-height:40px; padding:8px 18px; }
.sa-button--primary { background:var(--sa-blue-500); border-color:var(--sa-blue-500); }
.sa-button--secondary { background:var(--sa-n-800); border-color:var(--sa-n-400); }
.sa-button:hover:not(:disabled), .sa-button[data-state="hover"] { background:color-mix(in srgb, var(--sa-button-color, var(--sa-blue-500)) 82%, var(--sa-white)); }
.sa-button--secondary { --sa-button-color:var(--sa-n-600); }
.sa-button:active:not(:disabled), .sa-button[data-state="pressed"] { transform:translateY(1px); background:color-mix(in srgb, var(--sa-button-color, var(--sa-blue-500)) 78%, var(--sa-n-900)); }
.sa-button:disabled, .sa-button[data-state="disabled"] { opacity:.38; cursor:not-allowed; filter:saturate(.25); }
.sa-icon-button { width:40px; height:40px; display:inline-grid; place-items:center; padding:0; clip-path:var(--sa-clip); }
.sa-tab-group { display:inline-flex; }
.sa-toggle, .sa-tab { min-height:32px; padding:6px 14px; border-radius:0; border-inline-end:0; }
.sa-toggle:first-child, .sa-tab:first-child { border-radius:var(--sa-radius-small) 0 0 var(--sa-radius-small); }
.sa-toggle:last-child, .sa-tab:last-child { border-radius:0 var(--sa-radius-small) var(--sa-radius-small) 0; border-inline-end:var(--sa-line-hairline) solid var(--sa-n-400); }
.sa-toggle[aria-pressed="true"], .sa-tab[aria-selected="true"] { background:var(--sa-blue-500); border-color:var(--sa-blue-500); }
.sa-slider { accent-color:var(--sa-slider-color, var(--sa-blue-500)); }
.sa-panel { position:relative; box-sizing:border-box; padding:16px; border:var(--sa-line-hairline) solid var(--sa-n-600); border-radius:var(--sa-radius-medium); background:var(--sa-n-800); }
.sa-panel--top-accent { border-top:var(--sa-line-thin) solid var(--sa-blue-500); }
.sa-panel--holographic { clip-path:var(--sa-clip); background:linear-gradient(color-mix(in srgb,var(--sa-blue-500) 8%,transparent),transparent),repeating-linear-gradient(90deg,color-mix(in srgb,var(--sa-blue-500) 10%,transparent) 0 1px,transparent 1px 24px),var(--sa-n-800); }
.sa-progress { overflow:hidden; height:6px; border-radius:var(--sa-radius-small); background:var(--sa-n-700); }
.sa-progress__bar { width:var(--sa-progress,0%); height:100%; background:var(--sa-progress-color,var(--sa-blue-500)); transition:width 150ms; }
`;
