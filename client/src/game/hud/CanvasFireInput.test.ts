// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { CanvasFireInput } from "./CanvasFireInput.js";
import { RelativeSteerInput } from "./RelativeSteerInput.js";
import { resolveFlightHudLayout } from "./flightHudLayout.js";

function pointer(type: string, init: { id: number; button: number; movementX?: number }): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, {
    pointerId: init.id,
    pointerType: "mouse",
    button: init.button,
    clientX: 100,
    clientY: 100,
    movementX: init.movementX ?? 0,
    movementY: 0,
  });
  return event;
}

describe("CanvasFireInput", () => {
  it("holds LMB without disturbing an already-active RMB steer", () => {
    const root = document.createElement("div");
    const canvas = document.createElement("canvas");
    document.body.append(canvas, root);
    const layout = resolveFlightHudLayout(undefined, { width: 800, height: 600 });
    const steer = new RelativeSteerInput(root, canvas, layout);
    const fire = new CanvasFireInput(canvas);

    canvas.dispatchEvent(pointer("pointerdown", { id: 1, button: 2 }));
    document.dispatchEvent(pointer("pointermove", { id: 1, button: 2, movementX: 12 }));
    expect(steer.active).toBe(true);

    const press = pointer("pointerdown", { id: 1, button: 0 });
    canvas.dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true);
    expect(fire.held).toBe(true);
    expect(steer.active).toBe(true);

    canvas.dispatchEvent(pointer("pointerup", { id: 1, button: 0 }));
    expect(fire.held).toBe(false);
    expect(steer.active).toBe(true);
    fire.dispose();
    steer.dispose();
    canvas.remove();
    root.remove();
  });
});
