import type { EntityId, SimEvent, Snapshot } from "@space-arena/shared";
import type { FlightHudBinding } from "./FlightControls.js";
import type { ProjectedPoint } from "./flightHudLayout.js";

const MAX_LABELS = 24;
const LIFETIME_MS = 1000;
const MERGE_WINDOW_MS = 220;
const SELF_X_FRACTION = 0.58;
const SELF_Y_FRACTION = 0.68;

/** Distance (world units) inside which a damage value is drawn at full strength. */
export const DAMAGE_FULL_VISIBLE_DISTANCE = 400;
/** Distance (world units) at and beyond which a damage value is never drawn. */
export const DAMAGE_HIDDEN_DISTANCE = 500;

type DamageLayer = "shield" | "hull";
/**
 * Board semantics (design system v1.0): red is threat/damage to MY side, white
 * is neutral information. So a value is coloured by WHO took the hit, not by
 * who threw it — my own hull, a teammate's hull and an enemy's hull read the
 * same way every time.
 */
type DamageRelation = "friendly" | "hostile";

interface LabelSlot {
  readonly el: HTMLDivElement;
  active: boolean;
  targetId: EntityId;
  layer: DamageLayer;
  relation: DamageRelation;
  amount: number;
  ageMs: number;
  mergedAtMs: number;
  lateralPx: number;
  lastX: number;
  lastY: number;
  lastOpacity: number;
}

/**
 * Rounded combat value — ALWAYS a whole number. A decimal point in a floating
 * value reads as noise at speed (and a sustained beam produced a per-tick
 * "2.5" that never sat still), so the board quotes integers only. A hit that
 * landed at all is floored to `1`: the caller has already rejected `amount <= 0`,
 * so a real hit must never be reported as nothing.
 */
export function formatDamageAmount(amount: number): string {
  return String(Math.max(1, Math.round(amount)));
}

/** Size is intentionally capped: a kill is emphatic without covering the ship. */
export function damageTextScale(amount: number): number {
  return Math.min(1.65, 0.9 + Math.sqrt(Math.max(0, amount)) * 0.115);
}

/**
 * Distance falloff for a damage value, mirroring the audio range model: fully
 * opaque out to {@link DAMAGE_FULL_VISIBLE_DISTANCE}, a straight line down to
 * zero at {@link DAMAGE_HIDDEN_DISTANCE}, and nothing past it.
 *
 * A non-finite distance means the viewer or the target could not be placed this
 * frame; that reads as "right here" (opacity 1) so a missing position can never
 * blank a value that was legitimately in view.
 */
export function damageDistanceOpacity(distance: number): number {
  if (!Number.isFinite(distance) || distance <= DAMAGE_FULL_VISIBLE_DISTANCE) return 1;
  if (distance >= DAMAGE_HIDDEN_DISTANCE) return 0;
  return (DAMAGE_HIDDEN_DISTANCE - distance) / (DAMAGE_HIDDEN_DISTANCE - DAMAGE_FULL_VISIBLE_DISTANCE);
}

/**
 * Fixed DOM pool for RPG-style floating combat values. Events may allocate no
 * labels after construction: a new hit takes a dormant slot, or the oldest live
 * one when saturated. During an ordinary quiet render frame it performs no DOM
 * writes at all.
 */
export class FloatingDamageText {
  private readonly container: HTMLDivElement;
  private readonly slots: LabelSlot[] = [];
  private readonly projected: ProjectedPoint = { x: 0, y: 0, behind: false };
  private clockMs = 0;
  private randomState = 0x9e3779b9;
  /** Latest snapshot's ships, borrowed (never copied) for team lookups. */
  private ships: Snapshot["ships"] | null = null;
  /**
   * Viewer position for the distance falloff. The local hull IS the camera's
   * subject (the chase rig follows it), so reading it off the snapshot already
   * handed to {@link update} costs nothing and needs no extra binding: no
   * plumbing, no per-frame allocation, and it is exactly the point the audio
   * range model listens from. `viewerKnown` is false while the player is dead
   * or absent from the snapshot, which reads as "no distance information".
   */
  private viewerKnown = false;
  private viewerX = 0;
  private viewerY = 0;
  private viewerZ = 0;

