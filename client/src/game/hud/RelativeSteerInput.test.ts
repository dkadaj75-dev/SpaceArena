// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { HUD_CONTROL_ATTR } from "../inputGuards.js";
import { resolveFlightHudLayout } from "./flightHudLayout.js";
import { RelativeSteerInput, startsOnHudControl } from "./RelativeSteerInput.js";

function pointer(
  type: string,
  init: {
    id: number;
    pointerType: "mouse" | "touch";
    button?: number;
    x?: number;
    y?: number;
    movementX?: number;
    movementY?: number;
  },
): Event {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(ev, {
    pointerId: init.id,
    pointerType: init.pointerType,
    button: init.button ?? 0,
    clientX: init.x ?? 0,
    clientY: init.y ?? 0,
    movementX: init.movementX ?? 0,
    movementY: init.movementY ?? 0,
  });
  return ev;
}

function mount() {
  const root = document.createElement("div");
  const canvas = document.createElement("canvas");
  document.body.append(canvas, root);
  const input = new RelativeSteerInput(root, canvas, resolveFlightHudLayout(undefined, { width: 800, height: 600 }));
  return { root, canvas, input };
}

describe("RelativeSteerInput", () => {
  it("accumulates RMB mouse deltas and recentres both axes on release", () => {
    const { canvas, input } = mount();
    canvas.dispatchEvent(pointer("pointerdown", { id: 1, pointerType: "mouse", button: 2, x: 100, y: 100 }));
    document.dispatchEvent(pointer("pointermove", { id: 1, pointerType: "mouse", x: 110, y: 95, movementX: 10, movementY: -5 }));
    const firstTurn = input.turn;
    expect(input.active).toBe(true);
    expect(Math.abs(firstTurn)).toBeGreaterThan(0);
    expect(input.pitchStick).toBeGreaterThan(0);
    document.dispatchEvent(pointer("pointermove", { id: 1, pointerType: "mouse", x: 120, y: 90, movementX: 10, movementY: -5 }));
    expect(Math.abs(input.turn)).toBeGreaterThan(Math.abs(firstTurn));
    document.dispatchEvent(pointer("pointerup", { id: 1, pointerType: "mouse" }));
    expect(input.active).toBe(false);
    expect(input.turn).toBe(0);
    expect(input.pitchStick).toBe(0);
    input.dispose();
    canvas.remove();
  });

  it("rejects touch origins on HUD controls but accepts a free-area origin", () => {
    const { root, canvas, input } = mount();
    const button = document.createElement("button");
    button.setAttribute(HUD_CONTROL_ATTR, "throttle");
    root.append(button);
    expect(startsOnHudControl(button)).toBe(true);
    button.dispatchEvent(pointer("pointerdown", { id: 2, pointerType: "touch", x: 20, y: 20 }));
    expect(input.active).toBe(false);

    canvas.dispatchEvent(pointer("pointerdown", { id: 3, pointerType: "touch", x: 100, y: 100 }));
    document.dispatchEvent(pointer("pointermove", { id: 3, pointerType: "touch", x: 150, y: 60 }));
    expect(input.active).toBe(true);
    expect(Math.abs(input.turn)).toBeGreaterThan(0);
    expect(input.pitchStick).toBeGreaterThan(0);
    document.dispatchEvent(pointer("pointercancel", { id: 3, pointerType: "touch" }));
    expect(input.turn).toBe(0);
    input.dispose();
    canvas.remove();
  });
});
