import { describe, expect, it, vi } from "vitest";
import type { SimEvent, Snapshot } from "@space-arena/shared";
import { FloatingDamageText, damageTextScale, formatDamageAmount } from "./FloatingDamageText.js";

const PLAYER = 1;
const ENEMY = 2;
const TEAMMATE = 3;

/** Teams matter now: colour reads which SIDE took the hit, not who threw it. */
function snapshot(x = 40): Snapshot {
  return {
    ships: [
      { id: PLAYER, team: 0, pos: { x: 0, y: 0, z: 0 } },
      { id: ENEMY, team: 1, pos: { x, y: 2, z: 8 } },
      { id: TEAMMATE, team: 0, pos: { x: -10, y: 1, z: 4 } },
    ],
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
    expect(labels[0]?.classList.contains("hostile")).toBe(true);
    expect(labels[1]?.classList.contains("shield")).toBe(true);
    expect(project).toHaveBeenCalled();
    text.dispose();
  });

  it("uses the player-edge convention and the threat tint for own-ship damage", () => {
    const root = document.createElement("div");
    const text = new FloatingDamageText(root, PLAYER, null);
    text.consumeEvents([{ type: "damage", targetId: PLAYER, sourceId: ENEMY, amount: 9, damageType: "energy", isAsteroid: false }]);
    text.update(snapshot(), snapshot(), 1, 16);
    const label = root.querySelector<HTMLElement>(".hud-damage-number:not([hidden])")!;
    expect(label.classList.contains("friendly")).toBe(true);
    expect(label.textContent).toBe("9");
    text.dispose();
  });

  // The owner's rule (2026-08-06): my side bleeding is an alarm, so a
  // TEAMMATE's damage reads the same red as my own — never the neutral white
  // reserved for damage landing on the enemy.
  it("colours a teammate's damage as threat and an enemy's as information", () => {
    const root = document.createElement("div");
    // Off-ship values need a projection; only own-ship damage uses the edge.
    const text = new FloatingDamageText(root, PLAYER, {
      project: (_x, _y, _z, out) => {
        out.x = 30;
        out.y = 40;
        out.behind = false;
        return true;
      },
    });
    // Seed the team lookup the way a live frame does, then take the hits.
    text.update(snapshot(), snapshot(), 1, 16);
    text.consumeEvents([
      { type: "damage", targetId: TEAMMATE, sourceId: ENEMY, amount: 5, damageType: "energy", isAsteroid: false },
      { type: "damage", targetId: ENEMY, sourceId: TEAMMATE, amount: 6, damageType: "energy", isAsteroid: false },
    ]);
    text.update(snapshot(), snapshot(), 1, 16);

    const labels = root.querySelectorAll<HTMLElement>(".hud-damage-number:not([hidden])");
    expect(labels).toHaveLength(2);
    const teammateHit = [...labels].find((el) => el.textContent === "5")!;
    const enemyHit = [...labels].find((el) => el.textContent === "6")!;
    expect(teammateHit.classList.contains("friendly")).toBe(true);
    expect(enemyHit.classList.contains("hostile")).toBe(true);
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
