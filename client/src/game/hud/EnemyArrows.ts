import { HUD_CONTROL_ATTR } from "../inputGuards.js";
import {
  arrowOpacity,
  offScreenArrowPlacement,
  type ArrowPlacement,
  type FlightHudLayout,
  type ProjectedPoint,
} from "./flightHudLayout.js";
import { formatHudDistance, roundedHudMeters } from "./SpeedReadout.js";

/** One pooled arrow node plus its last-written values (DOM writes only on change). */
interface ArrowSlot {
  el: HTMLDivElement;
  glyph: HTMLDivElement;
  distance: HTMLSpanElement;
  lastX: number;
  lastY: number;
  lastDeg: number;
  lastDistanceM: number;
  lastOpacity: number;
  lastCandidate: boolean | null;
  visible: boolean;
}

/**
 * Off-screen enemy direction arrows (BUBBLE.md §C) — the bubble's headline HUD
 * feature. On the ground plane an enemy that left the frame was always somewhere
 * along the screen's left or right edge; in a bubble it can be above, below or
 * straight behind, and a pilot with no cue simply loses it.
 *
 * Same shape as {@link import("./ModuleButtons.js").ModuleButtons}: it owns its
 * DOM, is tagged {@link HUD_CONTROL_ATTR}, takes every dimension from the
 * resolved theme layout, and only touches the DOM when a value actually changed.
 *
 * Allocation discipline: the node pool is built ONCE at `maxCount` and reused
 * forever (this runs every frame with one entry per enemy ship), the placement
 * math writes into a single scratch object, and the caller drives it with a
 * plain indexed loop — see {@link begin} / {@link place} / {@link finish}.
 *
 * Tints are the reticle's own custom properties rather than new theme fields:
 * `--hud-danger` for a plain enemy and `--hud-primary` for the current lock
 * candidate, so re-painting the lock visuals re-paints the arrows with them.
 */
export class EnemyArrows {
  private readonly container: HTMLDivElement;
  private readonly slots: ArrowSlot[] = [];
  private layout: FlightHudLayout;
  /** Per-frame scratch — nothing here allocates. */
  private readonly placement: ArrowPlacement = { x: 0, y: 0, rotationRad: 0 };
  /** How many slots the current frame has claimed so far. */
  private used = 0;

  constructor(root: HTMLElement, layout: FlightHudLayout) {
    this.layout = layout;

    this.container = document.createElement("div");
    this.container.className = "hud-enemy-arrows";
    const style = document.createElement("style");
    style.textContent = `
      .hud-enemy-arrow {
        overflow: visible;
        clip-path: none;
        background: transparent;
        filter: none;
      }
      .hud-enemy-arrow.candidate {
        background: transparent;
        filter: none;
      }
      .hud-enemy-arrow-glyph {
        position: absolute;
        inset: 0;
        clip-path: polygon(0% 0%, 100% 50%, 0% 100%, 0% 72%, 55% 50%, 0% 28%);
        background: var(--hud-danger, #ff405c);
        filter: drop-shadow(0 0 calc(5px * var(--hud-glow)) var(--hud-danger, #ff405c));
      }
      .hud-enemy-arrow.candidate .hud-enemy-arrow-glyph {
        background: var(--hud-primary, #39bfff);
        filter: drop-shadow(0 0 calc(6px * var(--hud-glow)) var(--hud-primary, #39bfff));
      }
      .hud-enemy-arrow-distance {
        position: absolute;
        left: 50%;
        top: calc(100% + 2px);
        transform: translateX(-50%);
        color: var(--hud-danger, #ff405c);
        font-size: 0.5625em;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
        letter-spacing: 0.06em;
        line-height: 1;
        white-space: nowrap;
        text-shadow: 0 0 calc(5px * var(--hud-glow)) var(--hud-bg, #0a0f1e);
      }
      .hud-enemy-arrow.candidate .hud-enemy-arrow-distance {
        color: var(--hud-primary, #39bfff);
      }
    `;
    this.container.appendChild(style);
    root.appendChild(this.container);

    this.buildPool(layout.enemyArrows.maxCount);
  }

  /**
   * Adopt a freshly resolved layout (theme hot-reload, rotation, resize). The
   * pool only ever GROWS: `maxCount` is a ceiling on live arrows, and rebuilding
   * it downward mid-match would churn DOM nodes for nothing.
   */
  applyLayout(layout: FlightHudLayout): void {
    this.layout = layout;
    this.buildPool(layout.enemyArrows.maxCount);
    // Geometry moved under every arrow; the next frame re-places the live ones
    // and this hides whatever is currently parked at a stale position.
    this.begin();
    this.finish();
  }

