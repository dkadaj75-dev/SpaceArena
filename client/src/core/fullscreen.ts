import { createLogger } from "@space-arena/shared";

const log = createLogger("Fullscreen");

/**
 * Browser fullscreen for the whole app (ROADMAP §10 5.8, owner request
 * 2026-07-30). Pure wrappers over the Fullscreen API, kept in one place because
 * the API has three sharp edges the UI must not care about:
 *
 *  - **Vendor prefixes.** Safari still ships `webkitRequestFullscreen` /
 *    `webkitFullscreenElement` / `webkitfullscreenchange` on some versions;
 *    iPhone Safari has NO element fullscreen at all (iPad does). Every helper
 *    falls back to the prefixed member and reports support honestly.
 *  - **Gesture gating.** `requestFullscreen` only succeeds inside a user
 *    gesture, so fullscreen is a LIVE toggle, never a persisted setting — a
 *    stored "fullscreen: on" could not be honoured at boot and would dangle as
 *    a lie in the Settings screen.
 *  - **External exits.** Esc (and mobile back) leave fullscreen without asking
 *    us, so any UI showing the state must subscribe to
 *    {@link onFullscreenChange} rather than remember what it last requested.
 *
 * The target is `document.documentElement`, NOT the render canvas: the whole
 * HUD is DOM layered over the canvas, and fullscreening the canvas alone would
 * play the match with no instruments.
 *
 * Every function takes the document as a parameter (defaulting to the real
 * one) so the whole contract is unit-testable without a browser window.
 */

/** The minimal document surface these helpers touch (prefixed members included). */
export interface FullscreenDocument {
  documentElement: Element & {
    requestFullscreen?: () => Promise<void>;
    webkitRequestFullscreen?: () => void;
  };
  fullscreenEnabled?: boolean;
  webkitFullscreenEnabled?: boolean;
  fullscreenElement?: Element | null;
  webkitFullscreenElement?: Element | null;
  exitFullscreen?: () => Promise<void>;
  webkitExitFullscreen?: () => void;
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
}

/** Minimal Screen API surface used for the optional landscape lock. */
export interface OrientationScreen {
  orientation?: {
    lock?: (orientation: "landscape") => Promise<void>;
  };
}

function doc(override?: FullscreenDocument): FullscreenDocument {
  return override ?? (document as unknown as FullscreenDocument);
}

/** True when this browser can fullscreen the app at all (iPhone Safari: false). */
export function fullscreenSupported(d?: FullscreenDocument): boolean {
  const target = doc(d);
  if (target.fullscreenEnabled !== undefined) return target.fullscreenEnabled;
  if (target.webkitFullscreenEnabled !== undefined) return target.webkitFullscreenEnabled;
  return (
    typeof target.documentElement.requestFullscreen === "function" ||
    typeof target.documentElement.webkitRequestFullscreen === "function"
  );
}

/** Live fullscreen state — the only truth the UI may display. */
export function isFullscreen(d?: FullscreenDocument): boolean {
  const target = doc(d);
  return Boolean(target.fullscreenElement ?? target.webkitFullscreenElement ?? null);
}

/**
 * Ask supporting fullscreen browsers to keep the installed game in landscape.
 * iOS Safari exposes neither a reliable lock nor a successful implementation,
 * so rejection is deliberately silent.
 */
export async function lockLandscapeOrientation(
  orientationScreen: OrientationScreen = globalThis.screen as unknown as OrientationScreen,
): Promise<void> {
  try {
    await orientationScreen.orientation?.lock?.("landscape");
  } catch {
    // Orientation locking is optional and commonly rejected by iOS Safari.
  }
}

/**
 * Toggle fullscreen. MUST be called from a user-gesture handler (a click) or
 * the browser rejects the request. Resolves to the resulting state as best it
 * can be known synchronously after the transition; a denied request resolves
 * to the unchanged state rather than throwing — the Settings toggle repaints
 * from {@link onFullscreenChange} either way, so a lie here cannot stick.
 */
export async function toggleFullscreen(d?: FullscreenDocument): Promise<boolean> {
  const target = doc(d);
  try {
    if (isFullscreen(target)) {
      if (target.exitFullscreen) await target.exitFullscreen();
      else target.webkitExitFullscreen?.();
    } else {
      const root = target.documentElement;
      if (root.requestFullscreen) await root.requestFullscreen();
      else root.webkitRequestFullscreen?.();
      await lockLandscapeOrientation();
    }
  } catch (err) {
    // Denied (no gesture, iframe policy) or interrupted — state simply stands.
    log.warn("fullscreen toggle rejected", err);
  }
  return isFullscreen(target);
}

/**
 * Subscribe to fullscreen state changes, from OUR toggle and from external
 * exits (Esc) alike. Returns the unsubscribe. Both the standard and the
 * webkit-prefixed event names are wired — a browser fires whichever matches
 * the API flavour it implements.
 */
export function onFullscreenChange(listener: () => void, d?: FullscreenDocument): () => void {
  const target = doc(d);
  target.addEventListener("fullscreenchange", listener);
  target.addEventListener("webkitfullscreenchange", listener);
  return () => {
    target.removeEventListener("fullscreenchange", listener);
    target.removeEventListener("webkitfullscreenchange", listener);
  };
}
