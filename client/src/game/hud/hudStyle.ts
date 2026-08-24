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
  color: var(--hud-text, var(--sa-white));
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

  --hud-panel-fill: color-mix(in srgb, var(--hud-bg, var(--sa-n-900)) var(--hud-panel-pct), transparent);
  --hud-rim-color: color-mix(in srgb, var(--hud-primary, var(--sa-blue-500)) 52%, transparent);
  --hud-rim-dim: color-mix(in srgb, var(--hud-primary, var(--sa-blue-500)) 26%, transparent);
  --hud-tick-color: color-mix(in srgb, var(--hud-primary, var(--sa-blue-500)) 55%, transparent);
}

.hud-kill-feed { position:absolute; top:var(--hud-inset-top); right:var(--hud-inset-right); width:min(360px,58vw); display:flex; flex-direction:column; gap:4px; align-items:flex-end; }
.hud-kill-feed-line { display:none; padding:5px 9px; background:color-mix(in srgb,var(--hud-bg,var(--sa-n-900)) 72%,transparent); border-right:2px solid var(--hud-muted,var(--sa-n-400)); font-size:.78rem; white-space:nowrap; }
.hud-kill-feed-line.visible { display:block; }
.hud-kill-feed-line.self { color:var(--hud-accent,var(--sa-white)); border-color:var(--hud-accent,var(--sa-white)); }
.hud-kill-feed-line.friendly { color:var(--hud-primary,var(--sa-blue-500)); border-color:var(--hud-primary,var(--sa-blue-500)); }
.hud-kill-feed-line.enemy { color:var(--hud-danger,var(--sa-red-500)); border-color:var(--hud-danger,var(--sa-red-500)); }
.hud-scoreboard { position:absolute; inset:0; display:none; place-items:center; background:color-mix(in srgb,var(--hud-bg,var(--sa-n-900)) 62%,transparent); pointer-events:auto; z-index:30; }
.hud-scoreboard.visible { display:grid; }
.hud-scoreboard-panel { position:relative; width:min(900px,calc(100vw - var(--hud-inset-left) - var(--hud-inset-right))); max-height:calc(100% - var(--hud-inset-top) - var(--hud-inset-bottom)); overflow:hidden; padding:18px; box-sizing:border-box; display:flex; flex-direction:column; }
.hud-scoreboard-rows { min-height:0; overflow-y:auto; overscroll-behavior:contain; }
.hud-scoreboard-actions { display:none; flex:0 0 auto; padding-top:12px; gap:10px; justify-content:center; background:linear-gradient(transparent,var(--hud-bg,var(--sa-n-900)) 28%); }
.hud-scoreboard.final .hud-scoreboard-actions { display:flex; }
.hud-root[data-presentation] > :not(.hud-results):not(.hud-scoreboard) { display:none !important; }
.hud-root[data-presentation="scoreboard"] > .hud-results { display:none !important; }
.hud-scoreboard h2 { margin:0 0 12px; font-family:var(--hud-font-display,inherit); letter-spacing:.15em; color:var(--hud-primary,var(--sa-blue-500)); }
.hud-scoreboard h2 { flex:0 0 auto; }
.hud-scoreboard table { --hud-scoreboard-team:var(--sa-red-500); width:100%; border-collapse:collapse; margin:8px 0 16px; font-size:clamp(.68rem,2vw,.9rem); }
.hud-scoreboard table.hud-scoreboard-team--ally { --hud-scoreboard-team:var(--sa-blue-500); }
.hud-scoreboard table.hud-scoreboard-team--enemy { --hud-scoreboard-team:var(--sa-red-500); }
.hud-scoreboard caption { text-align:left; color:var(--hud-scoreboard-team); font-weight:700; padding:5px; }
.hud-scoreboard th,.hud-scoreboard td { padding:6px; text-align:right; border-bottom:1px solid color-mix(in srgb,var(--hud-scoreboard-team) 30%,transparent); }
.hud-scoreboard th:first-child,.hud-scoreboard td:first-child { text-align:left; min-width:8em; }
.hud-scoreboard tr.hud-scoreboard-local-player { background:color-mix(in srgb,var(--hud-scoreboard-team) 22%,transparent); box-shadow:inset 3px 0 var(--hud-accent,var(--sa-white)); }
.hud-scoreboard tr.hud-scoreboard-local-player td { color:var(--hud-accent,var(--sa-white)); font-weight:700; }
.hud-scoreboard-btn { position:absolute; top:calc(var(--hud-inset-top) + 42px); right:var(--hud-inset-right); z-index:31; pointer-events:auto; border:1px solid var(--hud-primary,var(--sa-blue-500)); background:color-mix(in srgb,var(--hud-bg,var(--sa-n-900)) 75%,transparent); color:var(--hud-text,var(--sa-white)); padding:7px 10px; font:inherit; font-size:.68rem; }
@media (orientation:portrait) { .hud-kill-feed { top:calc(var(--hud-inset-top) + 78px); width:66vw; } .hud-scoreboard-panel { padding:10px; } .hud-scoreboard th,.hud-scoreboard td { padding:5px 3px; } }
@media (orientation:portrait) { .hud-scoreboard-actions { flex-direction:column; align-items:stretch; } .hud-scoreboard-actions .hud-results-btn { width:100%; } }

/* Buttons opt into the browser's low-latency tap handling. Continuous HUD
   controls override this with touch-action:none where they own the gesture. */
.hud-root [data-hud-control] {
  touch-action: manipulation;
}

/* Shared HUD buttons. Anything that wants a cut-corner plate opts into
   .hud-frame below, reusing its two-plate chamfer contract instead of drawing a
   second kind of bevel. */
.hud-button, .hud-icon-button, .hud-results-btn, .hud-scoreboard-btn, .hud-settings-btn {
  box-sizing:border-box; color:var(--sa-white); border:var(--sa-line-hairline) solid var(--sa-n-400);
  background:var(--sa-n-800); font:var(--sa-type-caption); border-radius:var(--sa-radius-small);
  transition:background-color 150ms,border-color 150ms,transform 100ms,opacity 150ms;
}
.hud-button--primary, .hud-results-btn--primary { color:var(--sa-n-900); background:var(--sa-blue-500); border-color:var(--sa-blue-500); }
.hud-button:hover:not(:disabled), .hud-results-btn:hover:not(:disabled), .hud-icon-button:hover:not(:disabled) { border-color:var(--sa-blue-500); }
.hud-button:active:not(:disabled), .hud-results-btn:active:not(:disabled), .hud-icon-button:active:not(:disabled) { transform:translateY(1px); }
.hud-button:disabled, .hud-results-btn:disabled, .hud-icon-button:disabled { opacity:.38; cursor:not-allowed; }
.hud-icon-button, .hud-settings-btn { inline-size:44px; block-size:44px; display:grid; place-items:center; padding:0; }

/*
 * Shared two-layer chamfer contract. The isolated negative layer stays above
 * the host background while it cannot cover in-flow children or bare text.
 * Keep every rim/fill component on this list so its layering is constructional.
 */
.hud-frame,
.hud-module-btn,
.hud-throttle-track,
.hud-boost-btn,
.hud-jettison-btn,
.hud-results-panel {
  isolation: isolate;
}
.hud-frame::before,
.hud-frame::after,
.hud-module-btn::before,
.hud-module-btn::after,
.hud-throttle-track::before,
.hud-throttle-track::after,
.hud-boost-btn::before,
.hud-boost-btn::after,
.hud-jettison-btn::before,
.hud-jettison-btn::after,
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
  filter: drop-shadow(0 0 calc(5px * var(--hud-glow)) color-mix(in srgb, var(--hud-primary, var(--sa-blue-500)) 30%, transparent));
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
  color: var(--hud-primary, var(--sa-blue-500));
  opacity: 0.52;
}

