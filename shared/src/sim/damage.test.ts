import { beforeAll, describe, expect, it } from "vitest";
import type { ConfigService } from "../core/ConfigService.js";
import type { DamageType } from "../schemas/common.js";
import type { TuningConfig } from "../schemas/index.js";
import type { ModuleConfig } from "../schemas/module.js";
import type { EntityId } from "./components.js";
import { applyDamageToShip, type DamageTally } from "./damage.js";
import { spawnShipFromConfig } from "./spawn.js";
import { INTERCEPTOR_FITTING, INTERCEPTOR_FITTING_SHIELD, loadTestConfigs, makeWorld } from "./testutil.js";
import { DEFAULT_DAMAGE_TYPE_PROFILES, damageComponentsOf, damageTypeProfileOf } from "./tuningDefaults.js";
import type { World } from "./World.js";

/**
 * The damage-type triangle (energy vs kinetic, against shields and hull).
 *
 * The shipped rules, which every case below pins one clause of:
 *   - ENERGY  is stopped by shields (0.8 of the hit soaked, 0.2 penetrates) but
 *     only half-effective on hull (hullMult 0.5).
 *   - KINETIC sails through shields (0.2 soaked, 0.8 penetrates) and lands on
 *     hull at full nominal (hullMult 1.0).
 *   - The hull multiplier applies to EVERYTHING that reaches hull, whether it
 *     penetrated a live shield or arrived with no shield in its way at all.
 *
 * ORDER, deliberately, and asserted by `globalDamageMult ordering` below:
 *   base × globalDamageMult → shield share (capped by reserve, remainder
 *   carries on) → hullMult → hull resist.
 *
 * The light hull (`ship.interceptor`) is the fixture: 0 energy resist and 0.1
 * kinetic resist, so energy cases read as clean arithmetic and the kinetic ones
 * carry exactly one extra factor of 0.9.
 */

const SHIELD = 1; // the light hull mounts a shield on hardpoint 1 (2026-07-31)
const ENERGY_RESIST = 0; // ship.interceptor
const KINETIC_RESIST = 0.1; // ship.interceptor
/**
 * The standard hit for the clean-split cases. Deliberately small: `shield-mk1`
 * carries a 40-point reserve and the light hull 120 points of plating, so 20 is
 * comfortably inside BOTH — the shield can always afford the 0.8 energy share
 * (16) and the hull always survives. Cases that mean to blow through one or the
 * other say so with their own numbers.
 */
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

/** Total hull SAVED across every `shieldAbsorb` event emitted so far. */
function avoided(world: World): number {
  return world.events
    .filter((e) => e.type === "shieldAbsorb")
    .reduce((sum, e) => sum + (e as { hullAvoided: number }).hullAvoided, 0);
}

/** The single `damage` event's amount, or 0 when the hit emitted none. */
function damageEvent(world: World): number {
  const ev = world.events.filter((e) => e.type === "damage");
  return ev.length === 0 ? 0 : (ev[0] as { amount: number }).amount;
}

/** Hull points a fresh ship of the given shape loses to one `amount`/`type` hit. */
function lossOnFresh(fixture: { world: World; id: EntityId }, amount: number, type: DamageType): number {
  return hullLoss(fixture.world, fixture.id, amount, type);
}

