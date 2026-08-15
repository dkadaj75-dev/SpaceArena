import { describe, expect, it, vi } from "vitest";
import type { SimEvent, Snapshot } from "@space-arena/shared";
import {
  DAMAGE_FULL_VISIBLE_DISTANCE,
  DAMAGE_HIDDEN_DISTANCE,
  FloatingDamageText,
  damageDistanceOpacity,
  damageTextScale,
  formatDamageAmount,
} from "./FloatingDamageText.js";

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

/** Projection that always succeeds on-screen, so a test isolates distance alone. */
function fixedProject(_x: number, _y: number, _z: number, out: { x: number; y: number; behind: boolean }): boolean {
  out.x = 30;
  out.y = 40;
  out.behind = false;
  return true;
}

function damage(amount: number): SimEvent {
  return { type: "damage", targetId: ENEMY, sourceId: PLAYER, amount, damageType: "kinetic", isAsteroid: false };
}

describe("FloatingDamageText", () => {
  // Whole numbers only (2026-08-14): a beam's per-tick fraction used to show as
  // "2.5" and read as noise. Rounding never reaches 0 — `add()` has already
  // rejected a non-positive hit, so anything that gets here landed.
  it("formats every value as a whole number and scales larger hits without unbounded growth", () => {
    expect(formatDamageAmount(0.04)).toBe("1");
    expect(formatDamageAmount(0.5)).toBe("1");
    expect(formatDamageAmount(2.34)).toBe("2");
    expect(formatDamageAmount(2.5)).toBe("3");
    expect(formatDamageAmount(24.4)).toBe("24");
    expect(formatDamageAmount(24.6)).toBe("25");
    expect(damageTextScale(1000)).toBe(1.65);
  });

  it("fades a value out between the full-visible and hidden distances", () => {
    expect(damageDistanceOpacity(0)).toBe(1);
    expect(damageDistanceOpacity(DAMAGE_FULL_VISIBLE_DISTANCE)).toBe(1);
    expect(damageDistanceOpacity(450)).toBeCloseTo(0.5, 6);
    expect(damageDistanceOpacity(DAMAGE_HIDDEN_DISTANCE)).toBe(0);
    expect(damageDistanceOpacity(9999)).toBe(0);
    // An unplaceable point must never blank a value that is really in view.
    expect(damageDistanceOpacity(Number.NaN)).toBe(1);
  });

  it("never spawns a label for a hit beyond the hidden distance", () => {
    const root = document.createElement("div");
    const text = new FloatingDamageText(root, PLAYER, { project: fixedProject });
    // Seed the viewer/ship positions the way a live frame does: the enemy sits
    // 600 units out, past the 500-unit cutoff.
    text.update(snapshot(600), snapshot(600), 1, 16);
    text.consumeEvents([damage(7)]);
    text.update(snapshot(600), snapshot(600), 1, 16);
    expect(root.querySelector(".hud-damage-number:not([hidden])")).toBeNull();
    text.dispose();
  });

  it("dims a label inside the fade band and retires one that drifts out of range", () => {
    const root = document.createElement("div");
    const text = new FloatingDamageText(root, PLAYER, { project: fixedProject });
    text.update(snapshot(450), snapshot(450), 1, 16);
    text.consumeEvents([damage(7)]);
    text.update(snapshot(450), snapshot(450), 1, 16);
    const label = root.querySelector<HTMLElement>(".hud-damage-number:not([hidden])")!;
    // Halfway through the band, times the (still full) lifetime opacity.
    expect(Number(label.style.opacity)).toBeCloseTo(0.5, 2);
    // The same ship drifts past the cutoff: its label goes, slot and all.
    text.update(snapshot(600), snapshot(600), 1, 16);
    expect(root.querySelector(".hud-damage-number:not([hidden])")).toBeNull();
    text.dispose();
  });

  it("never fades own-ship damage — the player edge is at zero range", () => {
    const root = document.createElement("div");
    const text = new FloatingDamageText(root, PLAYER, null);
    text.update(snapshot(900), snapshot(900), 1, 16);
    text.consumeEvents([
      { type: "damage", targetId: PLAYER, sourceId: ENEMY, amount: 9, damageType: "energy", isAsteroid: false },
    ]);
    text.update(snapshot(900), snapshot(900), 1, 16);
    const label = root.querySelector<HTMLElement>(".hud-damage-number:not([hidden])")!;
    expect(label.textContent).toBe("9");
    expect(Number(label.style.opacity)).toBeGreaterThan(0.9);
    text.dispose();
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
      { type: "damage", targetId: PLAYER, sourceId: ENEMY, amount: 5, damageType: "energy", isAsteroid: false },
      { type: "damage", targetId: ENEMY, sourceId: PLAYER, amount: 6, damageType: "energy", isAsteroid: false },
    ]);
    text.update(snapshot(), snapshot(), 1, 16);

    const labels = root.querySelectorAll<HTMLElement>(".hud-damage-number:not([hidden])");
    expect(labels).toHaveLength(2);
    const takenHit = [...labels].find((el) => el.textContent === "5")!;
    const dealtHit = [...labels].find((el) => el.textContent === "6")!;
    expect(takenHit.classList.contains("friendly")).toBe(true);
    expect(dealtHit.classList.contains("hostile")).toBe(true);
    text.dispose();
  });

  // Owner's rule (2026-08-15): the board is the PLAYER's fight. Ten ships
  // trading hits produced labels for exchanges the player cannot act on, and
  // they competed with the two numbers that decide the next move.
  it("ignores damage the player neither dealt nor took", () => {
    const root = document.createElement("div");
    const text = new FloatingDamageText(root, PLAYER, {
      project: (_x, _y, _z, out) => {
        out.x = 30;
        out.y = 40;
        out.behind = false;
        return true;
      },
    });
    text.update(snapshot(), snapshot(), 1, 16);
    text.consumeEvents([
      // A teammate and an enemy duelling somewhere else on the map.
      { type: "damage", targetId: TEAMMATE, sourceId: ENEMY, amount: 5, damageType: "energy", isAsteroid: false },
      { type: "damage", targetId: ENEMY, sourceId: TEAMMATE, amount: 6, damageType: "energy", isAsteroid: false },
      { type: "shieldAbsorb", targetId: TEAMMATE, sourceId: ENEMY, hardpointIndex: 0, amount: 4, damageType: "energy" },
      // An unattributed hit on someone else — no source to claim it either.
      { type: "damage", targetId: TEAMMATE, sourceId: null, amount: 7, damageType: "kinetic", isAsteroid: false },
    ]);
    text.update(snapshot(), snapshot(), 1, 16);

    expect(root.querySelectorAll(".hud-damage-number:not([hidden])")).toHaveLength(0);
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
      // The player's own hits: only damage they dealt or took reaches the pool.
      events.push({ type: "damage", targetId: 100 + i, sourceId: PLAYER, amount: 1, damageType: "kinetic", isAsteroid: false });
    }
    text.consumeEvents(events);
    expect(root.querySelectorAll(".hud-damage-number")).toHaveLength(24);
    expect(root.querySelectorAll(".hud-damage-number:not([hidden])")).toHaveLength(24);
    text.dispose();
  });
});
