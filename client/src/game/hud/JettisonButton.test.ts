// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { HUD_CONTROL_ATTR } from "../inputGuards.js";
import { JettisonButton, JETTISON_LABEL } from "./JettisonButton.js";
import { resolveFlightHudLayout } from "./flightHudLayout.js";

function pointer(type: string, pointerId: number): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { pointerId, pointerType: "touch", button: 0 });
  return event;
}

describe("JettisonButton", () => {
  it("only appears for a jettisonable sink, orders once, and follows its cooldown sweep", () => {
    const root = document.createElement("div");
    const jettison = vi.fn();
    const widget = new JettisonButton(root, resolveFlightHudLayout(undefined, { width: 390, height: 740 }), jettison);
    const container = root.querySelector<HTMLElement>(".hud-jettison")!;
    const button = root.querySelector<HTMLElement>(".hud-jettison-btn")!;
    expect(container.hidden).toBe(true);

    widget.update({ fitted: true, cooldownSec: 0, cooldownTotalSec: 25 });
    expect(container.hidden).toBe(false);
    expect(button.querySelector(".label")!.textContent).toBe(JETTISON_LABEL);
    expect(button.getAttribute(HUD_CONTROL_ATTR)).toBe("jettison");
    button.dispatchEvent(pointer("pointerdown", 1));
    expect(jettison).toHaveBeenCalledOnce();
    button.dispatchEvent(pointer("pointerup", 1));

    widget.update({ fitted: true, cooldownSec: 12.5, cooldownTotalSec: 25 });
    expect(button.classList).toContain("disabled");
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.style.getPropertyValue("--ring")).toBe("50");
    button.dispatchEvent(pointer("pointerdown", 2));
    expect(jettison).toHaveBeenCalledOnce();
    widget.dispose();
  });
});
