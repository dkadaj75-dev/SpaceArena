import type { EntityId, SimEvent, Snapshot } from "@space-arena/shared";
import type { FlightHudBinding } from "./FlightControls.js";
import type { ProjectedPoint } from "./flightHudLayout.js";

const MAX_LABELS = 24;
const LIFETIME_MS = 1000;
const MERGE_WINDOW_MS = 220;
const SELF_X_FRACTION = 0.58;
const SELF_Y_FRACTION = 0.68;

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

/** Rounded combat value, with sustained fractional damage kept readable. */
export function formatDamageAmount(amount: number): string {
  if (amount >= 10) return String(Math.round(amount));
  if (amount >= 1) return String(Math.round(amount * 10) / 10);
  return String(Math.max(1, Math.round(amount * 10) / 10));
}

/** Size is intentionally capped: a kill is emphatic without covering the ship. */
export function damageTextScale(amount: number): number {
  return Math.min(1.65, 0.9 + Math.sqrt(Math.max(0, amount)) * 0.115);
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
      const opacity = Math.round((1 - progress * progress) * 100) / 100;
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
