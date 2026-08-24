import { afterEach, describe, expect, it } from "vitest";
import { installTouchGuards } from "./touchGuards.js";

function touchEnd(target: EventTarget, timestamp: number): TouchEvent {
  const event = new Event("touchend", { bubbles: true, cancelable: true }) as TouchEvent;
  Object.defineProperty(event, "timeStamp", { value: timestamp });
  target.dispatchEvent(event);
  return event;
}

function touchMove(target: EventTarget): TouchEvent {
  const event = new Event("touchmove", { bubbles: true, cancelable: true }) as TouchEvent;
  target.dispatchEvent(event);
  return event;
}

describe("installTouchGuards", () => {
  let dispose: (() => void) | undefined;

  afterEach(() => {
    dispose?.();
    dispose = undefined;
    document.body.replaceChildren();
  });

  it("blocks iOS gesture events outside the canvas but leaves canvas gestures alone", () => {
    dispose = installTouchGuards();
    const page = document.createElement("div");
    const canvas = document.createElement("canvas");
    document.body.append(page, canvas);

    const pageGesture = new Event("gesturestart", { bubbles: true, cancelable: true });
    page.dispatchEvent(pageGesture);
    expect(pageGesture.defaultPrevented).toBe(true);

    const canvasGesture = new Event("gesturestart", { bubbles: true, cancelable: true });
    canvas.dispatchEvent(canvasGesture);
    expect(canvasGesture.defaultPrevented).toBe(false);
  });

  it("blocks only the second rapid page tap, never HUD controls or canvas", () => {
    dispose = installTouchGuards();
    const page = document.createElement("div");
    const canvas = document.createElement("canvas");
    const hudButton = document.createElement("button");
    hudButton.setAttribute("data-hud-control", "fire");
    document.body.append(page, canvas, hudButton);

    expect(touchEnd(page, 100).defaultPrevented).toBe(false);
    expect(touchEnd(page, 250).defaultPrevented).toBe(true);
    expect(touchEnd(hudButton, 300).defaultPrevented).toBe(false);
    expect(touchEnd(canvas, 350).defaultPrevented).toBe(false);
  });

  it("blocks page touch moves but preserves canvas and scrollable-panel moves", () => {
    dispose = installTouchGuards();
    const page = document.createElement("div");
    const canvas = document.createElement("canvas");
    const scrollPane = document.createElement("div");
    const scrollChild = document.createElement("div");
    scrollPane.style.overflowY = "auto";
    scrollPane.append(scrollChild);
    document.body.append(page, canvas, scrollPane);

    expect(touchMove(page).defaultPrevented).toBe(true);
    expect(touchMove(canvas).defaultPrevented).toBe(false);
    expect(touchMove(scrollChild).defaultPrevented).toBe(false);
  });

  /**
   * Playtest finding 13: 414 console ERRORS in a single session — "Ignored
   * attempt to cancel a touchmove event with cancelable=false" — one per
   * steering frame, because once a touch gesture is handed to the compositor
   * the browser stops making its moves cancelable and refuses (loudly) to
   * cancel them. Steering worked throughout; the log did not.
   */
  it("does not argue with an uncancelable move", () => {
    dispose = installTouchGuards();
    const page = document.createElement("div");
    document.body.append(page);

    const uncancelable = new Event("touchmove", { bubbles: true, cancelable: false }) as TouchEvent;
    let attempted = false;
    uncancelable.preventDefault = () => { attempted = true; };
    page.dispatchEvent(uncancelable);
    expect(attempted).toBe(false);
  });

  it("does not argue with an uncancelable second tap either", () => {
    dispose = installTouchGuards();
    const page = document.createElement("div");
    document.body.append(page);
    touchEnd(page, 100);
    const uncancelable = new Event("touchend", { bubbles: true, cancelable: false }) as TouchEvent;
    Object.defineProperty(uncancelable, "timeStamp", { value: 250 });
    let attempted = false;
    uncancelable.preventDefault = () => { attempted = true; };
    page.dispatchEvent(uncancelable);
    expect(attempted).toBe(false);
  });
});
