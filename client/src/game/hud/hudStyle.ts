const STYLE_ID = "hud-style";

/**
 * Injects the HUD stylesheet once. All colors/sizes come from CSS custom
 * properties (`--hud-*`) set on `#hud` by {@link import("./Hud.js").Hud} from
 * `theme.json` (and re-applied on theme hot-reload) — this file only lays out
 * structure/animations, never hardcodes a color or size that the Theme editor
 * should own.
 *
 * ## The shape language (dark holographic)
 *
 * Every framed widget shares three primitives, so a designer changes the whole
 * HUD's character from `theme.hud.style` rather than from CSS:
 *
 *  - **chamfer** — `--hud-clip` is an octagon whose corner cut is
 *    `--hud-chamfer`; `--hud-clip-hex` is the harder two-corner bevel the module
 *    buttons wear. Applied with `clip-path`, so there is no image and no extra
 *    node.
 *  - **luminous rim + translucent fill** — a framed widget paints its rim on
 *    `::before` (a filled chamfered plate) and its fill on `::after` (the same
 *    plate inset by the rim width). Two layers rather than a `border`, because
 *    `clip-path` cuts a border's corners off and leaves the bevel unlined. Each
 *    host isolates a stacking context and both plates sit at z=-1, below even
 *    bare text nodes (which cannot themselves be positioned).
 *  - **glow** — `filter: drop-shadow()` on the rim layer, NOT `box-shadow`:
 *    `clip-path` would clip an outer box-shadow away entirely, while a filter is
 *    applied after clipping and traces the chamfered silhouette. Reserved for
 *    the widgets where it earns its compositing cost (frames, and active/alarm
 *    states) and scaled by `--hud-glow` so a pack can flatten it to zero.
 *
 * Per-frame paths are untouched by all of this: the components still write only
 * `transform`, `--ring`, a class or a `textContent`, exactly as before.
 */
export function injectHudStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

