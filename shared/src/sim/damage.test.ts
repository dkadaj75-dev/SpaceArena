import { beforeAll, describe, expect, it } from "vitest";
import type { ConfigService } from "../core/ConfigService.js";
import type { DamageType } from "../schemas/common.js";
import type { TuningConfig } from "../schemas/index.js";
import type { ModuleConfig } from "../schemas/module.js";
import type { EntityId } from "./components.js";
import { applyDamageToShip, type DamageTally } from "./damage.js";
import { spawnShipFromConfig } from "./spawn.js";
import { INTERCEPTOR_FITTING, INTERCEPTOR_FITTING_SHIELD, loadTestConfigs, makeWorld } from "./testutil.js";
import { DEFAULT_DAMAGE_TYPE_PROFILES, damageTypeProfileOf } from "./tuningDefaults.js";
import type { World } from "./World.js";

/**
 * The damage rules (owner 2026-08-15). Shielded and bare are SEPARATE cases,
 * stated per type rather than derived from one another:
 *
 *   type      shield up → reserve   shield up → hull   bare hull
 *   energy            1.0                 0.0             0.5
 *   kinetic           0.2                 0.2             1.0
 *   hybrid            0.5                 0.0             1.0
 *
 * The shielded pair deliberately need NOT sum to 1: an autocannon puts a fifth
 * into the reserve and a fifth through to plating, and the rest of the round is
 * spent on the shield's surface. That is the point of stating the two cases
 * independently, and `spends only 40%` below pins it.
 *
 * The light hull (`ship.interceptor`) is the fixture: 0 energy resist and 0.1
 * kinetic resist, so energy cases read as clean arithmetic and kinetic ones
 * carry exactly one extra factor of 0.9.
 */

const SHIELD = 1; // the light hull mounts a shield on hardpoint 1 (2026-07-31)
const KINETIC_RESIST = 0.1; // ship.interceptor
/** Small enough to sit inside both the 40-point reserve and the 120-point hull. */
const HIT = 20;

let configs: ConfigService;
beforeAll(async () => {
  configs = await loadTestConfigs();
});

/** A ship with NO shield fitted — the "nothing in the way" baseline. */
function unshielded(tuningOverride?: Partial<TuningConfig>): { world: World; id: EntityId } {
  const world = makeWorld(configs, tuningOverride ? { tuningOverride } : {});
  const id = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 0, z: 0 }, 0);
  return { world, id };
}

/**
 * A ship carrying `module.shield-mk1`, raised and charged to `reserve` (default
 * a full tank). `reserve: 0` is the COLLAPSED shield — equipped and active but
 * with nothing left to spend, which must behave exactly like no shield at all.
 */
function shielded(reserve?: number, tuningOverride?: Partial<TuningConfig>): { world: World; id: EntityId } {
  const world = makeWorld(configs, tuningOverride ? { tuningOverride } : {});
  const id = spawnShipFromConfig(world, configs, "ship.interceptor", INTERCEPTOR_FITTING_SHIELD, 0, { x: 0, z: 0 }, 0);
  const shield = world.modules.get(id)!.modules[SHIELD]!;
  shield.state = "active";
  shield.energy = reserve ?? shield.energyCapacity;
  return { world, id };
}

/** Hull points lost by `id` when `amount` of `type` lands on it. */
function hullLoss(world: World, id: EntityId, amount: number, type: DamageType): number {
  const core = world.shipCores.get(id)!;
  const before = core.hull;
  applyDamageToShip(world, id, null, amount, type);
  return before - core.hull;
}

/** Total soaked across every `shieldAbsorb` event emitted so far. */
function absorbed(world: World): number {
  return world.events
    .filter((e) => e.type === "shieldAbsorb")
    .reduce((sum, e) => sum + (e as { amount: number }).amount, 0);
}

/** The single `damage` event's amount, or 0 when the hit emitted none. */
function damageEvent(world: World): number {
  const ev = world.events.filter((e) => e.type === "damage");
  return ev.length === 0 ? 0 : (ev[0] as { amount: number }).amount;
}