  private buildPool(count: number): void {
    for (let i = this.slots.length; i < count; i++) {
      const el = document.createElement("div");
      el.className = "hud-enemy-arrow";
      el.setAttribute(HUD_CONTROL_ATTR, "enemy-arrow");
      el.setAttribute("aria-hidden", "true");
      const glyph = document.createElement("div");
      glyph.className = "hud-enemy-arrow-glyph";
      const distance = document.createElement("span");
      distance.className = "hud-enemy-arrow-distance";
      el.append(glyph, distance);
      this.container.appendChild(el);
      this.slots.push({
        el,
        glyph,
        distance,
        lastX: Number.NaN,
        lastY: Number.NaN,
        lastDeg: Number.NaN,
        lastDistanceM: Number.NaN,
        lastOpacity: Number.NaN,
        lastCandidate: null,
        visible: false,
      });
    }
  }

  /** Start a frame: the next {@link place} call claims the first slot again. */
  begin(): void {
    this.used = 0;
  }

  /**
   * Place an arrow for one enemy, if it needs one. `point` is that enemy's
   * projected position (see {@link ProjectedPoint}), `distanceUnits` its 3D
   * distance from the player (drives the fade) and `candidate` whether it is the
   * sim's current lock candidate (drives the tint).
   *
   * Returns false when nothing was drawn — either the enemy is comfortably on
   * screen or the pool ceiling is already spent this frame. Enemies are offered
   * in whatever order the snapshot lists them, so a ceiling below the ship count
   * drops the tail of that list; `maxCount` is meant to be sized for the arena.
   */
  place(point: ProjectedPoint, distanceUnits: number, candidate: boolean): boolean {
    const arrows = this.layout.enemyArrows;
    if (!arrows.enabled || this.used >= this.slots.length) return false;
    if (!offScreenArrowPlacement(point, this.layout.viewport, arrows, this.placement)) return false;

    const slot = this.slots[this.used]!;
    this.used += 1;
    this.write(slot, this.placement, distanceUnits, arrowOpacity(distanceUnits, arrows), candidate);
    return true;
  }

  /** End a frame: hide every slot the frame did not claim. */
  finish(): void {
    for (let i = this.used; i < this.slots.length; i++) {
      const slot = this.slots[i]!;
      if (!slot.visible) continue;
      slot.visible = false;
      slot.el.classList.remove("visible");
    }
  }

  /** Live arrow count — debug overlays and tests. */
  get visibleCount(): number {
    return this.used;
  }

  /** Hide everything at once (the controls being disarmed, a dead player). */
  clear(): void {
    this.begin();
    this.finish();
  }

  private write(
    slot: ArrowSlot,
    at: ArrowPlacement,
    distanceUnits: number,
    opacity: number,
    candidate: boolean,
  ): void {
    if (!slot.visible) {
      slot.visible = true;
      slot.el.classList.add("visible");
    }
    // Whole px + whole degrees: finer values are invisible at this size and
    // would cost a style write on every frame of a slow sweep.
    const x = Math.round(at.x);
    const y = Math.round(at.y);
    const deg = Math.round((at.rotationRad * 180) / Math.PI);
    if (x !== slot.lastX || y !== slot.lastY) {
      slot.lastX = x;
      slot.lastY = y;
      slot.el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
    }
    if (deg !== slot.lastDeg) {
      slot.lastDeg = deg;
      slot.glyph.style.transform = `rotate(${deg}deg)`;
    }
    const distanceM = roundedHudMeters(distanceUnits);
    if (distanceM !== slot.lastDistanceM) {
      slot.lastDistanceM = distanceM;
      slot.distance.textContent = formatHudDistance(distanceM);
    }
    const alpha = Math.round(opacity * 100) / 100;
    if (alpha !== slot.lastOpacity) {
      slot.lastOpacity = alpha;
      slot.el.style.opacity = String(alpha);
    }
    if (candidate !== slot.lastCandidate) {
      slot.lastCandidate = candidate;
      slot.el.classList.toggle("candidate", candidate);
    }
  }

  dispose(): void {
    this.slots.length = 0;
    this.container.remove();
  }
}
