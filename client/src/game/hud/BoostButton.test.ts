// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { HUD_CONTROL_ATTR } from "../inputGuards.js";
import { BoostButton, BOOST_BLOCKED_TITLE, BOOST_LABEL, BOOST_SLOT_TYPE, type BoostButtonState } from "./BoostButton.js";
import { anchoredOffset, resolveFlightHudLayout } from "./flightHudLayout.js";
import { resolveSlotCluster } from "./slotCluster.js";

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

  /**
   * BOOST moved to the LEFT thumb with the rest of the utilitarian skills (owner
   * HUD pass, 2026-08-21) and wears the shared slot skin, so it is now one
   * circle of a cluster rather than a bespoke satellite of the FIRE pedestal.
   */
  it("takes its slot in the shared left cluster, sized like every other slot", () => {
    const { root, boost } = mount();
    const layout = resolveFlightHudLayout(undefined, PORTRAIT);
    const container = root.querySelector<HTMLElement>(".hud-boost")!;
    const button = root.querySelector<HTMLElement>(".hud-boost-btn")!;

    // Two utility slots: a deployable in 01, BOOST in 02.
    boost.applySlotLayout(layout, 2, 1);
    const cluster = resolveSlotCluster(2, "utilities", {
      viewport: layout.viewport,
      scale: layout.scale,
    });
    const slot = cluster.slots[1]!;
    const expected = anchoredOffset(slot.anchor, slot.offsetXPx, slot.offsetYPx, slot.sizePx / 2);

    expect(container.dataset["anchor"]).toBe("bottom-left");
    expect(button.dataset["slot"]).toBe("02");
    expect(button.querySelector(".slot-num")!.textContent).toBe("02");
    expect(button.querySelector(".slot-type")!.textContent).toBe(BOOST_SLOT_TYPE);
    // Same skin as the module slots — that is what makes the left thumb read as
    // one cluster and not three widgets that happen to be near each other.
    expect(button.classList).toContain("hud-slot-btn");
    expect(button.classList).toContain("hud-module-btn");
    expect(Number.parseFloat(button.style.width)).toBeCloseTo(slot.sizePx, 6);
    expect(Number.parseFloat(button.style.height)).toBeCloseTo(slot.sizePx, 6);
    // Grows right/up from the bottom-LEFT pivot.
    expect(Number.parseFloat(button.style.left)).toBeCloseTo(expected.dx - slot.sizePx / 2, 6);
    expect(Number.parseFloat(button.style.top)).toBeCloseTo(expected.dy - slot.sizePx / 2, 6);
    boost.dispose();
  });
});