describe("damage rules — a shield is up", () => {
  it("energy is stopped outright: all of it into the reserve, none to hull", () => {
    const { world, id } = shielded();
    const shield = world.modules.get(id)!.modules[SHIELD]!;
    const full = shield.energyCapacity;

    const loss = hullLoss(world, id, HIT, "energy");
    expect(absorbed(world)).toBeCloseTo(HIT, 6);
    expect(shield.energy).toBeCloseTo(full - HIT, 6);
    expect(loss).toBe(0);
  });

  it("kinetic puts a fifth in the reserve and a fifth through to hull", () => {
    const { world, id } = shielded();
    const shield = world.modules.get(id)!.modules[SHIELD]!;
    const full = shield.energyCapacity;

    const loss = hullLoss(world, id, HIT, "kinetic");
    expect(absorbed(world)).toBeCloseTo(4, 6);
    expect(shield.energy).toBeCloseTo(full - 4, 6);
    expect(loss).toBeCloseTo(20 * 0.2 * (1 - KINETIC_RESIST), 6);
  });

  it("the missile warhead is stopped by a shield, at half the cost to it", () => {
    const { world, id } = shielded();
    const loss = hullLoss(world, id, HIT, "hybrid");
    expect(absorbed(world)).toBeCloseTo(10, 6);
    expect(loss).toBe(0);
  });

  // The rule that makes this model different from the old absorb-and-remainder
  // one: the two shielded shares are independent, so a round can be PARTLY
  // wasted on the shield's surface rather than every point landing somewhere.
  it("spends only 40% of a kinetic round while the shield holds — the rest is stopped", () => {
    const { world, id } = shielded();
    const shield = world.modules.get(id)!.modules[SHIELD]!;
    const before = shield.energy;
    const loss = hullLoss(world, id, HIT, "kinetic");
    const spentOnShield = before - shield.energy;
    const hullNominal = loss / (1 - KINETIC_RESIST);
    expect(spentOnShield + hullNominal).toBeCloseTo(HIT * 0.4, 6);
  });
});

describe("damage rules — no working shield", () => {
  it("energy scorches bare plating for half", () => {
    const { world, id } = unshielded();
    expect(hullLoss(world, id, HIT, "energy")).toBeCloseTo(10, 6);
  });

  it("kinetic lands full on bare plating", () => {
    const { world, id } = unshielded();
    expect(hullLoss(world, id, HIT, "kinetic")).toBeCloseTo(20 * (1 - KINETIC_RESIST), 6);
  });

  it("the missile warhead lands FULL once the shield is gone", () => {
    const { world, id } = unshielded();
    expect(hullLoss(world, id, HIT, "hybrid")).toBeCloseTo(20, 6);
  });

  it("a shield that is equipped but NOT raised protects nothing", () => {
    const { world, id } = shielded();
    world.modules.get(id)!.modules[SHIELD]!.state = "retracted";
    expect(hullLoss(world, id, HIT, "energy")).toBeCloseTo(10, 6);
    expect(absorbed(world)).toBe(0);
  });

  it("a COLLAPSED shield (active, reserve flat) is indistinguishable from no shield", () => {
    for (const type of ["energy", "kinetic", "hybrid"] as const) {
      const flat = shielded(0);
      const none = unshielded();
      expect(hullLoss(flat.world, flat.id, HIT, type)).toBeCloseTo(
        hullLoss(none.world, none.id, HIT, type),
        6,
      );
      expect(absorbed(flat.world)).toBe(0);
    }
  });
});

describe("damage rules — the shield collapsing mid-hit", () => {
  // The seam between the two cases. The share the reserve could not cover is
  // charged at the BARE rate rather than evaporating, so the round that breaks
  // a shield still hurts.
  it("charges the uncovered share to hull at the bare rate (energy)", () => {
    const { world, id } = shielded(5);
    // 20 energy wants 20 of reserve, gets 5. Shortfall 15 → 15 × 0.5 on hull.
    const loss = hullLoss(world, id, HIT, "energy");
    expect(absorbed(world)).toBeCloseTo(5, 6);
    expect(loss).toBeCloseTo(15 * 0.5, 6);
  });

  it("charges the uncovered share to hull at the bare rate (kinetic)", () => {
    const { world, id } = shielded(2);
    // Wants 4, gets 2. Hull = the 0.2 that always leaks (4) + the shortfall (2).
    const loss = hullLoss(world, id, HIT, "kinetic");
    expect(absorbed(world)).toBeCloseTo(2, 6);
    expect(loss).toBeCloseTo((20 * 0.2 + 2 * 1.0) * (1 - KINETIC_RESIST), 6);
  });

  it("a shield collapsing mid-hit still kills the ship it could not save", () => {
    const { world, id } = shielded(5);
    const core = world.shipCores.get(id)!;
    core.hull = 4; // less than the 7.5 the shortfall will put through
    applyDamageToShip(world, id, null, HIT, "energy");
    expect(core.hull).toBe(0);
    expect(world.events.filter((e) => e.type === "entityDestroyed")).toHaveLength(1);
  });

  it("never lets a second shield double the protection", () => {
    // Two covering shields draw from ONE share, in module order, rather than
    // each taking the type's full share off the same hit.
    const { world, id } = shielded(3);
    const mods = world.modules.get(id)!.modules;
    const first = mods[SHIELD]!;
    const clone = { ...first, hardpointIndex: 99, energy: 3 };
    mods.push(clone as (typeof mods)[number]);

    const loss = hullLoss(world, id, HIT, "energy");
    // One 20-point share, filled 3 + 3; the remaining 14 is bare-rate hull.
    expect(absorbed(world)).toBeCloseTo(6, 6);
    expect(loss).toBeCloseTo(14 * 0.5, 6);
  });
});

