import { describe, expect, it } from "vitest";
import { abilityOf, moduleSchema } from "./module.js";

/**
 * The cross-checks that keep the two 2026-08-22 support pulses authorable but
 * not authorable WRONG. Same shape of contract as the `jettison`/`boost`/
 * `mitigation` rules beside them in `moduleSchema.superRefine`: a behaviour
 * block belongs to the family named for it, and the family owes that block.
 */

const RAY = {
  id: "module.ray-test",
  type: "module",
  version: 1,
  name: "Ray Test",
  family: "disruptor",
  level: 1,
  activation: { deployTime: 0.3, retractTime: 0.2 },
  power: { draw: 3 },
  slow: { range: 100, factor: 0.35, durationSec: 4, cooldownSec: 12 },
  ui: { icon: "[ICON: disruptor]", label: "Ray" },
  price: 0,
  requiresLevel: 1,
} as const;

const FIELD = {
  ...RAY,
  id: "module.field-test",
  name: "Field Test",
  family: "repair",
  slow: undefined,
  repairField: { radiusUnits: 45, healAmount: 40, cooldownSec: 18 },
} as const;

const parse = (mod: unknown): ReturnType<typeof moduleSchema.safeParse> => moduleSchema.safeParse(mod);
const errorOn = (mod: unknown, path: string): boolean => {
  const result = parse(mod);
  return !result.success && result.error.issues.some((i) => i.path.join(".") === path);
};

describe("support pulse blocks (owner 2026-08-22)", () => {
  it("accepts a well-formed slowing ray and repair field", () => {
    expect(parse(RAY).success).toBe(true);
    expect(parse({ ...FIELD, slow: undefined }).success).toBe(true);
  });

  it("keeps each block to the family named for it", () => {
    expect(errorOn({ ...RAY, family: "laser" }, "slow")).toBe(true);
    expect(errorOn({ ...FIELD, family: "shield" }, "repairField")).toBe(true);
  });

  it("refuses a support family with no pulse to fire — a hardpoint that does nothing", () => {
    expect(errorOn({ ...RAY, slow: undefined }, "slow")).toBe(true);
    expect(errorOn({ ...FIELD, repairField: undefined }, "repairField")).toBe(true);
  });

  it("refuses a pulse that is also a weapon: two contradictory activation paths", () => {
    const armed = {
      ...RAY,
      fire: {
        mode: "held",
        range: 90,
        cycleTime: 0.5,
        damage: 10,
        damageType: "energy",
        requiresLineOfSight: true,
        projectile: null,
      },
    };
    expect(errorOn(armed, "fire")).toBe(true);
  });

  it("refuses an energy tank on a pulse — the cooldown is the limiter", () => {
    const tanked = { ...RAY, energy: { capacity: 40, rechargePerSec: 4, drawPerSec: 4 } };
    expect(errorOn(tanked, "energy")).toBe(true);
  });

  it("holds the slow factor inside the band a pilot can play against", () => {
    // Below the floor nobody can feel it; above the ceiling the target is
    // parked and the counter to being slowed stops being "fly differently".
    expect(parse({ ...RAY, slow: { ...RAY.slow, factor: 0.05 } }).success).toBe(false);
    expect(parse({ ...RAY, slow: { ...RAY.slow, factor: 0.75 } }).success).toBe(false);
    expect(parse({ ...RAY, slow: { ...RAY.slow, factor: 0.6 } }).success).toBe(true);
  });
});

describe("abilityOf", () => {
  it("names the pulse a module carries and its cooldown, or nothing at all", () => {
    expect(abilityOf(moduleSchema.parse(RAY))).toEqual({ kind: "slow", cooldownSec: 12 });
    expect(abilityOf(moduleSchema.parse({ ...FIELD, slow: undefined }))).toEqual({
      kind: "repairField",
      cooldownSec: 18,
    });
    expect(abilityOf(undefined)).toBeUndefined();
    expect(abilityOf({ slow: undefined, repairField: undefined })).toBeUndefined();
  });
});
