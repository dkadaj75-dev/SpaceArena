import { describe, expect, it } from "vitest";
import type { ProjectileSnapshot } from "@space-arena/shared";
import { KineticTracerField } from "./kineticTracers.js";

/**
 * Regression family for the invisible autocannon (owner 2026-08-16, first met
 * on a phone because that lobby's bots roll kinetic loadouts): kinetic rounds
 * are deliberately not replicated, and the client received the fire EVENT but
 * never reconstructed the visible round — online autocannons fired invisible
 * bullets on every device. The field under test is that reconstruction.
 */
describe("KineticTracerField", () => {
  const ball = { speed: 60, ttlSec: 1.25 };

  const sampled = (field: KineticTracerField, nowMs: number): ProjectileSnapshot[] => {
    const out: ProjectileSnapshot[] = [];
    field.sample(nowMs, out);
    return out;
  };

  it("flies the round at the authored speed along the given direction", () => {
    const field = new KineticTracerField();
    field.spawn(7, 1000, { x: 10, y: 2, z: -5 }, { x: 2, y: 0, z: 0 }, ball);
    const [round] = sampled(field, 1500);
    expect(round).toBeDefined();
    expect(round!.kind).toBe("kinetic");
    // 0.5 s at 60 u/s, direction normalized from (2,0,0).
    expect(round!.pos).toEqual({ x: 40, y: 2, z: -5 });
    expect(round!.heading).toBeCloseTo(0, 12);
  });

  it("expires at ttl and never returns an expired round", () => {
    const field = new KineticTracerField();
    field.spawn(7, 0, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, ball);
    expect(sampled(field, 1249)).toHaveLength(1);
    expect(sampled(field, 1250)).toHaveLength(0);
    expect(field.size).toBe(0);
  });

  it("assigns NEGATIVE, unique ids — the view keys tracks by id and real entities are non-negative", () => {
    const field = new KineticTracerField();
    field.spawn(1, 0, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, ball);
    field.spawn(2, 0, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, ball);
    const ids = sampled(field, 100).map((round) => round.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(id).toBeLessThan(0);
  });

  it("retires the OLDEST round of the named shooter on a kinetic damage report, nobody else's", () => {
    const field = new KineticTracerField();
    field.spawn(7, 0, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, ball); // oldest of 7
    field.spawn(9, 10, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, ball);
    field.spawn(7, 20, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, ball);
    field.onKineticDamage(7);
    const rounds = sampled(field, 50);
    expect(rounds).toHaveLength(2);
    // The survivors are shooter 9's round and shooter 7's NEWER round — the
    // oldest (born 0) is gone. Distinguish by position: born-10 and born-20
    // rounds have flown 40/50ths and 30/50ths of 60 u/s respectively.
    const xs = rounds.map((round) => +round.pos.x.toFixed(3)).sort((a, b) => a - b);
    expect(xs).toEqual([1.8, 2.4]);
  });

  it("drops degenerate spawns instead of NaN-ing the renderer", () => {
    const field = new KineticTracerField();
    field.spawn(7, 0, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, ball); // zero direction
    field.spawn(7, 0, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { speed: 0, ttlSec: 1 });
    field.spawn(7, 0, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { speed: 60, ttlSec: 0 });
    expect(field.size).toBe(0);
  });

  it("clear() empties the field (match teardown)", () => {
    const field = new KineticTracerField();
    field.spawn(7, 0, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, ball);
    field.clear();
    expect(sampled(field, 10)).toHaveLength(0);
  });
});