describe("damage types — shield split", () => {
  it("energy is mostly eaten by a working shield: 80% soaked, 20% through", () => {
    const { world, id } = shielded();
    const shield = world.modules.get(id)!.modules[SHIELD]!;
    const full = shield.energyCapacity;

    // 20 energy → 16 into the reserve, 4 penetrates → hull takes 4 × 0.5.
    const loss = hullLoss(world, id, HIT, "energy");
    expect(absorbed(world)).toBeCloseTo(16, 6);
    expect(shield.energy).toBeCloseTo(full - 16, 6);
    expect(loss).toBeCloseTo(2, 6);
  });

  it("kinetic punches through a working shield: only 20% soaked, 80% through", () => {
    const { world, id } = shielded();
    const shield = world.modules.get(id)!.modules[SHIELD]!;
    const full = shield.energyCapacity;

    // 20 kinetic → 4 into the reserve, 16 penetrates → hull takes 16 × 1.0 × 0.9.
    const loss = hullLoss(world, id, HIT, "kinetic");
    expect(absorbed(world)).toBeCloseTo(4, 6);
    expect(shield.energy).toBeCloseTo(full - 4, 6);
    expect(loss).toBeCloseTo(16 * (1 - KINETIC_RESIST), 6);
  });

  it("kinetic beats energy through a shield, and the ranking flips once it drops", () => {
    // The whole point of the triangle: pick your gun for the target's state.
    const behindShield = {
      energy: lossOnFresh(shielded(), HIT, "energy"),
      kinetic: lossOnFresh(shielded(), HIT, "kinetic"),
    };
    expect(behindShield.kinetic).toBeGreaterThan(behindShield.energy);

    const bare = {
      energy: lossOnFresh(unshielded(), HIT, "energy"),
      kinetic: lossOnFresh(unshielded(), HIT, "kinetic"),
    };
    // Kinetic still wins on a bare hull, but energy closes most of the gap:
    // it loses its 0.2 penetration cap and keeps only the 0.5 hull penalty.
    expect(bare.energy).toBeGreaterThan(behindShield.energy);
    expect(bare.kinetic / bare.energy).toBeLessThan(behindShield.kinetic / behindShield.energy);
  });
});

describe("damage types — hull effectiveness with no working shield", () => {
  it("energy does half nominal to a hull with NO shield equipped", () => {
    const { world, id } = unshielded();
    expect(hullLoss(world, id, HIT, "energy")).toBeCloseTo(HIT * 0.5 * (1 - ENERGY_RESIST), 6);
    expect(absorbed(world)).toBe(0);
  });

  it("kinetic does full nominal to a hull with NO shield equipped", () => {
    const { world, id } = unshielded();
    expect(hullLoss(world, id, HIT, "kinetic")).toBeCloseTo(HIT * 1.0 * (1 - KINETIC_RESIST), 6);
  });

  it("a shield that is equipped but NOT raised soaks nothing", () => {
    const { world, id } = shielded();
    world.modules.get(id)!.modules[SHIELD]!.state = "retracted";
    expect(hullLoss(world, id, HIT, "energy")).toBeCloseTo(10, 6);
    expect(absorbed(world)).toBe(0);
  });

  it("a COLLAPSED shield (active, reserve flat) is indistinguishable from no shield", () => {
    // Fresh fixture per type: an exhausted shield must not be a special case,
    // it must land on exactly the unshielded number.
    const collapsedEnergy = shielded(0);
    expect(hullLoss(collapsedEnergy.world, collapsedEnergy.id, HIT, "energy")).toBeCloseTo(
      lossOnFresh(unshielded(), HIT, "energy"),
      6,
    );
    expect(absorbed(collapsedEnergy.world)).toBe(0);

    const collapsedKinetic = shielded(0);
    expect(hullLoss(collapsedKinetic.world, collapsedKinetic.id, HIT, "kinetic")).toBeCloseTo(
      lossOnFresh(unshielded(), HIT, "kinetic"),
      6,
    );
    expect(absorbed(collapsedKinetic.world)).toBe(0);
  });
});

