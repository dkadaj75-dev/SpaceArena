import { HUD_CONTROL_ATTR } from "../inputGuards.js";
import { anchoredOffset, type FlightHudLayout } from "./flightHudLayout.js";
import { iconIdFromRef, moduleIconSvg } from "./moduleIcons.js";

/** Theme-placed, momentary mobile FIRE control (COMBAT-REWORK.md §8). */
export class FireButton {
  private readonly container: HTMLDivElement;
  private readonly ring: HTMLSpanElement;
  private readonly button: HTMLDivElement;
  private readonly label: HTMLSpanElement;
  private pointerId: number | null = null;
  private lastIconRef: string | null = null;

  private readonly onPointerDown = (ev: PointerEvent): void => {
    if (this.pointerId !== null) return;
    this.pointerId = ev.pointerId;
    // WebKit can reject capture during transient DOM/layout changes. Capture is
    // an optimisation, not correctness: document-level release listeners below
    // are the backstop that prevents a level-triggered FIRE order sticking true.
    try { this.button.setPointerCapture?.(ev.pointerId); } catch { /* release fallback remains armed */ }
    this.button.classList.add("active");
    ev.preventDefault();
  };

  private readonly onPointerUp = (ev: PointerEvent): void => {
    if (ev.pointerId !== this.pointerId) return;
    this.pointerId = null;
    try { this.button.releasePointerCapture?.(ev.pointerId); } catch { /* already released by the UA */ }
    this.button.classList.remove("active");
  };

  constructor(root: HTMLElement, layout: FlightHudLayout) {
    this.container = document.createElement("div");
    this.container.className = "hud-fire";

    this.button = document.createElement("div");
    this.button.className = "hud-fire-btn hex-action";
    this.button.setAttribute(HUD_CONTROL_ATTR, "fire");
    this.button.setAttribute("role", "button");
    this.button.setAttribute("aria-label", "Fire");
    this.ring = document.createElement("span");
    this.ring.className = "hud-fire-ring";
    this.ring.setAttribute("aria-hidden", "true");
    this.label = document.createElement("span");
    this.label.className = "label";
    this.button.append(this.label);
    this.container.append(this.ring, this.button);
    root.appendChild(this.container);

    this.button.addEventListener("pointerdown", this.onPointerDown);
    this.button.addEventListener("pointerup", this.onPointerUp);
    this.button.addEventListener("pointercancel", this.onPointerUp);
    this.button.addEventListener("lostpointercapture", this.onPointerUp);
    document.addEventListener("pointerup", this.onPointerUp);
    document.addEventListener("pointercancel", this.onPointerUp);
    this.applyLayout(layout);
  }

  applyLayout(layout: FlightHudLayout): void {
    const fire = layout.fire;
    this.container.dataset["anchor"] = fire.anchor;
    const { dx, dy } = anchoredOffset(fire.anchor, fire.offsetXPx, fire.offsetYPx, fire.radiusPx);
    this.button.style.left = `${dx - fire.radiusPx}px`;
    this.button.style.top = `${dy - fire.radiusPx}px`;
    this.button.style.width = `${fire.radiusPx * 2}px`;
    this.button.style.height = `${fire.radiusPx * 2}px`;
    const ringRadius = fire.radiusPx + fire.ringGapPx;
    this.ring.style.left = `${dx - ringRadius}px`;
    this.ring.style.top = `${dy - ringRadius}px`;
    this.ring.style.width = `${ringRadius * 2}px`;
    this.ring.style.height = `${ringRadius * 2}px`;
    this.ring.style.display = fire.ringArcDeg > 0 && fire.ringStrokePx > 0 ? "" : "none";
    this.renderIcon(fire.icon);
  }

  private renderIcon(ref: string): void {
    if (ref === this.lastIconRef) return;
    this.lastIconRef = ref;
    const id = iconIdFromRef(ref);
    if (id) this.label.innerHTML = moduleIconSvg(id);
    else this.label.textContent = ref;
  }

  get held(): boolean {
    return this.pointerId !== null;
  }

  setKeyActive(active: boolean): void {
    if (this.pointerId !== null) return;
    this.button.classList.toggle("active", active);
  }

  setEnabled(enabled: boolean): void {
    if (enabled || this.pointerId === null) return;
    this.pointerId = null;
    this.button.classList.remove("active");
  }

  dispose(): void {
    this.button.removeEventListener("pointerdown", this.onPointerDown);
    this.button.removeEventListener("pointerup", this.onPointerUp);
    this.button.removeEventListener("pointercancel", this.onPointerUp);
    this.button.removeEventListener("lostpointercapture", this.onPointerUp);
    document.removeEventListener("pointerup", this.onPointerUp);
    document.removeEventListener("pointercancel", this.onPointerUp);
    this.container.remove();
  }
}
