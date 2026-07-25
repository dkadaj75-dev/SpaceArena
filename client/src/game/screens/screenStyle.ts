const STYLE_ID = "sa-screen-style";

/**
 * Shared stylesheet for the full-screen menus (Auth, Lobby) — ROADMAP 5.5.
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
  color: #e8f1ff;
  font-family: system-ui, sans-serif;
  box-sizing: border-box;
}
/* Center the stack whenever it fits; scroll from the top when it doesn't. */
.sa-screen > * { flex: 0 0 auto; }
.sa-screen::before,
.sa-screen::after { content: ""; flex: 1 1 auto; min-height: 0; }

.sa-screen-title {
  letter-spacing: .3em;
  font-weight: 300;
  color: #57d8ff;
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

/* Landscape phones: the header would collide with a top-anchored stack, and
   vertical room is scarce — tighten the paddings and the gaps. */
@media (orientation: landscape) and (max-height: 480px) {
  .sa-screen { gap: 8px; padding-top: calc(env(safe-area-inset-top, 0px) + 48px); }
  .sa-screen-title { margin-bottom: 2px; }
  .sa-screen-btn { min-height: 40px; padding: 8px 16px; }
}
`;
