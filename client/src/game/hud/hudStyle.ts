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
  font-family: var(--hud-font-body, system-ui, sans-serif);
  color: var(--hud-text, #e6f0ff);
  --hud-safe-inset: 12px;
}

.hud-fps {
  position: absolute;
  top: calc(env(safe-area-inset-top, 0px) + var(--hud-safe-inset));
  right: var(--hud-safe-inset);
  padding: 2px 8px;
  font: 12px/1.4 monospace;
  color: var(--hud-primary, #9be8ff);
  background: rgba(0, 0, 0, 0.35);
  border-radius: 4px;
}

/* --- Minimap (top-left) --- */
.hud-minimap {
  position: absolute;
  top: calc(env(safe-area-inset-top, 0px) + var(--hud-safe-inset));
  left: var(--hud-safe-inset);
  width: var(--hud-minimap-size, 128px);
  height: var(--hud-minimap-size, 128px);
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
  left: var(--hud-safe-inset);
  bottom: calc(env(safe-area-inset-bottom, 0px) + var(--hud-safe-inset));
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: var(--hud-gauge-width, 140px);
}
.hud-gauge {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.hud-gauge-label {
  font-size: 10px;
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

/* --- Module radial buttons (bottom-right) --- */
.hud-modules {
  position: absolute;
  right: var(--hud-safe-inset);
  bottom: calc(env(safe-area-inset-bottom, 0px) + var(--hud-safe-inset));
  display: flex;
  flex-direction: row-reverse;
  flex-wrap: wrap-reverse;
  justify-content: flex-end;
  align-items: flex-end;
  gap: var(--hud-module-gap, 14px);
  width: calc(var(--hud-module-btn-radius, 34px) * 6);
}
.hud-module-btn {
  pointer-events: auto;
  position: relative;
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
  font-size: 9px;
  line-height: 1.2;
  cursor: pointer;
  user-select: none;
  transition: filter 0.15s linear, opacity 0.15s linear, box-shadow 0.15s linear;
}
.hud-module-btn .icon { font-size: 16px; }
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
  top: calc(env(safe-area-inset-top, 0px) + var(--hud-safe-inset));
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  pointer-events: none;
}
.hud-toast {
  padding: 4px 14px;
  border-radius: 4px;
  font-size: 13px;
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
  top: calc(env(safe-area-inset-top, 0px) + var(--hud-safe-inset) + 40px);
  left: 50%;
  transform: translateX(-50%);
  font-size: 12px;
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
.hud-results-panel {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  padding: 32px 48px;
  background: var(--hud-bg, #0a0e1a);
  border: 1px solid var(--hud-primary, #57d8ff);
  border-radius: 8px;
}
.hud-results-title {
  font-size: 22px;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}
.hud-results-rewards {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  min-height: 0;
}
.hud-results-rewards:empty { display: none; }
.hud-results-rewards-line {
  font-size: 14px;
  color: var(--hud-primary, #57d8ff);
  letter-spacing: 0.03em;
}
.hud-results-levelup {
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: #5fe08c;
  animation: hud-toast-in 0.2s ease-out;
}
.hud-results-btn {
  pointer-events: auto;
  cursor: pointer;
  padding: 8px 24px;
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--hud-bg, #0a0e1a);
  background: var(--hud-primary, #57d8ff);
  border: none;
  border-radius: 4px;
}
`;
