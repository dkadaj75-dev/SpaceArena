import type { FlightHudLayout } from "./flightHudLayout.js";
import { formatHudDistance, roundedHudMeters } from "./SpeedReadout.js";

/**
 * Lock visualization (FLIGHT.md §4). Two separate things share this component
 * because they describe one mechanic:
 *
 *  - the **zone circle**, fixed at screen centre, whose radius is the honest
 *    projection of the sim's heading-relative lock cone under the live chase
 *    camera (computed by
 *    {@link import("./flightHudLayout.js").reticleRadiusPx} and pushed in via
 *    {@link setZone}) — an enemy drawn inside it is an enemy the sim considers
 *    inside `sensors.coneDeg`;
 *  - the **target bracket**, projected onto the ship the sim actually picked as
 *    the candidate, carrying `snapshot.lockProgress` as a ring and flipping to a
 *    distinct locked state when weapons come live.
 *
 * Purely presentational: it never decides what is locked. The sim owns that and
 * the snapshot reports it, so the HUD can never disagree with what will fire.
 */
export class LockReticle {
  /** Display-only unit→metre factor (theme.hud.metersPerUnit). */
  private metersPerUnit = 1;
  private readonly container: HTMLDivElement;
  private readonly zone: HTMLDivElement;
  private readonly bracket: HTMLDivElement;
  /** Lock-progress arc — its own node so the corner ticks can be a sibling. */
  private readonly ring: HTMLDivElement;
  private readonly distance: HTMLSpanElement;
  private readonly targetName: HTMLSpanElement;
  private readonly blocked: HTMLDivElement;
  private blockedRemainingMs = 0;
  private blockedFlashMs = 650;
  private showZone = true;

  private lastRadius = Number.NaN;
  private lastClamped: boolean | null = null;
  private lastX = Number.NaN;
  private lastY = Number.NaN;
  private lastRing = Number.NaN;
  private lastLocked: boolean | null = null;
  private lastVisible: boolean | null = null;
  private lastDistanceM = Number.NaN;
  private lastTargetName = "";

  constructor(root: HTMLElement, layout: FlightHudLayout) {
    this.container = document.createElement("div");
    this.container.className = "hud-reticle";
    const style = document.createElement("style");
    style.textContent = `
      .hud-reticle-distance {
        position: absolute;
        left: 50%;
        top: calc(100% + var(--hud-reticle-ring-stroke, 4px) + 6px);
        transform: translateX(-50%);
        color: var(--hud-primary, #39bfff);
        font-size: 0.625em;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
        letter-spacing: 0.08em;
        line-height: 1;
        white-space: nowrap;
        text-shadow: 0 0 calc(6px * var(--hud-glow)) var(--hud-bg, #0a0f1e);
      }
      .hud-reticle-bracket.locked .hud-reticle-distance {
        color: var(--hud-danger, #ff405c);
      }
      .hud-reticle-target-name {
        position: absolute;
        display: none;
        left: calc(100% + var(--hud-reticle-target-name-offset, 12px));
        top: 50%;
        transform: translateY(-50%);
        color: var(--hud-danger, #ff405c);
        font-size: var(--hud-reticle-target-name-size, 10px);
        font-weight: 600;
        letter-spacing: 0.12em;
        line-height: 1;
        white-space: nowrap;
        text-transform: uppercase;
        text-shadow: 0 0 calc(5px * var(--hud-glow)) var(--hud-bg, #0a0f1e);
      }
      .hud-reticle-bracket.locked .hud-reticle-target-name {
        display: block;
      }
    `;
    this.container.appendChild(style);

    this.zone = document.createElement("div");
    this.zone.className = "hud-reticle-zone";

    this.bracket = document.createElement("div");
    this.bracket.className = "hud-reticle-bracket";
    this.bracket.style.setProperty("--ring", "0");
    // Four L-shaped corner ticks (one masked box, no per-corner nodes) plus the
    // progress arc around them — the target-designator language, not a circle.
    const corners = document.createElement("div");
    corners.className = "corners";
    this.ring = document.createElement("div");
    this.ring.className = "ring";
    this.distance = document.createElement("span");
    this.distance.className = "hud-reticle-distance";
    this.targetName = document.createElement("span");
    this.targetName.className = "hud-reticle-target-name";
    this.bracket.append(corners, this.ring, this.distance, this.targetName);
    this.blocked = document.createElement("div");
    this.blocked.className = "hud-reticle-blocked";

    this.container.appendChild(this.zone);
    this.container.appendChild(this.bracket);
    this.container.appendChild(this.blocked);
    root.appendChild(this.container);

    this.applyLayout(layout);
  }

