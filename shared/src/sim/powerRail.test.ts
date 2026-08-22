import { beforeAll, describe, expect, it } from "vitest";
import type { ConfigService } from "../core/ConfigService.js";
import type { ModuleConfig, ShipConfig } from "../schemas/index.js";
import { activePowerDraw, fittingPowerDraw, modulesToShedFor, powerDrawOf, railAdmitted } from "./powerRail.js";
import { resolveShipStats } from "./resolveStats.js";
import { spawnShipFromConfig } from "./spawn.js";
import { moduleSystem } from "./systems/ModuleSystem.js";
import {
  INTERCEPTOR_FITTING,
  INTERCEPTOR_FITTING_OVERSUBSCRIBED,
  INTERCEPTOR_SLOTS,
  loadTestConfigs,
  makeWorld,
} from "./testutil.js";
import type { World } from "./World.js";

const DT = 1 / 30;
const GUN = 0;
const SHIELD = 1;
// The balance pass halves the heavy gun + shield to 12 rail draw. Keep this
// fixture deliberately over capacity so the admission/displacement behavior is
// still exercised.
const OVERSUBSCRIBED_CAPACITY = 10;

let configs: ConfigService;
beforeAll(async () => {
  configs = await loadTestConfigs();
});

const draw = (id: string) => powerDrawOf(configs.get<ModuleConfig>("module", id));
const railOf = (shipId: string, fitting: readonly string[]) =>
  resolveShipStats(configs.get<ShipConfig>("ship", shipId)!, configs, { fittedModuleIds: fitting }).power.capacity;

function spawn(fitting: readonly string[]): { world: World; id: number } {
  const world = makeWorld(configs);
  const id = spawnShipFromConfig(world, configs, "ship.interceptor", fitting, 0, { x: 0, z: 0 }, 0);
  if (fitting === INTERCEPTOR_FITTING_OVERSUBSCRIBED) world.shipCores.get(id)!.power.capacity = OVERSUBSCRIBED_CAPACITY;
  return { world, id };
}

function tick(world: World, n: number): void {
  for (let i = 0; i < n; i++) moduleSystem(world, DT);
}

const stateAt = (world: World, id: number, slot: number) =>
  world.modules.get(id)!.modules.find((m) => m.hardpointIndex === slot)!.state;

describe("power rail draw (owner 2026-07-31)", () => {
  it("reads the authored draw, and treats an unauthored block as free", () => {
    expect(draw("module.laser-mk2")).toBeGreaterThan(0);
    expect(powerDrawOf(undefined)).toBe(0);
  });

  it("never charges an INTERNAL — the bay supplies the rail, it does not contend", () => {
    for (const id of [
      "module.engine-earth-eng1",
      "module.generator-earth-eng1",
      "module.alloy-earth-p1",
      "module.countermeasure-flare",
      "module.sensors-common-mk1",
    ]) {
      expect(draw(id), id).toBe(0);
    }
  });

  it("only counts modules that are up or coming up", () => {
    const { world, id } = spawn(INTERCEPTOR_FITTING);
    const mods = world.modules.get(id)!.modules;
    expect(activePowerDraw(configs, mods)).toBe(draw("module.laser-mk1") + draw("module.missile-mk1"));

    mods.find((m) => m.hardpointIndex === GUN)!.state = "retracted";
    expect(activePowerDraw(configs, mods)).toBe(draw("module.missile-mk1"));
  });

  it("sums a whole FITTING regardless of state — what the hangar warns on", () => {
    expect(fittingPowerDraw(configs, INTERCEPTOR_FITTING_OVERSUBSCRIBED)).toBe(
      draw("module.laser-mk2") + draw("module.shield-mk2"),
    );
    expect(fittingPowerDraw(configs, [null, undefined, "module.nope"])).toBe(0);
  });
});

describe("the HULL is what sizes the rail (owner 2026-08-22)", () => {
  it("no fitted module widens or narrows it", () => {
    // The transformer family used to feed the rail, and choosing one was
    // choosing how much you could run at once. It is gone, and capacity is now
    // authored on the airframe alone — so swapping every internal a hull can
    // take must leave the rail exactly where it was.
    const swap = (bay: number, mod: string) => {
      const fitting = [...INTERCEPTOR_FITTING];
      fitting[bay] = mod;
      return railOf("ship.interceptor", fitting);
    };
    const stock = railOf("ship.interceptor", INTERCEPTOR_FITTING);
    expect(swap(INTERCEPTOR_SLOTS.hull, "module.alloy-martian-p4")).toBe(stock);
    expect(swap(INTERCEPTOR_SLOTS.engine, "module.engine-earth-eng4")).toBe(stock);
    expect(swap(INTERCEPTOR_SLOTS.generator, "module.generator-earth-eng4")).toBe(stock);
    expect(swap(INTERCEPTOR_SLOTS.sensors, "module.sensors-sharpshooter-mk4")).toBe(stock);
  });

  it("a heavier hull carries a wider rail than a light one", () => {
    const brawler = configs.get<ShipConfig>("ship", "ship.brawler")!;
    const interceptor = configs.get<ShipConfig>("ship", "ship.interceptor")!;
    expect(railOf("ship.brawler", brawler.defaultFitting.filter((m): m is string => m !== null))).toBeGreaterThan(
      railOf("ship.interceptor", interceptor.defaultFitting.filter((m): m is string => m !== null)),
    );
  });

  it("every shipped hull can run its own stock fitting whole", () => {
    for (const ship of configs.getAll<ShipConfig>("ship")) {
      const fitted = ship.defaultFitting.filter((m): m is string => m !== null && m !== undefined);
      expect(fittingPowerDraw(configs, fitted), ship.id).toBeLessThanOrEqual(railOf(ship.id, fitted));
    }
  });
});

