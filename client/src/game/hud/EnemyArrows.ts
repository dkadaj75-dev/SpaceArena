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
  marker: HTMLDivElement;
  distance: HTMLSpanElement;
  lastX: number;
  lastY: number;
  lastDeg: number;
  lastDistanceM: number;
  lastOpacity: number;
  lastCandidate: boolean | null;
  lastMarker: boolean | null;
  lastScale: number;
  lastFriendly: boolean | null;
  /** Objective slot appearance; enemy slots retain the regular chevron. */
  kind: "enemy" | "flag" | "base";
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
 * Allocation discipline: an enemy pool at `maxCount` plus two reserved flag
 * slots and two reserved base slots are built ONCE and reused forever. The placement math writes
 * into a single scratch object, and the caller drives it with a plain indexed
 * loop — see {@link begin} / {@link place} / {@link finish}.
 *
 * Tints are the reticle's own custom properties rather than new theme fields:
 * `--hud-danger` for a plain enemy — off-screen chevron and in-view contact
 * diamond alike — and `--hud-primary` for the current lock candidate, so
 * re-painting the lock visuals re-paints the arrows with them. Objectives
 * (flags, bases) instead take the primary tint when they are the player's own,
 * which is the same rule read from the other side: blue is mine, red is theirs.
 */
