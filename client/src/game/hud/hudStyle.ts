const STYLE_ID = "hud-style";

/**
 * Injects the HUD stylesheet once. All colors/sizes come from CSS custom
 * properties (`--hud-*`) set on `#hud` by {@link import("./Hud.js").Hud} from
 * `theme.json` (and re-applied on theme hot-reload) — this file only lays out
 * structure/animations, never hardcodes a color or size that the Theme editor
 * should own.
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
  color: var(--hud-text, #e6f0ff);
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
}

.hud-fps {
  position: absolute;
  top: var(--hud-inset-top);
  right: var(--hud-inset-right);
  padding: 2px 8px;
  font: 0.75em/1.4 monospace;
  color: var(--hud-primary, #9be8ff);
  background: rgba(0, 0, 0, 0.35);
  border-radius: 4px;
}

/* --- Minimap (top-left) --- */
.hud-minimap {
  position: absolute;
  top: var(--hud-inset-top);
  left: var(--hud-inset-left);
  width: var(--hud-minimap-size, 128px);
  height: var(--hud-minimap-size, 128px);
  max-width: 40vw;
  max-height: 40vw;
  border-radius: 50%;
  border: 1px solid var(--hud-primary, #57d8ff);
  background: rgba(5, 10, 20, 0.55);
  overflow: hidden;
}
.hud-minimap canvas {
  width: 100%;
  height: 100%;
  display: block;
}

/* --- Gauges (left side): hull, shield, energy, heat --- */
.hud-gauges {
  position: absolute;
  left: var(--hud-inset-left);
  bottom: var(--hud-inset-bottom);
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: var(--hud-gauge-width, 140px);
  max-width: calc(100vw - var(--hud-inset-left) - var(--hud-inset-right));
}
.hud-gauge {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.hud-gauge-label {
  font-size: 0.625em;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  opacity: 0.75;
}
.hud-gauge-track {
  position: relative;
  width: 100%;
  height: 10px;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 3px;
  overflow: hidden;
}
.hud-gauge-fill {
  position: absolute;
  inset: 0;
  width: 100%;
  transform-origin: left center;
  background: var(--hud-primary, #57d8ff);
  transition: transform 0.08s linear, background-color 0.15s linear;
}
.hud-gauge-fill.hull { background: var(--hud-accent, #ff8c42); }
.hud-gauge-fill.shield { background: var(--hud-primary, #57d8ff); }
.hud-gauge-fill.energy { background: #5fe08c; }
.hud-gauge-fill.heat { background: var(--hud-accent, #ff8c42); }
.hud-gauge-fill.heat.warn { background: var(--hud-danger, #ff4d5e); }

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
  border-radius: 50%;
  border: 2px solid rgba(255, 255, 255, 0.25);
  background:
    conic-gradient(var(--hud-primary, #57d8ff) calc(var(--ring, 0) * 1%), transparent 0),
    rgba(10, 14, 26, 0.7);
  color: var(--hud-text, #e6f0ff);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  font-size: 0.5625em;
  line-height: 1.2;
  cursor: pointer;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
  transition: filter 0.15s linear, opacity 0.15s linear, box-shadow 0.15s linear;
}
.hud-module-btn .icon { font-size: 1em; }
.hud-module-btn .label { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hud-module-btn.state-retracted { filter: brightness(0.6) saturate(0.7); }
.hud-module-btn.state-deploying { filter: brightness(0.9); }
.hud-module-btn.state-active {
  filter: brightness(1.15);
  box-shadow: 0 0 10px 2px var(--hud-primary, #57d8ff);
  border-color: var(--hud-primary, #57d8ff);
}
.hud-module-btn.state-retracting { filter: brightness(0.85) saturate(0.85); }
.hud-module-btn.state-overheated {
  filter: brightness(1) saturate(0.4);
  border-color: var(--hud-danger, #ff4d5e);
  animation: hud-overheat-flash 0.6s ease-in-out infinite;
}
.hud-module-btn.no-energy { filter: grayscale(0.85) brightness(0.5); opacity: 0.7; }
@keyframes hud-overheat-flash {
  0%, 100% { box-shadow: 0 0 6px 1px var(--hud-danger, #ff4d5e); }
  50% { box-shadow: 0 0 16px 4px var(--hud-danger, #ff4d5e); }
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
.hud-toast {
  padding: 4px 14px;
  border-radius: 4px;
  max-width: 100%;
  text-align: center;
  font-size: 0.8125em;
  font-weight: 600;
  letter-spacing: 0.03em;
  background: rgba(10, 14, 26, 0.85);
  border: 1px solid var(--hud-primary, #57d8ff);
  animation: hud-toast-in 0.15s ease-out;
}
.hud-toast.warning { border-color: var(--hud-accent, #ff8c42); color: var(--hud-accent, #ff8c42); }
.hud-toast.critical { border-color: var(--hud-danger, #ff4d5e); color: var(--hud-danger, #ff4d5e); }
.hud-toast.success { border-color: #5fe08c; color: #5fe08c; }
.hud-toast.info { border-color: var(--hud-primary, #57d8ff); color: var(--hud-primary, #57d8ff); }
@keyframes hud-toast-in {
  from { opacity: 0; transform: translateY(-6px); }
  to { opacity: 1; transform: translateY(0); }
}

/* --- Match status (top-center, above notifications) --- */
.hud-match-status {
  position: absolute;
  top: calc(var(--hud-inset-top) + 40px);
  left: 50%;
  transform: translateX(-50%);
  max-width: calc(100vw - var(--hud-inset-left) - var(--hud-inset-right));
  font-size: 0.75em;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  opacity: 0.85;
  background: rgba(10, 14, 26, 0.4);
  padding: 2px 10px;
  border-radius: 4px;
  white-space: nowrap;
}

/* --- Damage feedback --- */
.hud-vignette {
  position: absolute;
  inset: 0;
  pointer-events: none;
  opacity: 0;
  background: radial-gradient(ellipse at center, transparent 55%, var(--hud-danger, #ff4d5e) 130%);
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
  background: var(--hud-text, #e6f0ff);
}
.hud-hitmarker::before { left: 50%; top: 0; width: 2px; height: 100%; transform: translateX(-50%); }
.hud-hitmarker::after { top: 50%; left: 0; height: 2px; width: 100%; transform: translateY(-50%); }
@keyframes hud-hitmarker-pop {
  0% { opacity: 1; transform: translate(-50%, -50%) scale(1.1); }
  100% { opacity: 0; transform: translate(-50%, -50%) scale(0.6); }
}

/* --- Results overlay --- */
.hud-results {
  position: absolute;
  inset: 0;
  display: none;
  align-items: center;
  justify-content: center;
  background: rgba(2, 4, 10, 0.7);
  pointer-events: auto;
}
.hud-results.visible { display: flex; }
/* Portrait phones: drop the panel to the thumb end of the screen so "Play
   again" stays a one-thumb reach (ROADMAP S3). */
@media (orientation: portrait) {
  .hud-results { align-items: flex-end; }
}
.hud-results-panel {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  padding: min(32px, 6vh) min(48px, 8vw);
  margin: var(--hud-inset-top) var(--hud-inset-right) var(--hud-inset-bottom) var(--hud-inset-left);
  max-width: min(420px, 100%);
  max-height: 100%;
  overflow-y: auto;
  background: var(--hud-bg, #0a0e1a);
  border: 1px solid var(--hud-primary, #57d8ff);
  border-radius: 8px;
}
.hud-results-title {
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
  color: var(--hud-primary, #57d8ff);
  text-shadow: 0 0 24px rgba(87, 216, 255, 0.45);
}
.hud-results-title[data-outcome="defeat"] {
  color: var(--hud-danger, #ff4d5e);
  text-shadow: 0 0 24px rgba(255, 77, 94, 0.35);
}
.hud-results-title[data-outcome="draw"] { color: var(--hud-accent, #ff8c42); }
@keyframes hud-results-banner {
  from { opacity: 0; transform: translateY(-10px) scale(0.94); letter-spacing: 0.02em; }
  to { opacity: 1; transform: none; letter-spacing: 0.14em; }
}
.hud-results-sub {
  font-size: 0.75em;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  opacity: 0.7;
}
.hud-results-sub:empty { display: none; }
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
  color: var(--hud-primary, #57d8ff);
  letter-spacing: 0.03em;
  font-variant-numeric: tabular-nums;
}
.hud-results-rewards-line .credits { color: var(--hud-accent, #ff8c42); font-weight: 700; }
.hud-results-rewards-line .xp { color: var(--hud-primary, #57d8ff); font-weight: 700; }
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
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: #5fe08c;
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
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--hud-text, #e6f0ff);
  background: transparent;
  border: 1px solid var(--hud-primary, #57d8ff);
  border-radius: 4px;
}
.hud-results-btn--primary {
  flex: 1 1 100%;
  color: var(--hud-bg, #0a0e1a);
  background: var(--hud-primary, #57d8ff);
  border-color: var(--hud-primary, #57d8ff);
  font-size: 0.875em;
}

/* --- In-match settings affordance (top-right, next to the FPS readout) ---
   Tagged data-hud-control so edge palm rejection never eats it (5.4). */
.hud-settings-btn {
  pointer-events: auto;
  position: absolute;
  top: var(--hud-inset-top);
  right: calc(var(--hud-inset-right) + 76px);
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1em;
  line-height: 1;
  color: var(--hud-primary, #57d8ff);
  background: rgba(10, 14, 26, 0.7);
  border: 1px solid var(--hud-primary, #57d8ff);
  border-radius: 8px;
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}
`;