  constructor(
    root: HTMLElement,
    private readonly playerId: EntityId,
    private readonly binding: Pick<FlightHudBinding, "project"> | null,
  ) {
    this.container = document.createElement("div");
    this.container.className = "hud-floating-damage";
    root.appendChild(this.container);
    for (let i = 0; i < MAX_LABELS; i++) {
      const el = document.createElement("div");
      el.className = "hud-damage-number";
      el.hidden = true;
      this.container.appendChild(el);
      this.slots.push({
        el,
        active: false,
        targetId: 0,
        layer: "hull",
        relation: "hostile",
        amount: 0,
        ageMs: 0,
        mergedAtMs: -Infinity,
        lateralPx: 0,
        lastX: Number.NaN,
        lastY: Number.NaN,
        lastOpacity: Number.NaN,
      });
    }
  }

  consumeEvents(events: readonly SimEvent[]): void {
    for (let i = 0; i < events.length; i++) {
      const event = events[i]!;
      if (event.type === "damage" && !event.isAsteroid) {
        this.add(event.targetId, event.amount, "hull");
      } else if (event.type === "shieldAbsorb") {
        this.add(event.targetId, event.amount, "shield");
      }
    }
  }

  update(cur: Snapshot, prev: Snapshot, alpha: number, dtMs: number): void {
    this.ships = cur.ships;
    const viewer = findShip(cur, this.playerId);
    this.viewerKnown = viewer !== null;
    if (viewer) {
      this.viewerX = viewer.pos.x;
      this.viewerY = viewer.pos.y;
      this.viewerZ = viewer.pos.z;
    }
    this.clockMs += dtMs;
    const width = this.container.clientWidth || 1;
    const height = this.container.clientHeight || 1;
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i]!;
      if (!slot.active) continue;
      slot.ageMs += dtMs;
      if (slot.ageMs >= LIFETIME_MS) {
        this.hide(slot);
        continue;
      }
      let x: number;
      let y: number;
      // Own-ship damage is drawn at the player edge, not in the world, so it is
      // by definition at zero range and never fades.
      let distanceOpacity = 1;
      if (slot.targetId === this.playerId) {
        x = width * SELF_X_FRACTION;
        y = height * SELF_Y_FRACTION;
      } else {
        const ship = findShip(cur, slot.targetId);
        if (!ship || !this.binding) {
          this.hide(slot);
          continue;
        }
        const before = findShip(prev, slot.targetId) ?? ship;
        const sx = before.pos.x + (ship.pos.x - before.pos.x) * alpha;
        const sy = before.pos.y + (ship.pos.y - before.pos.y) * alpha;
        const sz = before.pos.z + (ship.pos.z - before.pos.z) * alpha;
        // A label whose ship has drifted out of range is retired outright rather
        // than drawn at zero alpha — that returns the slot to the pool.
        distanceOpacity = damageDistanceOpacity(this.distanceToViewer(sx, sy, sz));
        if (distanceOpacity <= 0) {
          this.hide(slot);
          continue;
        }
        if (!this.binding.project(sx, sy, sz, this.projected) || this.projected.behind) {
          this.hide(slot);
          continue;
        }
        x = this.projected.x;
        y = this.projected.y;
      }
      const progress = slot.ageMs / LIFETIME_MS;
      const px = Math.round(x + slot.lateralPx * (1 - progress));
      const py = Math.round(y - 20 - progress * 46);
      const opacity = Math.round((1 - progress * progress) * distanceOpacity * 100) / 100;
      if (px !== slot.lastX || py !== slot.lastY) {
        slot.lastX = px;
        slot.lastY = py;
        slot.el.style.transform = `translate(${px}px, ${py}px) translate(-50%, -50%)`;
      }
      if (opacity !== slot.lastOpacity) {
        slot.lastOpacity = opacity;
        slot.el.style.opacity = String(opacity);
      }
    }
  }

  dispose(): void {
    this.container.remove();
  }

  private add(targetId: EntityId, amount: number, layer: DamageLayer): void {
    if (!(amount > 0)) return;
    // Cheapest possible cull: a hit landing beyond the fade window never claims
    // a slot, so a firefight on the far side of the map costs no DOM at all.
    if (this.isOutOfRange(targetId)) return;
    const relation: DamageRelation = this.isFriendly(targetId) ? "friendly" : "hostile";
    const slot = this.findMerge(targetId, layer, relation) ?? this.claimSlot();
    if (slot.active) {
      slot.amount += amount;
      slot.ageMs = Math.min(slot.ageMs, 180);
      slot.mergedAtMs = this.clockMs;
      slot.el.textContent = formatDamageAmount(slot.amount);
      slot.el.style.setProperty("--hud-damage-scale", String(damageTextScale(slot.amount)));
      return;
    }
    slot.active = true;
    slot.targetId = targetId;
    slot.layer = layer;
    slot.relation = relation;
    slot.amount = amount;
    slot.ageMs = 0;
    slot.mergedAtMs = this.clockMs;
    slot.lateralPx = this.nextLateralOffset();
    slot.lastX = Number.NaN;
    slot.lastY = Number.NaN;
    slot.lastOpacity = Number.NaN;
    slot.el.className = `hud-damage-number ${layer} ${relation}`;
    slot.el.textContent = formatDamageAmount(amount);
    slot.el.style.setProperty("--hud-damage-scale", String(damageTextScale(amount)));
    slot.el.hidden = false;
  }

  /**
   * Distance from the viewer to a world point, or `NaN` while the viewer has no
   * known position (dead, or before the first {@link update}). `NaN` propagates
   * through {@link damageDistanceOpacity} as "fully visible".
   */
  private distanceToViewer(x: number, y: number, z: number): number {
    if (!this.viewerKnown) return Number.NaN;
    const dx = x - this.viewerX;
    const dy = y - this.viewerY;
    const dz = z - this.viewerZ;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /**
   * True when the hit landed far enough away that no label could be seen. Uses
   * the latest snapshot the HUD already handed us; an unknown target or an
   * unplaced viewer is never culled — a missing position must not silence a hit
   * that is in fact right in front of the player.
   */
  private isOutOfRange(targetId: EntityId): boolean {
    if (targetId === this.playerId) return false;
    const ships = this.ships;
    if (!ships || !this.viewerKnown) return false;
    for (let i = 0; i < ships.length; i++) {
      const ship = ships[i]!;
      if (ship.id !== targetId) continue;
      return this.distanceToViewer(ship.pos.x, ship.pos.y, ship.pos.z) >= DAMAGE_HIDDEN_DISTANCE;
    }
    return false;
  }

  /**
   * True when the ship that took the hit is the player or one of their team.
   * Unknown ids (a corpse already gone from the snapshot) read hostile: a
   * stray white number is a smaller lie than a stray red alarm.
   */
  private isFriendly(targetId: EntityId): boolean {
    if (targetId === this.playerId) return true;
    const ships = this.ships;
    if (!ships) return false;
    let myTeam: number | undefined;
    let theirTeam: number | undefined;
    for (let i = 0; i < ships.length; i++) {
      const ship = ships[i]!;
      if (ship.id === this.playerId) myTeam = ship.team;
      if (ship.id === targetId) theirTeam = ship.team;
    }
    return myTeam !== undefined && myTeam === theirTeam;
  }

  private findMerge(targetId: EntityId, layer: DamageLayer, relation: DamageRelation): LabelSlot | null {
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i]!;
      if (
        slot.active && slot.targetId === targetId && slot.layer === layer && slot.relation === relation &&
        this.clockMs - slot.mergedAtMs <= MERGE_WINDOW_MS
      ) return slot;
    }
    return null;
  }

  private claimSlot(): LabelSlot {
    let oldest = this.slots[0]!;
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i]!;
      if (!slot.active) return slot;
      if (slot.ageMs > oldest.ageMs) oldest = slot;
    }
    return oldest;
  }

  private hide(slot: LabelSlot): void {
    if (!slot.active) return;
    slot.active = false;
    slot.el.hidden = true;
  }

  private nextLateralOffset(): number {
    this.randomState = (this.randomState * 1664525 + 1013904223) >>> 0;
    return ((this.randomState >>> 16) / 65535 - 0.5) * 32;
  }
}

function findShip(snapshot: Snapshot, id: EntityId) {
  for (let i = 0; i < snapshot.ships.length; i++) {
    const ship = snapshot.ships[i]!;
    if (ship.id === id) return ship;
  }
  return null;
}
