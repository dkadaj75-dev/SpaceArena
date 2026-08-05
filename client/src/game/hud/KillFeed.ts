import type { EntityId, SimEvent } from "@space-arena/shared";
import type { GameSession } from "../GameSession.js";

const MAX_ENTRIES = 5;
const LIFE_MS = 6000;

interface Slot { el: HTMLDivElement; remaining: number }

export class KillFeed {
  private readonly root: HTMLDivElement;
  private readonly slots: Slot[] = [];

  constructor(parent: HTMLElement, private readonly session: GameSession, private readonly playerId: EntityId) {
    this.root = document.createElement("div");
    this.root.className = "hud-kill-feed";
    this.root.setAttribute("aria-live", "polite");
    for (let i = 0; i < MAX_ENTRIES; i++) {
      const el = document.createElement("div");
      el.className = "hud-kill-feed-line";
      this.root.appendChild(el);
      this.slots.push({ el, remaining: 0 });
    }
    parent.appendChild(this.root);
  }

  consumeEvents(events: readonly SimEvent[]): void {
    for (const event of events) {
      const text = this.textFor(event);
      if (!text) continue;
      const slot = this.slots.pop()!;
      this.slots.unshift(slot);
      this.root.prepend(slot.el);
      slot.remaining = LIFE_MS;
      slot.el.textContent = text;
      slot.el.className = `hud-kill-feed-line visible ${this.flavour(event)}`;
    }
  }

  update(dtMs: number): void {
    for (const slot of this.slots) {
      if (slot.remaining <= 0) continue;
      slot.remaining = Math.max(0, slot.remaining - dtMs);
      const opacity = slot.remaining < 1000 ? slot.remaining / 1000 : 1;
      const value = opacity.toFixed(2);
      if (slot.el.style.opacity !== value) slot.el.style.opacity = value;
      if (slot.remaining === 0) slot.el.classList.remove("visible");
    }
  }

  private name(id: EntityId | null): string {
    return id === null ? "Environment" : this.session.displayNameFor(id) ?? `Pilot ${id}`;
  }

  private textFor(event: SimEvent): string | null {
    if (event.type === "entityDestroyed" && !event.isAsteroid) return `${this.name(event.killerId)} ⚔ ${this.name(event.entityId)}`;
    if (event.type === "flagTaken") return `${this.name(event.carrierId)} took the ${teamColour(event.flagTeam)} flag`;
    if (event.type === "flagDropped") return event.carrierId === null ? "Flag dropped" : `${this.name(event.carrierId)} dropped the flag`;
    if (event.type === "flagReturned") return event.byId === null ? `${teamColour(event.flagTeam)} flag returned` : `${this.name(event.byId)} returned the ${teamColour(event.flagTeam)} flag`;
    if (event.type === "flagCaptured") return `${this.name(event.carrierId)} captured!`;
    return null;
  }

  private flavour(event: SimEvent): string {
    const actor = event.type === "entityDestroyed" ? event.killerId : event.type === "flagReturned" ? event.byId : "carrierId" in event ? event.carrierId : null;
    if (actor === this.playerId) return "self";
    if (actor !== null && this.session.teamOf(actor) === this.session.playerTeam) return "friendly";
    return "enemy";
  }

  dispose(): void { this.root.remove(); }
}

function teamColour(team: number): string { return team === 0 ? "blue" : team === 1 ? "red" : `team ${team}`; }