describe("modulesToShedFor", () => {
  it("sheds nothing when there is room", () => {
    const { world, id } = spawn(INTERCEPTOR_FITTING);
    const mods = world.modules.get(id)!.modules;
    const gun = mods.find((m) => m.hardpointIndex === GUN)!;
    gun.state = "retracted";
    expect(modulesToShedFor(configs, mods, gun, 100)).toEqual([]);
  });

  it("NEVER sheds a weapon — the target is refused instead (2026-08-21)", () => {
    const { world, id } = spawn(INTERCEPTOR_FITTING);
    const mods = world.modules.get(id)!.modules;
    const gun = mods.find((m) => m.hardpointIndex === GUN)!;
    gun.state = "retracted";
    // Rail wide enough for the gun plus nothing else. Under the old rule the
    // missile was shed to make room; a weapon has no toggle now, so a gun taken
    // down could never come back and the rail refuses the raise instead.
    expect(modulesToShedFor(configs, mods, gun, draw("module.laser-mk1"))).toBeNull();
  });

  it("refuses a module the hull could not feed even alone", () => {
    const { world, id } = spawn(INTERCEPTOR_FITTING);
    const mods = world.modules.get(id)!.modules;
    const gun = mods.find((m) => m.hardpointIndex === GUN)!;
    expect(modulesToShedFor(configs, mods, gun, draw("module.laser-mk1") - 1)).toBeNull();
  });
});

describe("railAdmitted", () => {
  it("fills in SLOT order, not fitting order", () => {
    const { world, id } = spawn(INTERCEPTOR_FITTING);
    const mods = [...world.modules.get(id)!.modules].reverse();
    const admitted = railAdmitted(configs, mods, draw("module.laser-mk1"));
    expect([...admitted].some((m) => m.hardpointIndex === GUN)).toBe(true);
    expect([...admitted].some((m) => m.hardpointIndex === 1)).toBe(false);
  });

  it("always admits the free modules — internals never wait for current", () => {
    const { world, id } = spawn(INTERCEPTOR_FITTING);
    const admitted = railAdmitted(configs, world.modules.get(id)!.modules, 0);
    expect([...admitted].map((m) => m.hardpointIndex).sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6]);
  });
});

describe("an over-subscribed fitting in flight", () => {
  it("spawns legally — the fit is buildable, it just cannot all be online", () => {
    const { world, id } = spawn(INTERCEPTOR_FITTING_OVERSUBSCRIBED);
    expect(world.modules.get(id)!.modules).toHaveLength(INTERCEPTOR_FITTING_OVERSUBSCRIBED.length);
    expect(fittingPowerDraw(configs, INTERCEPTOR_FITTING_OVERSUBSCRIBED)).toBeGreaterThan(
      OVERSUBSCRIBED_CAPACITY,
    );
  });

  it("REFUSES the heavy shield rather than taking the gun down (2026-08-21)", () => {
    const { world, id } = spawn(INTERCEPTOR_FITTING_OVERSUBSCRIBED);
    expect(stateAt(world, id, GUN)).toBe("active");

    world.queueOrder(id, { kind: "moduleToggle", hardpointIndex: SHIELD });
    tick(world, 30);

    // The gun is a rail PERMANENT now: it has no toggle, so shedding it would
    // silence it for the rest of the match. The decision the rail exists to
    // force is still there — it just falls on the side that can act on it.
    expect(stateAt(world, id, GUN)).toBe("active");
    expect(stateAt(world, id, SHIELD)).toBe("retracted");
  });

  it("emits nothing at all for the refused raise — a no-op is silent", () => {
    const { world, id } = spawn(INTERCEPTOR_FITTING_OVERSUBSCRIBED);
    world.drainEvents();
    world.queueOrder(id, { kind: "moduleToggle", hardpointIndex: SHIELD });
    moduleSystem(world, DT);
    expect(world.drainEvents().filter((e) => e.type === "moduleStateChanged")).toHaveLength(0);
  });

  it("the whole rail stays within capacity at every step", () => {
    const { world, id } = spawn(INTERCEPTOR_FITTING_OVERSUBSCRIBED);
    const capacity = world.shipCores.get(id)!.power.capacity;
    for (const slot of [SHIELD, GUN, SHIELD, GUN, GUN]) {
      world.queueOrder(id, { kind: "moduleToggle", hardpointIndex: slot });
      for (let i = 0; i < 30; i++) {
        moduleSystem(world, DT);
        expect(activePowerDraw(configs, world.modules.get(id)!.modules)).toBeLessThanOrEqual(capacity);
      }
    }
  });
});

describe("a fitting the rail can hold is untouched", () => {
  it("the stock light hull brings both weapons up and keeps them up", () => {
    const { world, id } = spawn(INTERCEPTOR_FITTING);
    tick(world, 30);
    expect(stateAt(world, id, GUN)).toBe("active");
    expect(stateAt(world, id, 1)).toBe("active");
  });
});
