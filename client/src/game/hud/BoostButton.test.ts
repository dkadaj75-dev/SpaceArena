// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { HUD_CONTROL_ATTR } from "../inputGuards.js";
import { BoostButton, BOOST_BLOCKED_TITLE, BOOST_LABEL, type BoostButtonState } from "./BoostButton.js";
import { resolveFlightHudLayout } from "./flightHudLayout.js";

function pointer(type: string, pointerId: number): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { pointerId, pointerType: "touch", button: 0 });
  return event;
}

const PORTRAIT = { width: 390, height: 740 };

function fitted(overrides: Partial<BoostButtonState> = {}): BoostButtonState {
  return {
    hardpointIndex: 3,
    active: false,
    energy: 0,
    energyCapacity: 0,
    blocked: false,
    ...overrides,
  };
}

function mount(): {
  root: HTMLElement;
  boost: BoostButton;
  toggle: ReturnType<typeof vi.fn>;
  button: () => HTMLElement;
} {
  const root = document.createElement("div");
  const toggle = vi.fn();
  const boost = new BoostButton(root, resolveFlightHudLayout(undefined, PORTRAIT), toggle);
  return { root, boost, toggle, button: () => root.querySelector<HTMLElement>(".hud-boost-btn")! };
}

/**
 * The tester report this control exists for: with a boost module fitted, the
 * touch HUD showed nothing but one more anonymous hex in the module cluster.
 * These pin the three things that made it useless — it must appear only when a
 * boost is fitted, it must go dead (visibly) while the ship carries a flag, and
 * a tap must reach the same `moduleToggle` order the Shift key sends.
 */
describe("BoostButton", () => {
  it("stays out of the HUD until the fitting actually has a boost module", () => {
    const { root, boost, button } = mount();
    const container = root.querySelector<HTMLElement>(".hud-boost")!;
    expect(container.hidden).toBe(true);

    boost.update({ hardpointIndex: null, active: false, energy: 0, energyCapacity: 0, blocked: false });
    expect(container.hidden).toBe(true);

    boost.update(fitted());
    expect(container.hidden).toBe(false);
    // Recognizable on its own terms: BOOST caption, boost glyph, its own class.
    expect(button().querySelector(".label")!.textContent).toBe(BOOST_LABEL);
    expect(button().querySelector(".icon svg")).not.toBeNull();
    expect(button().getAttribute(HUD_CONTROL_ATTR)).toBe("boost");
    expect(button().getAttribute("role")).toBe("button");

    // A respawn into a fitting without one takes the control away again.
    boost.update({ hardpointIndex: null, active: false, energy: 0, energyCapacity: 0, blocked: false });
    expect(container.hidden).toBe(true);
    boost.dispose();
  });

  it("toggles the fitted boost module's OWN hardpoint on tap", () => {
    const { boost, toggle, button } = mount();
    boost.update(fitted({ hardpointIndex: 5 }));

    button().dispatchEvent(pointer("pointerdown", 3));
    expect(toggle).toHaveBeenCalledWith(5);
    expect(button().classList).toContain("pressed");
    button().dispatchEvent(pointer("pointerup", 3));
    expect(button().classList).not.toContain("pressed");

    // A second tap toggles again — the module's state, not the widget, latches.
    button().dispatchEvent(pointer("pointerdown", 4));
    expect(toggle).toHaveBeenCalledTimes(2);
    boost.dispose();
  });

  it("emits nothing while the ship carries the flag, and says so instead of hiding", () => {
    const { root, boost, toggle, button } = mount();
    boost.update(fitted({ blocked: true }));

    expect(root.querySelector<HTMLElement>(".hud-boost")!.hidden).toBe(false);
    expect(button().classList).toContain("disabled");
    expect(button().getAttribute("aria-disabled")).toBe("true");
    expect(button().getAttribute("title")).toBe(BOOST_BLOCKED_TITLE);

    button().dispatchEvent(pointer("pointerdown", 9));
    expect(toggle).not.toHaveBeenCalled();
    button().dispatchEvent(pointer("pointerup", 9));

    // Capping the flag hands the control straight back.
    boost.update(fitted({ blocked: false }));
    expect(button().classList).not.toContain("disabled");
    expect(button().hasAttribute("aria-disabled")).toBe(false);
    button().dispatchEvent(pointer("pointerdown", 10));
    expect(toggle).toHaveBeenCalledWith(3);
    boost.dispose();
  });

  it("reflects active and module-local energy straight off replication", () => {
    const { boost, button } = mount();
    boost.update(fitted());
    expect(button().classList).not.toContain("active");
    expect(button().getAttribute("aria-pressed")).toBe("false");

    boost.update(fitted({ active: true, energy: 36.8, energyCapacity: 60 }));
    expect(button().classList).toContain("active");
    expect(button().getAttribute("aria-pressed")).toBe("true");
    expect(button().classList).toContain("ring-energy");
    expect(button().style.getPropertyValue("--ring")).toBe("61");

    // Out-of-range energy is clamped rather than spilling out of the ring.
    boost.update(fitted({ energy: 140, energyCapacity: 100 }));
    expect(button().style.getPropertyValue("--ring")).toBe("100");

    boost.update(fitted({ energy: 0, energyCapacity: 0 }));
    expect(button().classList).not.toContain("ring-energy");
    expect(button().querySelector<HTMLElement>(".ring")!.hidden).toBe(true);

    // Death / match end drops the fitting so a stale control cannot be tapped.
    boost.clear();
    expect(button().classList).not.toContain("ring-energy");
    boost.dispose();
  });

  it("sizes and places itself entirely from the resolved boost layout", () => {
    const { root, boost } = mount();
    const layout = resolveFlightHudLayout(undefined, PORTRAIT);
    const container = root.querySelector<HTMLElement>(".hud-boost")!;
    const button = root.querySelector<HTMLElement>(".hud-boost-btn")!;

    // The authored slot keeps BOOST with FIRE and the other right-thumb actions.
    expect(layout.fire.anchor).toBe("bottom-right");
    expect(container.dataset["anchor"]).toBe("bottom-right");
    expect(Number.parseFloat(button.style.width)).toBeCloseTo(layout.boost.radiusPx * 2, 6);
    expect(Number.parseFloat(button.style.height)).toBeCloseTo(layout.boost.radiusPx * 2, 6);
    // Grows left/up from the bottom-right pivot.
    expect(Number.parseFloat(button.style.left)).toBeCloseTo(-(layout.boost.offsetXPx + layout.boost.radiusPx * 2), 6);
    expect(Number.parseFloat(button.style.top)).toBeCloseTo(
      -(layout.boost.offsetYPx + layout.boost.radiusPx * 2),
      6,
    );
    boost.dispose();
  });
});
