/**
 * Browser-level gesture guards for the game shell. Canvas is intentionally
 * exempt: TacticalCamera owns its touch/pinch controls there (notably in the
 * hangar and dev editor), with touch-action:none already preventing page zoom.
 */
const DOUBLE_TAP_WINDOW_MS = 300;
const INTERACTIVE_TARGET = [
  "canvas",
  "button",
  "a",
  "input",
  "textarea",
  "select",
  "[contenteditable]",
  "[role=button]",
  "[data-hud-control]",
  ".hud-root",
  ".sa-editor",
].join(",");

function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(INTERACTIVE_TARGET) !== null;
}

function isCanvasTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("canvas") !== null;
}

function isScrollableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;

  // A touch event keeps its original touchstart target while it moves. Walk
  // that target's ancestors so the menu and editor's intentionally scrollable
  // panes retain native scrolling, while the fixed game shell cannot bounce.
  for (let element: Element | null = target; element; element = element.parentElement) {
    const style = element.ownerDocument.defaultView?.getComputedStyle(element);
    if (!style) continue;
    if ([style.overflow, style.overflowX, style.overflowY].some((value) => /^(auto|scroll|overlay)$/.test(value))) {
      return true;
    }
  }
  return false;
}

/** Install iOS pinch and page double-tap zoom guards once for this document. */
export function installTouchGuards(target: Document = document): () => void {
  const existing = target.documentElement.dataset["saTouchGuardsInstalled"];
  if (existing === "true") return () => {};
  target.documentElement.dataset["saTouchGuardsInstalled"] = "true";

  const preventBrowserGesture = (event: Event): void => {
    // Canvas owns its own pinch controls; every other surface is page UI.
    if (!isCanvasTarget(event.target)) event.preventDefault();
  };
  const preventPageScroll = (event: TouchEvent): void => {
    if (!isCanvasTarget(event.target) && !isScrollableTarget(event.target)) event.preventDefault();
  };
  let lastTouchEnd = -Infinity;
  const preventDoubleTapZoom = (event: TouchEvent): void => {
    if (isInteractiveTarget(event.target)) return;
    const elapsed = event.timeStamp - lastTouchEnd;
    if (elapsed > 0 && elapsed < DOUBLE_TAP_WINDOW_MS) event.preventDefault();
    lastTouchEnd = event.timeStamp;
  };

  target.addEventListener("gesturestart", preventBrowserGesture, { passive: false });
  target.addEventListener("gesturechange", preventBrowserGesture, { passive: false });
  target.addEventListener("gestureend", preventBrowserGesture, { passive: false });
  target.addEventListener("touchmove", preventPageScroll, { passive: false });
  target.addEventListener("touchend", preventDoubleTapZoom, { passive: false });

  return () => {
    target.documentElement.dataset["saTouchGuardsInstalled"] = "";
    target.removeEventListener("gesturestart", preventBrowserGesture);
    target.removeEventListener("gesturechange", preventBrowserGesture);
    target.removeEventListener("gestureend", preventBrowserGesture);
    target.removeEventListener("touchmove", preventPageScroll);
    target.removeEventListener("touchend", preventDoubleTapZoom);
  };
}