describe("damage rules — events and ordering", () => {
  it("shieldAbsorb reports what the shield SOAKED, damage what the hull LOST", () => {
    const { world, id } = shielded();
    hullLoss(world, id, HIT, "kinetic");
    expect(absorbed(world)).toBeCloseTo(4, 6);
    expect(damageEvent(world)).toBeCloseTo(20 * 0.2 * (1 - KINETIC_RESIST), 6);
  });

  it("emits no damage event when a shield stops the hit outright", () => {
    const { world, id } = shielded();
    hullLoss(world, id, HIT, "energy");
    expect(damageEvent(world)).toBe(0);
    expect(world.events.filter((e) => e.type === "shieldAbsorb")).toHaveLength(1);
  });

  it("a banked tally matches the emitted events point for point", () => {
    const emitted = shielded();
    hullLoss(emitted.world, emitted.id, HIT, "kinetic");

    const banked = shielded();
    const tally: DamageTally = { hull: 0, absorbed: new Map() };
    applyDamageToShip(banked.world, banked.id, null, HIT, "kinetic", tally);

    expect(tally.hull).toBeCloseTo(damageEvent(emitted.world), 9);
    expect([...tally.absorbed.values()].reduce((a, b) => a + b, 0)).toBeCloseTo(absorbed(emitted.world), 9);
    expect(banked.world.events.filter((e) => e.type === "damage" || e.type === "shieldAbsorb")).toHaveLength(0);
  });

  it("applies globalDamageMult once, to the whole hit, before the split", () => {
    const plain = shielded();
    const doubled = shielded(undefined, { globalDamageMult: 2 } as Partial<TuningConfig>);
    const plainLoss = hullLoss(plain.world, plain.id, HIT, "kinetic");
    const doubledLoss = hullLoss(doubled.world, doubled.id, HIT, "kinetic");
    // Both the reserve draw and the hull share scale together.
    expect(doubledLoss).toBeCloseTo(plainLoss * 2, 6);
    expect(absorbed(doubled.world)).toBeCloseTo(absorbed(plain.world) * 2, 6);
  });
});

describe("damage rules — authored content", () => {
  it("ships the rules the design states", () => {
    const world = makeWorld(configs);
    expect(damageTypeProfileOf(world.tuning, "energy")).toEqual({ shieldedShield: 1, shieldedHull: 0, bareHull: 0.5 });
    expect(damageTypeProfileOf(world.tuning, "kinetic")).toEqual({ shieldedShield: 0.2, shieldedHull: 0.2, bareHull: 1 });
    expect(damageTypeProfileOf(world.tuning, "hybrid")).toEqual({ shieldedShield: 0.5, shieldedHull: 0, bareHull: 1 });
  });

  it("falls back to the shipped rules when a pack authors none", () => {
    expect(DEFAULT_DAMAGE_TYPE_PROFILES.kinetic).toEqual({ shieldedShield: 0.2, shieldedHull: 0.2, bareHull: 1.0 });
  });

  it("honours an authored override per field", () => {
    const world = makeWorld(configs, {
      tuningOverride: { damageTypes: { energy: { bareHull: 0.9 } } } as Partial<TuningConfig>,
    });
    const profile = damageTypeProfileOf(world.tuning, "energy");
    expect(profile.bareHull).toBeCloseTo(0.9, 9);
    // untouched fields still come from the shipped rules
    expect(profile.shieldedShield).toBe(1);
  });

  it("is what the shipped missile racks actually author", () => {
    const missile = configs.get<ModuleConfig>("module", "module.missile-mk1")!;
    expect(missile.fire?.damageType).toBe("hybrid");
  });
});