export class EnemyArrows {
  private readonly container: HTMLDivElement;
  private readonly slots: ArrowSlot[] = [];
  /** Objectives have reserved nodes, so enemy count can never hide a flag. */
  private readonly flagSlots: ArrowSlot[] = [];
  /** Bases have their own reservation, independent of both flags and ships. */
  private readonly baseSlots: ArrowSlot[] = [];
  private layout: FlightHudLayout;
  /** Per-frame scratch — nothing here allocates. */
  private readonly placement: ArrowPlacement = { x: 0, y: 0, rotationRad: 0 };
  /** How many slots the current frame has claimed so far. */
  private used = 0;
  private flagUsed = 0;
  private baseUsed = 0;

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
        background: var(--hud-danger, var(--sa-red-500));
        filter: drop-shadow(0 0 calc(5px * var(--hud-glow)) var(--hud-danger, var(--sa-red-500)));
      }
      /* The in-view contact diamond. Enemy is RED, like every other threat cue
         on the board (arrows, damage values, enemy shield bubbles) — it read as
         a friendly blue pip before, which is the one thing a contact marker
         must never say. The faintness is unchanged and comes from the slot's
         opacity (markerMinOpacity / outOfRangeOpacity), NOT from the tint:
         these stay quiet without lying about whose they are. */
      .hud-enemy-marker-glyph {
        position: absolute;
        left: 50%;
        top: 50%;
        display: none;
        box-sizing: border-box;
        border: 1.25px solid var(--hud-danger, var(--sa-red-500));
        background: transparent;
        transform: translate(-50%, -50%) rotate(45deg);
        filter: drop-shadow(0 0 calc(3px * var(--hud-glow)) var(--hud-danger, var(--sa-red-500)));
      }
      /* The lock candidate keeps the primary tint its chevron and reticle use,
         so "the one I am locking" stays distinct from "a contact". */
      .hud-enemy-arrow.candidate .hud-enemy-marker-glyph {
        border-color: var(--hud-primary, var(--sa-blue-500));
        filter: drop-shadow(0 0 calc(3px * var(--hud-glow)) var(--hud-primary, var(--sa-blue-500)));
      }
      .hud-enemy-arrow.on-screen-marker .hud-enemy-arrow-glyph {
        display: none;
      }
      .hud-enemy-arrow.on-screen-marker .hud-enemy-marker-glyph {
        display: block;
      }
      .hud-enemy-arrow.candidate .hud-enemy-arrow-glyph {
        background: var(--hud-primary, var(--sa-blue-500));
        filter: drop-shadow(0 0 calc(6px * var(--hud-glow)) var(--hud-primary, var(--sa-blue-500)));
      }
      .hud-enemy-arrow.flag .hud-enemy-arrow-glyph {
        clip-path: none;
        background: transparent;
        filter: none;
      }
      /* A flag remains a pennant when it is projected into the play area. */
      .hud-enemy-arrow.flag.on-screen-marker .hud-enemy-arrow-glyph {
        display: block;
      }
      .hud-enemy-arrow.flag.on-screen-marker .hud-enemy-marker-glyph {
        display: none;
      }
      .hud-enemy-arrow.flag .hud-enemy-arrow-glyph::before {
        content: "";
        position: absolute;
        left: 28%;
        top: 8%;
        width: 12%;
        height: 84%;
        background: var(--hud-danger, var(--sa-red-500));
        box-shadow: 0 0 calc(5px * var(--hud-glow)) var(--hud-danger, var(--sa-red-500));
      }
      .hud-enemy-arrow.flag .hud-enemy-arrow-glyph::after {
        content: "";
        position: absolute;
        left: 38%;
        top: 10%;
        width: 54%;
        height: 48%;
        clip-path: polygon(0 0, 100% 22%, 70% 56%, 100% 100%, 0 78%);
        background: var(--hud-danger, var(--sa-red-500));
        filter: drop-shadow(0 0 calc(5px * var(--hud-glow)) var(--hud-danger, var(--sa-red-500)));
      }
      .hud-enemy-arrow.flag.friendly .hud-enemy-arrow-glyph::before,
      .hud-enemy-arrow.flag.friendly .hud-enemy-arrow-glyph::after {
        background: var(--hud-primary, var(--sa-blue-500));
      }
      .hud-enemy-arrow.flag.friendly .hud-enemy-arrow-glyph::before {
        box-shadow: 0 0 calc(5px * var(--hud-glow)) var(--hud-primary, var(--sa-blue-500));
      }
      .hud-enemy-arrow.flag.friendly .hud-enemy-arrow-glyph::after {
        filter: drop-shadow(0 0 calc(5px * var(--hud-glow)) var(--hud-primary, var(--sa-blue-500)));
      }
      .hud-enemy-arrow.flag .hud-enemy-arrow-distance {
        color: var(--hud-danger, var(--sa-red-500));
      }
      .hud-enemy-arrow.flag.friendly .hud-enemy-arrow-distance {
        color: var(--hud-primary, var(--sa-blue-500));
      }
      /* Bases are locations, not entities: in view they use a hollow beacon
         instead of either an enemy diamond or a moving flag pennant. Off-screen
         they retain the directional chevron that makes an edge cue useful. */
      .hud-enemy-arrow.base .hud-enemy-marker-glyph {
        border-color: var(--hud-danger, var(--sa-red-500));
        border-radius: 50%;
        transform: translate(-50%, -50%);
        filter: drop-shadow(0 0 calc(3px * var(--hud-glow)) var(--hud-danger, var(--sa-red-500)));
      }
      .hud-enemy-arrow.base.friendly .hud-enemy-marker-glyph {
        border-color: var(--hud-primary, var(--sa-blue-500));
        filter: drop-shadow(0 0 calc(3px * var(--hud-glow)) var(--hud-primary, var(--sa-blue-500)));
      }
      .hud-enemy-arrow.base.friendly .hud-enemy-arrow-glyph {
        background: var(--hud-primary, var(--sa-blue-500));
        filter: drop-shadow(0 0 calc(5px * var(--hud-glow)) var(--hud-primary, var(--sa-blue-500)));
      }
      .hud-enemy-arrow.base .hud-enemy-arrow-distance { color: var(--hud-danger, var(--sa-red-500)); }
      .hud-enemy-arrow.base.friendly .hud-enemy-arrow-distance { color: var(--hud-primary, var(--sa-blue-500)); }
      .hud-enemy-arrow-distance {
        position: absolute;
        left: 50%;
        top: calc(100% + 2px);
        transform: translateX(-50%);
        color: var(--hud-danger, var(--sa-red-500));
        font-size: 0.5625em;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
        letter-spacing: 0.06em;
        line-height: 1;
        white-space: nowrap;
        text-shadow: 0 0 calc(5px * var(--hud-glow)) var(--hud-bg, var(--sa-n-900));
      }
      .hud-enemy-arrow.candidate .hud-enemy-arrow-distance {
        color: var(--hud-primary, var(--sa-blue-500));
      }
      .hud-enemy-arrow.on-screen-marker .hud-enemy-arrow-distance {
        font-size: 0.5em;
        opacity: 0.72;
      }
    `;
    this.container.appendChild(style);
    root.appendChild(this.container);

    this.buildPool(layout.enemyArrows.maxCount, this.slots, "enemy");
    this.buildPool(2, this.flagSlots, "flag");
    this.buildPool(2, this.baseSlots, "base");
  }

  /**
   * Adopt a freshly resolved layout (theme hot-reload, rotation, resize). The
   * pool only ever GROWS: `maxCount` is a ceiling on live arrows, and rebuilding
   * it downward mid-match would churn DOM nodes for nothing.
   */
  applyLayout(layout: FlightHudLayout): void {
    this.layout = layout;
    this.buildPool(layout.enemyArrows.maxCount, this.slots, "enemy");
    const markerPx = `${layout.enemyArrows.markerSizePx}px`;
    for (let i = 0; i < this.slots.length; i++) {
      this.slots[i]!.marker.style.width = markerPx;
      this.slots[i]!.marker.style.height = markerPx;
    }
    for (let i = 0; i < this.flagSlots.length; i++) {
      this.flagSlots[i]!.marker.style.width = markerPx;
      this.flagSlots[i]!.marker.style.height = markerPx;
    }
    for (let i = 0; i < this.baseSlots.length; i++) {
      this.baseSlots[i]!.marker.style.width = markerPx;
      this.baseSlots[i]!.marker.style.height = markerPx;
    }
    // Geometry moved under every arrow; the next frame re-places the live ones
    // and this hides whatever is currently parked at a stale position.
    this.begin();
    this.finish();
  }

  private buildPool(count: number, slots: ArrowSlot[], kind: ArrowSlot["kind"]): void {
    for (let i = slots.length; i < count; i++) {
      const el = document.createElement("div");
      el.className = kind === "enemy" ? "hud-enemy-arrow" : `hud-enemy-arrow ${kind}`;
      el.setAttribute(HUD_CONTROL_ATTR, "enemy-arrow");
      el.setAttribute("aria-hidden", "true");
      const glyph = document.createElement("div");
      glyph.className = "hud-enemy-arrow-glyph";
      const marker = document.createElement("div");
      marker.className = "hud-enemy-marker-glyph";
      marker.style.width = `${this.layout.enemyArrows.markerSizePx}px`;
      marker.style.height = `${this.layout.enemyArrows.markerSizePx}px`;
      const distance = document.createElement("span");
      distance.className = "hud-enemy-arrow-distance";
      el.append(glyph, marker, distance);
      this.container.appendChild(el);
      slots.push({
        el,
        glyph,
        marker,
        distance,
        lastX: Number.NaN,
        lastY: Number.NaN,
        lastDeg: Number.NaN,
        lastDistanceM: Number.NaN,
        lastOpacity: Number.NaN,
        lastCandidate: null,
        lastMarker: null,
        lastScale: Number.NaN,
        lastFriendly: null,
        kind,
        visible: false,
      });
    }
  }

  /** Start a frame: the next {@link place} call claims the first slot again. */
  begin(): void {
    this.used = 0;
    this.flagUsed = 0;
    this.baseUsed = 0;
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

    const slot = this.slots[this.used]!;
    if (offScreenArrowPlacement(point, this.layout.viewport, arrows, this.placement)) {
      this.used += 1;
      // A far contact chooses the faint-contact alpha instead of multiplying it
      // by distance fade. With the shipped values the old far result was
      // 0.35 * 0.4 = 0.14; this path is max(0.35, 0.4) = 0.4.
      const opacity = Math.max(
        arrows.markerMinOpacity,
        candidate ? arrowOpacity(distanceUnits, arrows) : arrows.outOfRangeOpacity,
      );
      this.write(
        slot,
        this.placement,
        distanceUnits,
        opacity,
        candidate,
        false,
        candidate ? 1 : arrows.outOfRangeScale,
      );
      return true;
    }

    // The current candidate keeps today's full LockReticle bracket unchanged.
    // Every other in-view enemy gets this component's smaller pooled marker.
    if (candidate) return false;
    this.used += 1;
    this.placement.x = point.x;
    this.placement.y = point.y;
    this.placement.rotationRad = 0;
    this.write(
      slot,
      this.placement,
      distanceUnits,
      Math.max(arrows.markerMinOpacity, arrows.outOfRangeOpacity),
      false,
      true,
      arrows.outOfRangeScale,
    );
    return true;
  }

  /**
   * Place an objective pennant. Flag slots are separate from enemy slots, so
   * the two CTF objectives remain discoverable in a crowded fight.
   */
  placeFlag(point: ProjectedPoint, distanceUnits: number, friendly: boolean): boolean {
    const arrows = this.layout.enemyArrows;
    if (!arrows.enabled || this.flagUsed >= this.flagSlots.length) return false;
    const slot = this.flagSlots[this.flagUsed++]!;
    const offScreen = offScreenArrowPlacement(point, this.layout.viewport, arrows, this.placement);
    if (!offScreen) {
      this.placement.x = point.x;
      this.placement.y = point.y;
      this.placement.rotationRad = 0;
    }
    this.write(
      slot,
      this.placement,
      distanceUnits,
      Math.max(arrows.markerMinOpacity, arrowOpacity(distanceUnits, arrows)),
      false,
      !offScreen,
      offScreen ? 1.25 : arrows.outOfRangeScale,
      friendly,
    );
    return true;
  }

  /** Place a CTF delivery base as a location beacon, on-screen or at the edge. */
  placeBase(point: ProjectedPoint, distanceUnits: number, friendly: boolean): boolean {
    const arrows = this.layout.enemyArrows;
    if (!arrows.enabled || this.baseUsed >= this.baseSlots.length) return false;

    const slot = this.baseSlots[this.baseUsed++]!;
    const offScreen = offScreenArrowPlacement(point, this.layout.viewport, arrows, this.placement);
    if (!offScreen) {
      this.placement.x = point.x;
      this.placement.y = point.y;
      this.placement.rotationRad = 0;
    }
    this.write(
      slot,
      this.placement,
      distanceUnits,
      Math.max(arrows.markerMinOpacity, arrowOpacity(distanceUnits, arrows)),
      false,
      !offScreen,
      offScreen ? 1 : arrows.outOfRangeScale,
      friendly,
    );
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
    for (let i = this.flagUsed; i < this.flagSlots.length; i++) {
      const slot = this.flagSlots[i]!;
      if (!slot.visible) continue;
      slot.visible = false;
      slot.el.classList.remove("visible");
    }
    for (let i = this.baseUsed; i < this.baseSlots.length; i++) {
      const slot = this.baseSlots[i]!;
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
    marker: boolean,
    scale: number,
    friendly?: boolean,
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
      slot.el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%) scale(${scale})`;
    } else if (scale !== slot.lastScale) {
      slot.el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%) scale(${scale})`;
    }
    slot.lastScale = scale;
    if (deg !== slot.lastDeg) {
      slot.lastDeg = deg;
      slot.glyph.style.transform = `rotate(${deg}deg)`;
    }
    const distanceM = roundedHudMeters(distanceUnits * this.layout.metersPerUnit);
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
      slot.el.classList.toggle("out-of-range", !candidate);
    }
    if (marker !== slot.lastMarker) {
      slot.lastMarker = marker;
      slot.el.classList.toggle("on-screen-marker", marker);
    }
    if (slot.kind !== "enemy" && friendly !== slot.lastFriendly) {
      slot.lastFriendly = friendly ?? false;
      slot.el.classList.toggle("friendly", slot.lastFriendly);
    }
  }

  dispose(): void {
    this.slots.length = 0;
    this.flagSlots.length = 0;
    this.baseSlots.length = 0;
    this.container.remove();
  }
}