describe("damage types — shield overflow at collapse", () => {
  it("carries the un-soaked excess to hull when the reserve cannot cover its share", () => {
    // Reserve 5 against 20 energy: the shield WANTS 16, can only pay 5, and the
    // other 15 must reach hull — not vanish with the shield.
    const { world, id } = shielded(5);
    const loss = hullLoss(world, id, HIT, "energy");
    expect(absorbed(world)).toBeCloseTo(5, 6);
    expect(world.modules.get(id)!.modules[SHIELD]!.energy).toBeCloseTo(0, 6);
    expect(loss).toBeCloseTo(15 * 0.5, 6);
  });

  it("conserves the hit exactly across the collapse: soaked + hull-equivalent = nominal", () => {
    // Ledger form of the same rule, swept across the 16-point boundary where the
    // reserve stops covering the share: nothing is created, nothing is lost.
    for (const reserve of [0, 0.5, 5, 15.999, 16, 16.001, 24, 40]) {
      const { world, id } = shielded(reserve);
      const loss = hullLoss(world, id, HIT, "energy");
      const soaked = absorbed(world);
      // Undo the hull multiplier to compare like with like against the 20 in.
      expect(soaked + loss / DEFAULT_DAMAGE_TYPE_PROFILES.energy.hullMult).toBeCloseTo(HIT, 6);
      expect(soaked).toBeCloseTo(Math.min(16, reserve), 6);
    }
  });

  it("kinetic overflows the same way, on its own 0.2 share", () => {
    const { world, id } = shielded(3); // wants 4, can pay 3
    const loss = hullLoss(world, id, HIT, "kinetic");
    expect(absorbed(world)).toBeCloseTo(3, 6);
    expect(loss).toBeCloseTo(17 * (1 - KINETIC_RESIST), 6);
  });

  it("a shield collapsing mid-hit still kills the ship it could not save", () => {
    const { world, id } = shielded(5);
    const core = world.shipCores.get(id)!;
    core.hull = 10; // 95 penetrating × 0.5 = 47.5, far past what is left
    applyDamageToShip(world, id, null, 100, "energy");
    expect(core.hull).toBe(0);
    expect(world.events.some((e) => e.type === "entityDestroyed")).toBe(true);
  });
});

describe("damage types — event semantics", () => {
  it("shieldAbsorb reports what the shield SOAKED, damage what the hull LOST", () => {
    const { world, id } = shielded();
    const loss = hullLoss(world, id, HIT, "energy");
    // The two numbers the HUD floats must be the two that happened — not the
    // nominal 20, and not the 4 that penetrated before the hull multiplier.
    expect(absorbed(world)).toBeCloseTo(16, 6);
    expect(damageEvent(world)).toBeCloseTo(loss, 6);
    expect(damageEvent(world)).toBeCloseTo(2, 6);
  });

  it("hullAvoided is the SOAK carried through the hull stage, not the soak itself", () => {
    // The blue number on the HUD. An energy hit is soaked at 0.8 but would only
    // ever have landed on hull at 0.5, so the charge spent (16) and the hull
    // saved (8) are different numbers — floating the first would tell a pilot
    // their shield stopped twice the damage it actually stopped.
    const { world, id } = shielded();
    hullLoss(world, id, HIT, "energy");
    expect(absorbed(world)).toBeCloseTo(16, 6);
    expect(avoided(world)).toBeCloseTo(16 * 0.5 * (1 - ENERGY_RESIST), 6);
  });

  it("carries the hull RESIST too, so the saving is the one the hull would have felt", () => {
    const { world, id } = shielded();
    hullLoss(world, id, HIT, "kinetic");
    // Kinetic: 4 soaked, and on this hull a point of kinetic costs 0.9 hull.
    expect(absorbed(world)).toBeCloseTo(4, 6);
    expect(avoided(world)).toBeCloseTo(4 * 1.0 * (1 - KINETIC_RESIST), 6);
  });

  it("BALANCES: what the hull lost plus what the shield saved is the bare-hull hit", () => {
    // The identity that makes `hullAvoided` meaningful rather than merely
    // plausible — the two floated numbers must account for the whole hit, or the
    // blue one is quoting a saving that was never on the table. Asserted for
    // every leaf and composite type, since each splits differently.
    for (const type of ["energy", "kinetic", "hybrid"] as const) {
      const bare = lossOnFresh(unshielded(), HIT, type);
      const { world, id } = shielded();
      const loss = hullLoss(world, id, HIT, type);
      expect(loss + avoided(world), `${type}: saved + lost must equal the bare-hull hit`).toBeCloseTo(bare, 6);
    }
  });

  it("a banked tally matches the emitted events point for point", () => {
    // A channelling beam banks instead of emitting; the mechanics must not care.
    const emitted = shielded();
    const emittedLoss = hullLoss(emitted.world, emitted.id, HIT, "kinetic");

    const banked = shielded();
    const tally: DamageTally = { hull: 0, absorbed: new Map(), avoided: new Map() };
    applyDamageToShip(banked.world, banked.id, null, HIT, "kinetic", tally);

    expect(tally.hull).toBeCloseTo(emittedLoss, 6);
    expect(tally.absorbed.get(SHIELD)).toBeCloseTo(absorbed(emitted.world), 6);
    expect(tally.avoided.get(SHIELD)).toBeCloseTo(avoided(emitted.world), 6);
    expect(banked.world.events.some((e) => e.type === "damage" || e.type === "shieldAbsorb")).toBe(false);
  });
});

