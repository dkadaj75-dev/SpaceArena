import { HUD_CONTROL_ATTR } from "../inputGuards.js";
import { anchoredOffset, type FlightHudLayout } from "./flightHudLayout.js";
import { moduleIconSvg } from "./moduleIcons.js";

export const JETTISON_LABEL = "JETTISON";

export interface JettisonButtonState {
  /** A fitted heatsink has authored a jettison block. */
  fitted: boolean;
  /** Seconds before the sim will accept another jettison. */
  cooldownSec: number;
  /** The authored cooldown, used to draw a truthful sweep. */
  cooldownTotalSec: number;
}

const ABSENT: JettisonButtonState = { fitted: false, cooldownSec: 0, cooldownTotalSec: 0 };

/** Dedicated action for a jettisonable fitted heatsink. */
export class JettisonButton {
  private readonly container: HTMLDivElement;
  private readonly button: HTMLDivElement;
  private readonly ring: HTMLSpanElement;
  private state = ABSENT;
  private lastFitted: boolean | null = null;
  private lastCooling: boolean | null = null;
  private lastRing = -1;
  private pointerId: number | null = null;

  private readonly onPointerDown = (ev: PointerEvent): void => {
    if (this.pointerId !== null) return;
    this.pointerId = ev.pointerId;
    this.button.setPointerCapture?.(ev.pointerId);
    this.button.classList.add("pressed");
    ev.preventDefault();
    if (this.state.fitted && this.state.cooldownSec <= 0) this.onJettison();
  };
  private readonly onPointerUp = (ev: PointerEvent): void => {
    if (ev.pointerId !== this.pointerId) return;
    this.pointerId = null;
    this.button.releasePointerCapture?.(ev.pointerId);
    this.button.classList.remove("pressed");
  };

  constructor(root: HTMLElement, layout: FlightHudLayout, private readonly onJettison: () => void) {
    this.container = document.createElement("div");
    this.container.className = "hud-jettison";
    this.container.hidden = true;
    this.button = document.createElement("div");
    this.button.className = "hud-jettison-btn hex-action";
    this.button.setAttribute(HUD_CONTROL_ATTR, "jettison");
    this.button.setAttribute("role", "button");
    this.button.setAttribute("aria-label", JETTISON_LABEL);
    this.ring = document.createElement("span");
    this.ring.className = "ring";
    this.ring.setAttribute("aria-hidden", "true");
    const icon = document.createElement("span");
    icon.className = "icon";
    icon.innerHTML = moduleIconSvg("heat-sink");
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = JETTISON_LABEL;
    this.button.append(this.ring, icon, label);
    this.container.append(this.button);
    root.appendChild(this.container);
    this.button.addEventListener("pointerdown", this.onPointerDown);
    this.button.addEventListener("pointerup", this.onPointerUp);
    this.button.addEventListener("pointercancel", this.onPointerUp);
    this.button.addEventListener("lostpointercapture", this.onPointerUp);
    this.applyLayout(layout);
  }

  applyLayout(layout: FlightHudLayout): void {
    const action = layout.jettison;
    this.container.dataset["anchor"] = action.anchor;
    const { dx, dy } = anchoredOffset(action.anchor, action.offsetXPx, action.offsetYPx, action.radiusPx);
    this.button.style.left = `${dx - action.radiusPx}px`;
    this.button.style.top = `${dy - action.radiusPx}px`;
    this.button.style.width = `${action.radiusPx * 2}px`;
    this.button.style.height = `${action.radiusPx * 2}px`;
  }

  update(state: JettisonButtonState): void {
    this.state = state;
    if (state.fitted !== this.lastFitted) {
      this.container.hidden = !state.fitted;
      this.lastFitted = state.fitted;
    }
    if (!state.fitted) return;
    const cooling = state.cooldownSec > 0;
    if (cooling !== this.lastCooling) {
      this.button.classList.toggle("disabled", cooling);
      if (cooling) this.button.setAttribute("aria-disabled", "true");
      else this.button.removeAttribute("aria-disabled");
      this.lastCooling = cooling;
    }
    const ring = cooling && state.cooldownTotalSec > 0 ? Math.round((100 * state.cooldownSec) / state.cooldownTotalSec) : 0;
    if (ring !== this.lastRing) {
      this.button.style.setProperty("--ring", String(Math.max(0, Math.min(100, ring))));
      this.lastRing = ring;
    }
  }

  clear(): void { this.pointerId = null; this.button.classList.remove("pressed"); this.update(ABSENT); }
  dispose(): void {
    this.button.removeEventListener("pointerdown", this.onPointerDown);
    this.button.removeEventListener("pointerup", this.onPointerUp);
    this.button.removeEventListener("pointercancel", this.onPointerUp);
    this.button.removeEventListener("lostpointercapture", this.onPointerUp);
    this.container.remove();
  }
}