/* --- Hardpoint slot clusters (owner HUD pass, 2026-08-21) --- */
/* Two clusters: weapons bottom-right, utilitarian skills bottom-left. The
   container spans the viewport and is inert; each cluster is a zero-size pivot
   pinned inside its corner's safe-area inset, and ModuleButtons writes every
   button's pivot-relative box from slotCluster.ts. Nothing here is geometry. */
.hud-modules {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.hud-slot-cluster {
  position: absolute;
  width: 0;
  height: 0;
}
.hud-slot-cluster[data-anchor="bottom-right"] { right: var(--hud-inset-right); bottom: var(--hud-inset-bottom); }
.hud-slot-cluster[data-anchor="bottom-left"] { left: var(--hud-inset-left); bottom: var(--hud-inset-bottom); }
.hud-slot-cluster[data-anchor="top-right"] { right: var(--hud-inset-right); top: var(--hud-inset-top); }
.hud-slot-cluster[data-anchor="top-left"] { left: var(--hud-inset-left); top: var(--hud-inset-top); }
.hud-module-btn {
  pointer-events: auto;
  position: absolute;
  touch-action: manipulation;
  /* border-box so the rendered box is exactly the slot diameter the cluster
     math computed — every inline width/height comes from slotCluster.ts. */
  box-sizing: border-box;
  width: var(--hud-slot-size, 64px);
  height: var(--hud-slot-size, 64px);
  background: transparent;
  border: 0;
  color: var(--hud-text, var(--sa-white));
  display: flex;
  align-items: center;
  justify-content: center;
  /* One typographic scale for the whole slot: the number, the TYPE caption and
     the ammo pill are all 'em' off this, so a 44 px slot is a smaller version of
     an 82 px one rather than the same type crammed into a smaller ring. */
  font-size: calc(var(--hud-slot-size, 64px) * 0.16);
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
    var(--hud-module-family-color, var(--hud-primary, var(--sa-blue-500)))
      var(--hud-module-inner-border-pct, 55%),
    transparent
  );
  --hud-btn-plate: color-mix(in srgb, var(--hud-bg, var(--sa-n-900)) 66%, transparent);
  --hud-btn-fill: var(--hud-btn-plate);
  --hud-action-color: var(--hud-module-family-color, var(--hud-primary));
}
/* Rim + fill plates (same two-layer trick as .hud-frame, circular silhouette). */
.hud-module-btn::before,
.hud-module-btn::after {
  content: "";
  position: absolute;
  border-radius: 50%;
  pointer-events: none;
}
.hud-module-btn::before {
  inset: 0;
  background: repeating-conic-gradient(
    from -45deg,
    var(--hud-btn-rim) 0 calc(90deg - var(--hud-action-ring-tick-gap, 3deg)),
    transparent calc(90deg - var(--hud-action-ring-tick-gap, 3deg)) 90deg
  );
  -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - var(--hud-action-ring-stroke, 1.5px)), #000 0);
  mask: radial-gradient(farthest-side, transparent calc(100% - var(--hud-action-ring-stroke, 1.5px)), #000 0);
}
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
  background: conic-gradient(var(--hud-action-color) calc(var(--ring, 0) * 1%), transparent 0);
  opacity: 0;
  -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - var(--hud-action-ring-stroke, 1.5px)), #000 0);
  mask: radial-gradient(farthest-side, transparent calc(100% - var(--hud-action-ring-stroke, 1.5px)), #000 0);
}
.hud-module-btn.ring-energy > .ring {
  opacity: 0.72;
  background: conic-gradient(var(--hud-primary, var(--sa-blue-500)) calc(var(--ring, 0) * 1%), transparent 0);
}
.hud-module-btn.ring-reload > .ring {
  opacity: 0.9;
  background: conic-gradient(var(--sa-white) calc(var(--ring, 0) * 1%), transparent 0);
}
/* Weapon cycle time and shield collapse lockout — the two countdowns. The
   reload sweep's shape (a filling arc that means "ready when full"), drawn
   bright and thick because since heat was deleted (2026-08-20) a weapon's
   cooldown is the ONLY thing gating it, so it has to be readable at a glance
   mid-dogfight rather than a muted hint that the module is unavailable. */
.hud-module-btn.ring-cooldown > .ring {
  opacity: 1;
  --hud-action-ring-stroke: 3px;
  background: conic-gradient(var(--sa-white) calc(var(--ring, 0) * 1%), transparent 0);
}
/* COOLING (mockup state 3): a radial PIE sweeping the whole disc as well as the
   annulus, so the fraction is readable from the corner of the eye at slot size —
   a 3 px arc on a 44 px button is not. It layers onto the FILL PLATE rather than
   onto the ring: the ring is masked to an annulus, and a mask applies to a
   pseudo-element's children too, so a pie drawn inside it would be cut away. */
.hud-module-btn.ring-cooldown::after,
.hud-module-btn.ring-reload::after {
  background:
    conic-gradient(
      color-mix(in srgb, var(--sa-white) 16%, transparent) calc(var(--ring, 0) * 1%),
      transparent 0
    ),
    var(--hud-btn-fill);
}
/* Seconds remaining on whichever countdown owns the ring. */
.hud-module-btn > .cooldown-secs {
  position: absolute;
  z-index: 3;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  color: var(--sa-white);
  font: 800 1.5em/1 ui-monospace, monospace;
  font-variant-numeric: tabular-nums;
  text-shadow: 0 0 calc(5px * var(--hud-glow)) var(--hud-bg, var(--sa-n-900));
  pointer-events: none;
}
.hud-module-btn > .cooldown-secs[hidden] { display: none; }
/* With a number in the middle the glyph would fight it; step it back further. */
.hud-module-btn.ring-cooldown > .icon,
.hud-module-btn.ring-reload > .icon { opacity: 0.22; }
.hud-module-btn.ring-danger > .ring {
  opacity: 0.92;
  background: conic-gradient(var(--hud-danger, var(--sa-red-500)) calc(var(--ring, 0) * 1%), transparent 0);
}
/* Interior stack: SLOT NUMBER at the top, glyph through the middle, TYPE word
   at the foot. The glyph is what a pilot reads mid-turn; the number is what a
   callout names ("dry on 02") and what the mockup leads with. */
.hud-module-btn > .slot-num {
  position: absolute;
  z-index: 2;
  left: 50%;
  top: 15%;
  transform: translateX(-50%);
  color: var(--sa-white);
  font: 800 1.05em/1 ui-monospace, monospace;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.06em;
  opacity: 0.9;
  pointer-events: none;
}
.hud-module-btn > .icon {
  z-index: 2;
  width: 40%;
  max-width: 34px;
  margin-top: 4%;
  color: var(--hud-text);
  display: flex;
  align-items: center;
  justify-content: center;
}
.hud-module-btn > .icon .hud-icon-svg { width: 100%; height: auto; display: block; }
.hud-module-btn > .slot-type {
  position: absolute;
  z-index: 2;
  left: 50%;
  bottom: 12%;
  transform: translateX(-50%);
  max-width: 84%;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: clip;
  color: color-mix(in srgb, var(--sa-white) 78%, transparent);
  font: 700 0.72em/1 var(--hud-font-display, system-ui, sans-serif);
  letter-spacing: 0.1em;
  text-transform: uppercase;
  pointer-events: none;
}
/* Ammo. Only a magazine-fed weapon has one, and it doubles as the DRY badge —
   the same pill, so the eye finds the answer in the same place either way. */
