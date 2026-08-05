// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { HUD_CONTROL_ATTR } from "../inputGuards.js";
import { FireButton } from "./FireButton.js";
import { resolveFlightHudLayout } from "./flightHudLayout.js";

function pointer(type: string, pointerId: number): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { pointerId, pointerType: "touch", button: 0 });
  return event;
}

describe("FireButton", () => {
  it("maps press/release to a momentary fire flag and marks itself as a HUD control", () => {
    const root = document.createElement("div");
    const fire = new FireButton(
      root,
      resolveFlightHudLayout(undefined, { width: 400, height: 800 }),
    );
    const button = root.querySelector<HTMLElement>(".hud-fire-btn")!;
    expect(button.getAttribute(HUD_CONTROL_ATTR)).toBe("fire");
    expect(button.classList).toContain("hex-action");
    expect(root.querySelector(".hud-fire-ring")).not.toBeNull();
    expect(button.querySelector(".label")?.textContent).toBe("FIRE");
    expect(fire.held).toBe(false);

    button.dispatchEvent(pointer("pointerdown", 7));
    expect(fire.held).toBe(true);
    button.dispatchEvent(pointer("pointerup", 7));
    expect(fire.held).toBe(false);
    fire.dispose();
  });

  it("clears a held trigger when the release lands outside the button", () => {
    const root = document.createElement("div");
    const fire = new FireButton(root, resolveFlightHudLayout(undefined, { width: 400, height: 800 }));
    root.querySelector<HTMLElement>(".hud-fire-btn")!.dispatchEvent(pointer("pointerdown", 9));
    expect(fire.held).toBe(true);
    document.dispatchEvent(pointer("pointerup", 9));
    expect(fire.held).toBe(false);
    fire.dispose();
  });

  it.each([
    { width: 390, height: 740 },
    { width: 740, height: 390 },
  ])("keeps the circular ring concentric with the pointy hex at $width x $height", (viewport) => {
    const root = document.createElement("div");
    const layout = resolveFlightHudLayout(
      {
        hud: {
          scale: 1,
          flight: {
            fire: { radiusPx: 42, offsetXPx: 24, offsetYPx: 34, ringGapPx: 7 },
          },
          landscape: {
            scale: 0.85,
            flight: { fire: { radiusPx: 36, offsetXPx: 22, offsetYPx: 30 } },
          },
        },
      } as never,
      viewport,
    );
    const fire = new FireButton(root, layout);
    const button = root.querySelector<HTMLElement>(".hud-fire-btn")!;
    const ring = root.querySelector<HTMLElement>(".hud-fire-ring")!;
    const center = (el: HTMLElement) => ({
      x: Number.parseFloat(el.style.left) + Number.parseFloat(el.style.width) / 2,
      y: Number.parseFloat(el.style.top) + Number.parseFloat(el.style.height) / 2,
    });
    const buttonCenter = center(button);
    const ringCenter = center(ring);
    expect(Math.abs(ringCenter.x - buttonCenter.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(ringCenter.y - buttonCenter.y)).toBeLessThanOrEqual(1);
    expect(Number.parseFloat(ring.style.width) / 2).toBeCloseTo(
      layout.fire.radiusPx + layout.fire.ringGapPx,
      6,
    );
    fire.dispose();
  });

  it("removes the decorative circle when the theme disables its arc", () => {
    const root = document.createElement("div");
    const fire = new FireButton(
      root,
      resolveFlightHudLayout(
        { hud: { flight: { fire: { ringArcDeg: 0, ringStrokePx: 0 } } } } as never,
        { width: 400, height: 800 },
      ),
    );
    expect(root.querySelector<HTMLElement>(".hud-fire-ring")!.style.display).toBe("none");
    fire.dispose();
  });
});