/**
 * The HYBRID warhead (missiles, 2026-08-14).
 *
 * `hybrid` is not a third set of shield/hull numbers — it is a MIX, authored in
 * `tuning.damageTypes.hybrid.mix`, of the two leaf types. A hybrid hit is dealt
 * as half an energy hit and half a kinetic one, each through its OWN live
 * profile and the hull's own resist column, and the two halves are re-joined for
 * the events so one impact still floats one number.
 *
 * On the light hull the shipped 50/50 warhead reads as clean arithmetic:
 *   20 hybrid, no shield  → 10 kinetic (×1.0 ×0.9 = 9) + 10 energy (×0.5 = 5) = 14
 *   20 hybrid, shield up  → shield soaks 2 (kinetic share) + 8 (energy share) = 10,
 *                           hull takes 8×0.9 + 2×0.5 = 8.2
 */
describe("damage types — the hybrid warhead (split at damage time)", () => {
  it("is exactly the average of the two pure hits on a bare hull", () => {
    const hybrid = lossOnFresh(unshielded(), HIT, "hybrid");
    const kinetic = lossOnFresh(unshielded(), HIT, "kinetic");
    const energy = lossOnFresh(unshielded(), HIT, "energy");
    // The identity that makes this worth doing at all: half of each, not a
    // third number invented for missiles.
    expect(hybrid).toBeCloseTo((kinetic + energy) / 2, 6);
    expect(hybrid).toBeCloseTo(9 + 5, 6);
  });

  it("splits against a shield too: each half is soaked on its OWN share", () => {
    const { world, id } = shielded();
    const shield = world.modules.get(id)!.modules[SHIELD]!;
    const full = shield.energyCapacity;

    const loss = hullLoss(world, id, HIT, "hybrid");
    // 10 kinetic → 2 soaked, 8 through; 10 energy → 8 soaked, 2 through.
    expect(absorbed(world)).toBeCloseTo(10, 6);
    expect(shield.energy).toBeCloseTo(full - 10, 6);
    expect(loss).toBeCloseTo(8 * (1 - KINETIC_RESIST) + 2 * 0.5, 6);
  });

  it("sits between its parents against a shield — worse than kinetic, better than energy", () => {
    const behindShield = {
      energy: lossOnFresh(shielded(), HIT, "energy"),
      hybrid: lossOnFresh(shielded(), HIT, "hybrid"),
      kinetic: lossOnFresh(shielded(), HIT, "kinetic"),
    };
    expect(behindShield.hybrid).toBeGreaterThan(behindShield.energy);
    expect(behindShield.hybrid).toBeLessThan(behindShield.kinetic);
  });

  it("spends the reserve share by share, in the enum's order, and overflows the rest to hull", () => {
    // Reserve 5 against 20 hybrid. Components resolve in ENUM order — kinetic
    // then energy — so the kinetic half draws its 2 first and the energy half
    // finds only 3 of the 8 it wants. The other 5 stay in the hit.
    const { world, id } = shielded(5);
    const loss = hullLoss(world, id, HIT, "hybrid");
    expect(absorbed(world)).toBeCloseTo(5, 6);
    expect(world.modules.get(id)!.modules[SHIELD]!.energy).toBeCloseTo(0, 6);
    // kinetic: 8 through ×0.9 = 7.2. energy: 7 through ×0.5 = 3.5.
    expect(loss).toBeCloseTo(7.2 + 3.5, 6);
  });

  it("emits ONE damage event and ONE shieldAbsorb per shield, under the authored type", () => {
    // Event coherence is the whole reason the shares are re-joined: a missile is
    // one impact, so the HUD must float one number, and that number must be the
    // hull the missile actually removed — not one of its halves.
    const { world, id } = shielded();
    const loss = hullLoss(world, id, HIT, "hybrid");
    const damages = world.events.filter((e) => e.type === "damage");
    const absorbs = world.events.filter((e) => e.type === "shieldAbsorb");
    expect(damages.length).toBe(1);
    expect(absorbs.length).toBe(1);
    expect(damageEvent(world)).toBeCloseTo(loss, 6);
    expect((damages[0] as { damageType: string }).damageType).toBe("hybrid");
    expect((absorbs[0] as { damageType: string }).damageType).toBe("hybrid");
    expect((absorbs[0] as { amount: number }).amount).toBeCloseTo(10, 6);
    // …and its saving is re-joined the same way: the kinetic half's 2 soaked at
    // 0.9 hull effect plus the energy half's 8 at 0.5 — one absorb, one number.
    expect((absorbs[0] as { hullAvoided: number }).hullAvoided).toBeCloseTo(2 * 0.9 + 8 * 0.5, 6);
  });

  it("banks a split hit into a tally exactly as it would have emitted it", () => {
    const emitted = shielded();
    const emittedLoss = hullLoss(emitted.world, emitted.id, HIT, "hybrid");

    const banked = shielded();
    const tally: DamageTally = { hull: 0, absorbed: new Map(), avoided: new Map() };
    applyDamageToShip(banked.world, banked.id, null, HIT, "hybrid", tally);

    expect(tally.hull).toBeCloseTo(emittedLoss, 6);
    expect(tally.absorbed.get(SHIELD)).toBeCloseTo(absorbed(emitted.world), 6);
    expect(tally.avoided.get(SHIELD)).toBeCloseTo(avoided(emitted.world), 6);
    expect(banked.world.events.some((e) => e.type === "damage" || e.type === "shieldAbsorb")).toBe(false);
  });

  it("kills with the share that crosses zero, and announces the kill exactly once", () => {
    const { world, id } = unshielded();
    const core = world.shipCores.get(id)!;
    core.hull = 4; // the kinetic half alone (9) is already fatal
    applyDamageToShip(world, id, null, HIT, "hybrid");
    expect(core.hull).toBe(0);
    expect(world.events.filter((e) => e.type === "entityDestroyed").length).toBe(1);
    // …and the damage event still precedes the kill, as it does for a leaf hit.
    expect(world.events.findIndex((e) => e.type === "damage")).toBeLessThan(
      world.events.findIndex((e) => e.type === "entityDestroyed"),
    );
  });

  it("is what the shipped missile racks actually author", () => {
    for (const id of ["module.missile-mk1", "module.missile-mk2", "module.missile-mk3", "module.missile-heavy"]) {
      expect(configs.get<ModuleConfig>("module", id)!.fire!.damageType, id).toBe("hybrid");
    }
  });
});