.hud-module-btn > .rounds {
  position: absolute;
  z-index: 3;
  right: -4%;
  top: 6%;
  min-width: 1.5em;
  padding: 0 0.2em;
  border: 1px solid color-mix(in srgb, var(--hud-module-family-color) 72%, var(--sa-white));
  background: color-mix(in srgb, var(--hud-bg) 92%, transparent);
  color: var(--sa-white);
  font: 800 0.82em/1.3 ui-monospace, monospace;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.04em;
  text-align: center;
}
.hud-module-btn > .rounds[hidden] { display: none; }
/* Getting low: the pill starts to speak up before it has to shout. */
.hud-module-btn.low-ammo > .rounds {
  border-color: var(--hud-warning, var(--sa-amber-500, #F59E0B));
  color: var(--hud-warning, var(--sa-amber-500, #F59E0B));
}
/* DRY: out of rounds. Alert ring on the whole button, not just the pill —
   a pilot pulling an empty trigger needs to know from the silhouette. */
.hud-module-btn.dry {
  --hud-btn-rim: var(--hud-danger, var(--sa-red-500));
}
.hud-module-btn.dry > .rounds {
  border-color: var(--hud-danger, var(--sa-red-500));
  background: color-mix(in srgb, var(--hud-danger, var(--sa-red-500)) 26%, var(--hud-bg));
  color: var(--sa-white);
  letter-spacing: 0.02em;
}
.hud-module-btn.dry::before {
  filter: drop-shadow(0 0 calc(8px * var(--hud-glow)) var(--hud-danger, var(--sa-red-500)));
}
.hud-module-btn.state-retracted { filter: saturate(0.6) brightness(0.72); }
.hud-module-btn.state-deploying { --hud-btn-rim: color-mix(in srgb, var(--hud-module-family-color) 82%, transparent); }
.hud-module-btn.state-active {
  --hud-btn-rim: color-mix(in srgb, var(--hud-module-family-color) 88%, var(--sa-white));
  /* ON is the one state that earns the family colour as a fill — layered over
     the dark plate so it stays a tint, not a paint bucket. */
  --hud-btn-fill: color-mix(
    in srgb,
    var(--hud-module-family-color, var(--hud-primary, var(--sa-blue-500))) var(--hud-module-fill-pct, 32%),
    var(--hud-btn-plate)
  );
}
/* Glow only in the states that mean something — a filter on four idle buttons
   would be compositing cost with nothing to say. */
.hud-module-btn.state-active::before {
  filter: drop-shadow(0 0 calc(9px * var(--hud-glow)) var(--hud-module-family-color));
}
.hud-module-btn.state-retracting { --hud-btn-rim: color-mix(in srgb, var(--hud-module-family-color) 45%, transparent); }
.hud-module-btn.state-reloading {
  --hud-btn-rim: color-mix(in srgb, var(--hud-module-family-color) 48%, var(--sa-white));
  filter: saturate(0.55) brightness(0.72);
}
.hud-module-btn.state-reloading > .icon { opacity: 0.48; }
.hud-module-btn.state-reloading > .rounds { animation: hud-reload-pulse 0.8s ease-in-out infinite; }
.hud-module-btn.no-energy { filter: saturate(0.42) brightness(0.7); opacity: 0.78; }
.hud-module-btn.armed {
  --hud-btn-rim: color-mix(in srgb, var(--hud-module-family-color) 72%, var(--sa-white));
}
.hud-module-btn.armed::before {
  filter: drop-shadow(0 0 calc(11px * var(--hud-glow)) var(--hud-module-family-color));
}
.hud-module-btn.unarmable {
  --hud-btn-rim: color-mix(in srgb, var(--hud-neutral, var(--sa-n-400)) 60%, transparent);
  filter: saturate(0.62) brightness(0.76);
}
.hud-module-btn.unarmable > .icon { color: var(--sa-white); opacity: 0.86; }
@keyframes hud-reload-pulse { 50% { opacity: 0.42; } }

/* --- Flight controls (FLIGHT.md §4) ---
   Every dimension arrives as a --hud-* custom property resolved in
   flightHudLayout.ts, and every widget's position is written inline from the
   same math. Nothing about the flight HUD's geometry lives here. */
.hud-flight.hidden { display: none; }
/* Zero-size pivots pinned to the themed anchor corner, exactly like .hud-modules. */
.hud-joystick,
.hud-throttle,
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
  border: var(--hud-steer-vector-width, 2px) solid color-mix(in srgb, var(--hud-primary, var(--sa-blue-500)) 62%, transparent);
  background: color-mix(in srgb, var(--hud-bg, var(--sa-n-900)) 45%, transparent);
}
.hud-relative-steer-current {
  width: calc(var(--hud-steer-current-radius, 12px) * 2);
  height: calc(var(--hud-steer-current-radius, 12px) * 2);
  margin: calc(var(--hud-steer-current-radius, 12px) * -1);
  border-radius: 50%;
  background: color-mix(in srgb, var(--hud-primary, var(--sa-blue-500)) 32%, transparent);
  border: var(--hud-steer-vector-width, 2px) solid color-mix(in srgb, var(--hud-primary, var(--sa-blue-500)) 72%, transparent);
}
.hud-relative-steer-vector {
  height: var(--hud-steer-vector-width, 2px);
  background: color-mix(in srgb, var(--hud-primary, var(--sa-blue-500)) 48%, transparent);
}
.hud-joystick[data-anchor="bottom-right"],
.hud-throttle[data-anchor="bottom-right"] { right: var(--hud-inset-right); bottom: var(--hud-inset-bottom); }
.hud-boost[data-anchor="bottom-right"],
.hud-jettison[data-anchor="bottom-right"] { right: var(--hud-inset-right); bottom: var(--hud-inset-bottom); }
.hud-joystick[data-anchor="bottom-left"],
.hud-throttle[data-anchor="bottom-left"] { left: var(--hud-inset-left); bottom: var(--hud-inset-bottom); }
.hud-boost[data-anchor="bottom-left"],
.hud-jettison[data-anchor="bottom-left"] { left: var(--hud-inset-left); bottom: var(--hud-inset-bottom); }
.hud-joystick[data-anchor="top-right"],
.hud-throttle[data-anchor="top-right"] { right: var(--hud-inset-right); top: var(--hud-inset-top); }
.hud-boost[data-anchor="top-right"],
.hud-jettison[data-anchor="top-right"] { right: var(--hud-inset-right); top: var(--hud-inset-top); }
.hud-joystick[data-anchor="top-left"],
.hud-throttle[data-anchor="top-left"] { left: var(--hud-inset-left); top: var(--hud-inset-top); }
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
  background: radial-gradient(circle at center, color-mix(in srgb, var(--hud-bg, var(--sa-n-900)) 55%, transparent) 40%, transparent 100%);
  -webkit-tap-highlight-color: transparent;
  user-select: none;
  transition: border-color 0.12s linear;
}
.hud-joystick-base.active { border-color: var(--hud-primary, var(--sa-blue-500)); }
.hud-joystick-thumb {
  position: absolute;
  left: 50%;
  top: 50%;
  box-sizing: border-box;
  width: calc(var(--hud-joy-thumb-radius, 28px) * 2);
  height: calc(var(--hud-joy-thumb-radius, 28px) * 2);
  border-radius: 50%;
  border: 2px solid var(--hud-primary, var(--sa-blue-500));
  background: color-mix(in srgb, var(--hud-bg, var(--sa-n-900)) 80%, transparent);
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
.hud-throttle-track.active { --hud-frame-rim: var(--hud-primary, var(--sa-blue-500)); }
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
    color-mix(in srgb, var(--hud-primary, var(--sa-blue-500)) 18%, transparent),
    color-mix(in srgb, var(--hud-primary, var(--sa-blue-500)) 72%, transparent)
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
    var(--hud-primary, var(--sa-blue-500)) 0,
    var(--hud-primary, var(--sa-blue-500)) 1px,
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
  border: 2px solid var(--hud-primary, var(--sa-blue-500));
  background: color-mix(in srgb, var(--hud-bg, var(--sa-n-900)) 88%, transparent);
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
  color: var(--hud-primary, var(--sa-blue-500));
  background: color-mix(in srgb, var(--hud-bg, var(--sa-n-900)) 66%, transparent);
  clip-path: polygon(5px 0%, 100% 0%, 100% calc(100% - 5px), calc(100% - 5px) 100%, 0% 100%, 0% 5px);
  white-space: nowrap;
}

/* WEAPON TRIGGERS (2026-08-21). The dedicated FIRE button is gone: every weapon
   is its own button on the module rail, and the pilot's PRIMARY weapon inherits
   FIRE's pedestal — same footprint, same theme tokens, so a theme that dressed
   FIRE still dresses the control that replaced it. */
.hud-module-btn.trigger { touch-action: none; }
/* Held: the same brightened rim + fill FIRE used, so "I am shooting" reads at a
   glance and from the corner of the eye. */
.hud-module-btn.trigger.firing {
  --hud-btn-rim: color-mix(in srgb, var(--hud-module-family-color) 82%, var(--sa-white));
  --hud-btn-fill: color-mix(in srgb, var(--hud-module-family-color) var(--hud-fire-armed-fill-pct, 52%), transparent);
  transform: scale(0.96);
}
.hud-module-btn.trigger.firing::before {
  filter: drop-shadow(0 0 var(--hud-fire-armed-glow, 18px) var(--hud-module-family-color));
}
/* Names are gone from the buttons (owner 2026-08-21): the glyph plus the short
   TYPE word is what a pilot reads mid-turn, and the full fitted name under a
   thumb-sized circle read as neither. The text stays in the DOM for assistive
   tech, and the button's own aria-label leads with the slot number. */
.hud-module-btn .label.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}
/* A weapon the power rail could not seat. It has no toggle, so it stays cold for
   the whole match: this is the mockup's "unfitted" language — a DASHED rim, no
   colour, number only, and inert to the touch. */
.hud-module-btn.unpowered {
  --hud-btn-rim: transparent;
  filter: saturate(0) brightness(0.6);
  opacity: 0.6;
  pointer-events: none;
}
.hud-module-btn.unpowered::before {
  background: none;
  border: 1.5px dashed var(--hud-neutral, var(--sa-n-400));
  border-radius: 50%;
  -webkit-mask: none;
  mask: none;
  filter: none;
}
/* Number only: the glyph, the caption and the ammo pill all describe a module
   that is not going to do anything this match. */
.hud-module-btn.unpowered > .icon,
.hud-module-btn.unpowered > .slot-type,
.hud-module-btn.unpowered > .rounds { display: none; }
.hud-module-btn.unpowered > .slot-num { top: 50%; transform: translate(-50%, -50%); }

/* Gated rail (dead pilot, results screen): every button reads as unavailable,
   and ModuleButtons.setEnabled has already released whatever was held. */
.hud-modules.disabled { pointer-events: none; }
.hud-modules.disabled .hud-module-btn { opacity: 0.58; filter: saturate(0.18) brightness(0.72); }

/* BOOST and JETTISON wear the SHARED slot skin (.hud-module-btn.hud-slot-btn)
   and take their slots in the left cluster alongside the fitted deployables, so
   the left thumb reads as one cluster rather than three visual dialects. What
   remains here is only what is specific to each action: its family tint, its
   surge animation, and the two "refused" states. */
.hud-boost-btn {
  --hud-module-family-color: var(--hud-boost-color, var(--sa-blue-500));
}
/* ON. The module is asking for boost — whether the sim grants it this tick is
   the ship's business, and the speed readout already tells that story. */
.hud-boost-btn.active {
  --hud-btn-rim: color-mix(in srgb, var(--hud-boost-color, var(--sa-white)) 92%, var(--sa-white));
  --hud-btn-fill: color-mix(
    in srgb,
    var(--hud-boost-color, var(--sa-white)) var(--hud-module-fill-pct, 32%),
    var(--hud-btn-plate)
  );
}
.hud-boost-btn.active::before {
  filter: drop-shadow(0 0 calc(16px * var(--hud-glow)) var(--hud-boost-color, var(--sa-white)));
}
.hud-boost-btn.active > .icon { animation: hud-boost-surge 0.7s ease-in-out infinite; }
.hud-boost-btn.pressed,
.hud-jettison-btn.pressed { transform: scale(0.96); filter: brightness(1.22); }
/* Refused by the RULES, not by the module: a flag carrier has no afterburner.
   Greyed and inert, never hidden — the flag is picked up mid-flight, and a
   control that disappears teaches the pilot nothing. */
.hud-boost-btn.disabled {
  cursor: default;
  opacity: 0.72;
  filter: saturate(0.22) brightness(0.62);
  --hud-btn-rim: color-mix(in srgb, var(--hud-neutral, var(--sa-n-400)) 55%, transparent);
}
.hud-boost-btn.disabled::before { filter: none; }
.hud-boost-btn.disabled > .icon { animation: none; }
@keyframes hud-boost-surge {
  0%, 100% { transform: translateX(-7%); }
  50% { transform: translateX(7%); }
}

/* JETTISON: a one-shot defensive action whose conic sweep is the authoritative
   sink cooldown, drawn with the same cooling language as a weapon's cycle. */
.hud-jettison-btn {
  --hud-module-family-color: var(--hud-jettison-color, var(--sa-blue-500));
}
.hud-jettison-btn > .ring { opacity: 0.55; }
.hud-jettison-btn.disabled {
  cursor: default;
  opacity: 0.58;
  filter: saturate(0.25) brightness(0.72);
  --hud-btn-rim: var(--hud-danger, var(--sa-red-500));
}
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
/* Dark ground under each arc, wider than the arc itself, so a bright nebula or
   a muzzle flash behind the ship cannot swallow the line. Non-scaling like the
   arcs, and butt-capped so it never pokes past their rounded ends. */
.hud-vital-arc.halo {
  stroke: var(--hud-bg, var(--sa-n-900));
  stroke-width: calc(var(--hud-vital-stroke, 6px) + 5px);
  stroke-linecap: butt;
  opacity: 0.5;
}
.hud-vital-arc.track {
  stroke: var(--hud-neutral, var(--sa-n-400));
  opacity: var(--hud-vital-track-opacity, 0.16);
}
.hud-vital-arc.track.hull { stroke: var(--hud-hull, var(--sa-white)); }
.hud-vital-arc.track.shield { stroke: var(--hud-shield, var(--sa-blue-500)); }
.hud-vital-arc.fill.hull {
  stroke: var(--hud-hull, var(--sa-white));
  filter: drop-shadow(0 0 calc(6px * var(--hud-glow)) var(--hud-hull, var(--sa-white)));
}
.hud-vital-arc.fill.shield {
  stroke: var(--hud-shield, var(--sa-blue-500));
  filter: drop-shadow(0 0 calc(6px * var(--hud-glow)) var(--hud-shield, var(--sa-blue-500)));
}
.hud-vital-arcs.hull-critical .hud-vital-arc.fill.hull {
  stroke: var(--hud-danger, var(--sa-red-500));
}
.hud-vital-label {
  position: absolute;
  top: 50%;
  display: flex;
  flex-direction: column;
  gap: 3px;
  transform: translateY(-50%);
  /* Same SIZE as before — the arcs must not start shouting over the fight.
     What changed is contrast: the caption is no longer the dimmest grey on the
     screen, and both lines carry a dark shadow so they hold up over the arena. */
  color: color-mix(in srgb, var(--hud-neutral, var(--sa-n-400)) 55%, var(--sa-white));
  font: 600 0.5em/1 var(--hud-font-display, system-ui, sans-serif);
  letter-spacing: 0.14em;
  text-transform: uppercase;
  text-shadow: 0 0 5px var(--hud-bg, var(--sa-n-900)), 0 1px 2px var(--hud-bg, var(--sa-n-900));
}
.hud-vital-label.hull { left: 7%; align-items: flex-start; }
.hud-vital-label.shield { right: 7%; align-items: flex-end; }
.hud-vital-label .value {
  color: var(--hud-text, var(--sa-white));
  font-size: 1.18em;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.06em;
}
.hud-vital-arcs.hull-critical .hud-vital-label.hull .value { color: var(--hud-danger, var(--sa-red-500)); }

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
  color: var(--hud-danger, var(--sa-red-500));
  font: 800 0.78em/1 var(--hud-font-display, system-ui, sans-serif);
  letter-spacing: 0.16em;
  text-shadow: 0 0 calc(14px * var(--hud-glow)) var(--hud-danger, var(--sa-red-500));
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
  border: var(--hud-rim) dotted color-mix(in srgb, var(--hud-text, var(--sa-white)) 34%, transparent);
}
.hud-reticle-zone.visible { display: block; }
.hud-reticle-zone::before,
.hud-reticle-zone::after {
  content: "";
  position: absolute;
  background: color-mix(in srgb, var(--hud-primary, var(--sa-blue-500)) 55%, transparent);
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
  border: 2px solid var(--hud-primary, var(--sa-blue-500));
  /* Keep only the corners: a cross-shaped hole erases the middle of each edge.
     The arms are SHORT (a quarter of each edge, was nearly a third) so the shape
     reads as four square brackets rather than a box with gaps in it. */
  -webkit-mask:
    linear-gradient(90deg, #000 0 26%, transparent 26% 74%, #000 74% 100%),
    linear-gradient(180deg, #000 0 26%, transparent 26% 74%, #000 74% 100%);
  -webkit-mask-composite: source-in;
  mask:
    linear-gradient(90deg, #000 0 26%, transparent 26% 74%, #000 74% 100%),
    linear-gradient(180deg, #000 0 26%, transparent 26% 74%, #000 74% 100%);
  mask-composite: intersect;
  filter: drop-shadow(0 0 calc(6px * var(--hud-glow)) var(--hud-primary, var(--sa-blue-500)));
}
/* Progress ring: a conic wedge masked to an annulus, so lockProgress reads as
   a filling arc without a second element or an SVG. */
.hud-reticle-bracket .ring {
  position: absolute;
  inset: -5px;
  border-radius: 50%;
  background: conic-gradient(var(--hud-primary, var(--sa-blue-500)) calc(var(--ring, 0) * 1%), transparent 0);
  -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - var(--hud-reticle-ring-stroke, 4px)), #000 0);
  mask: radial-gradient(farthest-side, transparent calc(100% - var(--hud-reticle-ring-stroke, 4px)), #000 0);
}
.hud-reticle-bracket.locked .corners {
  border-color: var(--hud-danger, var(--sa-red-500));
  filter: drop-shadow(0 0 calc(8px * var(--hud-glow)) var(--hud-danger, var(--sa-red-500)));
}
/* ACQUIRED: the ring stops being a filling gauge and becomes a confirmation, so
   it thins to --hud-reticle-locked-ring-stroke (half the acquiring width
   unless the theme says otherwise — owner 2026-08-22). LockReticle writes the
   property on the bracket itself; the literal fallback here is only for a
   reticle mounted outside a resolved layout. */
.hud-reticle-bracket.locked .ring {
  background: conic-gradient(var(--hud-danger, var(--sa-red-500)) 100%, var(--hud-danger, var(--sa-red-500)) 0);
  animation: hud-lock-pulse 0.9s ease-in-out infinite;
  -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - var(--hud-reticle-locked-ring-stroke, 2px)), #000 0);
  mask: radial-gradient(farthest-side, transparent calc(100% - var(--hud-reticle-locked-ring-stroke, 2px)), #000 0);
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
  background: var(--hud-danger, var(--sa-red-500));
  filter: drop-shadow(0 0 calc(5px * var(--hud-glow)) var(--hud-danger, var(--sa-red-500)));
  will-change: transform;
}
.hud-enemy-arrow.visible { display: block; }
.hud-enemy-arrow.candidate {
  background: var(--hud-primary, var(--sa-blue-500));
  filter: drop-shadow(0 0 calc(6px * var(--hud-glow)) var(--hud-primary, var(--sa-blue-500)));
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
  color: var(--hud-text, var(--sa-white));
  background: color-mix(in srgb, var(--hud-bg, var(--sa-n-900)) 88%, transparent);
  clip-path: polygon(8px 0%, 100% 0%, calc(100% - 8px) 100%, 0% 100%);
  box-shadow: inset 3px 0 0 0 var(--hud-toast-tint, var(--hud-primary, var(--sa-blue-500)));
  animation: hud-toast-in 0.22s cubic-bezier(0.16, 1, 0.3, 1);
}
.hud-toast.warning { --hud-toast-tint: var(--hud-accent, var(--sa-white)); color: var(--hud-accent, var(--sa-white)); }
.hud-toast.critical { --hud-toast-tint: var(--hud-danger, var(--sa-red-500)); color: var(--hud-danger, var(--sa-red-500)); }
.hud-toast.success { --hud-toast-tint: var(--hud-success, var(--sa-blue-500)); color: var(--hud-success, var(--sa-blue-500)); }
.hud-toast.info { --hud-toast-tint: var(--hud-primary, var(--sa-blue-500)); color: var(--hud-primary, var(--sa-blue-500)); }
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
  color: var(--hud-neutral, var(--sa-n-400));
  background: color-mix(in srgb, var(--hud-bg, var(--sa-n-900)) 52%, transparent);
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
  color: var(--hud-primary, var(--sa-blue-500));
  text-align: right;
  text-shadow: 0 0 calc(6px * var(--hud-glow)) color-mix(in srgb, var(--hud-primary, var(--sa-blue-500)) 60%, transparent);
}
.hud-match-status .hud-team-score.red {
  color: var(--hud-danger, var(--sa-red-500));
  text-align: left;
  text-shadow: 0 0 calc(6px * var(--hud-glow)) color-mix(in srgb, var(--hud-danger, var(--sa-red-500)) 60%, transparent);
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
  color: var(--hud-primary, var(--sa-blue-500));
}
/* Below this width the longest call at its capped size could not survive a 1.5x
   overshoot inside the safe area, so the punch is dialled back rather than the
   text pushed off-screen. */
@media (max-width: 960px) {
  .hud-kill-announce { --hud-announce-pop: 1.12; }
}
.hud-kill-announce.first-blood { color: var(--hud-danger, var(--sa-red-500)); }
.hud-kill-announce.multi { color: var(--hud-module-boost-color, var(--sa-white)); }
/* Capture-the-flag calls share the kill announcer's slot and animation; only the
   colour says whose news it is. */
.hud-kill-announce.flag-good { color: var(--hud-friendly, var(--sa-blue-500)); }
.hud-kill-announce.flag-bad { color: var(--hud-danger, var(--sa-red-500)); }
.hud-kill-announce.flag-info { color: var(--hud-module-boost-color, var(--sa-white)); }
.hud-kill-announce.visible {
  /* 1.8s mirrors how long one announcement stays on screen (KillAnnouncements.ts). */
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
  background: radial-gradient(ellipse at center, transparent 55%, var(--hud-danger, var(--sa-red-500)) 130%);
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
  background: var(--hud-text, var(--sa-white));
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
  color: var(--hud-hull, var(--sa-white));
  font-family: var(--hud-font-display, system-ui, sans-serif);
  /* 11px is ~60% of the original 18px base: the value stays legible over the
     terrain but no longer crowds the ship it belongs to. The per-label
     --hud-damage-scale (set from the hit size) still rides on top unchanged,
     and --hud-damage-size lets one layer size itself down (see .shield). */
  font-size: calc(var(--hud-damage-size, 11px) * var(--hud-damage-scale, 1));
  font-weight: 800;
  font-variant-numeric: tabular-nums;
  line-height: 1;
  letter-spacing: 0.025em;
  white-space: nowrap;
  text-shadow: -1px -1px 0 rgba(2, 5, 12, .95), 1px -1px 0 rgba(2, 5, 12, .95), -1px 1px 0 rgba(2, 5, 12, .95), 1px 1px 0 rgba(2, 5, 12, .95), 0 0 8px currentColor;
  will-change: transform, opacity;
}
/* Colour reads WHO was hit (design system v1.0): red is threat to my side,
   white is neutral information about theirs. */
.hud-damage-number.friendly { color: var(--hud-danger, var(--sa-red-500)); }
.hud-damage-number.hostile { color: var(--hud-text, var(--sa-white)); }
/* Shield absorbs are damage AVOIDED, not damage taken, so they are the one
   value that leaves the red/white axis: the HUD's own blue (--hud-primary, the
   same token the rims, ticks and armed rings use — no bespoke hex) and 8px
   against the 11px base, so an absorb reads as a smaller, cooler footnote to
   the hull number beside it rather than competing with it. Declared AFTER the
   two relation rules, which it deliberately overrides at equal specificity. */
.hud-damage-number.shield {
  --hud-damage-size: 8px;
  color: var(--hud-primary, var(--sa-blue-500));
  opacity: .9;
  font-weight: 700;
}
/* Hull GIVEN BACK by a repair field (2026-08-22) leaves the same axis in the
   other direction: green is the board's one helpful colour and nothing else on
   the HUD uses it, so a "+40" can never be misread as a hit. Same override
   position as .shield above, and at the full hull size — a heal is as
   load-bearing as the damage it undoes. */
.hud-damage-number.repair {
  color: var(--hud-repair, var(--sa-green-500));
  font-weight: 700;
}

/* --- Results overlay --- */
.hud-results {
  position: absolute;
  inset: 0;
  display: none;
  align-items: center;
  justify-content: center;
  background: radial-gradient(ellipse at center, color-mix(in srgb, var(--hud-bg, var(--sa-n-900)) 62%, transparent) 0%, rgba(2, 4, 10, 0.86) 100%);
  pointer-events: auto;
  isolation: isolate;
}
.hud-results.visible { display: flex; }
.hud-results-backdrop {
  position:absolute;
  inset:0;
  z-index:-1;
  overflow:hidden;
  pointer-events:none;
  opacity:0;
  background:
    radial-gradient(circle at 38% 47%, color-mix(in srgb, var(--hud-primary, var(--sa-blue-500)) 23%, transparent) 0%, transparent 24%),
    radial-gradient(ellipse at center, transparent 22%, color-mix(in srgb, var(--hud-bg, var(--sa-n-900)) 86%, transparent) 78%);
  transition:opacity .35s ease-out;
}
.hud-results--mvp .hud-results-backdrop { opacity:1; }
.hud-results-motes { position:absolute; inset:0; }
.hud-results-motes i {
  position:absolute;
  left:var(--mote-x);
  top:var(--mote-y);
  width:2px;
  height:2px;
  border-radius:50%;
  background:var(--hud-primary, var(--sa-blue-500));
  box-shadow:0 0 8px currentColor;
  animation:hud-mvp-mote calc(5s + var(--mote) * .31s) ease-in-out calc(var(--mote) * -.47s) infinite;
}
@keyframes hud-mvp-mote {
  0%, 100% { opacity:.08; transform:translate3d(0, 12px, 0); }
  50% { opacity:.55; transform:translate3d(8px, -16px, 0); }
}
.hud-results--outcome { background: rgba(2, 4, 10, 0.18); }
.hud-results--outcome .hud-results-panel::before,
.hud-results--outcome .hud-results-panel::after,
.hud-results--outcome .hud-results-rule,
.hud-results--outcome .hud-results-participants,
.hud-results--outcome .hud-results-sub,
.hud-results--outcome .hud-results-rewards-heading,
.hud-results--outcome .hud-results-rewards,
.hud-results--outcome .hud-results-actions { display: none; }
.hud-results--outcome .hud-results-outcome-tag,
.hud-results--outcome .hud-results-mvp-badge,
.hud-results--outcome .hud-results-team-accent,
.hud-results--outcome .hud-results-stats { display:none; }
/* The outcome banner is a FULL-SCREEN beat, not panel content. Every other
   panel child is display:none above, so the panel drops its 420px cap and its
   scroll box here: overflow-y:auto computes overflow-x to auto as well, which
   clipped VICTORY mid-glyph once the tracked word outgrew 420px. */
.hud-results--outcome .hud-results-panel {
  max-width: calc(100% - var(--hud-inset-left) - var(--hud-inset-right));
  overflow: visible;
  padding-inline: 0;
}
.hud-results--outcome .hud-results-title {
  /* Sized against the width the banner actually has (the viewport minus its
     insets), so the longest outcome word cannot outgrow its own box: a 700-weight
     display glyph advances about 0.62em, plus the 0.18em tracking. */
  --hud-results-title-tracking: .18em;
  font-size: min(clamp(3rem, 12vw, 8rem), calc((100vw - var(--hud-inset-left) - var(--hud-inset-right)) / 7 / 0.8));
  letter-spacing: var(--hud-results-title-tracking);
  white-space: nowrap;
  text-shadow: 0 0 18px currentColor, 0 0 52px currentColor, 0 3px 2px var(--sa-n-900);
}
/* Portrait phones: drop the panel to the thumb end of the screen so "Play
   again" stays a one-thumb reach (ROADMAP S3). */
@media (orientation: portrait) {
  .hud-results { align-items: flex-end; }
}
.hud-results--mvp { justify-content:flex-end; background:transparent; }
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
.hud-results--mvp .hud-results-panel {
  width:min(440px, 44vw);
  max-width:calc(100% - var(--hud-inset-left) - var(--hud-inset-right));
  margin-right:max(var(--hud-inset-right), 4vw);
  gap:10px;
  padding:min(25px, 3.2vh) min(34px, 4vw);
  /* The pilot name is sized against the CARD, not the viewport: 44vw of a
     landscape phone is 371px, nothing like 44vw of a desktop, and only the card
     knows which one it got. Safe to contain here — both MVP branches give the
     panel an explicit width, so nothing inside it decides how wide it is. */
  container-type:inline-size;
}
/* Nothing in the card may be squeezed to make the card fit. Flex items shrink
   by default, and a line box shrunk under its own font-size draws the glyphs at
   full height inside a short box — with overflow:hidden on the name that cut a
   clean horizontal line through the pilot's name on a landscape phone. Overflow
   now scrolls instead; the compact block below keeps it from having to. */
.hud-results--mvp .hud-results-panel > * { flex:0 0 auto; }
@media (orientation:portrait) {
  .hud-results--mvp .hud-results-panel {
    width:calc(100% - var(--hud-inset-left) - var(--hud-inset-right));
    margin:0 var(--hud-inset-right) var(--hud-inset-bottom) var(--hud-inset-left);
    max-height:52vh;
    padding:15px 20px;
    gap:7px;
  }
}
/* Landscape phones. The card at full size wants ~420px of height and a phone on
   its side offers ~370px, so every element used to give up a slice of itself.
   Spend the deficit on the chrome — badge, gaps, chip padding — and leave the
   name, the stats and the 44px buttons intact. */
@media (orientation:landscape) and (max-height:560px) {
  .hud-results--mvp { --hud-mvp-badge-size:min(76px, 20vh); }
  /* A little wider than the 44vw hero framing: below ~700px the two secondary
     buttons could not share a row, and a third 44px row is height this card
     does not have. The hull still gets the larger half of the screen. */
  .hud-results--mvp .hud-results-panel { width:min(440px, 48vw); gap:6px; padding:min(14px, 2.4vh) min(22px, 2.8vw); }
  .hud-results--mvp .hud-results-btn { min-width:84px; padding:6px 12px; }
  .hud-results--mvp .hud-results-mvp-badge { font-size:clamp(1rem, 2.6vw, 1.6rem); }
  .hud-results--mvp .hud-results-stat { padding:5px 4px 4px; }
  .hud-results--mvp .hud-results-stat-value { font-size:1.25em; }
  .hud-results--mvp .hud-results-rewards-line { font-size:1em; }
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
  background: color-mix(in srgb, var(--hud-bg, var(--sa-n-900)) 94%, transparent);
}
.hud-results-panel > * { position: relative; z-index: 1; }
.hud-results-outcome-tag {
  align-self:flex-end;
  padding:3px 9px;
  border-right:2px solid currentColor;
  color:var(--hud-neutral, var(--sa-n-400));
  background:color-mix(in srgb, currentColor 9%, transparent);
  font:700 .62em/1.4 var(--hud-font-display, system-ui, sans-serif);
  letter-spacing:.16em;
}
.hud-results-outcome-tag[data-outcome="victory"],
.hud-results-outcome-tag[data-outcome="targets-cleared"] { color:var(--hud-primary, var(--sa-blue-500)); }
.hud-results-outcome-tag[data-outcome="defeat"] { color:var(--hud-danger, var(--sa-red-500)); }
.hud-results-mvp-badge {
  width:var(--hud-mvp-badge-size, 112px);
  height:var(--hud-mvp-badge-size, 112px);
  display:grid;
  place-items:center;
  margin-top:calc(var(--hud-mvp-badge-size, 112px) * -.36);
  clip-path:polygon(50% 0, 88% 12%, 100% 50%, 88% 88%, 50% 100%, 12% 88%, 0 50%, 12% 12%);
  color:var(--hud-bg, var(--sa-n-900));
  background:var(--mvp-team, var(--hud-primary, var(--sa-blue-500)));
  font:900 clamp(1.5rem, 4vw, 2.5rem)/1 var(--hud-font-display, system-ui, sans-serif);
  letter-spacing:.08em;
  filter:drop-shadow(0 0 calc(24px * var(--hud-glow)) var(--mvp-team, var(--hud-primary, var(--sa-blue-500))));
  animation:hud-mvp-badge var(--hud-mvp-badge-ms, 520ms) cubic-bezier(.16, 1.35, .32, 1) both;
}
.hud-results[data-mvp-team="1"] { --mvp-team:var(--hud-accent, var(--sa-white)); }
.hud-results[data-mvp-team="0"] { --mvp-team:var(--hud-primary, var(--sa-blue-500)); }
@keyframes hud-mvp-badge {
  0% { opacity:0; transform:scale(.25) rotate(-12deg); filter:brightness(3) drop-shadow(0 0 45px currentColor); }
  62% { opacity:1; transform:scale(1.12) rotate(2deg); }
  100% { opacity:1; transform:none; }
}
.hud-results-team-accent {
  width:72%;
  height:3px;
  background:linear-gradient(90deg, transparent, var(--mvp-team), transparent);
  box-shadow:0 0 12px var(--mvp-team);
  transform-origin:center;
  animation:hud-mvp-accent .42s ease-out var(--hud-mvp-name-delay-ms, 430ms) both;
}
@keyframes hud-mvp-accent { from { opacity:0; transform:scaleX(.08); } to { opacity:1; transform:none; } }
.hud-results-title {
  /* Tracking has an advance after the final glyph. Reserve it inside the box:
     the scrolling panel otherwise clips it when horizontal overflow is auto. */
  --hud-results-title-tracking: 0.14em;
  box-sizing: border-box;
  max-width: 100%;
  padding-inline-end: var(--hud-results-title-tracking);
  font-family: var(--hud-font-display, var(--hud-font-body, system-ui, sans-serif));
  font-size: clamp(1.5rem, 7vw, 2.25rem);
  font-weight: 700;
  letter-spacing: var(--hud-results-title-tracking);
  text-transform: uppercase;
  text-align: center;
  animation: hud-results-banner 0.45s cubic-bezier(0.16, 1, 0.3, 1);
}
.hud-results--mvp .hud-results-title {
  max-width:100%;
  color:var(--hud-text, var(--sa-white));
  /* Fitted, not clipped. Three caps on one preferred size:
       - clamp(1.75rem, 4.5vw, 3.25rem) — what the name wants to be;
       - 9vh — the SHORT axis, which is the one a landscape phone runs out of;
       - the card's own inline size divided by the name's length, where 0.95em is
         what one tracked Orbitron capital measures (0.94 for ordinary names,
         and the wide-glyph tail wraps rather than spilling).
     --mvp-name-chars is published by ResultsOverlay.showMvp(); the 0.95rem
     floor is where the fit stops shrinking and the ellipsis below takes over. */
  font-size:max(
    0.95rem,
    min(
      clamp(1.75rem, 4.5vw, 3.25rem),
      9vh,
      calc(100cqi / max(var(--mvp-name-chars, 9), 5) / 0.95)
    )
  );
  /* 1.05 put the line box under the glyph box: ascenders and descenders were
     shaved even where the name fitted across. */
  line-height:1.22;
  /* NEVER mid-word (2026-08-23). An "anywhere" wrap broke a name at
     whatever character ran out of room — "VortexFall_99" rendered as
     "VORTEXFALL_9" with a lone "9" on a second line, which reads as a different
     pilot (playtest finding 18). A nickname is one word: it is fitted by the
     size ramp above, and the pathological remainder is elided rather than
     chopped into a second line. */
  overflow-wrap:normal;
  word-break:normal;
  white-space:nowrap;
  overflow:hidden;
  text-overflow:ellipsis;
  text-shadow:0 0 22px color-mix(in srgb, var(--mvp-team) 55%, transparent);
  animation:hud-mvp-name .48s cubic-bezier(.16, 1, .3, 1) var(--hud-mvp-name-delay-ms, 430ms) both;
}
@keyframes hud-mvp-name { from { opacity:0; transform:translateY(14px); letter-spacing:.02em; } to { opacity:1; transform:none; letter-spacing:.14em; } }
/* Outcome colouring — all four banners share one element, only the tint moves. */
.hud-results-title[data-outcome="victory"],
.hud-results-title[data-outcome="targets-cleared"] {
  color: var(--hud-primary, var(--sa-blue-500));
  text-shadow: 0 0 calc(30px * var(--hud-glow)) var(--hud-primary, var(--sa-blue-500));
}
.hud-results-title[data-outcome="defeat"] {
  color: var(--hud-danger, var(--sa-red-500));
  text-shadow: 0 0 calc(30px * var(--hud-glow)) var(--hud-danger, var(--sa-red-500));
}
.hud-results-title[data-outcome="draw"] { color: var(--hud-accent, var(--sa-white)); }
@keyframes hud-results-banner {
  from { opacity: 0; transform: translateY(-10px) scale(0.94); letter-spacing: 0.02em; }
  to { opacity: 1; transform: none; letter-spacing: var(--hud-results-title-tracking); }
}
/* Bracketed rule under the banner, the panel language's section mark. */
.hud-results-rule {
  width: 78%;
  height: var(--hud-rim);
  background: linear-gradient(90deg, transparent, var(--hud-primary, var(--sa-blue-500)), var(--hud-accent, var(--sa-white)), transparent);
  opacity: 0.85;
}
.hud-results-sub {
  font-size: 0.75em;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--hud-neutral, var(--sa-n-400));
}
.hud-results-sub:empty { display: none; }
.hud-results-participants {
  color: var(--hud-text, var(--sa-white));
  font: 600 0.78em/1.4 var(--hud-font-display, system-ui, sans-serif);
  letter-spacing: 0.1em;
  text-transform: uppercase;
}
.hud-results-participants:empty { display: none; }
.hud-results--mvp .hud-results-participants {
  color:var(--mvp-team);
  font-size:.68em;
  animation:hud-mvp-name .4s ease-out calc(var(--hud-mvp-name-delay-ms, 430ms) - 100ms) both;
}
.hud-results-stats { display:flex; justify-content:center; gap:8px; width:100%; }
.hud-results-stat {
  flex:1 1 0;
  min-width:0;
  padding:8px 5px 7px;
  display:flex;
  flex-direction:column;
  align-items:center;
  border-top:1px solid color-mix(in srgb, var(--mvp-team) 65%, transparent);
  background:linear-gradient(180deg, color-mix(in srgb, var(--mvp-team) 13%, transparent), transparent);
  clip-path:polygon(7px 0, 100% 0, 100% calc(100% - 7px), calc(100% - 7px) 100%, 0 100%, 0 7px);
  animation:hud-mvp-chip .42s cubic-bezier(.16, 1, .3, 1) calc(var(--hud-mvp-stats-delay-ms, 720ms) + var(--chip-delay, 0ms)) both;
}
.hud-results-stat:nth-child(2) { --chip-delay:80ms; }
.hud-results-stat:nth-child(3) { --chip-delay:160ms; }
.hud-results-stat-value { color:var(--hud-text, var(--sa-white)); font:800 1.45em/1 var(--hud-font-display, system-ui, sans-serif); font-variant-numeric:tabular-nums; }
.hud-results-stat-label { margin-top:4px; color:var(--hud-neutral, var(--sa-n-400)); font-size:.56em; letter-spacing:.12em; }
@keyframes hud-mvp-chip { from { opacity:0; transform:translateY(10px) scale(.94); } to { opacity:1; transform:none; } }
/* The line that says the numbers below belong to YOU, not to the MVP whose
   name and stat tiles are above them. A quiet rule-and-label, deliberately
   lighter than the stat labels: it is a boundary, not a third headline. */
.hud-results-rewards-heading {
  align-self: stretch;
  margin-top: 2px;
  padding-top: 6px;
  border-top: 1px solid color-mix(in srgb, var(--hud-neutral, var(--sa-n-400)) 34%, transparent);
  color: var(--hud-neutral, var(--sa-n-400));
  font: 600 0.6em/1.3 var(--hud-font-display, system-ui, sans-serif);
  letter-spacing: 0.16em;
  text-transform: uppercase;
  text-align: center;
}
.hud-results-rewards-heading[hidden] { display: none; }
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
  color: var(--hud-primary, var(--sa-blue-500));
  letter-spacing: 0.03em;
  font-variant-numeric: tabular-nums;
}
.hud-results-rewards-line .credits { color: var(--hud-accent, var(--sa-white)); font-weight: 700; }
.hud-results-rewards-line .xp { color: var(--hud-primary, var(--sa-blue-500)); font-weight: 700; }
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
.hud-results--mvp .hud-results-actions {
  animation:hud-mvp-actions .48s cubic-bezier(.16, 1, .3, 1) var(--hud-mvp-actions-delay-ms, 1120ms) both;
}
@keyframes hud-mvp-actions { from { opacity:0; transform:translateX(20px); } to { opacity:1; transform:none; } }
.hud-results--mvp-skipped .hud-results-mvp-badge,
.hud-results--mvp-skipped .hud-results-participants,
.hud-results--mvp-skipped .hud-results-title,
.hud-results--mvp-skipped .hud-results-team-accent,
.hud-results--mvp-skipped .hud-results-stat,
.hud-results--mvp-skipped .hud-results-actions { animation:none !important; opacity:1; transform:none; }
.hud-results-levelup {
  font-size: 0.8125em;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--hud-success, var(--sa-blue-500));
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
  color: var(--hud-text, var(--sa-white));
  background: color-mix(in srgb, var(--hud-primary, var(--sa-blue-500)) 8%, transparent);
  border: var(--hud-rim) solid var(--hud-rim-color);
  clip-path: polygon(9px 0%, 100% 0%, 100% calc(100% - 9px), calc(100% - 9px) 100%, 0% 100%, 0% 9px);
  transition: background-color 0.12s linear, color 0.12s linear;
}
.hud-results-btn:hover { background: color-mix(in srgb, var(--hud-primary, var(--sa-blue-500)) 20%, transparent); }
.hud-results-btn--primary {
  flex: 1 1 100%;
  color: var(--hud-bg, var(--sa-n-900));
  background: var(--hud-primary, var(--sa-blue-500));
  border-color: var(--hud-primary, var(--sa-blue-500));
  font-size: 0.875em;
  font-weight: 700;
}
.hud-results-btn--primary:hover { background: color-mix(in srgb, var(--hud-primary, var(--sa-blue-500)) 82%, var(--sa-white)); }

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
  color: var(--hud-primary, var(--sa-blue-500));
  background: color-mix(in srgb, var(--hud-bg, var(--sa-n-900)) 68%, transparent);
  border: var(--hud-rim) solid var(--hud-rim-color);
  clip-path: polygon(9px 0%, 100% 0%, 100% calc(100% - 9px), calc(100% - 9px) 100%, 0% 100%, 0% 9px);
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}
.hud-settings-btn:hover { border-color: var(--hud-primary, var(--sa-blue-500)); }

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
  color: var(--hud-primary, var(--sa-blue-500));
  text-shadow: 0 0 calc(40px * var(--hud-glow)) var(--hud-primary, var(--sa-blue-500));
  /* Scrim only behind the glyph, so the arena stays readable at the edges. */
  background: radial-gradient(
    circle at center,
    color-mix(in srgb, var(--hud-bg, var(--sa-n-900)) 46%, transparent) 0%,
    transparent 46%
  );
}
.hud-countdown.visible {
  display: flex;
  animation: hud-countdown-beat 0.9s cubic-bezier(0.16, 1, 0.3, 1) both;
}
.hud-lobby-waiting {
  position: absolute;
  inset: 0;
  display: none;
  place-items: center;
  pointer-events: none;
  background: radial-gradient(circle at center, color-mix(in srgb, var(--hud-bg, var(--sa-n-900)) 58%, transparent), transparent 52%);
}
.hud-lobby-waiting.visible { display: grid; }
.hud-lobby-waiting-panel {
  min-width: min(420px, 84vw);
  padding: 24px 30px;
  text-align: center;
  border: 1px solid color-mix(in srgb, var(--hud-primary, var(--sa-blue-500)) 72%, transparent);
  background: color-mix(in srgb, var(--hud-bg, var(--sa-n-900)) 82%, transparent);
  box-shadow: 0 0 calc(28px * var(--hud-glow)) color-mix(in srgb, var(--hud-primary, var(--sa-blue-500)) 35%, transparent);
}
.hud-lobby-waiting-title {
  color: var(--hud-primary, var(--sa-blue-500));
  font-family: var(--hud-font-display, var(--hud-font-body, system-ui, sans-serif));
  font-size: clamp(18px, 4vw, 28px);
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.hud-lobby-waiting-flavor {
  margin-top: 10px;
  color: var(--hud-text-muted, var(--sa-white));
  font-family: var(--hud-font-body, system-ui, sans-serif);
  font-size: clamp(13px, 2.5vw, 16px);
}
/* Hangar launch hold: the establishing shot IS the content, so the numerals
   step aside to a small top-centre strip and drop the centre scrim entirely.
   Placement only — the beat, the GO tint and the animations are shared. */
.hud-countdown.hangar {
  inset: 0 0 auto 0;
  align-items: flex-start;
  padding-top: max(2.5vh, env(safe-area-inset-top, 0px));
  font-size: clamp(26px, 6vh, 52px);
  letter-spacing: 0.22em;
  /* Trailing letter-spacing on the last glyph would read as an off-centre
     numeral against a strip this narrow. */
  text-indent: 0.22em;
  background: none;
}
.hud-countdown.hangar.go {
  font-size: clamp(22px, 5vh, 44px);
  letter-spacing: 0.3em;
  text-indent: 0.3em;
}
/* GO reads as a release, not a fourth beat: accent tint, wider, snappier. */
.hud-countdown.go {
  color: var(--hud-accent, var(--sa-white));
  text-shadow: 0 0 calc(48px * var(--hud-glow)) var(--hud-accent, var(--sa-white));
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
   is already carried by COLOUR (lock red, critical red), so they
   can stop without taking a combat cue away. The one-shot feedback animations
   (hit marker, damage vignette, toast slide, results banner) stay: they ARE the
   information — a hit marker that never appears is a hit the player never saw. */
@media (prefers-reduced-motion: reduce) {
  .hud-boost-btn.active > .icon,
  .hud-reticle-bracket.locked .ring {
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
}
`;
