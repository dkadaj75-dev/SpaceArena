import { afterEach, describe, expect, it } from "vitest";
import { installTouchGuards } from "./touchGuards.js";

function touchEnd(target: EventTarget, timestamp: number): TouchEvent {
  const event = new Event("touchend", { bubbles: true, cancelable: true }) as TouchEvent;
  Object.defineProperty(event, "timeStamp", { value: timestamp });
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
});
