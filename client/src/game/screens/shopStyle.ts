const STYLE_ID = "sa-shop-style";

/**
 * The shop's own layer over the shared menu stylesheet (`screenStyle.ts`).
 *
 * Everything structural — backdrop, panels, buttons, tabs, the two-plate
 * chamfer — is inherited from `.sa-screen`/`.sa-menu`; this file adds only what
 * a CATALOGUE needs and the play menu does not: a wide responsive grid, a card
 * whose action row is bottom-aligned so a row of cards never reads ragged, and
 * the swatch.
 *
 * Every colour is a design token or a `--sa-menu-*` theme variable, with one
 * deliberate exception: `--shop-primary/-accent/-glow` are the paint's OWN
 * authored colours, set per card from content. A swatch that resolved to the
 * palette would be showing the wrong thing.
 */
export function injectShopStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

const CSS = `
/* The catalogue is wide where the play menu is a column. */
.shop-overlay {
  justify-content: flex-start;
  gap: 14px;
  padding-top: calc(env(safe-area-inset-top, 0px) + 58px);
}
/* No vertical centering spacers: a grid that grows must start at the top. */
.shop-overlay::before,
.shop-overlay::after { content: none; }

.shop-overlay .sa-menu-titlewrap { margin-bottom: 0; }

.shop-tabs {
  display: flex;
  gap: 0;
  width: min(420px, 100%);
}
.shop-tabs .sa-tab {
  flex: 1 1 0;
  /* 44px, not 40: these are the screen's PRIMARY navigation and they were the
     one control under the touch minimum (finding 48). */
  min-height: 44px;
  font: var(--sa-type-caption);
  letter-spacing: .16em;
  text-transform: uppercase;
  cursor: pointer;
  touch-action: manipulation;
}
@media (pointer: coarse) {
  .shop-tabs .sa-tab { min-height: 48px; }
}

/* Text filter over the current list. 58 module cards across ~12 screens, with
   group headings as the only navigation, is not a list you browse (46). */
.shop-filter { width: min(420px, 100%); }
.shop-filter[hidden] { display: none; }
.shop-filter-input {
  width: 100%;
  min-height: 40px;
  padding: 8px 12px;
  box-sizing: border-box;
  font: var(--sa-type-body);
  font-size: 16px; /* < 16px makes iOS Safari zoom the page on focus */
  color: var(--sa-menu-text, var(--sa-white));
  background: color-mix(in srgb, var(--sa-menu-base, var(--sa-n-800)) 78%, transparent);
  border: var(--sa-line-hairline) solid var(--sa-menu-border, var(--sa-n-600));
  clip-path: var(--sa-clip-btn-sm);
}
.shop-filter-input:focus { outline: none; border-color: var(--sa-menu-primary, var(--sa-blue-500)); }
@media (pointer: coarse) {
  .shop-filter-input { min-height: 44px; }
}
.shop-tabs .sa-tab[aria-selected="true"] {
  color: var(--sa-n-900);
  font-weight: 700;
}

.shop-credits {
  display: inline-flex;
  align-items: baseline;
  gap: 8px;
}
.shop-credits .k {
  font-size: 10px;
  letter-spacing: .28em;
  text-transform: uppercase;
  color: var(--sa-menu-muted, var(--sa-n-400));
}
.shop-credits .v {
  font: var(--sa-type-data);
  font-variant-numeric: tabular-nums;
  color: var(--sa-menu-primary, var(--sa-blue-500));
}

/* Errors read as a STATE on the screen, not a toast that fades before the
   pilot has finished reading why the purchase did not happen. */
.shop-notice {
  display: none;
  width: min(1040px, 100%);
  padding: 6px 10px;
  font: var(--sa-type-caption);
  color: var(--sa-red-500);
  border-left: var(--sa-line-thin) solid var(--sa-red-500);
  background: color-mix(in srgb, var(--sa-red-500) 12%, transparent);
  box-sizing: border-box;
}
.shop-notice.visible { display: block; }

.shop-body { width: min(1040px, 100%); }
.shop-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(264px, 1fr));
  gap: 12px;
  align-items: stretch;
}
.shop-group-title {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
  font-size: 10px;
  letter-spacing: .28em;
  text-transform: uppercase;
  color: var(--sa-menu-muted, var(--sa-n-400));
}
.shop-group-title::before {
  content: "";
  width: 9px;
  height: 9px;
  flex: 0 0 auto;
  border-left: var(--sa-line-thin) solid var(--sa-menu-primary, var(--sa-blue-500));
  border-top: var(--sa-line-thin) solid var(--sa-menu-primary, var(--sa-blue-500));
}
.shop-group-title::after {
  content: "";
  flex: 1 1 auto;
  height: 1px;
  background: linear-gradient(90deg, var(--sa-menu-border, var(--sa-n-600)), transparent);
}

/* Card: the same rim-plus-fill-plate two-layer chamfer the menu sections use. */
.shop-card {
  position: relative;
  isolation: isolate;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  box-sizing: border-box;
  background: var(--sa-rim-color);
  clip-path: var(--sa-clip);
}
.shop-card::before {
  content: "";
  position: absolute;
  inset: var(--sa-rim);
  z-index: -1;
  clip-path: var(--sa-clip);
  background: var(--sa-panel-fill);
}
.shop-card[data-state="equipped"] {
  background: color-mix(in srgb, var(--sa-menu-primary, var(--sa-blue-500)) 60%, transparent);
}
.shop-card[data-state="buy"] .shop-card-name { color: var(--sa-white); }

.shop-card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}
.shop-card-name {
  font: var(--sa-type-h3);
  letter-spacing: .04em;
  color: var(--sa-menu-text, var(--sa-white));
}
.shop-card-sub {
  font: var(--sa-type-caption);
  letter-spacing: .1em;
  text-transform: uppercase;
  color: var(--sa-menu-muted, var(--sa-n-400));
}
/* Why this card's Buy is off, in the open. The refusal used to arrive only
   after the tap, as a 403 rendered into the notice bar at the top of a
   12-screen list (findings 43, 45) — and a title a phone cannot show is not
   an answer either. */
.shop-card-blocked {
  font: var(--sa-type-caption);
  line-height: 1.35;
  color: var(--sa-red-500);
}
.shop-card[data-blocked] .shop-card-name,
.shop-card[data-blocked] .shop-chips { opacity: .7; }

.shop-price {
  flex: 0 0 auto;
  padding: 3px 8px;
  font: var(--sa-type-data);
  font-size: 11px;
  letter-spacing: .1em;
  font-variant-numeric: tabular-nums;
  color: var(--sa-menu-primary, var(--sa-blue-500));
  border: var(--sa-line-hairline) solid color-mix(in srgb, var(--sa-menu-primary, var(--sa-blue-500)) 55%, transparent);
  clip-path: var(--sa-clip-btn-sm);
}
.shop-price[data-free="true"] { color: var(--sa-white); }
/* A price the balance in the header cannot meet. The two numbers are the ones
   the pilot is comparing, so the bad one says so in the palette's bad colour
   (finding 45 — there was no affordability state at all). */
.shop-price[data-afford="false"] {
  color: var(--sa-red-500);
  border-color: color-mix(in srgb, var(--sa-red-500) 60%, transparent);
}

.shop-chips { display: flex; flex-wrap: wrap; gap: 3px; }
.shop-chip {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  padding: 2px 6px;
  background: color-mix(in srgb, var(--sa-n-900) 55%, transparent);
  border: var(--sa-line-hairline) solid var(--sa-menu-border, var(--sa-n-600));
  clip-path: var(--sa-clip-btn-sm);
}
.shop-chip .k {
  font-size: 9.5px;
  letter-spacing: .14em;
  text-transform: uppercase;
  color: var(--sa-menu-muted, var(--sa-n-400));
}
.shop-chip .v {
  font: var(--sa-type-data);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--sa-white);
}

/* Actions sit on the card's floor, so cards of different heights still line
   their buttons up across a row. */
.shop-card-actions {
  margin-top: auto;
  display: flex;
  align-items: center;
  gap: 8px;
}
.shop-card-actions .sa-button { flex: 1 1 auto; min-height: 36px; }
.shop-badge {
  flex: 1 1 auto;
  padding: 7px 10px;
  text-align: center;
  font: var(--sa-type-caption);
  letter-spacing: .18em;
  text-transform: uppercase;
  color: var(--sa-menu-primary, var(--sa-blue-500));
  border: var(--sa-line-hairline) solid color-mix(in srgb, var(--sa-menu-primary, var(--sa-blue-500)) 45%, transparent);
  border-radius: var(--sa-radius-small);
}
.shop-badge[data-state="equipped"] {
  color: var(--sa-n-900);
  background: var(--sa-menu-primary, var(--sa-blue-500));
  border-color: var(--sa-menu-primary, var(--sa-blue-500));
}

/* --- Paints --------------------------------------------------------------
   A diagonal split reads both halves of a paint at a glance and leaves the
   lower-right corner for the emissive, which is the smallest of the three on
   the hull and should be the smallest here too. */
.shop-swatch {
  position: relative;
  height: 76px;
  clip-path: var(--sa-clip-btn);
  background: linear-gradient(
    135deg,
    var(--shop-primary, var(--sa-n-700)) 0 48%,
    var(--shop-accent, var(--sa-n-600)) 52% 100%
  );
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--sa-n-900) 55%, transparent);
}
/* The split line, so two close hues never blur into one flat plate. */
.shop-swatch::before {
  content: "";
  position: absolute;
  inset: 0;
  background: linear-gradient(135deg, transparent 47.5%, color-mix(in srgb, var(--sa-n-900) 70%, transparent) 48% 52%, transparent 52.5%);
}
.shop-swatch[data-glow="true"]::after {
  content: "";
  position: absolute;
  right: 0;
  bottom: 0;
  width: 34px;
  height: 34px;
  clip-path: polygon(100% 0, 100% 100%, 0 100%);
  background: var(--shop-glow, var(--sa-white));
  filter: drop-shadow(0 0 10px var(--shop-glow, var(--sa-white)));
}

.shop-equip {
  margin-top: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.shop-equip-label {
  width: 100%;
  font-size: 9.5px;
  letter-spacing: .22em;
  text-transform: uppercase;
  color: var(--sa-menu-muted, var(--sa-n-400));
}
.shop-equip .sa-button {
  flex: 0 1 auto;
  min-height: 32px;
  padding: 5px 10px;
}
.shop-equip .sa-button[aria-pressed="true"] {
  background: var(--sa-menu-primary, var(--sa-blue-500));
  border-color: var(--sa-menu-primary, var(--sa-blue-500));
  color: var(--sa-n-900);
  font-weight: 700;
}

.shop-hint,
.shop-empty {
  font: var(--sa-type-caption);
  color: var(--sa-menu-muted, var(--sa-n-400));
}
.shop-empty { grid-column: 1 / -1; padding: 24px 0; text-align: center; }

@media (max-width: 520px) {
  .shop-overlay { padding-top: calc(env(safe-area-inset-top, 0px) + 52px); }
  .shop-grid { grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 10px; }
  .shop-card { padding: 10px; }
}
`;