describe("damage types — the mix is content, and it composes", () => {
  /**
   * The reason the split is resolved at damage time rather than baked into an
   * averaged `hybrid` profile: the halves stay attached to the LIVE energy and
   * kinetic profiles, so a designer who buffs energy moves every missile in the
   * game by half that much, without touching a missile.
   */
  it("moves a hybrid weapon by exactly HALF of a change to energy", () => {
    const baseline = lossOnFresh(unshielded(), HIT, "hybrid");
    const buffed = {
      energy: { shieldAbsorb: 0.8, hullMult: 1.0 }, // 0.5 → 1.0
      kinetic: { shieldAbsorb: 0.2, hullMult: 1.0 },
      hybrid: { mix: { kinetic: 0.5, energy: 0.5 } },
    };
    const pureBefore = lossOnFresh(unshielded(), HIT, "energy");
    const pureAfter = lossOnFresh(unshielded({ damageTypes: buffed }), HIT, "energy");
    const hybridAfter = lossOnFresh(unshielded({ damageTypes: buffed }), HIT, "hybrid");
    expect(hybridAfter - baseline).toBeCloseTo((pureAfter - pureBefore) / 2, 6);
  });

  it("honours an authored ratio, normalised — 3:1 is a 75/25 warhead", () => {
    const fixture = unshielded({
      damageTypes: {
        energy: { shieldAbsorb: 0.8, hullMult: 0.5 },
        kinetic: { shieldAbsorb: 0.2, hullMult: 1.0 },
        hybrid: { mix: { kinetic: 3, energy: 1 } },
      },
    });
    // 15 kinetic ×0.9 = 13.5, 5 energy ×0.5 = 2.5.
    expect(lossOnFresh(fixture, HIT, "hybrid")).toBeCloseTo(16, 6);
  });

  it("resolves the shipped mix into two equal, ordered leaf components", () => {
    const tuning = configs.getAll<TuningConfig>("tuning")[0]!;
    expect(damageComponentsOf(tuning, "hybrid")).toEqual([
      { type: "kinetic", share: 0.5, profile: { shieldAbsorb: 0.2, hullMult: 1.0 } },
      { type: "energy", share: 0.5, profile: { shieldAbsorb: 0.8, hullMult: 0.5 } },
    ]);
  });

  it("leaves a leaf type as one whole component", () => {
    const tuning = configs.getAll<TuningConfig>("tuning")[0]!;
    expect(damageComponentsOf(tuning, "kinetic")).toEqual([
      { type: "kinetic", share: 1, profile: { shieldAbsorb: 0.2, hullMult: 1.0 } },
    ]);
  });

  it("orders components by the ENUM, never by the authored key order", () => {
    // Two packs that author the same ratio must draw on a short reserve in the
    // same sequence, or the same fight resolves differently on two machines.
    const keyed = (mix: Record<string, number>): TuningConfig =>
      ({ globalDamageMult: 1, damageTypes: { hybrid: { mix } } }) as unknown as TuningConfig;
    const a = damageComponentsOf(keyed({ energy: 0.5, kinetic: 0.5 }), "hybrid").map((c) => c.type);
    const b = damageComponentsOf(keyed({ kinetic: 0.5, energy: 0.5 }), "hybrid").map((c) => c.type);
    expect(a).toEqual(["kinetic", "energy"]);
    expect(b).toEqual(a);
  });

  it("normalises any positive weights, so shares always sum to 1", () => {
    const tuning = { globalDamageMult: 1, damageTypes: { hybrid: { mix: { kinetic: 7, energy: 3 } } } } as TuningConfig;
    const parts = damageComponentsOf(tuning, "hybrid");
    expect(parts.map((p) => p.share)).toEqual([0.7, 0.3]);
    expect(parts.reduce((sum, p) => sum + p.share, 0)).toBeCloseTo(1, 12);
  });

  it("drops nonsense weights instead of leaking NaN into hull", () => {
    const tuning = {
      globalDamageMult: 1,
      damageTypes: { hybrid: { mix: { kinetic: 1, energy: Number.NaN } } },
    } as TuningConfig;
    expect(damageComponentsOf(tuning, "hybrid").map((p) => [p.type, p.share])).toEqual([["kinetic", 1]]);
    const fixture = unshielded({ damageTypes: tuning.damageTypes });
    expect(lossOnFresh(fixture, HIT, "hybrid")).toBeCloseTo(HIT * (1 - KINETIC_RESIST), 6);
  });

  it("cannot recurse: a component's own mix is not expanded, and self-reference is ignored", () => {
    const tuning = {
      globalDamageMult: 1,
      damageTypes: {
        hybrid: { mix: { hybrid: 5, kinetic: 1, energy: 1 } },
        // A leaf that also declares a mix is still taken as a leaf here.
        kinetic: { shieldAbsorb: 0.2, hullMult: 1.0, mix: { energy: 1 } },
      },
    } as TuningConfig;
    const parts = damageComponentsOf(tuning, "hybrid");
    expect(parts.map((p) => [p.type, p.share])).toEqual([
      ["kinetic", 0.5],
      ["energy", 0.5],
    ]);
  });

  it("degrades to the type's own profile when the mix empties out", () => {
    // `hybrid`'s shipped leaf numbers ARE the collapse of the 50/50 mix, so a
    // pack that deletes the mix lands on the same behaviour rather than on a
    // legacy full-nominal hit.
    const tuning = { globalDamageMult: 1, damageTypes: { hybrid: { mix: {} } } } as TuningConfig;
    expect(damageComponentsOf(tuning, "hybrid")).toEqual([
      { type: "hybrid", share: 1, profile: { shieldAbsorb: 0.5, hullMult: 0.75 } },
    ]);
    // 20 through the collapsed profile on a bare hull: 20 × 0.75, on the energy
    // resist column (0 here) — the same 15 the mix produces… bar the kinetic
    // half's 0.9 resist, which is exactly what a per-type resist is FOR.
    const fixture = unshielded({ damageTypes: tuning.damageTypes });
    expect(lossOnFresh(fixture, HIT, "hybrid")).toBeCloseTo(15, 6);
  });
});