  /** Immediate local response to a trigger pull that the lock gate will reject. */
  flashNoLock(): void {
    this.blockedRemainingMs = this.blockedFlashMs;
    this.blocked.classList.remove("visible");
    // Force a fresh animation when pulls arrive close together.
    void this.blocked.offsetWidth;
    this.blocked.classList.add("visible");
  }

  updateFeedback(dtMs: number): void {
    if (this.blockedRemainingMs <= 0) return;
    this.blockedRemainingMs -= dtMs;
    if (this.blockedRemainingMs <= 0) this.blocked.classList.remove("visible");
  }

  /** Adopt a freshly resolved layout (theme hot-reload, rotation, resize). */
  applyLayout(layout: FlightHudLayout): void {
    this.metersPerUnit = layout.metersPerUnit;
    const px = `${layout.reticle.bracketSizePx}px`;
    this.bracket.style.width = px;
    this.bracket.style.height = px;
    this.bracket.style.setProperty("--hud-reticle-target-name-offset", `${layout.reticle.targetNameOffsetPx}px`);
    this.bracket.style.setProperty("--hud-reticle-target-name-size", `${layout.reticle.targetNameSizePx}px`);
    this.blocked.textContent = layout.reticle.blockedText;
    this.blockedFlashMs = layout.reticle.blockedFlashMs;
    this.showZone = layout.reticle.showZone;
    this.zone.classList.toggle("visible", this.showZone && this.lastVisible === true);
  }

  /**
   * Push the projected cone radius (CSS px). `clamped` means the cone is wider
   * than the camera can show, so the circle is a floor on the real zone rather
   * than its edge — marked in the DOM so the ring is never read as "the zone
   * ends here".
   */
  setZone(radiusPx: number, clamped: boolean): void {
    const rounded = Math.round(radiusPx);
    if (rounded !== this.lastRadius) {
      this.lastRadius = rounded;
      this.zone.style.width = `${rounded * 2}px`;
      this.zone.style.height = `${rounded * 2}px`;
    }
    if (clamped !== this.lastClamped) {
      this.lastClamped = clamped;
      this.zone.classList.toggle("clamped", clamped);
    }
  }

  /**
   * Place the bracket for this frame. `x`/`y` are CSS px inside the HUD root;
   * pass `visible: false` when there is no candidate or it did not project (off
   * screen / behind the camera). `progress` is `snapshot.lockProgress` (0..1).
   */
  update(
    visible: boolean,
    x: number,
    y: number,
    progress: number,
    locked: boolean,
    distanceUnits = 0,
    targetName?: string,
  ): void {
    if (visible !== this.lastVisible) {
      this.lastVisible = visible;
      this.bracket.classList.toggle("visible", visible);
      this.zone.classList.toggle("visible", visible && this.showZone);
    }
    if (!visible) return;

    const px = Math.round(x);
    const py = Math.round(y);
    if (px !== this.lastX || py !== this.lastY) {
      this.lastX = px;
      this.lastY = py;
      this.bracket.style.transform = `translate(${px}px, ${py}px) translate(-50%, -50%)`;
    }
    // Whole percent: the ring is a 100-step conic gradient, so finer values are
    // invisible and would only cost a style write per frame.
    const ring = Math.max(0, Math.min(100, Math.round(progress * 100)));
    if (ring !== this.lastRing) {
      this.lastRing = ring;
      this.bracket.style.setProperty("--ring", String(ring));
    }
    if (locked !== this.lastLocked) {
      this.lastLocked = locked;
      this.bracket.classList.toggle("locked", locked);
    }
    const name = locked ? (targetName?.trim() || "UNKNOWN").toUpperCase() : "";
    if (name !== this.lastTargetName) {
      this.lastTargetName = name;
      this.targetName.textContent = name;
    }
    const distanceM = roundedHudMeters(distanceUnits * this.metersPerUnit);
    if (distanceM !== this.lastDistanceM) {
      this.lastDistanceM = distanceM;
      this.distance.textContent = formatHudDistance(distanceM);
    }
  }

  dispose(): void {
    this.container.remove();
  }
}
