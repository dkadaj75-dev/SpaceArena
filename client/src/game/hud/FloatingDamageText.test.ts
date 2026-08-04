import { describe, expect, it, vi } from "vitest";
import type { SimEvent, Snapshot } from "@space-arena/shared";
import { FloatingDamageText, damageTextScale, formatDamageAmount } from "./FloatingDamageText.js";

const PLAYER = 1;
const ENEMY = 2;

function snapshot(x = 40): Snapshot {
  return {
    ships: [{ id: ENEMY, pos: { x, y: 2, z: 8 } }],
  } as unknown as Snapshot;
}

function damage(amount: number): SimEvent {
  return { type: "damage", targetId: ENEMY, sourceId: PLAYER, amount, damageType: "kinetic", isAsteroid: false };
}

describe("FloatingDamageText", () => {
  it("formats sustained damage and scales larger hits without unbounded growth", () => {
    expect(formatDamageAmount(0.04)).toBe("1");
    expect(formatDamageAmount(2.34)).toBe("2.3");
    expect(formatDamageAmount(24.4)).toBe("24");
    expect(damageTextScale(1000)).toBe(1.65);
  });

  it("wires hull and shield events into distinct, pooled labels and merges rapid hits", () => {
    const root = document.createElement("div");
    const project = vi.fn((x: number, _y: number, _z: number, out: { x: number; y: number; behind: boolean }) => {
      out.x = x * 2;
      out.y = 100;
      out.behind = false;
      return true;
    });
    const text = new FloatingDamageText(root, PLAYER, { project });
    text.consumeEvents([damage(3), damage(4), {
      type: "shieldAbsorb", targetId: ENEMY, sourceId: PLAYER, hardpointIndex: 0, amount: 2, damageType: "energy",
    }]);
    text.update(snapshot(), snapshot(), 1, 16);

    const labels = root.querySelectorAll<HTMLElement>(".hud-damage-number:not([hidden])");
    expect(labels).toHaveLength(2);
    expect(labels[0]?.textContent).toBe("7");
    expect(labels[0]?.classList.contains("hull")).toBe(true);
    expect(labels[0]?.classList.contains("dealt")).toBe(true);
    expect(labels[1]?.classList.contains("shield")).toBe(true);
    expect(project).toHaveBeenCalled();
    text.dispose();
  });

  it("uses the player-edge convention and the taken tint for own-ship damage", () => {
    const root = document.createElement("div");
    const text = new FloatingDamageText(root, PLAYER, null);
    text.consumeEvents([{ type: "damage", targetId: PLAYER, sourceId: ENEMY, amount: 9, damageType: "energy", isAsteroid: false }]);
    text.update(snapshot(), snapshot(), 1, 16);
    const label = root.querySelector<HTMLElement>(".hud-damage-number:not([hidden])")!;
    expect(label.classList.contains("taken")).toBe(true);
    expect(label.textContent).toBe("9");
    text.dispose();
  });

  it("expires labels after their lifetime", () => {
    const root = document.createElement("div");
    const text = new FloatingDamageText(root, PLAYER, { project: (_x, _y, _z, out) => {
      out.x = 20;
      out.y = 20;
      out.behind = false;
      return true;
    } });
    text.consumeEvents([damage(3)]);
    text.update(snapshot(), snapshot(), 1, 1001);
    expect(root.querySelector(".hud-damage-number:not([hidden])")).toBeNull();
    text.dispose();
  });

  it("caps the DOM pool and evicts the oldest live label when saturated", () => {
    const root = document.createElement("div");
    const text = new FloatingDamageText(root, PLAYER, null);
    const events: SimEvent[] = [];
    for (let i = 0; i < 25; i++) {
      events.push({ type: "damage", targetId: 100 + i, sourceId: null, amount: 1, damageType: "kinetic", isAsteroid: false });
    }
    text.consumeEvents(events);
    expect(root.querySelectorAll(".hud-damage-number")).toHaveLength(24);
    expect(root.querySelectorAll(".hud-damage-number:not([hidden])")).toHaveLength(24);
    text.dispose();
  });
});