describe("damage types — globalDamageMult ordering", () => {
  /**
   * `globalDamageMult` is applied FIRST, to the whole hit, before the shield
   * split. So it scales the soak and the hull damage by the same factor and
   * leaves their ratio alone — which is what makes it a pure "everything hits
   * harder" knob rather than a stealth shield buff.
   */
  it("scales shield soak and hull damage by the same factor", () => {
    const base = shielded();
    const baseLoss = hullLoss(base.world, base.id, HIT, "energy");

    const doubled = shielded(undefined, { globalDamageMult: 2 });
    const doubledLoss = hullLoss(doubled.world, doubled.id, HIT, "energy");

    // 40 through the split: 32 soaked (the 40-point tank still covers it), 8
    // penetrating, 4 on hull — every number exactly twice the base case.
    expect(absorbed(doubled.world)).toBeCloseTo(absorbed(base.world) * 2, 6);
    expect(doubledLoss).toBeCloseTo(baseLoss * 2, 6);
    expect(absorbed(doubled.world)).toBeCloseTo(32, 6);
    expect(doubledLoss).toBeCloseTo(4, 6);
  });

  it("multiplies BEFORE the reserve cap, so a doubled hit can collapse a shield the base hit would not", () => {
    // Reserve 20 covers the 16 a base 20-energy hit wants, but not the 32 a
    // doubled one does — proof the mult lands upstream of the cap.
    const base = shielded(20);
    hullLoss(base.world, base.id, HIT, "energy");
    expect(absorbed(base.world)).toBeCloseTo(16, 6);

    const doubled = shielded(20, { globalDamageMult: 2 });
    const doubledLoss = hullLoss(doubled.world, doubled.id, HIT, "energy");
    expect(absorbed(doubled.world)).toBeCloseTo(20, 6); // capped by the tank
    expect(doubledLoss).toBeCloseTo((40 - 20) * 0.5, 6); // overflow still lands
  });

  it("scales an unshielded hull hit after the hull multiplier all the same", () => {
    const { world, id } = unshielded({ globalDamageMult: 0.5 });
    expect(hullLoss(world, id, HIT, "energy")).toBeCloseTo(HIT * 0.5 * 0.5, 6);
  });
});

