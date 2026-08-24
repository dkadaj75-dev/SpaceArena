import { describe, expect, it, vi } from "vitest";
import { TAP_MOVE_TOLERANCE_PX, bindTap } from "./tapControl.js";

/** The fake-pointer idiom the rest of the HUD suite uses. */
function pointer(type: string, pointerId = 1, x?: number, y?: number): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { pointerId, pointerType: "touch", button: 0, clientX: x, clientY: y });
  return event;
}

describe("bindTap", () => {
  function bound(): { el: HTMLElement; fired: ReturnType<typeof vi.fn>; unbind: () => void } {
    const el = document.createElement("div");
    const fired = vi.fn();
    return { el, fired, unbind: bindTap(el, fired) };
  }

  it("fires on release, not on press — a press is not yet a decision", () => {
    const { el, fired, unbind } = bound();
    el.dispatchEvent(pointer("pointerdown", 1, 10, 10));
    expect(fired).not.toHaveBeenCalled();
    el.dispatchEvent(pointer("pointerup", 1, 10, 10));
    expect(fired).toHaveBeenCalledOnce();
    unbind();
  });

  /**
   * The bug the whole module exists for (playtest finding 1): with a first
   * touch already down, a second touch on a button raises pointer events and NO
   * click at all, so every `click`-bound HUD control was dead in flight.
   */
  it("fires for a SECOND pointer while a first one is held elsewhere", () => {
    const { el, fired, unbind } = bound();
    document.dispatchEvent(pointer("pointerdown", 1, 300, 300));
    el.dispatchEvent(pointer("pointerdown", 2, 20, 20));
    el.dispatchEvent(pointer("pointerup", 2, 20, 20));
    expect(fired).toHaveBeenCalledOnce();
    unbind();
  });

  it("ignores a release from a pointer that never pressed this control", () => {
    const { el, fired, unbind } = bound();
    el.dispatchEvent(pointer("pointerdown", 1, 20, 20));
    el.dispatchEvent(pointer("pointerup", 9, 20, 20));
    expect(fired).not.toHaveBeenCalled();
    unbind();
  });

  it("declines a DRAG: a thumb that slid across the button changed its mind", () => {
    const { el, fired, unbind } = bound();
    el.dispatchEvent(pointer("pointerdown", 1, 20, 20));
    el.dispatchEvent(pointer("pointerup", 1, 20 + TAP_MOVE_TOLERANCE_PX + 1, 20));
    expect(fired).not.toHaveBeenCalled();
    // Right at the tolerance is still a tap: a thumb never lands twice on the
    // same pixel, and a control that demanded it would feel broken.
    el.dispatchEvent(pointer("pointerdown", 2, 20, 20));
    el.dispatchEvent(pointer("pointerup", 2, 20 + TAP_MOVE_TOLERANCE_PX, 20));
    expect(fired).toHaveBeenCalledOnce();
    unbind();
  });

  it("drops the press on pointercancel", () => {
    const { el, fired, unbind } = bound();
    el.dispatchEvent(pointer("pointerdown", 1, 20, 20));
    el.dispatchEvent(pointer("pointercancel", 1, 20, 20));
    el.dispatchEvent(pointer("pointerup", 1, 20, 20));
    expect(fired).not.toHaveBeenCalled();
    unbind();
  });

  it("still answers the keyboard, and never twice for one pointer tap", () => {
    const { el, fired, unbind } = bound();
    // Enter/Space on a focused control: a click with no click count.
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 }));
    expect(fired).toHaveBeenCalledOnce();

    // A single-touch tap: pointer events AND the compatibility click that
    // follows them. One action.
    fired.mockClear();
    el.dispatchEvent(pointer("pointerdown", 1, 20, 20));
    el.dispatchEvent(pointer("pointerup", 1, 20, 20));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    expect(fired).toHaveBeenCalledOnce();
    unbind();
  });

  it("unbinds everything it bound", () => {
    const { el, fired, unbind } = bound();
    unbind();
    el.dispatchEvent(pointer("pointerdown", 1, 20, 20));
    el.dispatchEvent(pointer("pointerup", 1, 20, 20));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 }));
    expect(fired).not.toHaveBeenCalled();
  });
});