const CSS = `
.hud-root {
  position: fixed;
  inset: 0;
  z-index: 10;
  pointer-events: none;
  overflow: hidden;
  font-family: var(--hud-font-body, system-ui, sans-serif);
  color: var(--hud-text, #dbe9ff);
  -webkit-user-select: none;
  user-select: none;
  -webkit-touch-callout: none;
  -webkit-tap-highlight-color: transparent;
  --hud-scale: 1;
  --hud-safe-inset: 12px;
  /* Device safe area (notch/home indicator, viewport-fit=cover) + theme inset,
     resolved once per side so every anchor uses the same margins. */
  --hud-inset-top: calc(env(safe-area-inset-top, 0px) + var(--hud-safe-inset));
  --hud-inset-right: calc(env(safe-area-inset-right, 0px) + var(--hud-safe-inset));
  --hud-inset-bottom: calc(env(safe-area-inset-bottom, 0px) + var(--hud-safe-inset));
  --hud-inset-left: calc(env(safe-area-inset-left, 0px) + var(--hud-safe-inset));
  /* HUD scale factor (theme.hud.scale): control sizes are pre-scaled in
     hudLayout.ts, text scales through this root font-size. */
  font-size: calc(16px * var(--hud-scale));

  /* --- Shape-language primitives (theme.hud.style) --- */
  --hud-chamfer: 8px;
  --hud-glow: 0.55;
  --hud-panel-pct: 58%;
  --hud-tick-opacity: 0.34;
  --hud-blur: 6px;
  /* Rim thickness. One px at every scale on purpose: a hairline is what makes a
     hologram read as projected rather than drawn. */
  --hud-rim: 1px;

  /* Octagonal chamfer for panels/frames. */
  --hud-clip: polygon(
    var(--hud-chamfer) 0%,
    calc(100% - var(--hud-chamfer)) 0%,
    100% var(--hud-chamfer),
    100% calc(100% - var(--hud-chamfer)),
    calc(100% - var(--hud-chamfer)) 100%,
    var(--hud-chamfer) 100%,
    0% calc(100% - var(--hud-chamfer)),
    0% var(--hud-chamfer)
  );
  /* Hard two-corner bevel — the module buttons' "hex-ish" silhouette. Kept in
     percentages so one polygon serves every themed button radius. */
  --hud-clip-hex: polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%);

  --hud-panel-fill: color-mix(in srgb, var(--hud-bg, #0a0f1e) var(--hud-panel-pct), transparent);
  --hud-rim-color: color-mix(in srgb, var(--hud-primary, #39bfff) 52%, transparent);
  --hud-rim-dim: color-mix(in srgb, var(--hud-primary, #39bfff) 26%, transparent);
  --hud-tick-color: color-mix(in srgb, var(--hud-primary, #39bfff) 55%, transparent);
}

.hud-kill-feed { position:absolute; top:var(--hud-inset-top); right:var(--hud-inset-right); width:min(360px,58vw); display:flex; flex-direction:column; gap:4px; align-items:flex-end; }
.hud-kill-feed-line { display:none; padding:5px 9px; background:color-mix(in srgb,var(--hud-bg,#0a0f1e) 72%,transparent); border-right:2px solid var(--hud-muted,#8290a8); font-size:.78rem; white-space:nowrap; }
.hud-kill-feed-line.visible { display:block; }
.hud-kill-feed-line.self { color:var(--hud-accent,#ffd166); border-color:var(--hud-accent,#ffd166); }
.hud-kill-feed-line.friendly { color:var(--hud-primary,#39bfff); border-color:var(--hud-primary,#39bfff); }
.hud-kill-feed-line.enemy { color:var(--hud-danger,#ff526d); border-color:var(--hud-danger,#ff526d); }
.hud-scoreboard { position:absolute; inset:0; display:none; place-items:center; background:color-mix(in srgb,var(--hud-bg,#0a0f1e) 62%,transparent); pointer-events:auto; z-index:30; }
.hud-scoreboard.visible { display:grid; }
.hud-scoreboard-panel { position:relative; width:min(900px,calc(100vw - 24px)); max-height:calc(100vh - 28px); overflow:auto; padding:18px; box-sizing:border-box; }
.hud-scoreboard-actions { display:none; position:sticky; bottom:0; padding-top:12px; gap:10px; justify-content:center; background:linear-gradient(transparent,var(--hud-bg,#0a0f1e) 28%); }
.hud-scoreboard.final .hud-scoreboard-actions { display:flex; }
.hud-root[data-presentation] > :not(.hud-results):not(.hud-scoreboard) { display:none !important; }
.hud-root[data-presentation="scoreboard"] > .hud-results { display:none !important; }
.hud-scoreboard h2 { margin:0 0 12px; font-family:var(--hud-font-display,inherit); letter-spacing:.15em; color:var(--hud-primary,#39bfff); }
.hud-scoreboard table { width:100%; border-collapse:collapse; margin:8px 0 16px; font-size:clamp(.68rem,2vw,.9rem); }
.hud-scoreboard caption { text-align:left; color:var(--hud-accent,#ffd166); font-weight:700; padding:5px; }
.hud-scoreboard th,.hud-scoreboard td { padding:6px; text-align:right; border-bottom:1px solid color-mix(in srgb,var(--hud-primary,#39bfff) 22%,transparent); }
.hud-scoreboard th:first-child,.hud-scoreboard td:first-child { text-align:left; min-width:8em; }
.hud-scoreboard-btn { position:absolute; top:calc(var(--hud-inset-top) + 42px); right:var(--hud-inset-right); z-index:31; pointer-events:auto; border:1px solid var(--hud-primary,#39bfff); background:color-mix(in srgb,var(--hud-bg,#0a0f1e) 75%,transparent); color:var(--hud-text,#dbe9ff); padding:7px 10px; font:inherit; font-size:.68rem; }
.hud-results-scoreboard { width:100%; }
.hud-results-scoreboard .hud-scoreboard-panel { width:100%; max-height:38vh; padding:10px; }
.hud-results-scoreboard .hud-scoreboard-panel h2 { display:none; }
.hud-results-panel:has(.hud-results-scoreboard:not(:empty)) { max-width:min(900px,calc(100% - var(--hud-inset-left) - var(--hud-inset-right))); }
@media (orientation:portrait) { .hud-kill-feed { top:calc(var(--hud-inset-top) + 78px); width:66vw; } .hud-scoreboard-panel { padding:10px; } .hud-scoreboard th,.hud-scoreboard td { padding:5px 3px; } }
@media (orientation:portrait) { .hud-scoreboard-actions { flex-direction:column; align-items:stretch; } .hud-scoreboard-actions .hud-results-btn { width:100%; } }

/* Buttons opt into the browser's low-latency tap handling. Continuous HUD
   controls override this with touch-action:none where they own the gesture. */
.hud-root [data-hud-control] {
  touch-action: manipulation;
}

/*
 * Shared two-layer chamfer contract. The isolated negative layer stays above
 * the host background while it cannot cover in-flow children or bare text.
 * Keep every rim/fill component on this list so its layering is constructional.
 */
.hud-frame,
.hud-module-btn,
.hud-throttle-track,
.hud-fire-btn,
.hud-boost-btn,
.hud-results-panel {
  isolation: isolate;
}
.hud-frame::before,
.hud-frame::after,
.hud-module-btn::before,
.hud-module-btn::after,
.hud-throttle-track::before,
.hud-throttle-track::after,
.hud-fire-btn::before,
.hud-fire-btn::after,
.hud-boost-btn::before,
.hud-boost-btn::after,
.hud-results-panel::before,
.hud-results-panel::after {
  z-index: -1;
}

/* ============================================================
   Shared frame: chamfered rim plate + translucent fill plate.
   Opt in with .hud-frame; override --hud-frame-rim for a tint.
   ============================================================ */
.hud-frame {
  position: absolute;
  box-sizing: border-box;
  background: transparent;
  border: 0;
  --hud-frame-rim: var(--hud-rim-color);
}
.hud-frame::before,
.hud-frame::after {
  content: "";
  position: absolute;
  clip-path: var(--hud-clip);
  pointer-events: none;
}
.hud-frame::before {
  inset: 0;
  background: var(--hud-frame-rim);
  /* Glow traces the chamfered silhouette (see the header note on filters). */
  filter: drop-shadow(0 0 calc(10px * var(--hud-glow)) var(--hud-frame-rim));
}
.hud-frame::after {
  inset: var(--hud-rim);
  background: var(--hud-panel-fill);
  backdrop-filter: blur(var(--hud-blur));
  -webkit-backdrop-filter: blur(var(--hud-blur));
}
/* Own content rides above both plates. */
.hud-frame > * { position: relative; z-index: 1; }

/* Angular corner brackets framing a key widget — two L-shaped strokes drawn with
   borders on a pair of absolutely positioned spans (no extra colors, no images). */
.hud-bracket {
  position: absolute;
  z-index: 2;
  width: calc(var(--hud-chamfer) + 5px);
  height: calc(var(--hud-chamfer) + 5px);
  pointer-events: none;
  border: var(--hud-rim) solid var(--hud-primary, #39bfff);
  opacity: 0.85;
}
.hud-bracket[data-corner="tl"] { top: -2px; left: -2px; border-right: 0; border-bottom: 0; }
.hud-bracket[data-corner="br"] { bottom: -2px; right: -2px; border-left: 0; border-top: 0; }

/* --- Player-centred 3D radar (top-left) --- */
.hud-minimap {
  position: absolute;
  top: var(--hud-inset-top);
  left: var(--hud-inset-left);
  width: var(--hud-radar-size, var(--hud-minimap-size, 128px));
  height: var(--hud-radar-size, var(--hud-minimap-size, 128px));
  max-width: 40vw;
  max-height: 40vw;
  pointer-events: none;
}
.hud-minimap canvas {
  width: 100%;
  height: 100%;
  display: block;
  filter: drop-shadow(0 0 calc(5px * var(--hud-glow)) color-mix(in srgb, var(--hud-primary, #39bfff) 30%, transparent));
}
/* Small range legend under the translucent disc. */
.hud-minimap-scale {
  position: absolute;
  bottom: 2px;
  left: 0;
  right: 0;
  text-align: center;
  font: 0.5em/1 ui-monospace, monospace;
  letter-spacing: 0.14em;
  color: var(--hud-primary, #39bfff);
  opacity: 0.52;
}

/* --- Gauges: hull, shield, energy, heat --- */
.hud-gauges {
  display: flex;
  flex-direction: column;
  gap: var(--hud-gauge-gap, 6px);
  padding: calc(var(--hud-chamfer) * 0.7) calc(var(--hud-chamfer) * 0.8);
  width: var(--hud-gauge-width, 140px);
  box-sizing: content-box;
  max-width: calc(100vw - var(--hud-inset-left) - var(--hud-inset-right));
}
.hud-gauges[data-anchor="bottom-left"] {
  left: calc(var(--hud-inset-left) + var(--hud-gauge-offset-x, 0px));
  bottom: calc(var(--hud-inset-bottom) + var(--hud-gauge-offset-y, 0px));
}
.hud-gauges[data-anchor="bottom-right"] {
  right: calc(var(--hud-inset-right) + var(--hud-gauge-offset-x, 0px));
  bottom: calc(var(--hud-inset-bottom) + var(--hud-gauge-offset-y, 0px));
}
.hud-gauges[data-anchor="top-left"] {
  left: calc(var(--hud-inset-left) + var(--hud-gauge-offset-x, 0px));
  top: calc(var(--hud-inset-top) + var(--hud-gauge-offset-y, 0px));
}
.hud-gauges[data-anchor="top-right"] {
  right: calc(var(--hud-inset-right) + var(--hud-gauge-offset-x, 0px));
  top: calc(var(--hud-inset-top) + var(--hud-gauge-offset-y, 0px));
}
.hud-gauge {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.hud-gauge[hidden] { display: none; }
.hud-gauge-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 6px;
}
.hud-gauge-label {
  font-size: 0.5625em;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--hud-neutral, #7f9dc4);
}
.hud-gauge-value {
  font-size: 0.5625em;
  letter-spacing: 0.06em;
  font-variant-numeric: tabular-nums;
  color: var(--hud-text, #dbe9ff);
  opacity: 0.9;
}
.hud-gauge-track {
  position: relative;
  width: 100%;
  height: var(--hud-gauge-track-height, 10px);
  background: color-mix(in srgb, var(--hud-primary, #39bfff) 9%, transparent);
  /* Thin inner rule instead of a border: the segment overlay below has to reach
     the very edge of the track or the end cells read as clipped. */
  box-shadow: inset 0 0 0 var(--hud-rim) var(--hud-rim-dim);
  overflow: hidden;
}
.hud-gauge-fill {
  position: absolute;
  inset: 0;
  width: 100%;
  transform-origin: left center;
  background: var(--hud-primary, #39bfff);
  transition: transform 0.08s linear, background-color 0.15s linear;
}
/* Segmented cells: one repeating gradient laid over the whole track, so the
   FILL stays continuous (a value never quantizes) while the bar reads as cells.
   --hud-gauge-segment-pct is the cell pitch, resolved in hudLayout.ts. */
.hud-gauge-track::after {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: repeating-linear-gradient(
    90deg,
    transparent 0,
    transparent calc(var(--hud-gauge-segment-pct, 8.33%) - 1px),
    var(--hud-bg, #0a0f1e) calc(var(--hud-gauge-segment-pct, 8.33%) - 1px),
    var(--hud-bg, #0a0f1e) var(--hud-gauge-segment-pct, 8.33%)
  );
}
.hud-gauge-fill.hull { background: var(--hud-hull, var(--hud-accent, #ffb35c)); }
.hud-gauge-fill.shield { background: var(--hud-shield, var(--hud-primary, #39bfff)); }
.hud-gauge-fill.energy { background: var(--hud-energy, #4ee6b8); }
.hud-gauge-fill.heat { background: var(--hud-heat, var(--hud-accent, #ffb35c)); }
/* One "warn" class, two meanings: hull runs it when the hull is nearly gone and
   heat when it is nearly overheating, and both want the same critical red. */
.hud-gauge-fill.warn { background: var(--hud-danger, #ff405c); }
/* Critical readouts pulse rather than just recolour — colour alone is the one
   cue a player will miss mid-turn. */
.hud-gauge.critical .hud-gauge-value { color: var(--hud-danger, #ff405c); animation: hud-crit-pulse 1s ease-in-out infinite; }
@keyframes hud-crit-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.45; }
}

/* --- Module radial cluster --- */
/* Zero-size pivot pinned to the themed anchor corner; ModuleButtons places each
   button at a pivot-relative offset computed in hudLayout.ts. */
.hud-modules {
  position: absolute;
  width: 0;
  height: 0;
}
.hud-modules[data-anchor="bottom-right"] { right: var(--hud-inset-right); bottom: var(--hud-inset-bottom); }
.hud-modules[data-anchor="bottom-left"] { left: var(--hud-inset-left); bottom: var(--hud-inset-bottom); }
.hud-modules[data-anchor="top-right"] { right: var(--hud-inset-right); top: var(--hud-inset-top); }
.hud-modules[data-anchor="top-left"] { left: var(--hud-inset-left); top: var(--hud-inset-top); }
.hud-module-btn {
  pointer-events: auto;
  position: absolute;
  touch-action: manipulation;
  /* border-box so the rendered box is exactly 2 x the themed radius — the
     layout math in hudLayout.ts (and the one-thumb clamp) assumes it. */
  box-sizing: border-box;
  width: calc(var(--hud-module-btn-radius, 34px) * 2);
  height: calc(var(--hud-module-btn-radius, 34px) * 2);
  background: transparent;
  border: 0;
  color: var(--hud-text, #dbe9ff);
  display: flex;
  align-items: center;
  justify-content: center;
  /* Unchanged from the pre-redesign button: the icon takes the room, but the
     label still has to be readable at landscape scale (0.85 x 9px). */
  font-size: 0.5625em;
  line-height: 1.2;
  cursor: pointer;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
  transition: filter 0.15s linear, opacity 0.15s linear;
  /* Restrained circular buttons (owner presentation pass 2026-07-31): a quiet
     translucent plate with a thin family-tinted ring — the family colour only
     FILLS the button while the module is genuinely on. The old design painted
     the whole hex in solid family colour at 90%, which shouted over the arena. */
  --hud-btn-rim: color-mix(
    in srgb,
    var(--hud-module-family-color, var(--hud-primary, #39bfff))
      var(--hud-module-inner-border-pct, 55%),
    transparent
  );
  --hud-btn-plate: color-mix(in srgb, var(--hud-bg, #0a0f1e) 66%, transparent);
  --hud-btn-fill: var(--hud-btn-plate);
}
/* Rim + fill plates (same two-layer trick as .hud-frame, circular silhouette). */
.hud-module-btn::before,
.hud-module-btn::after {
  content: "";
  position: absolute;
  border-radius: 50%;
  pointer-events: none;
}
.hud-module-btn::before { inset: 0; background: var(--hud-btn-rim); }
.hud-module-btn::after {
  inset: 1.5px;
  background: var(--hud-btn-fill);
  backdrop-filter: blur(var(--hud-blur));
  -webkit-backdrop-filter: blur(var(--hud-blur));
}
/* State ring: a conic wedge masked to an annulus just inside the bevel, so
   deploy/retract/cooldown progress reads as a filling arc. Its own node rather
   than a pseudo-element because both pseudos are spent on the frame. */
.hud-module-btn > .ring {
  position: absolute;
  inset: calc(var(--hud-rim) * 1.5);
  z-index: 1;
  pointer-events: none;
  border-radius: 50%;
  background: conic-gradient(var(--hud-primary, #39bfff) calc(var(--ring, 0) * 1%), transparent 0);
  -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 3px), #000 0);
  mask: radial-gradient(farthest-side, transparent calc(100% - 3px), #000 0);
}
.hud-module-btn > .icon {
  z-index: 2;
  width: 55%;
  max-width: 26px;
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
}
.hud-module-btn > .icon .hud-icon-svg { width: 100%; height: auto; display: block; }
.hud-module-btn > .label {
  position: absolute;
  z-index: 2;
  top: calc(100% + var(--hud-module-label-gap, 4px));
  left: 50%;
  transform: translateX(-50%);
  width: max-content;
  max-width: var(--hud-module-label-max-width, 64px);
  height: var(--hud-module-label-height, 11px);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: #fff;
  font-size: 0.52em;
  font-weight: 700;
  opacity: 0.92;
}
.hud-module-btn.state-retracted { filter: saturate(0.6) brightness(0.72); }
.hud-module-btn.state-deploying { --hud-btn-rim: color-mix(in srgb, var(--hud-module-family-color) 82%, transparent); }
.hud-module-btn.state-active {
  --hud-btn-rim: color-mix(in srgb, var(--hud-module-family-color) 88%, #fff);
  /* ON is the one state that earns the family colour as a fill — layered over
     the dark plate so it stays a tint, not a paint bucket. */
  --hud-btn-fill: color-mix(
    in srgb,
    var(--hud-module-family-color, var(--hud-primary, #39bfff)) var(--hud-module-fill-pct, 32%),
    var(--hud-btn-plate)
  );
}
/* Glow only in the states that mean something — a filter on four idle buttons
   would be compositing cost with nothing to say. */
.hud-module-btn.state-active::before {
  filter: drop-shadow(0 0 calc(9px * var(--hud-glow)) var(--hud-module-family-color));
}
.hud-module-btn.state-retracting { --hud-btn-rim: color-mix(in srgb, var(--hud-module-family-color) 45%, transparent); }
.hud-module-btn.state-overheated {
  --hud-btn-rim: var(--hud-danger, #ff405c);
}
.hud-module-btn.state-overheated > .icon { color: var(--hud-danger, #ff405c); }
.hud-module-btn.state-overheated > .ring { background: conic-gradient(var(--hud-danger, #ff405c) calc(var(--ring, 0) * 1%), transparent 0); }
.hud-module-btn.state-overheated::before { animation: hud-overheat-flash 0.6s ease-in-out infinite; }
.hud-module-btn.no-energy { filter: saturate(0.42) brightness(0.7); opacity: 0.78; }
.hud-module-btn.armed {
  --hud-btn-rim: color-mix(in srgb, var(--hud-module-family-color) 72%, #fff);
}
.hud-module-btn.armed::before {
  filter: drop-shadow(0 0 calc(11px * var(--hud-glow)) var(--hud-module-family-color));
}
.hud-module-btn.cooling > .ring {
  background: conic-gradient(#fff calc(var(--ring, 0) * 1%), transparent 0);
}
.hud-module-btn.unarmable {
  --hud-btn-rim: color-mix(in srgb, var(--hud-neutral, #7f9dc4) 60%, transparent);
  filter: saturate(0.62) brightness(0.76);
}
.hud-module-btn.unarmable > .icon { color: #fff; opacity: 0.86; }
@keyframes hud-overheat-flash {
  0%, 100% { filter: drop-shadow(0 0 calc(5px * var(--hud-glow)) var(--hud-danger, #ff405c)); }
  50% { filter: drop-shadow(0 0 calc(18px * var(--hud-glow)) var(--hud-danger, #ff405c)); }
}

/* --- Flight controls (FLIGHT.md §4) ---
   Every dimension arrives as a --hud-* custom property resolved in
   flightHudLayout.ts, and every widget's position is written inline from the
   same math. Nothing about the flight HUD's geometry lives here. */
.hud-flight.hidden { display: none; }
/* Zero-size pivots pinned to the themed anchor corner, exactly like .hud-modules. */
.hud-joystick,
.hud-throttle,
.hud-fire,
.hud-boost,
.hud-jettison {
  position: absolute;
  width: 0;
  height: 0;
}
/* A fitting with no boost module renders no control at all. */
.hud-boost[hidden] { display: none; }
.hud-jettison[hidden] { display: none; }
.hud-throttle { opacity: var(--hud-throttle-opacity, 1); }
.hud-joystick.disabled { display: none; }

/* Floating touch-steer feedback. It never receives events itself. */
.hud-relative-steer {
  position: absolute;
  inset: 0;
  pointer-events: none;
  display: none;
}
.hud-relative-steer.active { display: block; }
.hud-relative-steer-origin,
.hud-relative-steer-current,
.hud-relative-steer-vector {
  position: absolute;
  left: 0;
  top: 0;
  pointer-events: none;
  transform-origin: left center;
}
.hud-relative-steer-origin {
  width: calc(var(--hud-steer-origin-radius, 7px) * 2);
  height: calc(var(--hud-steer-origin-radius, 7px) * 2);
  margin: calc(var(--hud-steer-origin-radius, 7px) * -1);
  border-radius: 50%;
  border: var(--hud-steer-vector-width, 2px) solid color-mix(in srgb, var(--hud-primary, #39bfff) 62%, transparent);
  background: color-mix(in srgb, var(--hud-bg, #0a0f1e) 45%, transparent);
}
.hud-relative-steer-current {
  width: calc(var(--hud-steer-current-radius, 12px) * 2);
  height: calc(var(--hud-steer-current-radius, 12px) * 2);
  margin: calc(var(--hud-steer-current-radius, 12px) * -1);
  border-radius: 50%;
  background: color-mix(in srgb, var(--hud-primary, #39bfff) 32%, transparent);
  border: var(--hud-steer-vector-width, 2px) solid color-mix(in srgb, var(--hud-primary, #39bfff) 72%, transparent);
}
.hud-relative-steer-vector {
  height: var(--hud-steer-vector-width, 2px);
  background: color-mix(in srgb, var(--hud-primary, #39bfff) 48%, transparent);
}
.hud-joystick[data-anchor="bottom-right"],
.hud-throttle[data-anchor="bottom-right"] { right: var(--hud-inset-right); bottom: var(--hud-inset-bottom); }
.hud-fire[data-anchor="bottom-right"],
.hud-boost[data-anchor="bottom-right"],
.hud-jettison[data-anchor="bottom-right"] { right: var(--hud-inset-right); bottom: var(--hud-inset-bottom); }
.hud-joystick[data-anchor="bottom-left"],
.hud-throttle[data-anchor="bottom-left"] { left: var(--hud-inset-left); bottom: var(--hud-inset-bottom); }
.hud-fire[data-anchor="bottom-left"],
.hud-boost[data-anchor="bottom-left"],
.hud-jettison[data-anchor="bottom-left"] { left: var(--hud-inset-left); bottom: var(--hud-inset-bottom); }
.hud-joystick[data-anchor="top-right"],
.hud-throttle[data-anchor="top-right"] { right: var(--hud-inset-right); top: var(--hud-inset-top); }
.hud-fire[data-anchor="top-right"],
.hud-boost[data-anchor="top-right"],
.hud-jettison[data-anchor="top-right"] { right: var(--hud-inset-right); top: var(--hud-inset-top); }
.hud-joystick[data-anchor="top-left"],
.hud-throttle[data-anchor="top-left"] { left: var(--hud-inset-left); top: var(--hud-inset-top); }
.hud-fire[data-anchor="top-left"],
.hud-boost[data-anchor="top-left"],
.hud-jettison[data-anchor="top-left"] { left: var(--hud-inset-left); top: var(--hud-inset-top); }

/* Steering stick: fixed base ring, spring-return thumb. */
.hud-joystick-base {
  pointer-events: auto;
  position: absolute;
  box-sizing: border-box;
  touch-action: none;
  width: calc(var(--hud-joy-base-radius, 62px) * 2);
  height: calc(var(--hud-joy-base-radius, 62px) * 2);
  border-radius: 50%;
  border: var(--hud-rim) solid var(--hud-rim-dim);
  background: radial-gradient(circle at center, color-mix(in srgb, var(--hud-bg, #0a0f1e) 55%, transparent) 40%, transparent 100%);
  -webkit-tap-highlight-color: transparent;
  user-select: none;
  transition: border-color 0.12s linear;
}
.hud-joystick-base.active { border-color: var(--hud-primary, #39bfff); }
.hud-joystick-thumb {
  position: absolute;
  left: 50%;
  top: 50%;
  box-sizing: border-box;
  width: calc(var(--hud-joy-thumb-radius, 28px) * 2);
  height: calc(var(--hud-joy-thumb-radius, 28px) * 2);
  border-radius: 50%;
  border: 2px solid var(--hud-primary, #39bfff);
  background: color-mix(in srgb, var(--hud-bg, #0a0f1e) 80%, transparent);
  transform: translate(-50%, -50%);
}

/* Throttle lever: 0 % at the bottom, 100 % at the top, thumb holds on release. */
.hud-throttle-track {
  pointer-events: auto;
  position: absolute;
  box-sizing: border-box;
  touch-action: none;
  width: var(--hud-throttle-width, 44px);
  height: var(--hud-throttle-height, 200px);
  background: transparent;
  border: 0;
  overflow: visible;
  -webkit-tap-highlight-color: transparent;
  user-select: none;
  --hud-frame-rim: var(--hud-rim-dim);
}
.hud-throttle-track::before,
.hud-throttle-track::after {
  content: "";
  position: absolute;
  inset: 0;
  clip-path: var(--hud-clip);
  pointer-events: none;
}
.hud-throttle-track::before {
  background: var(--hud-frame-rim);
  filter: drop-shadow(0 0 calc(8px * var(--hud-glow)) var(--hud-frame-rim));
}
.hud-throttle-track::after {
  inset: var(--hud-rim);
  background: var(--hud-panel-fill);
}
.hud-throttle-track.active { --hud-frame-rim: var(--hud-primary, #39bfff); }
.hud-throttle-fill,
.hud-throttle-thumb,
.hud-throttle-ticks { z-index: 1; }
.hud-throttle-fill {
  position: absolute;
  left: var(--hud-rim);
  right: var(--hud-rim);
  bottom: var(--hud-rim);
  height: 0%;
  background: linear-gradient(
    to top,
    color-mix(in srgb, var(--hud-primary, #39bfff) 18%, transparent),
    color-mix(in srgb, var(--hud-primary, #39bfff) 72%, transparent)
  );
}
/* Fine scale ticks on the left flank — one repeating gradient, pitch from the
   theme's tickCount (resolved in flightHudLayout.ts). */
.hud-throttle-ticks {
  position: absolute;
  left: var(--hud-rim);
  top: 0;
  bottom: 0;
  width: 34%;
  pointer-events: none;
  opacity: var(--hud-tick-opacity, 0.34);
  background: repeating-linear-gradient(
    to bottom,
    var(--hud-primary, #39bfff) 0,
    var(--hud-primary, #39bfff) 1px,
    transparent 1px,
    transparent var(--hud-throttle-tick-pct, 12.5%)
  );
}
.hud-throttle-thumb {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  box-sizing: border-box;
  height: var(--hud-throttle-thumb-height, 26px);
  border: 2px solid var(--hud-primary, #39bfff);
  background: color-mix(in srgb, var(--hud-bg, #0a0f1e) 88%, transparent);
  clip-path: polygon(0% 0%, 100% 0%, 100% 62%, 62% 100%, 0% 100%);
}
.hud-throttle-readout {
  position: absolute;
  transform: translate(-50%, -150%);
  padding: 2px 7px;
  font-size: 0.625em;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.1em;
  color: var(--hud-primary, #39bfff);
  background: color-mix(in srgb, var(--hud-bg, #0a0f1e) 66%, transparent);
  clip-path: polygon(5px 0%, 100% 0%, 100% calc(100% - 5px), calc(100% - 5px) 100%, 0% 100%, 0% 5px);
  white-space: nowrap;
}

/* FIRE: momentary, held for as long as a pointer is down. */
.hud-fire-btn {
  pointer-events: auto;
  position: absolute;
  box-sizing: border-box;
  touch-action: none;
  width: calc(var(--hud-fire-radius, 34px) * 2);
  height: calc(var(--hud-fire-radius, 34px) * 2);
  background: transparent;
  border: 0;
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1.1em;
  line-height: 1;
  cursor: pointer;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
  --hud-btn-rim: var(--hud-fire-color, #ff4655);
}
.hud-fire-btn {
  z-index: 1;
  color: #fff;
  font-size: 0.75em;
  font-weight: 800;
  letter-spacing: 0.08em;
}
.hud-fire-btn::before {
  filter: drop-shadow(0 0 var(--hud-fire-glow, 10px) var(--hud-fire-color, #ff4655));
}
.hud-fire-btn::before,
.hud-fire-btn::after {
  content: "";
  position: absolute;
  clip-path: var(--hud-clip-hex);
  pointer-events: none;
}
.hud-fire-btn::before { inset: 0; background: var(--hud-btn-rim); }
.hud-fire-btn::after {
  inset: var(--hud-fire-border, 2px);
  background: color-mix(
    in srgb,
    color-mix(in srgb, var(--hud-fire-color, #ff4655) 58%, #240008)
      var(--hud-fire-fill-pct, 30%),
    transparent
  );
}
.hud-fire-btn > * { position: relative; z-index: 1; }
.hud-fire-btn .label {
  color: #fff;
  font: 800 1em/1 var(--hud-font-display, system-ui, sans-serif);
}
.hud-fire-btn .label .hud-icon-svg { width: 30px; height: auto; display: block; }
.hud-fire-ring {
  position: absolute;
  z-index: 0;
  box-sizing: border-box;
  border-radius: 50%;
  background: conic-gradient(from -38deg, var(--hud-fire-color, #ff4655) 0 var(--hud-fire-ring-arc, 260deg), transparent var(--hud-fire-ring-arc, 260deg) 360deg);
  -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - var(--hud-fire-ring-stroke, 2px)), #000 0);
  mask: radial-gradient(farthest-side, transparent calc(100% - var(--hud-fire-ring-stroke, 2px)), #000 0);
  filter: drop-shadow(0 0 calc(7px * var(--hud-glow)) var(--hud-fire-color, #ff4655));
  pointer-events: none;
}
.hud-fire-btn.active { --hud-btn-rim: color-mix(in srgb, var(--hud-fire-color, #ff4655) 78%, #fff); }
.hud-fire-btn.active::after {
  background: color-mix(
    in srgb,
    var(--hud-fire-color, #ff4655) var(--hud-fire-armed-fill-pct, 52%),
    transparent
  );
}
.hud-fire-btn.active::before {
  filter: drop-shadow(0 0 var(--hud-fire-armed-glow, 18px) var(--hud-fire-color, #ff4655));
}
.hud-fire-btn.active .label {
  filter: drop-shadow(0 0 calc(7px * var(--hud-glow)) #fff);
}

/* BOOST: the fitted boost module's own control, opposite FIRE.
   Deliberately NOT skinned like a module hex — it wears the boost family colour
   as its own rim, captions itself BOOST rather than whatever the fitted module
   is called, and carries a heat bar, so a pilot can find the afterburner
   without reading four labels. Geometry (position, size) is written inline by
   BoostButton from layout.boost; only the look lives here. */
.hud-boost-btn {
  pointer-events: auto;
  position: absolute;
  box-sizing: border-box;
  touch-action: manipulation;
  width: calc(var(--hud-boost-radius, 30px) * 2);
  height: calc(var(--hud-boost-radius, 30px) * 2);
  background: transparent;
  border: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  cursor: pointer;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
  transition: filter 0.15s linear, opacity 0.15s linear;
  --hud-btn-rim: color-mix(in srgb, var(--hud-boost-color, #e8b44f) 58%, transparent);
  --hud-btn-plate: color-mix(in srgb, var(--hud-bg, #0a0f1e) 72%, transparent);
  --hud-btn-fill: var(--hud-btn-plate);
}
/* Same two-plate chamfer contract as FIRE, on the flat-top hex silhouette. */
.hud-boost-btn::before,
.hud-boost-btn::after {
  content: "";
  position: absolute;
  clip-path: var(--hud-clip-hex);
  pointer-events: none;
}
.hud-boost-btn::before {
  inset: 0;
  background: var(--hud-btn-rim);
  filter: drop-shadow(0 0 calc(6px * var(--hud-glow)) var(--hud-boost-color, #e8b44f));
}
.hud-boost-btn::after {
  inset: 2px;
  background: var(--hud-btn-fill);
  backdrop-filter: blur(var(--hud-blur));
  -webkit-backdrop-filter: blur(var(--hud-blur));
}
.hud-boost-btn > * { position: relative; z-index: 1; }
.hud-boost-btn > .icon {
  width: 50%;
  max-width: 26px;
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
}
.hud-boost-btn > .icon .hud-icon-svg { width: 100%; height: auto; display: block; }
.hud-boost-btn > .label {
  color: #fff;
  font: 700 0.5em/1 var(--hud-font-display, system-ui, sans-serif);
  letter-spacing: 0.14em;
  opacity: 0.92;
}
/* Heat: a hairline bar across the base of the plate, filled from the module's
   heat against ITS OWN overheat threshold — the number that actually cuts the
   afterburner off, which the ship-wide heat gauge does not show. */
.hud-boost-btn > .heat {
  position: absolute;
  left: 26%;
  right: 26%;
  bottom: 16%;
  height: 2px;
  overflow: hidden;
  background: color-mix(in srgb, var(--hud-text, #dbe9ff) 20%, transparent);
}
.hud-boost-btn > .heat::after {
  content: "";
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: calc(var(--heat, 0) * 1%);
  background: var(--hud-heat, var(--hud-accent, #ffb35c));
}
/* ON. The module is asking for boost — whether the sim grants it this tick is
   the ship's business, and the speed readout already tells that story. */
.hud-boost-btn.active {
  --hud-btn-rim: color-mix(in srgb, var(--hud-boost-color, #e8b44f) 92%, #fff);
  --hud-btn-fill: color-mix(
    in srgb,
    var(--hud-boost-color, #e8b44f) var(--hud-module-fill-pct, 32%),
    var(--hud-btn-plate)
  );
}
.hud-boost-btn.active::before {
  filter: drop-shadow(0 0 calc(16px * var(--hud-glow)) var(--hud-boost-color, #e8b44f));
}
.hud-boost-btn.active > .icon { animation: hud-boost-surge 0.7s ease-in-out infinite; }
.hud-boost-btn.pressed { filter: brightness(1.22); }
.hud-boost-btn.state-overheated {
  --hud-btn-rim: var(--hud-danger, #ff405c);
}
.hud-boost-btn.state-overheated > .icon { color: var(--hud-danger, #ff405c); }
.hud-boost-btn.state-overheated::before { animation: hud-overheat-flash 0.6s ease-in-out infinite; }
/* Refused by the RULES, not by the module: a flag carrier has no afterburner.
   Greyed and inert, never hidden — the flag is picked up mid-flight, and a
   control that disappears teaches the pilot nothing. */
.hud-boost-btn.disabled {
  cursor: default;
  opacity: 0.72;
  filter: saturate(0.22) brightness(0.62);
  --hud-btn-rim: color-mix(in srgb, var(--hud-neutral, #7f9dc4) 55%, transparent);
}
.hud-boost-btn.disabled::before { filter: none; }
.hud-boost-btn.disabled > .icon { animation: none; }
@keyframes hud-boost-surge {
  0%, 100% { transform: translateX(-7%); }
  50% { transform: translateX(7%); }
}

/* JETTISON uses the same compact hex language as BOOST, but is a one-shot
   defensive action. Its conic sweep is the authoritative sink cooldown. */
.hud-jettison-btn {
  pointer-events: auto;
  position: absolute;
  box-sizing: border-box;
  touch-action: manipulation;
  background: transparent;
  border: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  cursor: pointer;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
  --hud-btn-rim: color-mix(in srgb, var(--hud-energy, #4ee6b8) 62%, transparent);
  --hud-btn-plate: color-mix(in srgb, var(--hud-bg, #0a0f1e) 72%, transparent);
}
.hud-jettison-btn::before, .hud-jettison-btn::after, .hud-jettison-btn > .ring {
  content: "";
  position: absolute;
  clip-path: var(--hud-clip-hex);
  pointer-events: none;
}
.hud-jettison-btn::before { inset: 0; background: var(--hud-btn-rim); filter: drop-shadow(0 0 calc(6px * var(--hud-glow)) var(--hud-energy, #4ee6b8)); }
.hud-jettison-btn::after { inset: 2px; background: var(--hud-btn-plate); backdrop-filter: blur(var(--hud-blur)); -webkit-backdrop-filter: blur(var(--hud-blur)); }
.hud-jettison-btn > .ring { inset: 1px; background: conic-gradient(var(--hud-energy, #4ee6b8) calc(var(--ring, 0) * 1%), transparent 0); opacity: 0.78; }
.hud-jettison-btn > .icon, .hud-jettison-btn > .label { position: relative; z-index: 1; color: #fff; }
.hud-jettison-btn > .icon { width: 44%; display: flex; }
.hud-jettison-btn > .icon .hud-icon-svg { width: 100%; height: auto; display: block; }
.hud-jettison-btn > .label { font: 700 0.42em/1 var(--hud-font-display, system-ui, sans-serif); letter-spacing: 0.08em; }
.hud-jettison-btn.pressed { filter: brightness(1.22); }
.hud-jettison-btn.disabled { cursor: default; opacity: 0.58; filter: saturate(0.25) brightness(0.72); }
.hud-jettison-btn.disabled::before { filter: none; }

/* Hull and shield now flank the ship as restrained side arcs. */
.hud-vital-arcs {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  pointer-events: none;
  transition: opacity 0.15s linear;
}
.hud-vital-arcs[hidden] { display: none; }
.hud-vital-arcs svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
}
.hud-vital-arc {
  fill: none;
  stroke-width: var(--hud-vital-stroke, 6px);
  stroke-linecap: round;
  vector-effect: non-scaling-stroke;
}
.hud-vital-arc.track {
  stroke: var(--hud-neutral, #7f9dc4);
  opacity: var(--hud-vital-track-opacity, 0.16);
}
.hud-vital-arc.track.hull { stroke: var(--hud-hull, #ffb35c); }
.hud-vital-arc.track.shield { stroke: var(--hud-shield, #39bfff); }
.hud-vital-arc.fill.hull {
  stroke: var(--hud-hull, #ffb35c);
  filter: drop-shadow(0 0 calc(4px * var(--hud-glow)) var(--hud-hull, #ffb35c));
}
.hud-vital-arc.fill.shield {
  stroke: var(--hud-shield, #39bfff);
  filter: drop-shadow(0 0 calc(4px * var(--hud-glow)) var(--hud-shield, #39bfff));
}
.hud-vital-arcs.hull-critical .hud-vital-arc.fill.hull {
  stroke: var(--hud-danger, #ff405c);
}
.hud-vital-label {
  position: absolute;
  top: 50%;
  display: flex;
  flex-direction: column;
  gap: 3px;
  transform: translateY(-50%);
  color: var(--hud-neutral, #7f9dc4);
  font: 500 0.5em/1 var(--hud-font-display, system-ui, sans-serif);
  letter-spacing: 0.14em;
  text-transform: uppercase;
}
.hud-vital-label.hull { left: 7%; align-items: flex-start; }
.hud-vital-label.shield { right: 7%; align-items: flex-end; }
.hud-vital-label .value {
  color: var(--hud-text, #dbe9ff);
  font-size: 1.18em;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.06em;
}
.hud-vital-arcs.hull-critical .hud-vital-label.hull .value { color: var(--hud-danger, #ff405c); }

/* Lock reticle: optional centre zone plus a bracket projected onto the candidate. */
.hud-reticle {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.hud-reticle-blocked {
  position: absolute;
  left: 50%;
  top: calc(50% + 42px);
  transform: translate(-50%, -50%) scale(0.9);
  color: var(--hud-danger, #ff405c);
  font: 800 0.78em/1 var(--hud-font-display, system-ui, sans-serif);
  letter-spacing: 0.16em;
  text-shadow: 0 0 calc(14px * var(--hud-glow)) var(--hud-danger, #ff405c);
  opacity: 0;
}
.hud-reticle-blocked.visible {
  animation: hud-fire-blocked 0.65s ease-out both;
}
@keyframes hud-fire-blocked {
  0% { opacity: 0; transform: translate(-50%, -50%) scale(0.8); }
  18%, 62% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
  100% { opacity: 0; transform: translate(-50%, -60%) scale(1); }
}
.hud-reticle-zone {
  position: absolute;
  display: none;
  left: 50%;
  top: 50%;
  box-sizing: border-box;
  transform: translate(-50%, -50%);
  border-radius: 50%;
  /* Finer than a dashed ring: a dotted hairline plus four cardinal ticks (the
     ::before/::after crosses below) reads as an instrument, not a border. */
  border: var(--hud-rim) dotted color-mix(in srgb, var(--hud-text, #dbe9ff) 34%, transparent);
}
.hud-reticle-zone.visible { display: block; }
.hud-reticle-zone::before,
.hud-reticle-zone::after {
  content: "";
  position: absolute;
  background: color-mix(in srgb, var(--hud-primary, #39bfff) 55%, transparent);
}
/* Horizontal pair of edge ticks. */
.hud-reticle-zone::before {
  top: 50%;
  left: -5px;
  right: -5px;
  height: var(--hud-rim);
  transform: translateY(-50%);
  -webkit-mask: linear-gradient(90deg, #000 0 9px, transparent 9px calc(100% - 9px), #000 calc(100% - 9px) 100%);
  mask: linear-gradient(90deg, #000 0 9px, transparent 9px calc(100% - 9px), #000 calc(100% - 9px) 100%);
}
/* Vertical pair. */
.hud-reticle-zone::after {
  left: 50%;
  top: -5px;
  bottom: -5px;
  width: var(--hud-rim);
  transform: translateX(-50%);
  -webkit-mask: linear-gradient(180deg, #000 0 9px, transparent 9px calc(100% - 9px), #000 calc(100% - 9px) 100%);
  mask: linear-gradient(180deg, #000 0 9px, transparent 9px calc(100% - 9px), #000 calc(100% - 9px) 100%);
}
/* Cone wider than the camera can show: the circle is a floor on the zone, not
   its edge, so it reads as an open boundary rather than a hard one. */
.hud-reticle-zone.clamped { border-style: dotted; opacity: 0.5; }
.hud-reticle-bracket {
  position: absolute;
  left: 0;
  top: 0;
  box-sizing: border-box;
  display: none;
}
.hud-reticle-bracket.visible { display: block; }
/* Four corner ticks on the candidate — an L at each corner, drawn with borders
   on the two pseudo-elements plus a repeating mask, so no extra nodes. */
.hud-reticle-bracket .corners {
  position: absolute;
  inset: 0;
  border: 1.5px solid var(--hud-primary, #39bfff);
  /* Keep only the corners: a cross-shaped hole erases the middle of each edge. */
  -webkit-mask:
    linear-gradient(90deg, #000 0 30%, transparent 30% 70%, #000 70% 100%),
    linear-gradient(180deg, #000 0 30%, transparent 30% 70%, #000 70% 100%);
  -webkit-mask-composite: source-in;
  mask:
    linear-gradient(90deg, #000 0 30%, transparent 30% 70%, #000 70% 100%),
    linear-gradient(180deg, #000 0 30%, transparent 30% 70%, #000 70% 100%);
  mask-composite: intersect;
  filter: drop-shadow(0 0 calc(6px * var(--hud-glow)) var(--hud-primary, #39bfff));
}
/* Progress ring: a conic wedge masked to an annulus, so lockProgress reads as
   a filling arc without a second element or an SVG. */
.hud-reticle-bracket .ring {
  position: absolute;
  inset: -5px;
  border-radius: 50%;
  background: conic-gradient(var(--hud-primary, #39bfff) calc(var(--ring, 0) * 1%), transparent 0);
  -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - var(--hud-reticle-ring-stroke, 4px)), #000 0);
  mask: radial-gradient(farthest-side, transparent calc(100% - var(--hud-reticle-ring-stroke, 4px)), #000 0);
}
.hud-reticle-bracket.locked .corners {
  border-color: var(--hud-danger, #ff405c);
  filter: drop-shadow(0 0 calc(8px * var(--hud-glow)) var(--hud-danger, #ff405c));
}
.hud-reticle-bracket.locked .ring {
  background: conic-gradient(var(--hud-danger, #ff405c) 100%, var(--hud-danger, #ff405c) 0);
  animation: hud-lock-pulse 0.9s ease-in-out infinite;
}
@keyframes hud-lock-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

/* --- Off-screen enemy arrows (BUBBLE.md §C) ---
   Pooled nodes parked on an elliptical track; EnemyArrows.ts writes each one's
   translate+rotate inline from the math in flightHudLayout.ts. The glyph is a
   CHEVRON pointing along +x — the same open-angle language as the reticle's
   corner ticks — so a rotation of 0 points screen-right and the placement's
   rotationRad needs no offset. Tints reuse the reticle's own properties: danger
   for a plain enemy, primary for the lock candidate. */
.hud-enemy-arrows {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.hud-enemy-arrow {
  position: absolute;
  left: 0;
  top: 0;
  display: none;
  width: var(--hud-enemy-arrow-size, 20px);
  height: var(--hud-enemy-arrow-size, 20px);
  /* Open chevron: outer wedge minus an inner wedge, cut in one polygon. */
  clip-path: polygon(0% 0%, 100% 50%, 0% 100%, 0% 72%, 55% 50%, 0% 28%);
  background: var(--hud-danger, #ff405c);
  filter: drop-shadow(0 0 calc(5px * var(--hud-glow)) var(--hud-danger, #ff405c));
  will-change: transform;
}
.hud-enemy-arrow.visible { display: block; }
.hud-enemy-arrow.candidate {
  background: var(--hud-primary, #39bfff);
  filter: drop-shadow(0 0 calc(6px * var(--hud-glow)) var(--hud-primary, #39bfff));
}

/* --- Notifications (top-center toast stack) --- */
.hud-notifications {
  position: absolute;
  top: var(--hud-inset-top);
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  pointer-events: none;
  max-width: calc(100vw - var(--hud-inset-left) - var(--hud-inset-right));
}
/* Angular banner: a parallelogram-ended plate with a colour-coded leading bar. */
.hud-toast {
  position: relative;
  /* border-box so the 30px of horizontal padding stays INSIDE the stack's
     safe-area max-width instead of spilling 15px past each screen edge. */
  box-sizing: border-box;
  padding: 5px 16px 5px 14px;
  max-width: 100%;
  text-align: center;
  font-size: 0.75em;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--hud-text, #dbe9ff);
  background: color-mix(in srgb, var(--hud-bg, #0a0f1e) 88%, transparent);
  clip-path: polygon(8px 0%, 100% 0%, calc(100% - 8px) 100%, 0% 100%);
  box-shadow: inset 3px 0 0 0 var(--hud-toast-tint, var(--hud-primary, #39bfff));
  animation: hud-toast-in 0.22s cubic-bezier(0.16, 1, 0.3, 1);
}
.hud-toast.warning { --hud-toast-tint: var(--hud-accent, #ffb35c); color: var(--hud-accent, #ffb35c); }
.hud-toast.critical { --hud-toast-tint: var(--hud-danger, #ff405c); color: var(--hud-danger, #ff405c); }
.hud-toast.success { --hud-toast-tint: var(--hud-success, #5fe08c); color: var(--hud-success, #5fe08c); }
.hud-toast.info { --hud-toast-tint: var(--hud-primary, #39bfff); color: var(--hud-primary, #39bfff); }
/* Slide + fade in from above the stack, as a banner deploying. */
@keyframes hud-toast-in {
  from { opacity: 0; transform: translateY(-10px); }
  to { opacity: 1; transform: translateY(0); }
}

/* --- Match status: the BLUE vs RED team scoreboard (top-center) --- */
.hud-match-status {
  position: absolute;
  top: calc(var(--hud-inset-top) + 40px);
  left: 50%;
  transform: translateX(-50%);
  box-sizing: border-box;
  max-width: calc(100vw - var(--hud-inset-left) - var(--hud-inset-right));
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 0.6875em;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--hud-neutral, #7f9dc4);
  background: color-mix(in srgb, var(--hud-bg, #0a0f1e) 52%, transparent);
  padding: 3px 12px;
  clip-path: polygon(7px 0%, calc(100% - 7px) 0%, 100% 100%, 0% 100%);
  white-space: nowrap;
}
/* The player's team is ALWAYS blue on the left, the enemy always red on the
   right (Overwatch convention) — MatchStatus maps sim team ids onto the sides. */
.hud-match-status .hud-team-score {
  /* The two numbers are the scoreboard — they never give ground. */
  flex: 0 0 auto;
  font-size: 1.35em;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
  line-height: 1;
  min-width: 1.2em;
}
.hud-match-status .hud-team-score.blue {
  color: var(--hud-primary, #39bfff);
  text-align: right;
  text-shadow: 0 0 calc(6px * var(--hud-glow)) color-mix(in srgb, var(--hud-primary, #39bfff) 60%, transparent);
}
.hud-match-status .hud-team-score.red {
  color: var(--hud-danger, #ff405c);
  text-align: left;
  text-shadow: 0 0 calc(6px * var(--hud-glow)) color-mix(in srgb, var(--hud-danger, #ff405c) 60%, transparent);
}
/* The meta line is the only part that can grow without bound ("FIRST TO 10 ·
   2:30 · RESPAWNING…"); with the row set to nowrap it would push the scores off
   both edges of a narrow phone, so it is the one item allowed to shrink, and it
   ellipsises rather than overflowing. */
.hud-match-status .hud-match-meta {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  font-variant-numeric: tabular-nums;
}

/* --- Kill announcements: DESTROYED! / FIRST BLOOD / DOUBLE KILL … ---
   The slot also carries the CTF calls, which are far longer than any frag line
   ("YOU HAVE THE ENEMY FLAG"), so the type has to survive a portrait phone:
    - font-size shrinks with the viewport (the 1.9em design size is the CAP, only
      reachable once the screen is wide enough for it) — a slightly smaller single
      line keeps the League-style punch that a two-line wrap would lose;
    - max-width is the safe area, so a wider display face wraps (centred, balanced)
      instead of running off both edges — the text is never clipped or truncated;
    - the pop-in overshoot is part of the width budget: the box is laid out at
      scale 1 but painted at --hud-announce-pop, so the max-width is divided by it
      and the overshoot itself is trimmed on the narrow screens where a 1.5x punch
      could not fit. Wide screens keep the original 1.5. */
.hud-kill-announce {
  position: absolute;
  left: 50%;
  top: 30%;
  transform: translate(-50%, -50%);
  pointer-events: none;
  opacity: 0;
  font-family: var(--hud-font-display, var(--hud-font-body, system-ui, sans-serif));
  --hud-announce-pop: 1.5;
  font-size: clamp(12px, 4vw, 1.9em);
  font-weight: 800;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  text-align: center;
  text-wrap: balance;
  max-width: calc(
    (100vw - var(--hud-inset-left) - var(--hud-inset-right) - 16px) / var(--hud-announce-pop)
  );
  color: var(--hud-primary, #39bfff);
}
/* Below this width the longest call at its capped size could not survive a 1.5x
   overshoot inside the safe area, so the punch is dialled back rather than the
   text pushed off-screen. */
@media (max-width: 960px) {
  .hud-kill-announce { --hud-announce-pop: 1.12; }
}
.hud-kill-announce.first-blood { color: var(--hud-danger, #ff405c); }
.hud-kill-announce.multi { color: var(--hud-module-boost-color, #e8b44f); }
/* Capture-the-flag calls share the kill announcer's slot and animation; only the
   colour says whose news it is. */
.hud-kill-announce.flag-good { color: var(--hud-friendly, #57d8ff); }
.hud-kill-announce.flag-bad { color: var(--hud-danger, #ff405c); }
.hud-kill-announce.flag-info { color: var(--hud-module-boost-color, #e8b44f); }
.hud-kill-announce.visible {
  animation: hud-kill-announce 1.8s ease-out forwards;
}
@keyframes hud-kill-announce {
  0% { opacity: 0; transform: translate(-50%, -50%) scale(var(--hud-announce-pop, 1.5)); }
  12% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
  70% { opacity: 1; }
  100% { opacity: 0; transform: translate(-50%, -52%) scale(0.98); }
}
.hud-kill-announce.visible {
  text-shadow: 0 0 calc(14px * var(--hud-glow)) currentColor;
}

/* --- Damage feedback --- */
.hud-vignette {
  position: absolute;
  inset: 0;
  pointer-events: none;
  opacity: 0;
  background: radial-gradient(ellipse at center, transparent 55%, var(--hud-danger, #ff405c) 130%);
}
.hud-vignette.flash { animation: hud-vignette-flash 0.35s ease-out; }
@keyframes hud-vignette-flash {
  0% { opacity: 0.75; }
  100% { opacity: 0; }
}
.hud-hitmarker {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 22px;
  height: 22px;
  transform: translate(-50%, -50%) scale(0.6);
  opacity: 0;
  pointer-events: none;
}
.hud-hitmarker.show { animation: hud-hitmarker-pop 0.25s ease-out; }
.hud-hitmarker::before,
.hud-hitmarker::after {
  content: "";
  position: absolute;
  background: var(--hud-text, #dbe9ff);
}
.hud-hitmarker::before { left: 50%; top: 0; width: 2px; height: 100%; transform: translateX(-50%); }
.hud-hitmarker::after { top: 50%; left: 0; height: 2px; width: 100%; transform: translateY(-50%); }
@keyframes hud-hitmarker-pop {
  0% { opacity: 1; transform: translate(-50%, -50%) scale(1.1); }
  100% { opacity: 0; transform: translate(-50%, -50%) scale(0.6); }
}

/* RPG-style damage values: the node pool lives above the 3D canvas and each
   number uses both a dark outline and shadow so it survives lunar terrain. */
.hud-floating-damage { position: absolute; inset: 0; pointer-events: none; overflow: hidden; }
.hud-damage-number {
  position: absolute;
  left: 0;
  top: 0;
  color: var(--hud-hull, #ffb35c);
  font-family: var(--hud-font-display, system-ui, sans-serif);
  font-size: calc(18px * var(--hud-damage-scale, 1));
  font-weight: 800;
  font-variant-numeric: tabular-nums;
  line-height: 1;
  letter-spacing: 0.025em;
  white-space: nowrap;
  text-shadow: -1px -1px 0 rgba(2, 5, 12, .95), 1px -1px 0 rgba(2, 5, 12, .95), -1px 1px 0 rgba(2, 5, 12, .95), 1px 1px 0 rgba(2, 5, 12, .95), 0 0 8px currentColor;
  will-change: transform, opacity;
}
.hud-damage-number.shield { color: var(--hud-shield, #39bfff); }
.hud-damage-number.taken { color: var(--hud-danger, #ff405c); }
.hud-damage-number.other { filter: saturate(.75); }

/* --- Results overlay --- */
.hud-results {
  position: absolute;
  inset: 0;
  display: none;
  align-items: center;
  justify-content: center;
  background: radial-gradient(ellipse at center, color-mix(in srgb, var(--hud-bg, #0a0f1e) 62%, transparent) 0%, rgba(2, 4, 10, 0.86) 100%);
  pointer-events: auto;
}
.hud-results.visible { display: flex; }
.hud-results--outcome { background: rgba(2, 4, 10, 0.18); }
.hud-results--outcome .hud-results-panel::before,
.hud-results--outcome .hud-results-panel::after,
.hud-results--outcome .hud-results-rule,
.hud-results--outcome .hud-results-participants,
.hud-results--outcome .hud-results-sub,
.hud-results--outcome .hud-results-rewards,
.hud-results--outcome .hud-results-actions { display: none; }
.hud-results--outcome .hud-results-title {
  font-size: clamp(3rem, 12vw, 8rem);
  letter-spacing: .18em;
  text-shadow: 0 0 18px currentColor, 0 0 52px currentColor, 0 3px 2px #02040a;
}
/* Portrait phones: drop the panel to the thumb end of the screen so "Play
   again" stays a one-thumb reach (ROADMAP S3). */
@media (orientation: portrait) {
  .hud-results { align-items: flex-end; }
}
.hud-results-panel {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  padding: min(32px, 6vh) min(44px, 8vw);
  margin: var(--hud-inset-top) var(--hud-inset-right) var(--hud-inset-bottom) var(--hud-inset-left);
  /* border-box + inset-aware cap: content-box would have added up to 88px of
     padding AND the two margins on top of a full-viewport 100%, running the
     panel off both sides of a portrait phone. */
  box-sizing: border-box;
  max-width: min(420px, calc(100% - var(--hud-inset-left) - var(--hud-inset-right)));
  max-height: calc(100% - var(--hud-inset-top) - var(--hud-inset-bottom));
  overflow-y: auto;
  background: transparent;
}
/* Same two-plate frame as the in-match widgets, at panel scale. */
.hud-results-panel::before,
.hud-results-panel::after {
  content: "";
  position: absolute;
  inset: 0;
  clip-path: polygon(
    22px 0%, calc(100% - 22px) 0%, 100% 22px,
    100% calc(100% - 22px), calc(100% - 22px) 100%,
    22px 100%, 0% calc(100% - 22px), 0% 22px
  );
  pointer-events: none;
}
.hud-results-panel::before {
  background: var(--hud-rim-color);
  filter: drop-shadow(0 0 calc(26px * var(--hud-glow)) var(--hud-rim-color));
}
.hud-results-panel::after {
  inset: var(--hud-rim);
  background: color-mix(in srgb, var(--hud-bg, #0a0f1e) 94%, transparent);
}
.hud-results-panel > * { position: relative; z-index: 1; }
.hud-results-title {
  font-family: var(--hud-font-display, var(--hud-font-body, system-ui, sans-serif));
  font-size: 1.75em;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  text-align: center;
  animation: hud-results-banner 0.45s cubic-bezier(0.16, 1, 0.3, 1);
}
/* Outcome colouring — all four banners share one element, only the tint moves. */
.hud-results-title[data-outcome="victory"],
.hud-results-title[data-outcome="targets-cleared"] {
  color: var(--hud-primary, #39bfff);
  text-shadow: 0 0 calc(30px * var(--hud-glow)) var(--hud-primary, #39bfff);
}
.hud-results-title[data-outcome="defeat"] {
  color: var(--hud-danger, #ff405c);
  text-shadow: 0 0 calc(30px * var(--hud-glow)) var(--hud-danger, #ff405c);
}
.hud-results-title[data-outcome="draw"] { color: var(--hud-accent, #ffb35c); }
@keyframes hud-results-banner {
  from { opacity: 0; transform: translateY(-10px) scale(0.94); letter-spacing: 0.02em; }
  to { opacity: 1; transform: none; letter-spacing: 0.14em; }
}
/* Bracketed rule under the banner, the panel language's section mark. */
.hud-results-rule {
  width: 78%;
  height: var(--hud-rim);
  background: linear-gradient(90deg, transparent, var(--hud-primary, #39bfff), var(--hud-accent, #ffb35c), transparent);
  opacity: 0.85;
}
.hud-results-sub {
  font-size: 0.75em;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--hud-neutral, #7f9dc4);
}
.hud-results-sub:empty { display: none; }
.hud-results-participants {
  color: var(--hud-text, #dbe9ff);
  font: 600 0.78em/1.4 var(--hud-font-display, system-ui, sans-serif);
  letter-spacing: 0.1em;
  text-transform: uppercase;
}
.hud-results-participants:empty { display: none; }
.hud-results-rewards {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  min-height: 0;
}
.hud-results-rewards:empty { display: none; }
.hud-results-rewards-line {
  font-size: 1.125em;
  color: var(--hud-primary, #39bfff);
  letter-spacing: 0.03em;
  font-variant-numeric: tabular-nums;
}
.hud-results-rewards-line .credits { color: var(--hud-accent, #ffb35c); font-weight: 700; }
.hud-results-rewards-line .xp { color: var(--hud-primary, #39bfff); font-weight: 700; }
.hud-results-rewards-line .unit,
.hud-results-rewards-line .dot { font-size: 0.7em; opacity: 0.75; letter-spacing: 0.06em; }
/* One soft pop when the count-up lands — marks "that's your total". */
.hud-results-rewards-line.done { animation: hud-results-tally 0.28s ease-out; }
@keyframes hud-results-tally {
  0% { transform: scale(1); }
  45% { transform: scale(1.08); }
  100% { transform: scale(1); }
}
.hud-results-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
  width: 100%;
}
.hud-results-levelup {
  font-size: 0.8125em;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--hud-success, #5fe08c);
  animation: hud-toast-in 0.2s ease-out;
}
.hud-results-btn {
  pointer-events: auto;
  cursor: pointer;
  touch-action: manipulation;
  flex: 1 1 auto;
  min-width: 96px;
  min-height: 44px;
  padding: 8px 18px;
  font-size: 0.8125em;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--hud-text, #dbe9ff);
  background: color-mix(in srgb, var(--hud-primary, #39bfff) 8%, transparent);
  border: var(--hud-rim) solid var(--hud-rim-color);
  clip-path: polygon(9px 0%, 100% 0%, 100% calc(100% - 9px), calc(100% - 9px) 100%, 0% 100%, 0% 9px);
  transition: background-color 0.12s linear, color 0.12s linear;
}
.hud-results-btn:hover { background: color-mix(in srgb, var(--hud-primary, #39bfff) 20%, transparent); }
.hud-results-btn--primary {
  flex: 1 1 100%;
  color: var(--hud-bg, #0a0f1e);
  background: var(--hud-primary, #39bfff);
  border-color: var(--hud-primary, #39bfff);
  font-size: 0.875em;
  font-weight: 700;
}
.hud-results-btn--primary:hover { background: color-mix(in srgb, var(--hud-primary, #39bfff) 82%, #ffffff); }

/* --- In-match settings affordance (top-right) ---
   Tagged data-hud-control so edge palm rejection never eats it (5.4). */
.hud-settings-btn {
  pointer-events: auto;
  position: absolute;
  top: var(--hud-inset-top);
  right: var(--hud-inset-right);
  /* 44px, not the old 36: it is a touch target like any other (ROADMAP S3). */
  width: 44px;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1em;
  line-height: 1;
  color: var(--hud-primary, #39bfff);
  background: color-mix(in srgb, var(--hud-bg, #0a0f1e) 68%, transparent);
  border: var(--hud-rim) solid var(--hud-rim-color);
  clip-path: polygon(9px 0%, 100% 0%, 100% calc(100% - 9px), calc(100% - 9px) 100%, 0% 100%, 0% 9px);
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}
.hud-settings-btn:hover { border-color: var(--hud-primary, #39bfff); }

/* ============================================================
   Match-start countdown (3 → 2 → 1 → GO). One centred numeral,
   drawn in the display face over a soft radial scrim so it stays
   legible against a bright skybox. Non-interactive: the player is
   already holding throttle through it.
   ============================================================ */
.hud-countdown {
  position: absolute;
  inset: 0;
  display: none;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  font-family: var(--hud-font-display, var(--hud-font-body, system-ui, sans-serif));
  font-size: min(28vh, 22vw);
  font-weight: 700;
  line-height: 1;
  letter-spacing: 0.06em;
  color: var(--hud-primary, #39bfff);
  text-shadow: 0 0 calc(40px * var(--hud-glow)) var(--hud-primary, #39bfff);
  /* Scrim only behind the glyph, so the arena stays readable at the edges. */
  background: radial-gradient(
    circle at center,
    color-mix(in srgb, var(--hud-bg, #0a0f1e) 46%, transparent) 0%,
    transparent 46%
  );
}
.hud-countdown.visible {
  display: flex;
  animation: hud-countdown-beat 0.9s cubic-bezier(0.16, 1, 0.3, 1) both;
}
/* GO reads as a release, not a fourth beat: accent tint, wider, snappier. */
.hud-countdown.go {
  color: var(--hud-accent, #ffb35c);
  text-shadow: 0 0 calc(48px * var(--hud-glow)) var(--hud-accent, #ffb35c);
  font-size: min(18vh, 26vw);
  letter-spacing: 0.2em;
  animation: hud-countdown-go 0.7s cubic-bezier(0.16, 1, 0.3, 1) both;
}
@keyframes hud-countdown-beat {
  0% { opacity: 0; transform: scale(1.5); }
  22% { opacity: 1; transform: scale(1); }
  100% { opacity: 0.55; transform: scale(0.94); }
}
@keyframes hud-countdown-go {
  0% { opacity: 0; transform: scale(0.7); }
  18% { opacity: 1; transform: scale(1.08); }
  40% { transform: scale(1); }
  100% { opacity: 0; transform: scale(1.04); }
}

/* Reduced motion: the looping pulses are decoration on top of information that
   is already carried by COLOUR (overheat red, lock red, critical red), so they
   can stop without taking a combat cue away. The one-shot feedback animations
   (hit marker, damage vignette, toast slide, results banner) stay: they ARE the
   information — a hit marker that never appears is a hit the player never saw. */
@media (prefers-reduced-motion: reduce) {
  .hud-module-btn.state-overheated::before,
  .hud-boost-btn.state-overheated::before,
  .hud-boost-btn.active > .icon,
  .hud-reticle-bracket.locked .ring,
  .hud-gauge.critical .hud-gauge-value {
    animation: none;
  }
  /* The countdown numerals ARE the information (one-shot, like the hit marker),
     so they keep appearing — only the scale punch is dropped. */
  .hud-countdown.visible,
  .hud-countdown.go {
    animation: none;
    opacity: 1;
    transform: none;
  }
  .hud-module-btn.state-overheated::before,
  .hud-boost-btn.state-overheated::before {
    filter: drop-shadow(0 0 calc(12px * var(--hud-glow)) var(--hud-danger, #ff405c));
  }
}
`;