describe("damage types — tuning resolution", () => {
  it("authors the shipped triangle explicitly in content", () => {
    const tuning = configs.getAll<TuningConfig>("tuning")[0]!;
    expect(tuning.damageTypes).toEqual({
      energy: { shieldAbsorb: 0.8, hullMult: 0.5 },
      kinetic: { shieldAbsorb: 0.2, hullMult: 1.0 },
      // The warhead ratio is CONTENT (2026-08-14): missiles carry no split of
      // their own, they carry a mix of the two rows above.
      hybrid: { mix: { kinetic: 0.5, energy: 0.5 } },
    });
  });

  it("falls back to the shipped triangle when a pack omits the block entirely", () => {
    const bare = { globalDamageMult: 1 } as TuningConfig;
    expect(damageTypeProfileOf(bare, "energy")).toEqual({ shieldAbsorb: 0.8, hullMult: 0.5 });
    expect(damageTypeProfileOf(bare, "kinetic")).toEqual({ shieldAbsorb: 0.2, hullMult: 1.0 });
  });

  it("inherits per FIELD, so half a profile is a legal thing to author", () => {
    const half = { globalDamageMult: 1, damageTypes: { energy: { hullMult: 0.25 } } } as TuningConfig;
    expect(damageTypeProfileOf(half, "energy")).toEqual({ shieldAbsorb: 0.8, hullMult: 0.25 });
  });

  it("ignores a nonsense authored ratio rather than propagating NaN into hull", () => {
    const bad = {
      globalDamageMult: 1,
      damageTypes: { energy: { shieldAbsorb: Number.NaN, hullMult: -3 } },
    } as TuningConfig;
    expect(damageTypeProfileOf(bad, "energy")).toEqual({ shieldAbsorb: 0.8, hullMult: 0.5 });
  });

  it("a re-authored pack actually changes the split the sim applies", () => {
    // The knobs are content, not constants: flip energy to kinetic's profile and
    // energy must behave exactly like kinetic (bar the hull's own resist).
    const { world, id } = shielded(undefined, {
      damageTypes: { energy: { shieldAbsorb: 0.2, hullMult: 1.0 } },
    });
    expect(hullLoss(world, id, HIT, "energy")).toBeCloseTo(16, 6);
    expect(absorbed(world)).toBeCloseTo(4, 6);
  });

  /**
   * `damageType` is exactly `kinetic | energy` today, so there is no third type
   * in content to regress — but the pipeline still has to have an answer for one,
   * because the enum is documented as extensible. The answer is "behave like the
   * pre-triangle pipeline": the shield module's own `damageReduction` decides the
   * soak, and hull takes the remainder at full nominal.
   */
  it("leaves an unprofiled damage type on the legacy path", () => {
    const EXPLOSIVE = "explosive" as DamageType;
    expect(damageTypeProfileOf({ globalDamageMult: 1 } as TuningConfig, EXPLOSIVE)).toEqual({
      shieldAbsorb: null,
      hullMult: 1,
    });

    // A shield whose `coversFamilies` does not list the type ignores it outright,
    // so the legacy soak is only reachable on a shield that covers everything.
    const { world, id } = unshielded();
    // No shield in the way: full nominal, no 0.5 energy-style penalty, and the
    // hull's per-type resist lookup degrades to the energy column.
    expect(hullLoss(world, id, HIT, EXPLOSIVE)).toBeCloseTo(HIT, 6);
  });

  it("an unprofiled type still soaks on the shield module's own damageReduction", () => {
    // The legacy soak path, reached by authoring a profile-less type onto a
    // shield that covers it: `shield-mk1` reduces 0.5, so 20 splits 10/10 and
    // the 10 that got through lands on hull at full nominal.
    const RADIANT = "radiant" as DamageType;
    const { world, id } = shielded();
    const cfg = world.configs.get<ModuleConfig>("module", "module.shield-mk1")!;
    world.configs.replace({ ...cfg, mitigation: { ...cfg.mitigation!, coversFamilies: undefined } });

    expect(hullLoss(world, id, HIT, RADIANT)).toBeCloseTo(10, 6);
    expect(absorbed(world)).toBeCloseTo(10, 6);
  });
});
