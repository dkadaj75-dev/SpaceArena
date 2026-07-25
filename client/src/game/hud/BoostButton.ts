import { HUD_CONTROL_ATTR } from "../inputGuards.js";
import { anchoredOffset, type FlightHudLayout } from "./flightHudLayout.js";

/**
 * Hold-to-boost button (FLIGHT.md §4), parked in the module-cluster corner so
 * the thumb that works the modules also works the afterburner. Momentary, not a
 * toggle: `boost` is true for exactly as long as a pointer is down, which is what
 * makes the sim's energy/heat cost feel like a decision rather than a mode.
 *
 * Same component contract as {@link import("./ModuleButtons.js").ModuleButtons}:
 * own DOM, {@link HUD_CONTROL_ATTR} so palm rejection exempts it, geometry from
 * the resolved theme layout.
 */
export class BoostButton {
  private readonly container: HTMLDivElement;
  private readonly button: HTMLDivElement;
  private layout: FlightHudLayout;

  private pointerId: number | null = null;

  private readonly onPointerDown = (ev: PointerEvent): void => {
    if (this.pointerId !== null) return;
    this.pointerId = ev.pointerId;
    this.button.setPointerCapture?.(ev.pointerId);
    this.button.classList.add("active");
    ev.preventDefault();
  };

  private readonly onPointerUp = (ev: PointerEvent): void => {
    if (ev.pointerId !== this.pointerId) return;
    this.pointerId = null;
    this.button.releasePointerCapture?.(ev.pointerId);
    this.button.classList.remove("active");
  };

  constructor(root: HTMLElement, layout: FlightHudLayout) {
    this.layout = layout;

    this.container = document.createElement("div");
    this.container.className = "hud-boost";

    this.button = document.createElement("div");
    this.button.className = "hud-boost-btn";
    this.button.setAttribute(HUD_CONTROL_ATTR, "boost");
    this.button.setAttribute("aria-label", "Boost");
    this.container.appendChild(this.button);
    root.appendChild(this.container);

    this.button.addEventListener("pointerdown", this.onPointerDown);
    this.button.addEventListener("pointerup", this.onPointerUp);
    this.button.addEventListener("pointercancel", this.onPointerUp);
    this.button.addEventListener("lostpointercapture", this.onPointerUp);

    this.applyLayout(layout);
  }

  /** Adopt a freshly resolved layout (theme hot-reload, rotation, resize). */
  applyLayout(layout: FlightHudLayout): void {
    this.layout = layout;
    const b = layout.boost;
    this.container.dataset["anchor"] = b.anchor;
    const { dx, dy } = anchoredOffset(b.anchor, b.offsetXPx, b.offsetYPx, b.radiusPx);
    this.button.style.left = `${dx - b.radiusPx}px`;
    this.button.style.top = `${dy - b.radiusPx}px`;
    if (this.button.textContent !== b.icon) this.button.textContent = b.icon;
  }

  /** True while a pointer is held on the button. */
  get held(): boolean {
    return this.pointerId !== null;
  }

  /**
   * Reflect a boost that the KEYBOARD is driving (Shift), so the button lights up
   * for the same state the ship is in. Never changes {@link held} — the two
   * sources are OR-ed by the caller.
   */
  setKeyActive(active: boolean): void {
    if (this.pointerId !== null) return;
    this.button.classList.toggle("active", active);
  }

  dispose(): void {
    this.button.removeEventListener("pointerdown", this.onPointerDown);
    this.button.removeEventListener("pointerup", this.onPointerUp);
    this.button.removeEventListener("pointercancel", this.onPointerUp);
    this.button.removeEventListener("lostpointercapture", this.onPointerUp);
    this.container.remove();
  }
}
