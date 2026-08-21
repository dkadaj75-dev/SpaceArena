import { HUD_CONTROL_ATTR } from "../inputGuards.js";
import { anchoredOffset, type FlightHudLayout } from "./flightHudLayout.js";
import { moduleIconSvg } from "./moduleIcons.js";
import { resolveSlotCluster, slotNumberLabel } from "./slotCluster.js";

export const JETTISON_LABEL = "JETTISON";

/** The TYPE word printed inside the slot circle. Short enough for a 44 px slot. */
export const JETTISON_SLOT_TYPE = "JETT";

export interface JettisonButtonState {
  /** A fitted countermeasure pod has authored a jettison block. */
  fitted: boolean;
  /** Seconds before the sim will accept another jettison. */
  cooldownSec: number;
  /** The authored cooldown, used to draw a truthful sweep. */
  cooldownTotalSec: number;
}

const ABSENT: JettisonButtonState = { fitted: false, cooldownSec: 0, cooldownTotalSec: 0 };

/** Dedicated action for a jettisonable fitted countermeasure pod. */
export class JettisonButton {
  private readonly container: HTMLDivElement;
  private readonly button: HTMLDivElement;
  private readonly ring: HTMLSpanElement;
  private readonly number: HTMLSpanElement;
  private state = ABSENT;
  private lastFitted: boolean | null = null;
  private lastCooldown: boolean | null = null;
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
    // Same shared slot skin as every other left-cluster control.
    this.button.className = "hud-jettison-btn hud-module-btn hud-slot-btn hex-action";
    this.button.setAttribute(HUD_CONTROL_ATTR, "jettison");
    this.button.setAttribute("role", "button");
    this.button.setAttribute("aria-label", JETTISON_LABEL);
    this.ring = document.createElement("span");
    this.ring.className = "ring";
    this.ring.setAttribute("aria-hidden", "true");
    this.number = document.createElement("span");
    this.number.className = "slot-num";
    this.number.setAttribute("aria-hidden", "true");
    const icon = document.createElement("span");
    icon.className = "icon";
    icon.innerHTML = moduleIconSvg("countermeasure");
    const type = document.createElement("span");
    type.className = "slot-type";
    type.textContent = JETTISON_SLOT_TYPE;
    type.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.className = "label sr-only";
    label.textContent = JETTISON_LABEL;
    this.button.append(this.ring, this.number, icon, type, label);
    this.container.append(this.button);
    root.appendChild(this.container);
    this.button.addEventListener("pointerdown", this.onPointerDown);
    this.button.addEventListener("pointerup", this.onPointerUp);
    this.button.addEventListener("pointercancel", this.onPointerUp);
    this.button.addEventListener("lostpointercapture", this.onPointerUp);
    this.applyLayout(layout);
  }

  applyLayout(layout: FlightHudLayout): void {
    this.applySlotLayout(layout, 1, 0);
  }

  /** Take one slot of the shared left cluster — see BoostButton.applySlotLayout. */
  applySlotLayout(layout: FlightHudLayout, utilityCount: number, slotIndex: number): void {
    const cluster = resolveSlotCluster(Math.max(1, utilityCount), "utilities", {
      viewport: layout.viewport,
      scale: layout.scale,
    });
    const slot = cluster.slots[Math.min(slotIndex, cluster.slots.length - 1)]!;
    const half = slot.sizePx / 2;
    this.container.dataset["anchor"] = slot.anchor;
    this.button.dataset["side"] = "utilities";
    this.button.dataset["slot"] = slotNumberLabel(slot.index + 1);
    this.number.textContent = slotNumberLabel(slot.index + 1);
    const { dx, dy } = anchoredOffset(slot.anchor, slot.offsetXPx, slot.offsetYPx, half);
    this.button.style.left = `${dx - half}px`;
    this.button.style.top = `${dy - half}px`;
    this.button.style.width = `${slot.sizePx}px`;
    this.button.style.height = `${slot.sizePx}px`;
    this.button.style.setProperty("--hud-slot-size", `${slot.sizePx}px`);
  }

  update(state: JettisonButtonState): void {
    this.state = state;
    if (state.fitted !== this.lastFitted) {
      this.container.hidden = !state.fitted;
      this.lastFitted = state.fitted;
    }
    if (!state.fitted) return;
    const onCooldown = state.cooldownSec > 0;
    if (onCooldown !== this.lastCooldown) {
      this.button.classList.toggle("disabled", onCooldown);
      if (onCooldown) this.button.setAttribute("aria-disabled", "true");
      else this.button.removeAttribute("aria-disabled");
      this.lastCooldown = onCooldown;
    }
    const ring = onCooldown && state.cooldownTotalSec > 0 ? Math.round((100 * state.cooldownSec) / state.cooldownTotalSec) : 0;
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
